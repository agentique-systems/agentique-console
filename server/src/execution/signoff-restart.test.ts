/**
 * Restart and idempotence of signoff resolution (execution-model §9.3, §10
 * `operator_signoff`, §14 "Server restart"; invariants 6, 12, 16, 19, 20):
 * every crash window of an acceptance and of a change request is closed
 * from canonical rows alone, over a file-backed database opened by
 * successive processes, without a duplicate Signoff Resolution, Decision
 * resolution, Gate closure, final diff Artifact, final Changeset, final
 * Snapshot reference, Run transition, active-Run clearing, follow-up
 * Invocation, workspace preparation, or Event.
 *
 * Accept: (1) the operator calls accept, the process dies before the
 * Workspace is inspected; (2) inspected, diff computed, no database write;
 * (3) diff blob written, the Artifact transaction rolls back; (4) Artifact
 * created, the final Changeset creation fails; (5) final Changeset created,
 * the Decision resolution fails; (6) Decision resolved, the Gate close fails;
 * (7) Gate passed, the Run transition fails; (8) Run completed, the
 * active-Run clear fails; (9) COMMIT fails after every callback mutation;
 * (10) the response is lost after success; (11) a second identical accept;
 * (12) a conflicting change request after acceptance.
 *
 * Request changes: (13) the request is received before its transaction;
 * (14) the resolution, Decision, Gate, and Run changes began, Invocation
 * preparation fails; (15) workspace preparation succeeded, the transaction
 * rolls back; (16) the transaction succeeded, the response is lost; (17) the
 * follow-up Invocation is committed, the provider not called; (18) the
 * follow-up result is committed, its Changeset not integrated; (19) the
 * process restarts before the follow-up settles; (20) a second identical
 * change request; (21) a conflicting accept after the change request.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationMessageId, DecisionId, GateId, RunId } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { prepareOperatorTurn, requestingStep, signoffGatesOf, synthesisStep } from "./completion-test-support.ts";
import { orchestratorStep, scriptByRole, until } from "./gate-test-support.ts";
import { awaitSignoff, followUpsOf, operatorMessage, signoffWork } from "./signoff-test-support.ts";
import { FakeAcceptanceCriterionExecution, FakeIntegrationWorkspace, FakeRunFinalizationWorkspace, openRuntimeHarness, type RuntimeHarness } from "./test-support.ts";

interface World {
  dir: string;
  file: string;
  clock: TestClock;
  blobs: MemoryBlobStore;
  integration: FakeIntegrationWorkspace;
  checks: FakeAcceptanceCriterionExecution;
  finalization: FakeRunFinalizationWorkspace;
  runId: RunId;
  gateId: GateId;
  decisionId: DecisionId;
  messageId: ConversationMessageId;
}

/** Runs `body` in a fresh process over the same database: recovery runs first, exactly as at startup, and the file is always closed. */
async function withProcess<T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}): Promise<T> {
  const h = openRuntimeHarness({ base: openHarness(w.file, { clock: w.clock, blobs: w.blobs }), governor: WIDE_GOVERNOR, integrationWorkspace: w.integration, criterionExecution: w.checks, finalizationWorkspace: w.finalization });
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
  return { dir, file: path.join(dir, "console.db"), clock: undefined as never, blobs: undefined as never, integration, checks: new FakeAcceptanceCriterionExecution(), finalization: new FakeRunFinalizationWorkspace(integration), runId: undefined as never, gateId: undefined as never, decisionId: undefined as never, messageId: undefined as never };
}

/** Everything a repeated resolution could duplicate, plus the blob count (an orphan blob would show here). */
const work = (h: RuntimeHarness, w: World) => ({ ...signoffWork(h, w.runId), blobs: h.blobs.size });

const accept = (h: RuntimeHarness, w: World) => h.signoff.accept({ runId: w.runId, gateId: w.gateId, decisionId: w.decisionId });
const requestChanges = (h: RuntimeHarness, w: World) => h.signoff.requestChanges({ runId: w.runId, gateId: w.gateId, decisionId: w.decisionId, operatorMessageId: w.messageId });

