/**
 * Restart and concurrency of Publication (execution-model §9.4, §14;
 * invariant 16): every crash window converges from canonical rows plus the
 * provider's durable external state (staging, the atomic-update receipt),
 * over a file-backed database opened by successive processes, with at most
 * one Target mutation, one durable receipt, one Publication per Decision,
 * one succeeded Publication per Run, no duplicated Evaluation, terminal
 * Event, report, or Snapshot, no false failure after a successful external
 * apply, no false success when the Target was not updated, no external call
 * inside a database transaction, and an identical projection after reopen.
 *
 * Windows: (1) crash after the publish Decision; (2) failure between the
 * Decision resolution and the Publication creation (one transaction: nothing
 * half-done); (3) crash after the Publication creation; (4) crash after
 * external preparation, before the prepared facts persist; (5–6) crash after
 * the prepared facts, before the first deterministic check; (7) crash
 * between deterministic checks; (8) crash after the last passing Evaluation,
 * before `verified`; (9) crash after `verified`; (10) crash after
 * `applying`, before the port call; (11) crash after the atomic Target
 * update and receipt, before SQLite records success; (12) a Target that
 * merely equals the candidate is never inferred as success; (13) restart
 * after the Target moved again following the successful authorized update;
 * (14) compare-and-swap failure because the Target changed; (15) COMMIT
 * failure while recording success; (16) crash after success, before the
 * staging release; (17) cleanup failure and later recovery; (18) two
 * processes advancing one Publication; (19) two publish Decisions racing for
 * one Run; (20) duplicate and conflicting operator-resolution replays.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcceptanceCriterionId, DecisionId, PublicationId, RunId } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { publicationWork } from "./publication-test-support.ts";
import { awaitSignoff } from "./signoff-test-support.ts";
import { FakeAcceptanceCriterionExecution, FakeIntegrationWorkspace, FakePublicationWorkspace, FakeRunFinalizationWorkspace, fakeSnapshot, openRuntimeHarness, type RuntimeHarness } from "./test-support.ts";

interface World {
  dir: string;
  file: string;
  clock: TestClock;
  blobs: MemoryBlobStore;
  integration: FakeIntegrationWorkspace;
  checks: FakeAcceptanceCriterionExecution;
  finalization: FakeRunFinalizationWorkspace;
  provider: FakePublicationWorkspace;
  runId: RunId;
  criterionIds: AcceptanceCriterionId[];
}

/** Runs `body` in a fresh process over the same database and the same durable external Workspace state. */
async function withProcess<T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}): Promise<T> {
  const h = openRuntimeHarness({ base: openHarness(w.file, { clock: w.clock, blobs: w.blobs }), governor: WIDE_GOVERNOR, integrationWorkspace: w.integration, criterionExecution: w.checks, finalizationWorkspace: w.finalization, publicationWorkspace: w.provider });
  try {
    if (options.recover !== false) h.recovery.recover();
    return await body(h);
  } finally {
    try {
      h.close();
    } catch {
      // A process that "died" closed its own handle already.
    }
  }
}

function newWorld(prefix: string): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const integration = new FakeIntegrationWorkspace(sha256Hex);
  return { dir, file: path.join(dir, "console.db"), clock: undefined as never, blobs: undefined as never, integration, checks: new FakeAcceptanceCriterionExecution(), finalization: new FakeRunFinalizationWorkspace(integration), provider: new FakePublicationWorkspace(sha256Hex), runId: undefined as never, criterionIds: [] };
}

/** Completes a Run through the real completion and signoff path in the world's first process; `extraCommand` adds a second deterministic completion criterion. */
async function completeWorldRun(w: World, options: { extraCommand?: string } = {}): Promise<void> {
  await withProcess(
    w,
    async (h) => {
      w.clock = h.clock;
      w.blobs = h.blobs;
      const boundary = await awaitSignoff(h, { diff: "+feature", seed: options.extraCommand === undefined ? {} : { completionCommands: [options.extraCommand] } });
      w.runId = boundary.runId;
      await h.signoff.accept({ runId: w.runId, gateId: boundary.gate.id, decisionId: boundary.decisionId });
      w.criterionIds = h.stores.gates.get(boundary.gate.completionGateId!).acceptanceCriterionIds;
      expect(h.stores.runs.get(w.runId).status).toBe("completed");
    },
    { recover: false },
  );
  // Re-create the world clock/blobs holders for later processes (they are the same instances).
}

