/**
 * The canonical side-effect approval lifecycle (execution-model §6.4, §7.2,
 * §7.4; invariants 5 runtime-owned retries, 6 no transcript decides, 9
 * canonical objects by id, 20 one Invocation per logical turn).
 */
import { canonicalJson, canonicalToolCall, InvariantViolationError, TOOL_CALL_MEDIA_TYPE, ValidationError, type Decision, type Invocation, approvalSubjectOf } from "@agentique-console/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { openHarness } from "../persistence/test-support.ts";
import { accepted, COMPLETED_RESULT, openRuntimeHarness, propose, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

const CALL = { tool: "shell", input: { command: "rm -rf build", cwd: "/w" } };
const CANONICAL = canonicalToolCall(CALL);
const DIGEST = sha256Hex(CANONICAL);

async function blockOnApproval(h: RuntimeHarness, invocation: Invocation) {
  h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "approval_required") throw new Error(`expected approval_required, got ${outcome.kind}`);
  return outcome;
}

function successorAfter(h: RuntimeHarness, s: ReturnType<typeof seedRuntime>, blocked: Invocation, decision: Decision, outcome: "approve_once" | "deny") {
  const subject = approvalSubjectOf(decision);
  return h.preparation.prepare({
    runId: s.created.run.id,
    planNodeId: s.created.root.id,
    role: "orchestrator",
    purpose: "decision_resolution",
    continuedFromInvocationId: blocked.id,
    patternPosition: { kind: "orchestrator" },
    inputs: [{ kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: blocked.id, attemptId: subject.attemptId, tool: subject.tool, callDigest: subject.callDigest, callArtifactId: subject.callArtifactId, outcome }],
  });
}

