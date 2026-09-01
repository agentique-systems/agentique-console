/**
 * Mutation replay across approval continuations (execution-model §6.4): a
 * logical turn is an Invocation plus the approval successors the canonical
 * runners prepare for it once its intercepted call's `side_effect_approval`
 * resolves — for the root Orchestrator that successor is the
 * `decision_resolution` turn (a `gate_result` turn continues as itself), for
 * a Worker or Coordinator the same purpose. Across that chain an identical
 * `write_artifact` or `request_completion` replays its committed row and
 * creates no second Artifact, Event, or call row; the turn's 32-call and
 * 1 MiB write quotas count every link and a replay consumes neither; and a
 * link the persisted facts do not corroborate — a completed predecessor, an
 * agent-requested Decision boundary, a successor without the resolution in
 * its manifest — continues nothing. Replay identity is never content
 * visibility: a replayed Artifact id reads nothing without canonical routing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_CALL_MEDIA_TYPE, WRITE_ARTIFACT_BOUNDS, type Invocation, type InvocationId, type PlanNodeId, type RunId, type RuntimeToolCallOutcome } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness } from "../persistence/test-support.ts";
import { REQUEST_COMPLETION } from "./completion-test-support.ts";
import { coordinatorNode, finishRoot, portFor, proposal, propose, seedApprovalCoordinator, turnsOf, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { APPROVAL_CALL, blockOnApproval, readArtifact, readResult, rejectionCodes, stepUntil, writeArtifact, writtenArtifact } from "./data-access-test-support.ts";
import { choice, rootPort, workerPort } from "./decision-test-support.ts";
import { gateEvaluatorStep, gatesOf, orchestratorStep, remediationOf, rootTurnsOf, scriptByRole, seedCriteria, singleExpression, workerStep } from "./gate-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, planNodes, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const ROOMY = { costUsd: 12, tokens: 120_000, attempts: 12 };
const SECOND_CALL = { tool: "shell", input: { command: "npm publish" } };
const A = writeArtifact({ title: "A", content: "first bytes" });
const B = writeArtifact({ title: "B", content: "second bytes" });

/** The replayed-or-not view of one recorded outcome. */
const view = (o: RuntimeToolCallOutcome) => (o.kind === "accepted" ? { tool: o.tool, replayed: o.replayed, id: o.result.tool === "write_artifact" ? o.result.artifactId : o.result.tool === "request_completion" ? o.result.completionRequestId : o.callId } : { kind: o.kind });

/** Every accepted mutating call row of a node, as [invocation, tool]. */
const rows = (h: RuntimeHarness, nodeId: PlanNodeId) => h.stores.runtimeToolCalls.listByPlanNode(nodeId).map((c) => [c.invocationId, c.tool]);

const written = (h: RuntimeHarness, runId: RunId) => h.stores.artifacts.listByRun(runId).filter((a) => a.producer.kind === "invocation");

/** Resolves the approval, lets the scheduler prepare the canonical successor, and binds a port to its first Attempt. */
async function continued(h: RuntimeHarness, runId: RunId, blocked: Invocation, outcome: "approve_once" | "deny") {
  h.stores.decisions.resolve(blocked.blockedByDecisionId!, { resolvedBy: "operator", chosenOptionId: outcome, rationale: null, artifactIds: [] });
  await stepUntil(h, runId, () => h.stores.invocations.listByRun(runId).some((i) => i.continuedFromInvocationId === blocked.id));
  const successor = h.stores.invocations.listByRun(runId).find((i) => i.continuedFromInvocationId === blocked.id)!;
  const prepared = await h.executor.prepareNextAttempt(successor.id);
  if (prepared.kind !== "prepared") throw new Error(`successor not prepared: ${prepared.kind}`);
  return { invocation: prepared.invocation, attempt: prepared.attempt, port: portFor(h, prepared.invocation, prepared.attempt) };
}