const work = (h: RuntimeHarness, w: World) => publicationWork(h, w.runId);
const projection = (h: RuntimeHarness, w: World) => JSON.stringify(h.publication.inspect(w.runId));

describe("publication restart", () => {
  it("converges across the request, preparation, and verification windows without duplicating a Decision, Publication, Snapshot, Evaluation, check, or Event (windows 1–9)", async () => {
    const w = newWorld("agentique-pub-prepare-");
    try {
      await completeWorldRun(w, { extraCommand: "npm run build" });
      expect(w.criterionIds).toHaveLength(2);
      let decisionId: DecisionId = undefined as never;
      let publicationId: PublicationId = undefined as never;
      // Window 1: crash after the publish Decision was created; a new process finds it open and an identical request replays it.
      await withProcess(w, (h) => {
        decisionId = h.publication.request({ runId: w.runId, requestedStrategy: { kind: "automatic" } }).decision.id;
      });
      await withProcess(w, (h) => {
        const replay = h.publication.request({ runId: w.runId, requestedStrategy: { kind: "automatic" } });
        expect([replay.decision.id, replay.replayed]).toEqual([decisionId, true]);
        // Window 2: the resolution and the Publication creation are one transaction — an injected failure between them leaves nothing half-done.
        const before = work(h, w);
        vi.spyOn(h.stores.publications, "create").mockImplementationOnce(() => {
          throw new Error("injected: process died before the Publication row");
        });
        expect(() => h.publication.resolve({ runId: w.runId, decisionId, option: "publish" })).toThrow("injected");
        expect(work(h, w)).toEqual(before);
        expect(h.stores.decisions.get(decisionId).status).toBe("open");
      });
      // Window 3: the Publication was created; the process died before anything advanced.
      await withProcess(w, (h) => {
        const outcome = h.publication.resolve({ runId: w.runId, decisionId, option: "publish" });
        if (outcome.kind !== "publishing") throw new Error(outcome.kind);
        publicationId = outcome.publicationId;
      });
      // Window 4: external preparation succeeded (staging exists) but the prepared facts did not persist; the replayed prepare converges once.
      await withProcess(w, async (h) => {
        expect(h.stores.publications.get(publicationId).status).toBe("requested");
        vi.spyOn(h.stores.publications, "transition").mockImplementationOnce(() => {
          throw new Error("injected: process died before the prepared facts persisted");
        });
        await expect(h.publication.advance(publicationId)).rejects.toThrow("injected");
        expect(w.provider.staged.has(publicationId)).toBe(true);
        expect(h.stores.publications.get(publicationId).status).toBe("requested");
        expect(work(h, w).publishSnapshots).toBe(0);
      });
      const afterPrepared = await withProcess(w, async (h) => {
        expect(await h.publication.advance(publicationId)).toEqual({ kind: "prepared", publicationId });
        expect(w.provider.prepares.at(-1)?.publicationId).toBe(publicationId);
        expect(work(h, w).publishSnapshots).toBe(2);
        return { work: work(h, w), projection: projection(h, w) };
      });
      // Windows 5–6: prepared persisted, the process died before the first deterministic check; the projection reads back identically.
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(afterPrepared.work);
        expect(projection(h, w)).toBe(afterPrepared.projection);
        // Window 7: the first check records, the second throws — a crash between deterministic checks.
        w.checks.script(w.criterionIds[1]!, { kind: "throw", error: new Error("process died between checks") });
        const outcome = await h.publication.advance(publicationId);
        expect(outcome).toMatchObject({ kind: "infrastructure_failure", stage: "verify" });
        expect(h.stores.publications.get(publicationId).status).toBe("prepared");
        expect(h.stores.evaluations.publicationCriterionEvaluationsOf(publicationId)).toHaveLength(1);
      });
      // The next pass reruns exactly the unrecorded check; the recorded one is never executed again.
      await withProcess(w, async (h) => {
        const executedBefore = w.checks.requests.filter((r) => r.publicationId === publicationId).length;
        // Window 8: every Evaluation recorded, the process died before `verified` persisted.
        vi.spyOn(h.stores.publications, "transition").mockImplementationOnce(() => {
          throw new Error("injected: process died before verified persisted");
        });
        await expect(h.publication.advance(publicationId)).rejects.toThrow("injected");
        expect(w.checks.requests.filter((r) => r.publicationId === publicationId).length).toBe(executedBefore + 1);
        expect(h.stores.evaluations.publicationCriterionEvaluationsOf(publicationId)).toHaveLength(2);
        expect(h.stores.publications.get(publicationId).status).toBe("prepared");
      });
      await withProcess(w, async (h) => {
        const executedBefore = w.checks.requests.filter((r) => r.publicationId === publicationId).length;
        expect(await h.publication.advance(publicationId)).toEqual({ kind: "verified", publicationId, checks: 2 });
        // Both checks were found recorded; no command ran again.
        expect(w.checks.requests.filter((r) => r.publicationId === publicationId).length).toBe(executedBefore);
        expect(h.stores.evaluations.publicationCriterionEvaluationsOf(publicationId)).toHaveLength(2);
      });
      // Window 9: `verified` persisted, the process died; reconciliation finishes everything with one Target mutation.
      await withProcess(w, async (h) => {
        const outcomes = await h.publication.reconcileOutstanding();
        expect(outcomes.map((o) => o.kind)).toEqual(["applying", "succeeded", "released"]);
        expect(w.provider.targetMutations).toHaveLength(1);
        expect(w.provider.receipts.size).toBe(1);
        const done = work(h, w);
        expect(done.publications).toEqual([["succeeded", "fast_forward", null, "released", true]]);
        expect(done.events.filter((t) => t === "run.published")).toHaveLength(1);
        expect(done.external.mutations).toBe(1);
      });
      // Every port call ran outside every database transaction.
      expect(w.provider.observedTransactions.every((t) => t === false)).toBe(true);
      expect(w.checks.observed.filter((o) => o.publicationId === publicationId).every((o) => o.inTransaction === false)).toBe(true);
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("converges across the apply, receipt, and cleanup windows with at most one Target mutation and one receipt (windows 10–17)", async () => {
    const w = newWorld("agentique-pub-apply-");
    try {
      await completeWorldRun(w);
      let publicationId: PublicationId = undefined as never;
      await withProcess(w, async (h) => {
        const { decision } = h.publication.request({ runId: w.runId, requestedStrategy: { kind: "automatic" } });
        const outcome = h.publication.resolve({ runId: w.runId, decisionId: decision.id, option: "publish" });
        if (outcome.kind !== "publishing") throw new Error(outcome.kind);
        publicationId = outcome.publicationId;
        await h.publication.advance(publicationId);
        await h.publication.advance(publicationId);
        // Window 10: `applying` persisted, the process died before the port call.
        expect(await h.publication.advance(publicationId)).toEqual({ kind: "applying", publicationId });
        expect(w.provider.applies).toHaveLength(0);
      });
      // Window 11: the atomic Target update and receipt happened, SQLite never learned; the runtime stayed `applying` and reconciles
      // from the durable receipt. Window 13: the Target moved AGAIN after the authorized update — still no false failure.
      await withProcess(w, async (h) => {
        w.provider.crashAfterApply = true;
        const unknown = await h.publication.advance(publicationId);
        expect(unknown).toMatchObject({ kind: "infrastructure_failure", stage: "apply" });
        expect(h.stores.publications.get(publicationId).status).toBe("applying");
        expect(w.provider.targetMutations).toHaveLength(1);
        expect(w.provider.receipts.size).toBe(1);
      });
      const run = await withProcess(w, (h) => h.stores.runs.get(w.runId));
      const candidateIdentity = w.provider.receipts.get(publicationId)!.targetSnapshot;
      w.provider.moveTarget({ workspaceId: run.workspaceId, target: run.target }, fakeSnapshot("operator", "later-push"));
      await withProcess(w, async (h) => {
        // Window 15 first: the success transaction fails after the (replayed) apply; nothing is recorded and nothing external repeats.
        vi.spyOn(h.stores.publications, "transition").mockImplementationOnce(() => {
          throw new Error("injected: COMMIT failed while recording success");
        });
        await expect(h.publication.advance(publicationId)).rejects.toThrow("injected");
        expect(h.stores.publications.get(publicationId).status).toBe("applying");
        expect(w.provider.targetMutations).toHaveLength(1);
      });
      await withProcess(w, async (h) => {
        const done = await h.publication.advance(publicationId);
        expect(done).toMatchObject({ kind: "succeeded", alreadyApplied: true });
        const succeeded = h.stores.publications.get(publicationId);
        expect(h.stores.snapshots.get(succeeded.targetAfterSnapshotId!).identity).toEqual(candidateIdentity);
        expect(work(h, w).events.filter((t) => t === "run.published")).toHaveLength(1);
        expect(w.provider.targetMutations).toHaveLength(1);
        expect(w.provider.receipts.size).toBe(1);
        // Window 16: success recorded, the process dies before the staging release; window 17: the release fails, then recovers.
        w.provider.releaseFailNext = 1;
        expect(await h.publication.advance(publicationId)).toMatchObject({ kind: "infrastructure_failure", stage: "release" });
        expect(h.stores.publications.get(publicationId)).toMatchObject({ status: "succeeded", stagingCleanup: "pending" });
      });
      await withProcess(w, async (h) => {
        expect((await h.publication.reconcileOutstanding()).map((o) => o.kind)).toEqual(["released"]);
        expect(h.stores.publications.get(publicationId).stagingCleanup).toBe("released");
        expect(w.provider.released.has(publicationId)).toBe(true);
        // The projection after reopen equals a fresh read of the same rows.
        expect(projection(h, w)).toBe(JSON.stringify(h.publication.inspect(w.runId)));
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("records the definite not-applied failure when the Target changed, and never infers success from a Target that merely equals the candidate (windows 12, 14)", async () => {
    const w = newWorld("agentique-pub-cas-");
    try {
      await completeWorldRun(w);
      let publicationId: PublicationId = undefined as never;
      await withProcess(w, async (h) => {
        const { decision } = h.publication.request({ runId: w.runId, requestedStrategy: { kind: "automatic" } });
        const outcome = h.publication.resolve({ runId: w.runId, decisionId: decision.id, option: "publish" });
        if (outcome.kind !== "publishing") throw new Error(outcome.kind);
        publicationId = outcome.publicationId;
        await h.publication.advance(publicationId);
        await h.publication.advance(publicationId);
        await h.publication.advance(publicationId);
        expect(h.stores.publications.get(publicationId).status).toBe("applying");
      });
      // Someone moves the Target to exactly the candidate identity, without any authorized update: no receipt exists, so this
      // is never success — the compare-and-swap against the expected Target-before refuses definitely.
      const run = await withProcess(w, (h) => h.stores.runs.get(w.runId));
      const candidate = await withProcess(w, (h) => h.stores.snapshots.get(h.stores.publications.get(publicationId).candidateSnapshotId!).identity);
      w.provider.moveTarget({ workspaceId: run.workspaceId, target: run.target }, candidate);
      await withProcess(w, async (h) => {
        expect(await h.publication.advance(publicationId)).toEqual({ kind: "failed", publicationId, failure: { kind: "target_changed" } });
        expect(w.provider.targetMutations).toHaveLength(0);
        expect(w.provider.receipts.size).toBe(0);
        expect(h.stores.publications.get(publicationId)).toMatchObject({ status: "failed", targetAfterSnapshotId: null });
        expect(work(h, w).events.filter((t) => t === "run.publish_failed")).toHaveLength(1);
        expect(h.stores.runs.get(w.runId).status).toBe("completed");
        await h.publication.advance(publicationId);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("keeps racing processes, racing publish Decisions, and duplicate or conflicting resolution replays canonical (windows 18–20)", async () => {
    const w = newWorld("agentique-pub-race-");
    try {
      await completeWorldRun(w);
      let decisionId: DecisionId = undefined as never;
      let publicationId: PublicationId = undefined as never;
      await withProcess(w, async (h) => {
        // Window 19: two requests race — the identical one replays the open Decision; a conflicting one is refused; one Decision exists.
        decisionId = h.publication.request({ runId: w.runId, requestedStrategy: { kind: "automatic" } }).decision.id;
        expect(h.publication.request({ runId: w.runId, requestedStrategy: { kind: "automatic" } }).decision.id).toBe(decisionId);
        expect(() => h.publication.request({ runId: w.runId, requestedStrategy: { kind: "exact", strategy: { kind: "merge" } } })).toThrow(expect.objectContaining({ refusal: "publish_decision_open" }));
        expect(h.stores.decisions.publishDecisionsOf(w.runId)).toHaveLength(1);
        // Window 20: duplicate and conflicting operator-resolution replays.
        const first = h.publication.resolve({ runId: w.runId, decisionId, option: "publish" });
        if (first.kind !== "publishing") throw new Error(first.kind);
        publicationId = first.publicationId;
        expect(h.publication.resolve({ runId: w.runId, decisionId, option: "publish" })).toEqual({ kind: "publishing", decisionId, publicationId, replayed: true });
        expect(() => h.publication.resolve({ runId: w.runId, decisionId, option: "cancel" })).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
        expect(h.stores.publications.listByRun(w.runId)).toHaveLength(1);
        await h.publication.advance(publicationId);
        await h.publication.advance(publicationId);
        await h.publication.advance(publicationId);
      });
      // Window 18: two processes advance the same `applying` Publication; the durable receipt and the transactional re-read give
      // exactly one Target mutation, one receipt, one success, one run.published — the loser observes the canonical outcome.
      await withProcess(w, async (h) => {
        const realApply = w.provider.apply.bind(w.provider);
        let raced = false;
        vi.spyOn(w.provider, "apply").mockImplementation(async (request) => {
          if (!raced) {
            raced = true;
            // The "other process" completes the whole apply while this one is mid-call.
            const other = await h.publication.advance(publicationId);
            expect(other).toMatchObject({ kind: "succeeded", alreadyApplied: false });
          }
          return realApply(request);
        });
        const mine = await h.publication.advance(publicationId);
        expect(mine).toMatchObject({ kind: "succeeded", alreadyApplied: true });
        vi.restoreAllMocks();
        expect(w.provider.targetMutations).toHaveLength(1);
        expect(w.provider.receipts.size).toBe(1);
        const done = work(h, w);
        expect(done.events.filter((t) => t === "run.published")).toHaveLength(1);
        expect(done.events.filter((t) => t === "publication.succeeded")).toHaveLength(1);
        expect(done.reports).toBe(1);
        await h.publication.reconcileOutstanding();
      });
      // A replayed resolution after success still returns the canonical Publication; a further request is refused for good.
      await withProcess(w, (h) => {
        expect(h.publication.resolve({ runId: w.runId, decisionId, option: "publish" })).toEqual({ kind: "publishing", decisionId, publicationId, replayed: true });
        expect(() => h.publication.request({ runId: w.runId, requestedStrategy: { kind: "automatic" } })).toThrow(expect.objectContaining({ refusal: "run_already_published" }));
        expect(h.stores.publications.listByRun(w.runId)).toHaveLength(1);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
