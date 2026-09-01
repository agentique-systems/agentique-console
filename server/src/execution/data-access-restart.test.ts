/**
 * Restart behavior of the runtime data-access tools (execution-model §6.4,
 * §14): over a file-backed database opened by successive "processes",
 * reads project identically before and after a reopen and record nothing;
 * a committed `write_artifact` whose response was lost replays the same
 * Artifact id on the provider's retry; a failure after the blob write and
 * before the commit leaves no blob, row, or Event; an unrouted predecessor
 * Artifact stays unreadable to the continuation Invocation; a canonically
 * routed Artifact is readable after a reopen; corrupted content stays a
 * closed typed failure; and an Evaluator's Evidence Artifact settles after
 * a reopen without a duplicated provider call, Artifact, Event, row, blob,
 * or Evidence association.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, type ArtifactId, type InvocationId, type RunId } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { portFor } from "./coordinator-test-support.ts";
import { evaluatorPort, passRetryBackoff, readArtifact, readRequirements, readResult, rejectionCodes, stepUntil, writeArtifact, writtenArtifact } from "./data-access-test-support.ts";
import { newWorld as worldAt, withProcess as withProcessOver, type World } from "./recovery-test-support.ts";
import { COMPLETED_RESULT, seedReadOnlyWorker, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

function newWorld(prefix: string): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return worldAt(dir, path.join(dir, "console.db"));
}

const removeWorld = (w: World) => fs.rmSync(w.dir, { recursive: true, force: true });

const withProcess = <T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean } = {}) => withProcessOver(w, body, { ...options, after: () => vi.restoreAllMocks() });

interface DataWorld extends World {
  invocationId: InvocationId;
}

/** A world whose first process seeded a Run and prepared its first root turn. */
async function rootWorld(prefix: string): Promise<DataWorld> {
  const w = newWorld(prefix) as DataWorld;
  await withProcess(w, (h) => {
    const s = seedRuntime(h);
    w.runId = s.created.run.id;
    w.invocationId = startRun(h, s).prepared.invocation.id;
  }, { recover: false });
  return w;
}

/** Everything a repeated write or read could duplicate, from rows alone. */
function facts(h: RuntimeHarness, runId: RunId) {
  const invocations = h.stores.invocations.listByRun(runId);
  return {
    artifacts: h.stores.artifacts.listByRun(runId).map((a) => [a.id, a.digest, a.byteSize, canonicalJson(a.producer)]),
    calls: invocations.flatMap((i) => h.stores.runtimeToolCalls.listByInvocation(i.id).map((c) => [i.id, c.tool, c.callDigest])),
    usage: h.stores.usage.totalsForRun(runId).rows,
    events: h.ctx.journal.read({ runId }).map((e) => e.type),
  };
}

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (ready()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
}