// Side-effect approval is exact-digest and at-most-once (invariant 24).
describe("side-effect approval", () => {
  it("atomically records the failed Attempt, the call Artifact, the open Decision, the blocked Invocation, blocked Tasks, and the released reservation", async () => {
    const h = openRuntimeHarness();
    try {
      // A Worker executing one Task on a running coordinator_worker node, so Task blocking is exercised too.
      const s = seedPlanningRuntime(h);
      const plan = accepted(propose(h, s, [{ pattern: "coordinator_worker", coordinator: { agentDefinitionRevisionId: s.worker.id, title: "coordinator" }, worker: { agentDefinitionRevisionId: s.worker.id, title: "build" }, allocation: { costUsd: 6, tokens: 60_000, attempts: 4 } }]));
      const node = plan.graph.nodes[1]!;
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      h.stores.plans.transitionNode(node.id, { to: "running" });
      const task = h.stores.tasks.create({ runId: s.created.run.id, planNodeId: node.id, origin: "orchestrator", subject: "build", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      h.stores.tasks.transition(task.id, { to: "ready" });
      const { invocation } = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "task", continuedFromInvocationId: null, patternPosition: { kind: "worker_task", taskId: task.id } });
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "running", invocationId: invocation.id });
      const seq = h.ctx.journal.lastSeq();
      const outcome = await blockOnApproval(h, invocation);
      // The Attempt: terminal, tool_failure, refused approval_required, detail naming the tool only.
      expect(outcome.attempt).toMatchObject({ status: "failed", failureClass: "tool_failure", failureDetail: { tool: "shell", message: "tool shell requires operator approval", violations: [] }, retryDecision: { permitted: false, reason: "approval_required", notBefore: null } });
      // The Decision: side_effect_approval, operator_required, the two stable options, affecting the node and Task, with the typed subject.
      const decision = outcome.decision;
      expect(decision).toMatchObject({
        kind: "side_effect_approval",
        resolutionPolicy: "operator_required",
        status: "open",
        runId: s.created.run.id,
        requestedBy: { kind: "invocation", invocationId: invocation.id },
        affects: { requirementIds: [], taskIds: [task.id], planNodeIds: [node.id] },
        subject: { kind: "side_effect_approval", tool: "shell", callDigest: DIGEST, runId: s.created.run.id, planNodeId: node.id, invocationId: invocation.id, attemptId: outcome.attempt.id },
      });
      expect(decision.options.map((o) => o.id)).toEqual(["approve_once", "deny"]);
      expect(h.stores.decisions.get(decision.id)).toEqual(decision);
      // The call Artifact holds exactly the canonical bytes; its digest is the subject's digest.
      const artifact = h.stores.artifacts.read(approvalSubjectOf(decision).callArtifactId);
      expect(artifact.artifact).toMatchObject({ mediaType: TOOL_CALL_MEDIA_TYPE, producer: { kind: "runtime", component: "tool_call" }, digest: DIGEST, runId: s.created.run.id });
      expect(new TextDecoder().decode(artifact.bytes)).toBe(CANONICAL);
      // The Invocation: terminal `blocked`, linked to the Decision, reservation released, lease released; its Task blocked on the Decision.
      const blocked = h.stores.invocations.get(invocation.id);
      expect(blocked).toMatchObject({ status: "blocked", blockedByDecisionId: decision.id, waitReason: null, failureReason: null });
      expect(blocked.endedAt).not.toBeNull();
      expect(outcome.settlement).toMatchObject({ kind: "settled", invocation: { status: "blocked" } });
      expect(h.stores.reservations.listByChild({ type: "invocation", id: invocation.id })[0]).toMatchObject({ status: "released", consumed: { attempts: 1 } });
      expect(h.governor.status().activeLeases).toEqual([]);
      expect(h.stores.tasks.get(task.id)).toMatchObject({ status: "blocked", blockReason: { kind: "decision", decisionId: decision.id } });
      expect(h.stores.invocations.listActive(s.created.run.id, "worker")).toEqual([]);
      expect(h.executor.inspectInvocation(invocation.id).next).toEqual({ permitted: false, reason: "invocation_terminal", notBefore: null });
      // One transaction, one Event per change, in finalization order.
      const events = h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type);
      expect(events).toEqual([
        "attempt.created",
        "capacity_lease.granted",
        "attempt.started",
        "invocation.started",
        "artifact.created",
        "usage.recorded",
        "attempt.failed",
        "capacity_lease.released",
        "artifact.created",
        "decision.requested",
        "invocation.blocked",
        "budget_reservation.released",
        "task.blocked",
        "invocation.workspace_released",
      ]);
      expect(h.stores.invocations.get(invocation.id).workspaceCleanup).toBe("released");
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "invocation.blocked" })[0]!.payload).toEqual({ invocationId: invocation.id, decisionId: decision.id });
      // Repeated advancement or finalization creates no second Artifact or Decision.
      expect(await h.executor.advanceInvocation(invocation.id)).toMatchObject({ kind: "not_permitted", reason: "invocation_terminal" });
      expect(await h.executor.executePreparedAttempt(outcome.attempt.id)).toMatchObject({ kind: "finalized", attempt: { id: outcome.attempt.id } });
      expect(h.stores.artifacts.listByRun(s.created.run.id).filter((a) => a.mediaType === TOOL_CALL_MEDIA_TYPE)).toHaveLength(1);
      expect(h.stores.decisions.listByConversation(s.created.run.conversationId).filter((d) => d.kind === "side_effect_approval")).toHaveLength(1);
      expect(h.provider.requests).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("never lets the raw call reach Events, failure details, diagnostics, or manifests; only its digest and Artifact id travel", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      const outcome = await blockOnApproval(h, invocation);
      const journal = canonicalJson(h.ctx.journal.read({ runId: s.created.run.id }));
      for (const forbidden of ["rm -rf build", '"cwd":"/w"', CANONICAL]) expect(journal).not.toContain(forbidden);
      expect(journal).toContain(DIGEST);
      expect(canonicalJson(outcome.attempt)).not.toContain("rm -rf");
      expect(canonicalJson({ ...outcome, decision: outcome.decision })).not.toContain("rm -rf");
      expect(h.diagnostics).toEqual([]);
      // The bytes exist exactly once, in the content-addressed blob the Artifact names.
      expect(h.blobs.has(DIGEST)).toBe(true);
      expect(new TextDecoder().decode(h.blobs.get(DIGEST))).toBe(CANONICAL);
    } finally {
      h.close();
    }
  });

  it("rolls back every approval record and the blob when finalization fails, then completes on the retried finalization", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const prepared = await h.executor.prepareNextAttempt(invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      const seq = h.ctx.journal.lastSeq();
      const blobs = h.blobs.size;
      // The Decision request fails after the call Artifact (and its blob) were written inside the transaction.
      const request = h.stores.decisions.request.bind(h.stores.decisions);
      h.stores.decisions.request = () => {
        throw new Error("decision insert failed");
      };
      await expect(h.executor.executePreparedAttempt(prepared.attempt.id)).rejects.toThrow("decision insert failed");
      h.stores.decisions.request = request;
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.blobs.size).toBe(blobs);
      expect(h.blobs.has(DIGEST)).toBe(false);
      expect(h.stores.artifacts.listByRun(s.created.run.id).filter((a) => a.mediaType === TOOL_CALL_MEDIA_TYPE)).toEqual([]);
      expect(h.stores.decisions.listByConversation(s.created.run.conversationId)).toEqual([]);
      expect(h.stores.invocations.get(invocation.id).status).toBe("running");
      expect(h.stores.invocations.getAttempt(prepared.attempt.id).status).toBe("running");
      // The retried finalization uses the same provider outcome: one Artifact, one Decision, one blob.
      const outcome = await h.executor.advanceInvocation(invocation.id);
      expect(outcome).toMatchObject({ kind: "approval_required", settlement: { invocation: { status: "blocked" } } });
      expect(h.provider.requests).toHaveLength(1);
      expect(h.stores.artifacts.listByRun(s.created.run.id).filter((a) => a.mediaType === TOOL_CALL_MEDIA_TYPE)).toHaveLength(1);
      expect(h.blobs.size).toBe(blobs + 2);
    } finally {
      h.close();
    }
  });

  it("preserves the complete approval subject across reopen, and a blocked Invocation is the terminal predecessor of its successor", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-approval-"));
    const file = path.join(dir, "console.db");
    const first = openRuntimeHarness({ base: openHarness(file) });
    let s!: ReturnType<typeof seedRuntime>;
    let blocked!: Invocation;
    let decision!: Decision;
    try {
      s = seedRuntime(first);
      const { invocation } = startRun(first, s).prepared;
      const outcome = await blockOnApproval(first, invocation);
      decision = outcome.decision;
      blocked = first.stores.invocations.get(invocation.id);
    } finally {
      first.close();
    }
    const reopened = openRuntimeHarness({ base: openHarness(file) });
    try {
      expect(reopened.stores.decisions.get(decision.id)).toEqual(decision);
      expect(reopened.stores.invocations.get(blocked.id)).toEqual(blocked);
      expect(reopened.recovery.recover()).toMatchObject({ interruptedAttemptIds: [], failedInvocationIds: [], retryEligible: [] });
      // The operator resolves; the successor continues from the blocked Invocation with the resolution as typed input.
      reopened.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      const successor = successorAfter(reopened, s, blocked, reopened.stores.decisions.get(decision.id), "approve_once");
      expect(successor.invocation).toMatchObject({ continuedFromInvocationId: blocked.id, purpose: "decision_resolution", status: "pending" });
      const content = successor.manifest.content;
      expect(content.inputs).toEqual([{ kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: blocked.id, attemptId: approvalSubjectOf(decision).attemptId, tool: "shell", callDigest: DIGEST, callArtifactId: approvalSubjectOf(decision).callArtifactId, outcome: "approve_once" }]);
      expect(content.approvedCalls).toEqual([{ decisionId: decision.id, tool: "shell", callDigest: DIGEST }]);
      expect(content.artifacts.some((a) => a.artifactId === approvalSubjectOf(decision).callArtifactId)).toBe(true);
      // Approval widens nothing: the Tool Policy still requires approval for shell; only the exact digest is permitted once.
      expect(content.toolPolicy.shell).toBe("approval_required");
      expect(content.capabilities.tools).toEqual(["read", "shell", "write"]);
      // The provider receives a manifest that renders the grant and an authorization port; the raw call is still absent, and the
      // exact approved call executes once through the port.
      reopened.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const run = await reopened.executor.advanceInvocation(successor.invocation.id);
      expect(run).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
      if (run.kind !== "finalized") throw new Error(run.kind);
      const recorded = reopened.provider.requests[0]!;
      const request = recorded.request;
      expect(recorded.authorizations.map((a) => a.authorization)).toEqual([{ kind: "approved_once", tool: "shell", callDigest: DIGEST, decisionId: decision.id, useId: expect.stringMatching(/^acu_/) }]);
      expect(reopened.stores.approvedToolCallUses.getByDecision(decision.id)).toMatchObject({ invocationId: successor.invocation.id, attemptId: run.attempt.id });
      expect(request.toolPolicy.shell).toBe("approval_required");
      expect(request.input.text).toContain(`- shell ${DIGEST} once, by decision ${decision.id}`);
      expect(request.input.text).not.toContain("rm -rf");
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the successor's resolution input against the canonical Decision, and a denial approves nothing", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      const { decision } = await blockOnApproval(h, invocation);
      const blocked = h.stores.invocations.get(invocation.id);
      // Unresolved, wrong outcome, wrong digest, wrong predecessor: each fails preparation transactionally.
      expect(() => successorAfter(h, s, blocked, decision, "approve_once")).toThrow(ValidationError);
      h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "deny", rationale: "not in CI", artifactIds: [] });
      const resolved = h.stores.decisions.get(decision.id);
      expect(() => successorAfter(h, s, blocked, resolved, "approve_once")).toThrow(InvariantViolationError);
      expect(() => successorAfter(h, s, blocked, { ...resolved, subject: { ...approvalSubjectOf(resolved), callDigest: "b".repeat(64) } }, "deny")).toThrow(InvariantViolationError);
      expect(h.stores.invocations.listByRun(s.created.run.id)).toHaveLength(1);
      const successor = successorAfter(h, s, blocked, resolved, "deny");
      expect(successor.manifest.content.approvedCalls).toEqual([]);
      expect(successor.manifest.content.inputs[0]).toMatchObject({ kind: "side_effect_approval_resolution", outcome: "deny" });
      expect(successor.manifest.content.toolPolicy.shell).toBe("approval_required");
      // The blocked predecessor is the latest Orchestrator Invocation; a successor that skips it is refused.
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: s.created.root.id, role: "orchestrator", purpose: "node_result", continuedFromInvocationId: null, patternPosition: { kind: "orchestrator" } })).toThrow(/records continuedFromInvocationId/);
    } finally {
      h.close();
    }
  });

  it("keeps a non-approval tool failure on the normal retry policy and refuses an over-bound call as a tool failure", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      h.provider.script({ kind: "tool_failure", tool: "shell", message: "exit 1" }, { kind: "tool_calls", calls: [{ tool: "shell", input: { command: "x".repeat(70_000) } }], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const first = await h.executor.advanceInvocation(invocation.id);
      expect(first).toMatchObject({ kind: "finalized", attempt: { failureClass: "tool_failure", retryDecision: { permitted: true, reason: "tool_failure" } }, settlement: { kind: "retry_pending" } });
      expect(h.stores.decisions.listByConversation(s.created.run.conversationId)).toEqual([]);
      // A proposed call beyond the canonical bound is never truncated into an approval subject; it is a tool failure (here the second, so no retry).
      const second = await h.executor.advanceInvocation(invocation.id);
      expect(second).toMatchObject({ kind: "finalized", attempt: { failureClass: "tool_failure", failureDetail: { tool: "shell" }, retryDecision: { permitted: false, reason: "tool_failure_retried" } }, settlement: { invocation: { status: "failed", failureReason: "attempts_exhausted" } } });
      expect(h.stores.decisions.listByConversation(s.created.run.conversationId)).toEqual([]);
      expect(h.stores.artifacts.listByRun(s.created.run.id).filter((a) => a.mediaType === TOOL_CALL_MEDIA_TYPE)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("refuses at the store and the database a blocked transition without an open approval of that Invocation", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      h.stores.invocations.transition(invocation.id, { to: "running" });
      expect(() => h.stores.invocations.transition(invocation.id, { to: "blocked", decisionId: "dec_000000000000000000000000" })).toThrow(/not found/);
      const request = { conversationId: s.created.run.conversationId, runId: s.created.run.id, kind: "operator_choice" as const, resolutionPolicy: "operator_required" as const, requestedBy: { kind: "operator" as const }, question: "q", options: [{ id: "a", label: "A", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null };
      const unrelated = h.stores.decisions.request(request);
      expect(() => h.stores.invocations.transition(invocation.id, { to: "blocked", decisionId: unrelated.id })).toThrow(InvariantViolationError);
      expect(() => h.database.sqlite.prepare("UPDATE invocations SET status = 'blocked', ended_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(invocation.id)).toThrow(/invocations_blocked_has_decision|a blocked invocation names the open decision/);
      // A side_effect_approval subject must name a real call Artifact with the digest it claims, and the database refuses the kind without a subject.
      expect(() =>
        h.stores.decisions.request({ ...request, kind: "side_effect_approval", options: [{ id: "approve_once", label: "A", description: null }, { id: "deny", label: "D", description: null }], subject: { kind: "side_effect_approval", tool: "shell", callDigest: DIGEST, callArtifactId: "art_000000000000000000000000", runId: s.created.run.id, planNodeId: s.created.root.id, invocationId: invocation.id, attemptId: "att_000000000000000000000000" } }),
      ).toThrow(/not found/);
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET kind = 'side_effect_approval' WHERE id = ?").run(unrelated.id)).toThrow(/immutable|decisions_subject_shape/);
      expect(h.stores.invocations.get(invocation.id).status).toBe("running");
    } finally {
      h.close();
    }
  });
});
