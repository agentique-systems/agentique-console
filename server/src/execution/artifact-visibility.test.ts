/**
 * `read_artifact` authorization (execution-model §6.4): replay identity and
 * Artifact-content visibility are different rules. A logical turn replays
 * its accepted mutations across approval successors; content is readable
 * only through the caller's immutable manifest or by the exact current
 * Invocation that created the Artifact through an accepted `write_artifact`
 * call (any Attempt of it). A predecessor's or successor's production, a
 * runtime-created Artifact that merely names an Invocation, a transcript, a
 * captured call, another Worker's output, a foreign Run's Artifact, and an
 * id learned from a replayed result or a Decision subject are all refused —
 * before any byte is loaded — unless canonical routing listed them.
 */
import { TRANSCRIPT_MEDIA_TYPE, type ArtifactId } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { portFor, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import {
  APPROVAL_CALL,
  approvalSuccessor,
  blockOnApproval,
  readArtifact,
  readDecisions,
  readResult,
  rejectionCodes,
  retriedAttempt,
  seedForeignRun,
  stepUntil,
  writeArtifact,
  writtenArtifact,
} from "./data-access-test-support.ts";
import { choice, rootPort, workerPort } from "./decision-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime, seedReadOnlyWorker, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

const ROOMY = { costUsd: 12, tokens: 120_000, attempts: 12 };

/** Counts every byte load of the harness blob store: a refused read must never reach it. */
function contentLoads(h: RuntimeHarness) {
  const spy = vi.spyOn(h.blobs, "get");
  return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() };
}