describe("runtime data-access recovery", () => {
  it("replays a committed write whose response was lost: the provider's retry receives the same Artifact id, and nothing — Artifact, Event, row, blob, Usage — exists twice (windows 2, 5)", async () => {
    const w = await rootWorld("agentique-write-replay-");
    let artifactId: ArtifactId | undefined;
    let before: ReturnType<typeof facts> | undefined;
    try {
      await withProcess(w, async (h) => {
        // The write commits; then the provider hangs and the process dies with the response lost.
        h.provider.script({ kind: "runtime_tool_calls", calls: [writeArtifact({ title: "kept", content: "kept bytes" })], then: { kind: "hang" } });
        void h.executor.advanceInvocation(w.invocationId).catch(() => {});
        await until(() => h.provider.runtimeToolCalls.length === 1);
        artifactId = writtenArtifact(h.provider.runtimeToolCalls[0]!.outcome).artifactId;
        before = facts(h, w.runId);
      });
      await withProcess(w, async (h) => {
        // Reads project identically after the reopen (window 1) and still record nothing.
        expect(facts(h, w.runId).artifacts).toEqual(before!.artifacts);
        // The retried Attempt submits the identical call: replayed, same Artifact, then the turn completes.
        passRetryBackoff(h, w.invocationId);
        h.provider.script({ kind: "runtime_tool_calls", calls: [writeArtifact({ title: "kept", content: "kept bytes" })], then: { kind: "succeed", result: COMPLETED_RESULT } });
        const outcome = await h.executor.advanceInvocation(w.invocationId);
        expect(outcome).toMatchObject({ kind: "finalized", attempt: { number: 2, status: "succeeded" } });
        const replay = writtenArtifact(h.provider.runtimeToolCalls[0]!.outcome);
        expect(replay).toMatchObject({ artifactId, replayed: true });
        const after = facts(h, w.runId);
        // Exactly one written Artifact and one call row exist, however many Attempts served the turn.
        expect(after.artifacts.filter((a) => a[1] === replay.digest)).toEqual(before!.artifacts.filter((a) => a[1] === replay.digest));
        expect(after.artifacts.filter((a) => a[1] === replay.digest)).toHaveLength(1);
        expect(after.calls).toEqual(before!.calls);
        expect(after.events.filter((e) => e === "runtime_tool_call.committed")).toHaveLength(1);
        expect(w.blobs.has(replay.digest)).toBe(true);
      });
    } finally {
      removeWorld(w);
    }
  });

  it("leaves no blob, row, or Event when the transaction fails after the blob write — before or at the commit — and the retried call succeeds from scratch (windows 3, 4)", async () => {
    const digest = sha256Hex(new TextEncoder().encode("doomed bytes"));
    const injections: [string, (h: RuntimeHarness) => void][] = [
      // Window 4: the Artifact and its Event exist in the transaction; the call-row commit fails; everything rolls back.
      ["after the Artifact, at the call row", (h) => vi.spyOn(h.stores.runtimeToolCalls, "record").mockImplementationOnce(() => { throw new Error("injected: died at the call row"); })],
      // Window 3: everything is written in the transaction; COMMIT itself fails; the blob compensation removes the new blob.
      ["at COMMIT", (h) => {
        const exec = h.ctx.sqlite.exec.bind(h.ctx.sqlite);
        const spy = vi.spyOn(h.ctx.sqlite, "exec").mockImplementation((sql: string) => {
          if (sql === "COMMIT") {
            spy.mockRestore();
            throw new Error("injected: died at COMMIT");
          }
          return exec(sql);
        });
      }],
    ];
    for (const [label, inject] of injections) {
      const w = await rootWorld("agentique-write-rollback-");
      try {
        await withProcess(w, async (h) => {
          const prepared = await h.executor.prepareNextAttempt(w.invocationId);
          if (prepared.kind !== "prepared") throw new Error(prepared.kind);
          const port = portFor(h, prepared.invocation, prepared.attempt);
          inject(h);
          const failed = await port.call(writeArtifact({ title: "doomed", content: "doomed bytes" }));
          expect(failed, label).toMatchObject({ kind: "failed", tool: "write_artifact" });
          expect(w.blobs.has(digest), label).toBe(false);
        });
        await withProcess(w, async (h) => {
          const f = facts(h, w.runId);
          expect(f.artifacts, label).toEqual([]);
          expect(f.calls, label).toEqual([]);
          expect(f.events.filter((e) => e.startsWith("artifact") || e.startsWith("runtime_tool_call")), label).toEqual([]);
          expect(w.blobs.has(digest), label).toBe(false);
          // The retried identical call in the next process succeeds exactly once.
          passRetryBackoff(h, w.invocationId);
          const prepared = await h.executor.prepareNextAttempt(w.invocationId);
          if (prepared.kind !== "prepared") throw new Error(`${label}: ${prepared.kind}`);
          const port = portFor(h, prepared.invocation, prepared.attempt);
          expect(writtenArtifact(await port.call(writeArtifact({ title: "doomed", content: "doomed bytes" }))).replayed, label).toBe(false);
          expect(w.blobs.has(digest), label).toBe(true);
          expect(facts(h, w.runId).artifacts, label).toHaveLength(1);
        });
      } finally {
        removeWorld(w);
      }
    }
  });

  it("keeps an unrouted predecessor Artifact unreadable to the continuation Invocation across a reopen (window 6)", async () => {
    const w = await rootWorld("agentique-unrouted-");
    let artifactId: ArtifactId | undefined;
    try {
      await withProcess(w, async (h) => {
        // The turn writes an Artifact, then ends on an accepted request_decision; the process dies after settlement.
        h.provider.script({
          kind: "runtime_tool_calls",
          calls: [
            writeArtifact({ title: "predecessor production", content: "not routed" }),
            { tool: "request_decision", input: { kind: "operator_choice", question: "Continue?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], resolutionPolicy: { kind: "operator_required" }, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } } },
          ],
          then: { kind: "succeed", result: COMPLETED_RESULT },
        });
        const outcome = await h.executor.advanceInvocation(w.invocationId);
        expect(outcome.kind).toBe("decision_requested");
        artifactId = writtenArtifact(h.provider.runtimeToolCalls[0]!.outcome).artifactId;
      });
      await withProcess(w, async (h) => {
        const decision = h.stores.decisions.listByRun(w.runId).find((d) => d.kind === "operator_choice")!;
        expect(h.decisionRequests.resolve({ decisionId: decision.id, optionId: "yes" }).kind).toBe("resolved");
        await h.scheduler.advanceRun(w.runId, { maxActions: 1 });
        const successor = h.stores.invocations.listByRun(w.runId).find((i) => i.continuedFromInvocationId === w.invocationId);
        if (!successor) throw new Error("no successor was prepared");
        const prepared = await h.executor.prepareNextAttempt(successor.id);
        if (prepared.kind !== "prepared") throw new Error(prepared.kind);
        const port = portFor(h, prepared.invocation, prepared.attempt);
        // A new logical turn: producer ownership does not carry over, and nothing routed the Artifact canonically.
        expect(rejectionCodes(await port.call(readArtifact({ artifactId: artifactId! })))).toEqual(["artifact_not_readable"]);
        // What the manifest carries — nothing — is what is readable; the projection repeats identically.
        expect(rejectionCodes(await port.call(readArtifact({ artifactId: artifactId! })))).toEqual(["artifact_not_readable"]);
      });
    } finally {
      removeWorld(w);
    }
  });

  it("makes a routed Artifact readable after a reopen: a chain step's written output travels by Handoff to the next step's manifest (window 7)", async () => {
    const w = newWorld("agentique-routed-") as DataWorld;
    let artifactId: ArtifactId | undefined;
    try {
      await withProcess(w, async (h) => {
        const s = seedRuntime(h);
        w.runId = s.created.run.id;
        const reader = seedReadOnlyWorker(h);
        const started = startRun(h, s);
        w.invocationId = started.prepared.invocation.id;
        // Root turn completes; the plan is a two-step read-only chain.
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        const outcome = await h.planRevisions.propose({
          runId: w.runId,
          proposedByInvocationId: w.invocationId,
          source: { version: 1, expressions: [{ pattern: "chain", steps: [{ pattern: "single", operation: { agentDefinitionRevisionId: reader.id, title: "produce" } }, { pattern: "single", operation: { agentDefinitionRevisionId: reader.id, title: "consume" } }], allocation: { costUsd: 8, tokens: 80_000, attempts: 6 } }] },
          correlationId: null,
          causationSeq: null,
        });
        if (!outcome.accepted) throw new Error("plan rejected");
        await h.executor.advanceInvocation(w.invocationId);
        // Step 1 writes its output through write_artifact and returns it as its result Artifact.
        h.provider.script({
          kind: "runtime_tool_calls",
          calls: [writeArtifact({ title: "step output", content: "carried forward" })],
          then: {
            kind: "derived",
            step: (request) => {
              const written = h.stores.runtimeToolCalls.listByInvocation(request.invocationId).find((c) => c.tool === "write_artifact")!;
              if (written.result.tool !== "write_artifact") throw new Error("no written Artifact");
              artifactId = written.result.artifactId;
              return { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [written.result.artifactId], summary: "produced" } };
            },
          },
        });
        await stepUntil(h, w.runId, () => h.stores.invocations.listByRun(w.runId).some((i) => i.patternPosition?.kind === "chain_step" && i.status === "succeeded"));
        // The process dies before step 2 executes.
      });
      await withProcess(w, async (h) => {
        // Step 2's manifest carries the Handoff; the routed Artifact reads back after the reopen.
        h.provider.script({
          kind: "derived",
          step: () => ({ kind: "runtime_tool_calls", calls: [readArtifact({ artifactId: artifactId! })], then: { kind: "succeed", result: COMPLETED_RESULT } }),
        });
        await stepUntil(h, w.runId, () => h.provider.runtimeToolCalls.length === 1);
        const read = readResult(h.provider.runtimeToolCalls[0]!.outcome, "read_artifact");
        expect(read).toMatchObject({ artifactId, content: "carried forward", eof: true });
      });
    } finally {
      removeWorld(w);
    }
  });

  it("keeps corrupted content a closed typed failure after a reopen, recording nothing (window 8)", async () => {
    const w = await rootWorld("agentique-corrupt-");
    let artifactId: ArtifactId | undefined;
    let digest: string | undefined;
    try {
      await withProcess(w, async (h) => {
        const prepared = await h.executor.prepareNextAttempt(w.invocationId);
        if (prepared.kind !== "prepared") throw new Error(prepared.kind);
        const port = portFor(h, prepared.invocation, prepared.attempt);
        const written = writtenArtifact(await port.call(writeArtifact({ title: "will corrupt", content: "original bytes" })));
        artifactId = written.artifactId;
        digest = written.digest;
        w.blobs.corrupt(written.digest, new TextEncoder().encode("tampered bytes"));
        expect(rejectionCodes(await port.call(readArtifact({ artifactId: written.artifactId })))).toEqual(["artifact_content_corrupt"]);
      });
      await withProcess(w, async (h) => {
        const before = facts(h, w.runId);
        passRetryBackoff(h, w.invocationId);
        const prepared = await h.executor.prepareNextAttempt(w.invocationId);
        if (prepared.kind !== "prepared") throw new Error(prepared.kind);
        const port = portFor(h, prepared.invocation, prepared.attempt);
        // Still the same closed failure — never "not found", never a byte or path in the outcome — and still nothing recorded.
        const seq = h.ctx.journal.lastSeq();
        const outcome = await port.call(readArtifact({ artifactId: artifactId! }));
        expect(rejectionCodes(outcome)).toEqual(["artifact_content_corrupt"]);
        expect(JSON.stringify(outcome)).not.toContain("tampered");
        expect(readResult(await port.call(readRequirements()), "read_requirements").items.length).toBeGreaterThan(0);
        expect(h.ctx.journal.lastSeq()).toBe(seq);
        expect(facts(h, w.runId).artifacts).toEqual(before.artifacts);
        expect(digest).toBeDefined();
      });
    } finally {
      removeWorld(w);
    }
  });

  it("settles an Evaluator whose Evidence Artifact was written before the crash without duplicating anything (window 9)", async () => {
    const w = newWorld("agentique-evaluator-evidence-") as DataWorld & { gateId?: string; nodeId2?: string; revisionNumber2?: number };
    let artifactId: ArtifactId | undefined;
    try {
      await withProcess(w, async (h) => {
        const e = await evaluatorPort(h);
        w.runId = e.runId;
        w.invocationId = e.invocation.id;
        w.gateId = e.gateId;
        w.nodeId2 = e.node.id;
        w.revisionNumber2 = e.revisionNumber;
        const written = writtenArtifact(await e.port.call(writeArtifact({ title: "evidence", content: "the finding" })));
        artifactId = written.artifactId;
        // The process dies with the Evaluator Attempt still running.
      });
      await withProcess(w, async (h) => {
        passRetryBackoff(h, w.invocationId);
        const prepared = await h.executor.prepareNextAttempt(w.invocationId);
        if (prepared.kind !== "prepared") throw new Error(prepared.kind);
        const port = portFor(h, prepared.invocation, prepared.attempt);
        // The fresh Attempt replays the identical write and reads its Evidence back.
        const replay = writtenArtifact(await port.call(writeArtifact({ title: "evidence", content: "the finding" })));
        expect(replay).toMatchObject({ artifactId, replayed: true });
        expect(readResult(await port.call(readArtifact({ artifactId: artifactId! })), "read_artifact").content).toBe("the finding");
        h.provider.script({
          kind: "derived",
          step: (request) => {
            const content = h.stores.invocations.getManifest(request.invocationId).content;
            const candidate = content.inputs.find((i) => i.kind === "gate_candidate");
            if (candidate?.kind !== "gate_candidate") throw new Error("no gate_candidate input");
            const evidence = [{ kind: "artifact" as const, artifactId: artifactId! }];
            return { kind: "succeed", result: { ...COMPLETED_RESULT, summary: "judged", evaluation: { verdict: "pass", criteria: candidate.acceptanceCriterionIds.map((id) => ({ acceptanceCriterionId: id, verdict: "pass", evidence })), evidence } } };
          },
        });
        const outcome = await h.executor.executePreparedAttempt(prepared.attempt.id);
        expect(outcome).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
        const settled = h.runners.single.settleGate(w.nodeId2 as never, w.revisionNumber2!);
        expect(settled).toMatchObject({ kind: "gate_passed", gateId: w.gateId });
        // Exactly one Artifact, one call row, one Evaluation per criterion, one Evidence association; a repeated settle changes nothing.
        const f = facts(h, w.runId);
        expect(f.artifacts.filter((a) => a[1] === replay.digest)).toHaveLength(1);
        expect(f.calls.filter((c) => c[1] === "write_artifact")).toHaveLength(1);
        const evaluations = h.stores.evaluations.listByGate(w.gateId as never).filter((x) => x.producedBy.kind === "evaluator");
        expect(evaluations).toHaveLength(1);
        expect(evaluations[0]!.evidence.filter((v) => v.kind === "artifact" && v.artifactId === artifactId)).toHaveLength(1);
        expect(h.runners.single.settleGate(w.nodeId2 as never, w.revisionNumber2!)).toEqual({ kind: "no_change" });
        expect(h.stores.plans.getNode(w.nodeId2 as never).status).toBe("succeeded");
      });
    } finally {
      removeWorld(w);
    }
  });
});