describe("signoff restart", () => {
  it("converges across the twelve windows of an acceptance without duplicating a resolution, Decision, Gate closure, Artifact, Changeset, transition, or Event", async () => {
    const w = newWorld("agentique-signoff-accept-");
    try {
      const before = await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        // The first boundary is answered with a change request; the follow-up writes more; a later turn requests completion again and the
        // second boundary opens, whose final diff ("+feature+renamed") is content no other Artifact holds.
        const first = await awaitSignoff(h, { diff: "+feature" });
        w.runId = first.runId;
        h.signoff.requestChanges({ runId: w.runId, gateId: first.gate.id, decisionId: first.decisionId, operatorMessageId: operatorMessage(h, w.runId).id });
        scriptByRole(h, { orchestrator: [orchestratorStep(h, { diff: "+renamed" })] });
        await h.scheduler.advanceRun(w.runId);
        prepareOperatorTurn(h, w.runId);
        scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h)] });
        await h.scheduler.advanceRun(w.runId);
        const gate = signoffGatesOf(h, w.runId).at(-1)!;
        expect([h.stores.runs.get(w.runId).status, gate.ordinal, gate.status]).toEqual(["awaiting_signoff", 2, "open"]);
        w.gateId = gate.id;
        w.decisionId = h.stores.decisions.signoffOf(gate.id)!.id;
        return work(h, w);
      }, { recover: false });
      const finalDigest = sha256Hex(new TextEncoder().encode("+feature+renamed"));
      // Window 1: the process died before inspecting; nothing happened. Window 2: inspected and computed, no database write.
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        vi.spyOn(h.stores.artifacts, "create").mockImplementationOnce(() => {
          throw new Error("process died before the transaction wrote");
        });
        await expect(accept(h, w)).rejects.toThrow("process died before the transaction wrote");
        expect(w.finalization.requests).toHaveLength(1);
        expect(work(h, w)).toEqual({ ...before, inspections: 1 });
      });
      // Windows 3–8: a failure at each step inside the transaction rolls every relational change back and compensates the diff blob.
      const injected: [string, (h: RuntimeHarness) => void][] = [
        ["the Artifact transaction (after the blob was written)", (h) => vi.spyOn(h.ctx.journal, "append").mockImplementationOnce(() => { throw new Error("injected: artifact event"); })],
        ["the final Changeset creation", (h) => vi.spyOn(h.stores.changesets, "recordFinal").mockImplementationOnce(() => { throw new Error("injected: final changeset"); })],
        ["the Decision resolution", (h) => vi.spyOn(h.stores.decisions, "resolve").mockImplementationOnce(() => { throw new Error("injected: decision"); })],
        ["the Gate close", (h) => vi.spyOn(h.stores.gates, "close").mockImplementationOnce(() => { throw new Error("injected: gate"); })],
        ["the Run transition", (h) => vi.spyOn(h.stores.runs, "transition").mockImplementationOnce(() => { throw new Error("injected: run"); })],
        ["the active-Run clear", (h) => vi.spyOn(h.stores.conversations, "setActiveRun").mockImplementationOnce(() => { throw new Error("injected: conversation"); })],
      ];
      let inspections = 1;
      for (const [label, inject] of injected) {
        await withProcess(w, async (h) => {
          expect(work(h, w), label).toEqual({ ...before, inspections });
          inject(h);
          await expect(accept(h, w), label).rejects.toThrow(/injected/);
          inspections += 1;
          expect(work(h, w), label).toEqual({ ...before, inspections });
          expect(h.blobs.has(finalDigest), label).toBe(false);
          expect(h.ctx.tx.inTransaction).toBe(false);
        });
      }
      // Window 9: COMMIT itself fails after every callback mutation; the rollback compensates the blob and the boundary stays open.
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual({ ...before, inspections });
        const sqlite = h.database.sqlite;
        const exec = sqlite.exec.bind(sqlite);
        let failed = false;
        vi.spyOn(sqlite, "exec").mockImplementation((source: string) => {
          if (source === "COMMIT" && !failed) {
            failed = true;
            throw new Error("injected: commit failure");
          }
          return exec(source);
        });
        await expect(accept(h, w)).rejects.toThrow("injected: commit failure");
        inspections += 1;
        expect(failed).toBe(true);
        expect(work(h, w)).toEqual({ ...before, inspections });
        expect(h.blobs.has(finalDigest)).toBe(false);
      });
      // Window 10: the acceptance commits; the response is lost with the process.
      const completed = await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual({ ...before, inspections });
        expect(await accept(h, w)).toMatchObject({ kind: "accepted", replayed: false });
        inspections += 1;
        const after = work(h, w);
        expect(after).toMatchObject({ run: "completed", resolutions: [["request_changes", true], ["accept", false]], signoffGates: [["failed", "changes_requested"], ["passed", null]], decisions: [["resolved", "request_changes"], ["resolved", "accept"]], diffs: 4, activeRunId: null, inspections });
        expect(after.changesets).toEqual([["invocation", "integrated"], ["invocation", "integrated"], ["invocation", "integrated"], ["final", "recorded"]]);
        expect(after.blobs).toBe(before.blobs + 1);
        expect(h.blobs.has(finalDigest)).toBe(true);
        expect(new TextDecoder().decode(h.stores.artifacts.read(h.stores.changesets.finalOf(w.runId)!.diffArtifactId).bytes)).toBe("+feature+renamed");
        return after;
      });
      // Window 11: a second identical accept in a new process replays from rows and inspects nothing. Window 12: a conflicting change request is rejected.
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(completed);
        expect(await accept(h, w)).toMatchObject({ kind: "accepted", replayed: true, finalSnapshotId: h.stores.runs.get(w.runId).finalSnapshotId, finalChangesetId: h.stores.runs.get(w.runId).finalChangesetId });
        expect(work(h, w)).toEqual(completed);
        w.messageId = operatorMessage(h, w.runId).id;
        expect(() => requestChanges(h, w)).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
        expect(work(h, w)).toEqual(completed);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "run_terminal", actions: [] });
        expect(h.signoff.inspect(w.runId)).toMatchObject({ runStatus: "completed", allowedActions: [] });
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("converges across the nine windows of a change request and its follow-up turn without duplicating a resolution, Invocation, preparation, Changeset, or Event", async () => {
    const w = newWorld("agentique-signoff-changes-");
    try {
      const before = await withProcess(w, async (h) => {
        w.clock = h.clock;
        w.blobs = h.blobs;
        const boundary = await awaitSignoff(h, { diff: "+feature" });
        w.runId = boundary.runId;
        w.gateId = boundary.gate.id;
        w.decisionId = boundary.decisionId;
        w.messageId = operatorMessage(h, w.runId).id;
        return work(h, w);
      }, { recover: false });
      // Window 13: the request was received; the process died before its transaction. Window 14: the resolution, Decision, Gate, and Run changes
      // began, Invocation preparation fails: everything rolls back, no worktree was prepared.
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        vi.spyOn(h.preparation, "prepare").mockImplementationOnce(() => {
          throw new Error("injected: preparation");
        });
        expect(() => requestChanges(h, w)).toThrow("injected: preparation");
        expect(work(h, w)).toEqual(before);
        expect(h.executionWorkspace.prepared).toEqual([]);
        expect(h.executionWorkspace.discarded).toEqual([]);
      });
      // Window 15: the worktree was prepared, the transaction rolls back at the last step: the port's compensation discards it.
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        vi.spyOn(h.stores.signoffResolutions, "link").mockImplementationOnce(() => {
          throw new Error("injected: link");
        });
        expect(() => requestChanges(h, w)).toThrow("injected: link");
        expect(work(h, w)).toEqual(before);
        expect(h.executionWorkspace.prepared).toHaveLength(1);
        expect(h.executionWorkspace.discarded.map((r) => r.runId)).toEqual([w.runId]);
        expect(h.ctx.tx.inTransaction).toBe(false);
      });
      // Window 16: the transaction commits; the response is lost with the process.
      const reopened = await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(before);
        expect(requestChanges(h, w)).toMatchObject({ kind: "changes_requested", replayed: false });
        const after = work(h, w);
        expect(after).toMatchObject({ run: "running", resolutions: [["request_changes", true]], signoffGates: [["failed", "changes_requested"]], decisions: [["resolved", "request_changes"]], finalChangesetId: null, diffs: 1 });
        expect(h.executionWorkspace.prepared).toHaveLength(1);
        expect(after.rootTurns).toEqual([["operator_input", "succeeded"], ["final_synthesis", "succeeded"], ["decision_resolution", "pending"]]);
        return after;
      });
      // Window 20 (early): a second identical request in a new process replays from rows and prepares nothing. Window 21: a conflicting accept is rejected.
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(reopened);
        expect(requestChanges(h, w)).toMatchObject({ kind: "changes_requested", replayed: true, followUpInvocationId: followUpsOf(h, w.runId)[0]!.id });
        await expect(accept(h, w)).rejects.toMatchObject({ refusal: "conflicting_resolution" });
        expect(work(h, w)).toEqual(reopened);
        expect(w.finalization.requests).toEqual([]);
      });
      // Window 17: the follow-up is committed and the provider is called; the process dies before any response.
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(reopened);
        expect(h.scheduler.reconcileRun(w.runId).actions.map((a) => a.kind)).toEqual(["execute_invocation"]);
        h.provider.script({ kind: "hang" });
        const pass = h.scheduler.advanceRun(w.runId);
        void pass.catch(() => undefined);
        await until(() => h.provider.requests.length === 1);
        expect(work(h, w)).toMatchObject({ rootTurns: [...reopened.rootTurns.slice(0, 2), ["decision_resolution", "running"]], attempts: reopened.attempts + 1 });
      });
      // Window 18: recovery interrupts the Attempt; the retried turn succeeds with a Changeset; the process dies before integration.
      const settled = await withProcess(w, async (h) => {
        expect(h.recovery.recover().interruptedAttemptIds).toEqual([]);
        const [followUp] = followUpsOf(h, w.runId);
        expect(h.stores.invocations.listAttempts(followUp!.id).map((a) => a.status)).toEqual(["interrupted"]);
        scriptByRole(h, { orchestrator: [orchestratorStep(h, { diff: "+renamed" })] });
        const pass = await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        expect(pass.actions.map((p) => p.action.kind)).toEqual(["execute_invocation"]);
        const after = work(h, w);
        expect(after).toMatchObject({ rootTurns: [...reopened.rootTurns.slice(0, 2), ["decision_resolution", "succeeded"]], attempts: reopened.attempts + 2 });
        expect(after.changesets).toEqual([["invocation", "integrated"], ["invocation", "pending"]]);
        return after;
      });
      // Window 19: the process restarted before the follow-up settled; the next pass integrates its Changeset once and the Run stays running, quiescent.
      await withProcess(w, async (h) => {
        expect(work(h, w)).toEqual(settled);
        const pass = await h.scheduler.advanceRun(w.runId);
        expect(pass.actions.map((p) => p.action.kind)).toEqual(["settle_root"]);
        expect(pass.stop).toBe("quiescent");
        expect(work(h, w)).toMatchObject({ run: "running", changesets: [["invocation", "integrated"], ["invocation", "integrated"]], resolutions: [["request_changes", true]], requests: ["passed"] });
        expect(followUpsOf(h, w.runId)).toHaveLength(1);
      });
      // Window 20 (late): the identical request still replays after the follow-up ended; nothing restarts, and no completion is requested by itself.
      await withProcess(w, async (h) => {
        const final = work(h, w);
        expect(requestChanges(h, w)).toMatchObject({ kind: "changes_requested", replayed: true });
        expect(work(h, w)).toEqual(final);
        expect(await h.scheduler.advanceRun(w.runId)).toMatchObject({ stop: "quiescent", actions: [] });
        expect(h.stores.completionRequests.listByRun(w.runId)).toHaveLength(1);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