describe("read_artifact visibility versus replay identity", () => {
  it("1–2: the exact current Invocation reads its accepted write in the same Attempt and in a retried Attempt — never a transcript of its own earlier Attempt", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const w = await workerPort(h, s, { allocation: ROOMY });
      const written = writtenArtifact(await w.port.call(writeArtifact({ title: "mine", content: "written by this Invocation" })));
      expect(readResult(await w.port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact").content).toBe("written by this Invocation");
      // The Attempt fails transiently; the same Invocation's retried Attempt reads the same Artifact (canonical producer rows, not process memory).
      h.provider.script({ kind: "transient_error", message: "provider hiccup" });
      const failed = await h.executor.executePreparedAttempt(w.attempt.id);
      expect(failed).toMatchObject({ kind: "finalized", attempt: { status: "failed" } });
      const retry = await retriedAttempt(h, w.invocation);
      expect(retry.attempt.number).toBe(2);
      expect(readResult(await retry.port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact")).toMatchObject({ content: "written by this Invocation", digest: written.digest });
      // The first Attempt's transcript is a runtime-created Artifact of this Run naming no write call: unreadable, refused before any byte loads.
      const transcript = h.stores.artifacts.listByRun(s.created.run.id).find((a) => a.mediaType === TRANSCRIPT_MEDIA_TYPE);
      expect(transcript).toBeDefined();
      const loads = contentLoads(h);
      expect(rejectionCodes(await retry.port.call(readArtifact({ artifactId: transcript!.id })))).toEqual(["artifact_not_readable"]);
      expect(loads.count()).toBe(0);
      loads.restore();
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });

  it("3: an agent-requested Decision ends the logical turn; the successor is a new turn that reads nothing its predecessor produced", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const root = await rootPort(h, s);
      const written = writtenArtifact(await root.port.call(writeArtifact({ title: "before the question", content: "predecessor bytes" })));
      const asked = await root.port.call(choice());
      if (asked.kind !== "accepted" || asked.result.tool !== "request_decision") throw new Error("request not accepted");
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(root.attempt.id);
      h.decisionRequests.resolve({ decisionId: asked.result.decisionId, optionId: "fastify" });
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      const successor = h.stores.invocations.listByRun(runId).find((i) => i.continuedFromInvocationId === root.invocation.id);
      if (!successor) throw new Error("no successor was prepared");
      const prepared = await h.executor.prepareNextAttempt(successor.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const port = portFor(h, prepared.invocation, prepared.attempt);
      const loads = contentLoads(h);
      expect(rejectionCodes(await port.call(readArtifact({ artifactId: written.artifactId })))).toEqual(["artifact_not_readable"]);
      expect(loads.count()).toBe(0);
      loads.restore();
      // The successor's own write is readable by it alone.
      const own = writtenArtifact(await port.call(writeArtifact({ title: "after the answer", content: "successor bytes" })));
      expect(own.replayed).toBe(false);
      expect(readResult(await port.call(readArtifact({ artifactId: own.artifactId })), "read_artifact").content).toBe("successor bytes");
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });

  it("4–5: an approval successor replays its predecessor's write (the same Artifact id, replay accounting intact) but cannot read it; a second approval link inherits neither; each link reads only what it created itself", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const w = await workerPort(h, s, { allocation: ROOMY });
      // Link 1 writes A, then blocks on an approval-required call.
      const first = await blockOnApproval(h, w.attempt.id, [writeArtifact({ title: "A", content: "link one" })]);
      const a = writtenArtifact(first.recorded[0]!.outcome);
      // Link 2: the same logical turn (execution-model §6.4) — its identical call replays A's id without a second Artifact ...
      const second = await approvalSuccessor(h, h.stores.invocations.get(w.invocation.id), first.decision.id, "deny");
      expect(second.invocation.continuedFromInvocationId).toBe(w.invocation.id);
      const replay = writtenArtifact(await second.port.call(writeArtifact({ title: "A", content: "link one" })));
      expect(replay).toMatchObject({ artifactId: a.artifactId, replayed: true });
      expect(h.stores.artifacts.listByRun(runId).filter((x) => x.digest === a.digest)).toHaveLength(1);
      // ... yet the replayed result is not a content grant: A's producer is the predecessor Invocation, and nothing routed A to link 2.
      const loads = contentLoads(h);
      expect(rejectionCodes(await second.port.call(readArtifact({ artifactId: a.artifactId })))).toEqual(["artifact_not_readable"]);
      expect(loads.count()).toBe(0);
      loads.restore();
      // The approval's call Artifact reached link 2 through the one existing explicit route: the manifest lists the resolution's call Artifact.
      expect(h.stores.invocations.getManifest(second.invocation.id).content.artifacts.map((x) => x.artifactId)).toEqual([second.subject.callArtifactId]);
      expect(readResult(await second.port.call(readArtifact({ artifactId: second.subject.callArtifactId })), "read_artifact").mediaType).toBe("application/x-tool-call+json");
      // Link 2 writes B and reads it; then it blocks again on a different call (a new Decision, a new call Artifact).
      const b = writtenArtifact(await second.port.call(writeArtifact({ title: "B", content: "link two" })));
      expect(readResult(await second.port.call(readArtifact({ artifactId: b.artifactId })), "read_artifact").content).toBe("link two");
      const again = await blockOnApproval(h, second.attempt.id, [], { tool: "shell", input: { command: "npm publish" } });
      expect(again.decision.id).not.toBe(first.decision.id);
      // Link 3: replays both A and B by digest (write accounting counts them once), reads neither, reads its own C.
      const third = await approvalSuccessor(h, h.stores.invocations.get(second.invocation.id), again.decision.id, "deny");
      expect(writtenArtifact(await third.port.call(writeArtifact({ title: "A", content: "link one" })))).toMatchObject({ artifactId: a.artifactId, replayed: true });
      expect(writtenArtifact(await third.port.call(writeArtifact({ title: "B", content: "link two" })))).toMatchObject({ artifactId: b.artifactId, replayed: true });
      const loads3 = contentLoads(h);
      expect(rejectionCodes(await third.port.call(readArtifact({ artifactId: a.artifactId })))).toEqual(["artifact_not_readable"]);
      expect(rejectionCodes(await third.port.call(readArtifact({ artifactId: b.artifactId })))).toEqual(["artifact_not_readable"]);
      expect(loads3.count()).toBe(0);
      loads3.restore();
      const c = writtenArtifact(await third.port.call(writeArtifact({ title: "C", content: "link three" })));
      expect(c.replayed).toBe(false);
      expect(readResult(await third.port.call(readArtifact({ artifactId: c.artifactId })), "read_artifact").content).toBe("link three");
      // Exactly three Artifacts and three accepted write rows exist for the whole turn: replay duplicated nothing.
      const rows = [w.invocation.id, second.invocation.id, third.invocation.id].flatMap((id) => h.stores.runtimeToolCalls.listByInvocation(id).filter((x) => x.tool === "write_artifact"));
      expect(rows.map((x) => x.invocationId)).toEqual([w.invocation.id, second.invocation.id, third.invocation.id]);
      expect(h.stores.artifacts.listByRun(runId).filter((x) => x.producer.kind === "invocation")).toHaveLength(3);
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });

  it("6: a predecessor's output becomes readable through an explicit canonical route — a chain step's returned Artifact travels by Handoff into the next step's manifest", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const reader = seedReadOnlyWorker(h);
      const started = startRun(h, s);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const outcome = await h.planRevisions.propose({
        runId,
        proposedByInvocationId: started.prepared.invocation.id,
        source: { version: 1, expressions: [{ pattern: "chain", steps: [{ pattern: "single", operation: { agentDefinitionRevisionId: reader.id, title: "produce" } }, { pattern: "single", operation: { agentDefinitionRevisionId: reader.id, title: "consume" } }], allocation: { costUsd: 8, tokens: 80_000, attempts: 6 } }] },
        correlationId: null,
        causationSeq: null,
      });
      if (!outcome.accepted) throw new Error("plan rejected");
      await h.executor.advanceInvocation(started.prepared.invocation.id);
      let routed: ArtifactId | undefined;
      let unrouted: ArtifactId | undefined;
      // Step 1 writes two Artifacts and returns exactly one of them as its result Artifact.
      h.provider.script({
        kind: "runtime_tool_calls",
        calls: [writeArtifact({ title: "returned", content: "carried forward" }), writeArtifact({ title: "kept back", content: "never returned" })],
        then: {
          kind: "derived",
          step: (request) => {
            const calls = h.stores.runtimeToolCalls.listByInvocation(request.invocationId).filter((c) => c.tool === "write_artifact");
            const ids = calls.map((c) => (c.result.tool === "write_artifact" ? c.result.artifactId : (null as never)));
            routed = ids[0];
            unrouted = ids[1];
            return { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [ids[0]!], summary: "produced" } };
          },
        },
      });
      // Step 2 reads both: the routed one through its manifest, the unrouted one refused.
      h.provider.script({ kind: "derived", step: () => ({ kind: "runtime_tool_calls", calls: [readArtifact({ artifactId: routed! }), readArtifact({ artifactId: unrouted! })], then: { kind: "succeed", result: COMPLETED_RESULT } }) });
      await stepUntil(h, runId, () => h.provider.runtimeToolCalls.filter((c) => c.call.tool === "read_artifact").length === 2);
      const reads = h.provider.runtimeToolCalls.filter((c) => c.call.tool === "read_artifact");
      expect(readResult(reads[0]!.outcome, "read_artifact")).toMatchObject({ artifactId: routed, content: "carried forward", eof: true });
      expect(rejectionCodes(reads[1]!.outcome)).toEqual(["artifact_not_readable"]);
      const consumer = h.stores.invocations.getAttempt(reads[0]!.attemptId).invocationId;
      expect(h.stores.invocations.getManifest(consumer).content.artifacts.map((a) => a.artifactId)).toEqual([routed]);
    } finally {
      h.close();
    }
  });

  it("7–8: another Worker's same-Run output and a same-Invocation Artifact created without an accepted write_artifact record are both unreadable", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const x = await workerPort(h, s, { allocation: ROOMY, title: "x" });
      const y = await workerPort(h, s, { allocation: ROOMY, title: "y" });
      const xs = writtenArtifact(await x.port.call(writeArtifact({ title: "x output", content: "x bytes" })));
      const loads = contentLoads(h);
      expect(rejectionCodes(await y.port.call(readArtifact({ artifactId: xs.artifactId })))).toEqual(["artifact_not_readable"]);
      // An Artifact whose producer names Worker y but that no accepted write_artifact call of y created (a runtime-recorded result output, say).
      const direct = h.stores.artifacts.create({ runId: s.created.run.id, mediaType: "text/plain", producer: { kind: "invocation", invocationId: y.invocation.id, attemptId: y.attempt.id }, taskId: null, title: "not through the tool" }, new TextEncoder().encode("direct"));
      expect(h.stores.runtimeToolCalls.writtenArtifactCall(y.invocation.id, direct.id)).toBeNull();
      expect(rejectionCodes(await y.port.call(readArtifact({ artifactId: direct.id })))).toEqual(["artifact_not_readable"]);
      expect(loads.count()).toBe(0);
      loads.restore();
      // Producer ownership alone is never enough, and a runtime component's Artifact is not "produced" by anyone.
      const runtimeMade = h.stores.artifacts.create({ runId: s.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "runtime" }, new TextEncoder().encode("runtime bytes"));
      expect(rejectionCodes(await y.port.call(readArtifact({ artifactId: runtimeMade.id })))).toEqual(["artifact_not_readable"]);
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });

  it("9–10: a Decision subject's call Artifact id, a transcript, and a foreign Run's Artifact grant nothing — the subject is a safe reference, not a content grant", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const foreign = seedForeignRun(h);
      const w = await workerPort(h, s, { allocation: ROOMY, title: "blocker" });
      const blocked = await blockOnApproval(h, w.attempt.id, [], APPROVAL_CALL);
      const callArtifactId = blocked.decision.subject?.kind === "side_effect_approval" ? blocked.decision.subject.callArtifactId : (null as never);
      // The Orchestrator sees the Decision (its Run's) with its typed subject naming the call Artifact and never the call's bytes.
      const root = await rootPort(h, s);
      const seen = readResult(await root.port.call(readDecisions({ decisionId: blocked.decision.id })), "read_decisions");
      expect(seen.items[0]!.subject).toMatchObject({ kind: "side_effect_approval", tool: "shell", callArtifactId });
      expect(JSON.stringify(seen)).not.toContain("rm -rf build");
      // Naming that Artifact reads nothing: not in the root's manifest, not produced by it through the write tool.
      const loads = contentLoads(h);
      expect(rejectionCodes(await root.port.call(readArtifact({ artifactId: callArtifactId })))).toEqual(["artifact_not_readable"]);
      // A transcript of the blocked Worker's Attempt, and a foreign Run's Artifact: refused without a byte loaded.
      const transcript = h.stores.artifacts.listByRun(s.created.run.id).find((a) => a.mediaType === TRANSCRIPT_MEDIA_TYPE)!;
      expect(rejectionCodes(await root.port.call(readArtifact({ artifactId: transcript.id })))).toEqual(["artifact_not_readable"]);
      expect(rejectionCodes(await root.port.call(readArtifact({ artifactId: foreign.artifact.id })))).toEqual(["artifact_not_readable"]);
      expect(rejectionCodes(await root.port.call(readArtifact({ artifactId: h.ctx.ids("artifact") })))).toEqual(["artifact_not_readable"]);
      expect(loads.count()).toBe(0);
      loads.restore();
    } finally {
      vi.restoreAllMocks();
      h.close();
    }
  });
});