describe("approval replay identity", () => {
  it("root: an ordinary turn's approval successor (purpose decision_resolution, prepared by the root runner) replays write_artifact and request_completion; a second link replays both; provider retries replay too; nothing is created twice", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const rootId = s.created.root.id;
      // Attempt 1 writes A and requests completion, then fails transiently; Attempt 2 of the same turn replays both, then blocks on approval.
      h.provider.script(
        { kind: "runtime_tool_calls", calls: [A, REQUEST_COMPLETION], then: { kind: "transient_error", message: "hiccup" } },
        { kind: "runtime_tool_calls", calls: [A, REQUEST_COMPLETION], then: { kind: "tool_calls", calls: [APPROVAL_CALL], then: { kind: "succeed", result: COMPLETED_RESULT } } },
      );
      await h.executor.advanceInvocation(s.invocation.id);
      h.clock.set(h.stores.invocations.listAttempts(s.invocation.id).at(-1)!.retryDecision!.notBefore!);
      const blockedOutcome = await h.executor.advanceInvocation(s.invocation.id);
      expect(blockedOutcome.kind).toBe("approval_required");
      const first = h.provider.requests[0]!.runtimeToolCalls.map((c) => c.outcome);
      const retry = h.provider.requests[1]!.runtimeToolCalls.map((c) => c.outcome);
      const a = writtenArtifact(first[0]!);
      expect(view(first[1]!)).toMatchObject({ tool: "request_completion", replayed: false });
      expect(retry.map(view)).toEqual([{ tool: "write_artifact", replayed: true, id: a.artifactId }, { tool: "request_completion", replayed: true, id: view(first[1]!).id }]);
      const blocked = h.stores.invocations.get(s.invocation.id);
      expect(blocked).toMatchObject({ status: "blocked", purpose: "operator_input" });
      // The operator approves; the root runner's settlement prepares the decision_resolution successor; it replays A and the request.
      const second = await continued(h, runId, blocked, "approve_once");
      expect(second.invocation).toMatchObject({ purpose: "decision_resolution", continuedFromInvocationId: blocked.id, role: "orchestrator" });
      const seq = h.ctx.journal.lastSeq();
      expect(view(await second.port.call(A))).toEqual({ tool: "write_artifact", replayed: true, id: a.artifactId });
      expect(view(await second.port.call(REQUEST_COMPLETION))).toEqual({ tool: "request_completion", replayed: true, id: view(first[1]!).id });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.completionRequests.listByRun(runId)).toHaveLength(1);
      // Replay is not a content grant: A is unreadable to the successor; the resolved call's Artifact is (its manifest lists it).
      expect(rejectionCodes(await second.port.call(readArtifact({ artifactId: a.artifactId })))).toEqual(["artifact_not_readable"]);
      const callArtifact = h.stores.artifacts.listByRun(runId).find((x) => x.mediaType === TOOL_CALL_MEDIA_TYPE)!;
      expect(readResult(await second.port.call(readArtifact({ artifactId: callArtifact.id })), "read_artifact").artifactId).toBe(callArtifact.id);
      // The successor writes B, then blocks on a different call: the second link replays A and B, creating nothing.
      const b = writtenArtifact(await second.port.call(B));
      expect(b.replayed).toBe(false);
      await blockOnApproval(h, second.attempt.id, [], SECOND_CALL);
      const third = await continued(h, runId, h.stores.invocations.get(second.invocation.id), "approve_once");
      expect(third.invocation).toMatchObject({ purpose: "decision_resolution", continuedFromInvocationId: second.invocation.id });
      const before = h.ctx.journal.lastSeq();
      expect(view(await third.port.call(A))).toEqual({ tool: "write_artifact", replayed: true, id: a.artifactId });
      expect(view(await third.port.call(B))).toEqual({ tool: "write_artifact", replayed: true, id: b.artifactId });
      expect(view(await third.port.call(REQUEST_COMPLETION))).toMatchObject({ tool: "request_completion", replayed: true });
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(rejectionCodes(await third.port.call(readArtifact({ artifactId: b.artifactId })))).toEqual(["artifact_not_readable"]);
      // Exactly two written Artifacts, one Completion Request, three accepted rows (A and the request under the first turn, B under the second).
      expect(written(h, runId).map((x) => x.id).sort()).toEqual([a.artifactId, b.artifactId].sort());
      expect(rows(h, rootId)).toEqual([[blocked.id, "write_artifact"], [blocked.id, "request_completion"], [second.invocation.id, "write_artifact"]]);
      expect(h.ctx.journal.read({ runId, type: "runtime_tool_call.committed" })).toHaveLength(3);
    } finally {
      h.close();
    }
  });

  it("root: a gate_result remediation turn continues as gate_result and replays its write; a denied approval continues the same turn too", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const criteria = seedCriteria(h, s, { deterministic: 1, evaluated: 1 });
      const { nodes } = planNodes(h, s, [singleExpression(s, "A", { gate: criteria.all })]);
      const node = nodes[0]!;
      await finishRoot(h, s);
      scriptByRole(h, { worker: [workerStep(h, "a")], evaluator: [gateEvaluatorStep(h, "fail", { criteria: Object.fromEntries(criteria.evaluated.map((id) => [id, "fail" as const])) })] });
      await stepUntil(h, runId, () => rootTurnsOf(h, runId).length === 2);
      const remediation = rootTurnsOf(h, runId)[1]!;
      expect(remediation.purpose).toBe("gate_result");
      const task = remediationOf(h, gatesOf(h, node.id)[0]!.id)!;
      // The gate_result turn writes A, then proposes a shell call: blocked; the operator denies; the successor keeps the purpose and replays A.
      scriptByRole(h, { orchestrator: [{ kind: "runtime_tool_calls", calls: [A], then: { kind: "tool_calls", calls: [APPROVAL_CALL], then: orchestratorStep(h) } }] });
      await stepUntil(h, runId, () => h.stores.invocations.get(remediation.id).status === "blocked");
      const a = writtenArtifact(h.provider.runtimeToolCalls.at(-1)!.outcome);
      const successor = await continued(h, runId, h.stores.invocations.get(remediation.id), "deny");
      expect(successor.invocation).toMatchObject({ purpose: "gate_result", continuedFromInvocationId: remediation.id });
      expect(h.stores.invocations.getManifest(successor.invocation.id).content.inputs.map((i) => i.kind)).toEqual(["gate_result", "side_effect_approval_resolution"]);
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "running", invocationId: successor.invocation.id });
      expect(view(await successor.port.call(A))).toEqual({ tool: "write_artifact", replayed: true, id: a.artifactId });
      expect(writtenArtifact(await successor.port.call(B)).replayed).toBe(false);
      const turnIds = new Set([remediation.id, successor.invocation.id]);
      expect(written(h, runId).filter((x) => x.producer.kind === "invocation" && turnIds.has(x.producer.invocationId)).map((x) => x.title).sort()).toEqual(["A", "B"]);
    } finally {
      h.close();
    }
  });

  it("Worker and Coordinator approval continuations, prepared by their Pattern runners, replay the predecessor's write", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const w = await workerPort(h, s, { allocation: ROOMY });
      await finishRoot(h, s);
      const { recorded } = await blockOnApproval(h, w.attempt.id, [A]);
      const a = writtenArtifact(recorded[0]!.outcome);
      const successor = await continued(h, runId, h.stores.invocations.get(w.invocation.id), "approve_once");
      expect(successor.invocation).toMatchObject({ role: "worker", purpose: "step", planNodeId: w.node.id, continuedFromInvocationId: w.invocation.id });
      expect(view(await successor.port.call(A))).toEqual({ tool: "write_artifact", replayed: true, id: a.artifactId });
      expect(rejectionCodes(await successor.port.call(readArtifact({ artifactId: a.artifactId })))).toEqual(["artifact_not_readable"]);
      expect(rows(h, w.node.id)).toEqual([[w.invocation.id, "write_artifact"]]);
    } finally {
      h.close();
    }
    const g = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(g);
      const runId = s.created.run.id;
      const coordinator = seedApprovalCoordinator(g);
      const { node, leafIds } = coordinatorNode(g, s, { coordinator: coordinator.id });
      await finishRoot(g, s);
      const WRITE = { tool: "write", input: { path: "notes.md", content: "plan" } };
      const batch = propose([proposal({ key: "a", requirementIds: [leafIds[0]!] })]);
      // The decompose writes A and accepts its proposal, then blocks; the runner's successor replays both and continues.
      g.provider.script({ kind: "runtime_tool_calls", calls: [A, batch], then: { kind: "tool_calls", calls: [WRITE], then: { kind: "succeed", result: COMPLETED_RESULT } } });
      await stepUntil(g, runId, () => turnsOf(g, node)[0]?.status === "blocked");
      const decompose = turnsOf(g, node)[0]!;
      const a = writtenArtifact(g.provider.requests.at(-1)!.runtimeToolCalls[0]!.outcome);
      g.stores.decisions.resolve(decompose.blockedByDecisionId!, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      g.provider.script({ kind: "runtime_tool_calls", calls: [A, batch], then: { kind: "tool_calls", calls: [WRITE], then: { kind: "succeed", result: COMPLETED_RESULT } } });
      await stepUntil(g, runId, () => turnsOf(g, node).length === 2 && turnsOf(g, node)[1]!.status === "succeeded");
      const successor = turnsOf(g, node)[1]!;
      expect(successor).toMatchObject({ purpose: "decompose", continuedFromInvocationId: decompose.id });
      const replays = g.provider.requests.find((r) => r.attemptId === g.stores.invocations.listAttempts(successor.id)[0]!.id)!.runtimeToolCalls.map((c) => view(c.outcome));
      expect(replays).toEqual([{ tool: "write_artifact", replayed: true, id: a.artifactId }, { tool: "propose_tasks", replayed: true, id: g.stores.runtimeToolCalls.listByInvocation(decompose.id).find((c) => c.tool === "propose_tasks")!.id }]);
      expect(rows(g, node.id)).toEqual([[decompose.id, "write_artifact"], [decompose.id, "propose_tasks"]]);
      expect(written(g, runId)).toHaveLength(1);
    } finally {
      g.close();
    }
  });

  it("reopen before replay: the approval resolved and continued in a fresh process replays the predecessor's write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-approval-replay-"));
    const file = path.join(dir, "console.db");
    const blobs = openHarness(file).blobs;
    let runId!: RunId;
    let blockedId!: InvocationId;
    let artifactId!: string;
    const first = openRuntimeHarness({ base: openHarness(file, { blobs }), governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(first);
      runId = s.created.run.id;
      h1: {
        first.provider.script({ kind: "runtime_tool_calls", calls: [A], then: { kind: "tool_calls", calls: [APPROVAL_CALL], then: { kind: "succeed", result: COMPLETED_RESULT } } });
        const outcome = await first.executor.advanceInvocation(s.invocation.id);
        expect(outcome.kind).toBe("approval_required");
        artifactId = writtenArtifact(first.provider.runtimeToolCalls[0]!.outcome).artifactId;
        blockedId = s.invocation.id;
        break h1;
      }
    } finally {
      first.close();
    }
    const again = openRuntimeHarness({ base: openHarness(file, { blobs }), governor: WIDE_GOVERNOR });
    try {
      again.recovery.recover();
      const successor = await continued(again, runId, again.stores.invocations.get(blockedId), "approve_once");
      expect(successor.invocation.purpose).toBe("decision_resolution");
      expect(view(await successor.port.call(A))).toEqual({ tool: "write_artifact", replayed: true, id: artifactId });
      expect(written(again, runId)).toHaveLength(1);
    } finally {
      again.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not carry replay across a completed turn, an agent-requested Decision boundary, or a successor whose manifest lacks the approval resolution", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const rootId = s.created.root.id;
      // (1) A completed turn: the next ordinary root turn continues from it and writes A afresh.
      const root = await rootPort(h, s);
      const a1 = writtenArtifact(await root.port.call(A));
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(root.attempt.id);
      const next = h.preparation.prepare({ runId, planNodeId: rootId, role: "orchestrator", purpose: "operator_input", continuedFromInvocationId: root.invocation.id, patternPosition: { kind: "orchestrator" } });
      const prepared = await h.executor.prepareNextAttempt(next.invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const nextPort = portFor(h, prepared.invocation, prepared.attempt);
      const a2 = writtenArtifact(await nextPort.call(A));
      expect(a2).toMatchObject({ replayed: false });
      expect(a2.artifactId).not.toBe(a1.artifactId);
      // (2) An agent-requested Decision ends the turn: its successor (prepared by the scheduler) writes A afresh again.
      const asked = await nextPort.call(choice());
      if (asked.kind !== "accepted" || asked.result.tool !== "request_decision") throw new Error("request not accepted");
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(prepared.attempt.id);
      h.decisionRequests.resolve({ decisionId: asked.result.decisionId, optionId: "fastify" });
      await stepUntil(h, runId, () => h.stores.invocations.listByRun(runId).some((i) => i.continuedFromInvocationId === next.invocation.id));
      const after = h.stores.invocations.listByRun(runId).find((i) => i.continuedFromInvocationId === next.invocation.id)!;
      const afterPrepared = await h.executor.prepareNextAttempt(after.id);
      if (afterPrepared.kind !== "prepared") throw new Error(afterPrepared.kind);
      const a3 = writtenArtifact(await portFor(h, afterPrepared.invocation, afterPrepared.attempt).call(A));
      expect(a3.replayed).toBe(false);
      expect(new Set([a1.artifactId, a2.artifactId, a3.artifactId]).size).toBe(3);
      // (3) A successor prepared without the resolution input (a malformed continuation) inherits nothing from a blocked predecessor.
      const blocked = await blockOnApproval(h, afterPrepared.attempt.id, [B]);
      const b = writtenArtifact(blocked.recorded[0]!.outcome);
      h.stores.decisions.resolve(blocked.decision.id, { resolvedBy: "operator", chosenOptionId: "deny", rationale: null, artifactIds: [] });
      const malformed = h.preparation.prepare({ runId, planNodeId: rootId, role: "orchestrator", purpose: "decision_resolution", continuedFromInvocationId: after.id, patternPosition: { kind: "orchestrator" }, inputs: [] });
      const malformedPrepared = await h.executor.prepareNextAttempt(malformed.invocation.id);
      if (malformedPrepared.kind !== "prepared") throw new Error(malformedPrepared.kind);
      const b2 = writtenArtifact(await portFor(h, malformedPrepared.invocation, malformedPrepared.attempt).call(B));
      expect(b2.replayed).toBe(false);
      expect(b2.artifactId).not.toBe(b.artifactId);
    } finally {
      h.close();
    }
  });

  it("quotas span the approval replay turn: 32 accepted writes and 1 MiB of decoded bytes count every link, replays consume nothing, and the root purpose change resets nothing", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const root = await rootPort(h, s);
      // 11 distinct 48 KiB chunks before the block: 540,672 bytes, 11 calls.
      const chunk = (i: number) => writeArtifact({ title: `chunk ${i}`, encoding: "base64", content: Buffer.alloc(WRITE_ARTIFACT_BOUNDS.maxContentBytes, i + 1).toString("base64") });
      for (let i = 0; i < 11; i += 1) expect(writtenArtifact(await root.port.call(chunk(i))).replayed).toBe(false);
      await blockOnApproval(h, root.attempt.id, []);
      const second = await continued(h, runId, h.stores.invocations.get(root.invocation.id), "approve_once");
      expect(second.invocation.purpose).toBe("decision_resolution");
      // The successor: 10 more chunks reach 1,032,192 bytes; a 16 KiB write fills exactly 1 MiB; one more byte is refused; a replay still serves.
      for (let i = 11; i < 21; i += 1) expect(writtenArtifact(await second.port.call(chunk(i))).replayed).toBe(false);
      expect(writtenArtifact(await second.port.call(writeArtifact({ title: "filler", encoding: "base64", content: Buffer.alloc(16_384, 200).toString("base64") }))).byteSize).toBe(16_384);
      expect(rejectionCodes(await second.port.call(writeArtifact({ title: "one more byte", content: "x" })))).toEqual(["artifact_bytes_exceeded"]);
      expect(writtenArtifact(await second.port.call(chunk(0))).replayed).toBe(true);
      // The call count: 22 accepted so far across both links; 10 zero-byte writes reach 32; the 33rd distinct call is refused; a replay still serves.
      for (let i = 0; i < 10; i += 1) expect(writtenArtifact(await second.port.call(writeArtifact({ title: `tiny ${i}`, content: "" }))).byteSize).toBe(0);
      expect(rejectionCodes(await second.port.call(writeArtifact({ title: "beyond", content: "" })))).toEqual(["artifact_count_exceeded"]);
      expect(writtenArtifact(await second.port.call(chunk(5))).replayed).toBe(true);
      expect(writtenArtifact(await second.port.call(writeArtifact({ title: "tiny 3", content: "" }))).replayed).toBe(true);
      // A second approval link inherits the exhausted bounds: nothing new, every replay served.
      await blockOnApproval(h, second.attempt.id, [], SECOND_CALL);
      const third = await continued(h, runId, h.stores.invocations.get(second.invocation.id), "approve_once");
      expect(rejectionCodes(await third.port.call(writeArtifact({ title: "still beyond", content: "" })))).toEqual(["artifact_count_exceeded"]);
      expect(writtenArtifact(await third.port.call(chunk(15))).replayed).toBe(true);
      expect(written(h, runId)).toHaveLength(32);
      expect(h.stores.runtimeToolCalls.listByPlanNode(s.created.root.id).filter((c) => c.tool === "write_artifact").map((c) => c.invocationId)).toEqual([...Array<string>(11).fill(root.invocation.id), ...Array<string>(21).fill(second.invocation.id)]);
    } finally {
      h.close();
    }
  });
});
