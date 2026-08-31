/**
 * The executable `request_completion` runtime tool and the completion
 * policy at Run creation (execution-model §6.4, §10; invariant 25): only the
 * root Orchestrator's ordinary turn may call it; an accepted call creates
 * exactly one Completion Request in its own short transaction and a replay
 * (a retry, an approval successor, or a concurrent duplicate) returns the
 * same request; every preflight refusal writes nothing; a coding Run must
 * declare a deterministic completion criterion at creation.
 */
import { runtimeToolsFor, ValidationError, type Invocation, type PatternPlanNode, type RuntimeToolCallRequest } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../persistence/test-support.ts";
import type { FakeStep } from "../provider/fake.ts";
import { CompletionFacts, CompletionRequestService } from "./completion-requests.ts";
import { RuntimeToolExecutor } from "./runtime-tools.ts";
import { COMPLETED_RESULT, fakeSnapshot, openRuntimeHarness, planNodes, seedCompletionCriterion, seedPlanningRuntime, seedReadOnlyWorker, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

const REQUEST: RuntimeToolCallRequest = { tool: "request_completion", input: {} };

/** A root turn that requests completion (once per `calls`) and then completes. */
function requesting(calls = 1, then: FakeStep = { kind: "succeed", result: COMPLETED_RESULT }): FakeStep {
  return { kind: "runtime_tool_calls", calls: Array.from({ length: calls }, () => REQUEST), then };
}

function requestsOf(h: RuntimeHarness, runId: string) {
  return h.stores.completionRequests.listByRun(runId as never);
}

describe("request_completion", () => {
  it("lets the root Orchestrator's running turn request completion: one accepted call, one Completion Request naming the call, the Run still running", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const seq = h.ctx.journal.lastSeq();
      h.provider.script(requesting());
      await h.executor.advanceInvocation(s.invocation.id);
      const [call] = h.provider.runtimeToolCalls;
      expect(call?.outcome).toMatchObject({ kind: "accepted", tool: "request_completion", replayed: false, result: { tool: "request_completion", status: "requested" } });
      if (call?.outcome.kind !== "accepted" || call.outcome.result.tool !== "request_completion") throw new Error("not accepted");
      const request = h.stores.completionRequests.get(call.outcome.result.completionRequestId);
      expect(request).toMatchObject({ runId, invocationId: s.invocation.id, runtimeToolCallId: call.outcome.callId, status: "requested", gateId: null });
      expect(h.stores.runtimeToolCalls.get(call.outcome.callId)).toMatchObject({ tool: "request_completion", invocationId: s.invocation.id, result: { completionRequestId: request.id } });
      expect(h.stores.completionRequests.activeOf(runId)).toEqual(request);
      expect(h.stores.runs.get(runId).status).toBe("running");
      expect(h.stores.invocations.get(s.invocation.id).status).toBe("succeeded");
      const types = h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type);
      expect(types.filter((t) => t.startsWith("completion_request"))).toEqual(["completion_request.created"]);
      expect(types.indexOf("runtime_tool_call.committed")).toBeLessThan(types.indexOf("completion_request.created"));
      // The provider saw the tool as callable and the call is recorded without its input.
      expect(h.provider.requests[0]!.runtimeTools).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "request_completion", "request_decision", "write_artifact"]);
      expect(JSON.stringify(h.ctx.journal.read({ runId, type: "runtime_tool_call.committed" })[0]!.payload)).not.toContain('"input"');
    } finally {
      h.close();
    }
  });

  it("replays a repeated call of the same logical turn — and a concurrent duplicate — as the same Completion Request, creating one row", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      h.provider.script({
        kind: "derived",
        step: (request) => ({
          kind: "runtime_tool_calls",
          calls: [REQUEST],
          then: {
            kind: "derived",
            step: () => {
              // Two calls submitted at once from the same Attempt: the database serializes them and the second replays the first.
              void Promise.all([request.runtimeTools.call(REQUEST), request.runtimeTools.call(REQUEST)]).then((outcomes) => h.provider.runtimeToolCalls.push(...outcomes.map((outcome) => ({ attemptId: request.attemptId, call: REQUEST, outcome }))));
              return { kind: "runtime_tool_calls", calls: [REQUEST], then: { kind: "succeed", result: COMPLETED_RESULT } };
            },
          },
        }),
      });
      await h.executor.advanceInvocation(s.invocation.id);
      const outcomes = h.provider.runtimeToolCalls.map((c) => c.outcome);
      expect(outcomes.length).toBeGreaterThanOrEqual(3);
      const accepted = outcomes.filter((o): o is Extract<typeof o, { kind: "accepted" }> => o.kind === "accepted");
      expect(accepted).toHaveLength(outcomes.length);
      expect(new Set(accepted.map((o) => o.callId)).size).toBe(1);
      expect(accepted.filter((o) => !o.replayed)).toHaveLength(1);
      expect(requestsOf(h, runId)).toHaveLength(1);
      expect(h.stores.runtimeToolCalls.listByInvocation(s.invocation.id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("is not callable by a Worker, a Coordinator, an Evaluator, or a final-synthesis turn, and a non-root caller is refused without a row", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const binding = (role: Invocation["role"], purpose: Invocation["purpose"]) => new RuntimeToolExecutor(h.ctx, h.stores, { runId, planNodeId: s.created.root.id, invocationId: s.invocation.id, attemptId: `att_${"0".repeat(24)}`, role, purpose, manifestTools: runtimeToolsFor(role, purpose) });
      expect(binding("worker", "step").tools).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "request_decision", "write_artifact"]);
      expect(binding("worker", "task").tools).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "request_decision", "write_artifact"]);
      expect(binding("coordinator", "decompose").tools).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "propose_tasks", "update_task", "request_decision", "write_artifact"]);
      expect(binding("evaluator", "evaluate").tools).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "write_artifact"]);
      expect(binding("orchestrator", "final_synthesis").tools).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions"]);
      expect(binding("orchestrator", "operator_input").tools).toEqual(["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions", "request_completion", "request_decision", "write_artifact"]);
      // A non-root caller with the Orchestrator role cannot exist; the handler still refuses it and writes nothing.
      const node = planNodes(h, s, [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "work" } }]).nodes[0] as PatternPlanNode;
      const service = new CompletionRequestService(h.ctx, h.stores);
      const seq = h.ctx.journal.lastSeq();
      expect(service.request({ invocation: { ...s.invocation, status: "running" }, node }, {})).toEqual({ kind: "rejected", reasons: [{ code: "caller_not_permitted", message: "only the root Orchestrator's turn requests completion", path: null }] });
      expect(service.request({ invocation: { ...s.invocation, status: "running", purpose: "final_synthesis" }, node: s.created.root as PatternPlanNode }, {})).toMatchObject({ kind: "rejected", reasons: [{ code: "caller_not_permitted" }] });
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(requestsOf(h, runId)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("refuses transactionally, with the closed reasons and no row, while a current node is unfinished; the preflight names every blocking fact", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      planNodes(h, s, [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "work" } }]);
      const task = h.stores.tasks.create({ runId, planNodeId: null, origin: "orchestrator", subject: "later", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const decision = h.stores.decisions.request({ conversationId: s.created.run.conversationId, runId, kind: "operator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "runtime" }, question: "?", options: [{ id: "a", label: "a", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      const seq = h.ctx.journal.lastSeq();
      h.provider.script(requesting());
      await h.executor.advanceInvocation(s.invocation.id);
      const outcome = h.provider.runtimeToolCalls[0]!.outcome;
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error(outcome.kind);
      expect(outcome.reasons.map((r) => r.code)).toEqual(["node_active", "task_unfinished", "decision_unresolved"]);
      expect(requestsOf(h, runId)).toEqual([]);
      expect(h.stores.runtimeToolCalls.listByInvocation(s.invocation.id)).toEqual([]);
      const written = h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type);
      expect(written.some((t) => t.startsWith("completion_request") || t === "runtime_tool_call.committed")).toBe(false);
      // The facts reader names the same blockers, and clears them as the rows change.
      const facts = new CompletionFacts(h.stores);
      const run = h.stores.runs.get(runId);
      // After the turn its own (empty) Changeset awaits integration too.
      expect(facts.preflight(run, null)).toEqual(["node_active", "changeset_unintegrated", "task_unfinished", "decision_unresolved"]);
      h.stores.tasks.transition(task.id, { to: "cancelled" });
      h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "a", rationale: null, artifactIds: [] });
      expect(facts.preflight(run, null)).toEqual(["node_active", "changeset_unintegrated"]);
    } finally {
      h.close();
    }
  });

  it("refuses an active request, a pending Changeset, an active Invocation, a missing deterministic criterion, and an underfunded final reserve, each by its own code", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const facts = new CompletionFacts(h.stores);
      // The requesting turn itself may be active; any other active Invocation blocks.
      expect(facts.preflight(h.stores.runs.get(runId), s.invocation.id)).toEqual([]);
      expect(facts.preflight(h.stores.runs.get(runId), null)).toEqual(["invocation_active"]);
      // The turn works directly and requests completion: its own Changeset is not yet integrated afterwards.
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("root", s.invocation.id), diff: new TextEncoder().encode("+x"), empty: false };
      h.provider.script(requesting());
      await h.executor.advanceInvocation(s.invocation.id);
      expect(h.provider.runtimeToolCalls[0]!.outcome.kind).toBe("accepted");
      const request = h.stores.completionRequests.activeOf(runId)!;
      expect(facts.preflight(h.stores.runs.get(runId), null)).toEqual(["completion_request_active", "changeset_unintegrated"]);
      expect(facts.preflight(h.stores.runs.get(runId), request.invocationId)).toEqual(["changeset_unintegrated"]);
      // A Run whose only deterministic criterion's Requirement was retired lacks one; a Run without an Evaluator cannot judge an evaluated criterion.
      const t = seedRuntime(h);
      const conversationId = t.created.run.conversationId;
      const other = h.ctx.ids("requirement");
      const revision = h.stores.requirements.createRevision({ conversationId, approvedByDecisionId: null, tree: [{ id: other, parentId: null, composition: null, statement: "Only judged", position: 0, acceptanceCriterionIds: [] }] });
      h.stores.requirements.createAcceptanceCriterion({ conversationId, requirementId: other, requirementRevisionId: revision.id, taskId: null, check: { kind: "evaluated", question: "good?", rubric: null } });
      const run = h.stores.runs.get(t.created.run.id);
      expect(h.stores.requirements.get(t.completion.requirementId).status).toBe("retired");
      expect(facts.criteriaOf(run, facts.pinnedRevision(run)).all).toHaveLength(1);
      // The evaluated criterion now needs the Evaluator, which the reserve (3 Attempts) cannot fund beside the synthesis.
      expect(facts.preflight({ ...run, status: "running" }, null)).toEqual(["no_deterministic_completion_criterion", "final_reserve_insufficient"]);
      const u = seedRuntime(h, { verificationPolicy: { evaluatorAgentDefinitionRevisionId: null }, finalReserve: { costUsd: 0, tokens: 0, attempts: 0 } });
      h.stores.requirements.createAcceptanceCriterion({ conversationId: u.created.run.conversationId, requirementId: u.completion.requirementId, requirementRevisionId: u.completion.revision.id, taskId: null, check: { kind: "evaluated", question: "good?", rubric: null } });
      expect(facts.preflight({ ...h.stores.runs.get(u.created.run.id), status: "running" }, null)).toEqual(["evaluator_unavailable", "final_reserve_insufficient"]);
      expect(facts.preflight(h.stores.runs.get(u.created.run.id), null)).toEqual(["run_not_running", "evaluator_unavailable", "final_reserve_insufficient"]);
    } finally {
      h.close();
    }
  });
});

describe("completion policy at Run creation", () => {
  it("requires a coding Run to declare a deterministic completion criterion of its Conversation, deduplicated and canonically ordered; an other Run may declare none", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const conversationId = s.created.run.conversationId;
      const request = { conversationId, kind: "code" as const, target: { kind: "branch" as const, branch: "main" }, budget: DEFAULT_BUDGET, orchestratorAgentDefinitionRevisionId: s.orchestrator.id };
      // The seeded Run declared its criterion once, in order.
      expect(s.created.run.verificationPolicy).toMatchObject({ maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [s.completion.criterionId] });
      // Another Run of the Conversation is blocked by the active one; validation still comes first.
      expect(() => h.runCreation.create({ ...request, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null } })).toThrow(/deterministic completion criterion/);
      expect(() => h.runCreation.create({ ...request, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [`ac_${"0".repeat(24)}`] } })).toThrow(/does not exist/);
      const foreign = seedRuntime(h);
      expect(() => h.runCreation.create({ ...request, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [foreign.completion.criterionId] } })).toThrow(/another Conversation/);
      const evaluated = h.stores.requirements.createAcceptanceCriterion({ conversationId, requirementId: s.completion.requirementId, requirementRevisionId: s.completion.revision.id, taskId: null, check: { kind: "evaluated", question: "good?", rubric: null } });
      expect(() => h.runCreation.create({ ...request, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [evaluated.id] } })).toThrow(/deterministic completion criterion/);
      expect(() => h.runCreation.create({ ...request, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [evaluated.id, s.completion.criterionId] } })).toThrow(/names a Gate Evaluator/);
      expect(() => h.runCreation.create({ ...request, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, maxRunCompletionCycles: 0, runCompletionAcceptanceCriterionIds: [s.completion.criterionId] } })).toThrow(ValidationError);
      // A fresh Conversation: dedupe and order, an other Run without criteria, and the persisted policy is immutable.
      const workspace = h.stores.workspaces.create({ name: "w2", rootPath: "/w2", kind: "git" });
      const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: null });
      const completion = seedCompletionCriterion(h, conversation.id);
      const judged = h.stores.requirements.createAcceptanceCriterion({ conversationId: conversation.id, requirementId: completion.requirementId, requirementRevisionId: completion.revision.id, taskId: null, check: { kind: "evaluated", question: "good?", rubric: null } });
      const ids = [judged.id, completion.criterionId, judged.id];
      const created = h.runCreation.create({ ...request, conversationId: conversation.id, verificationPolicy: { evaluatorAgentDefinitionRevisionId: seedReadOnlyWorker(h, "judge").id, runCompletionAcceptanceCriterionIds: ids } });
      expect(created.run.verificationPolicy.runCompletionAcceptanceCriterionIds).toEqual([...new Set(ids)].sort());
      expect(() => h.database.sqlite.prepare("UPDATE runs SET verification_policy = json_set(verification_policy, '$.runCompletionAcceptanceCriterionIds', '[]') WHERE id = ?").run(created.run.id)).toThrow(/immutable/);
      const third = h.stores.conversations.create({ workspaceId: workspace.id, title: null });
      expect(h.runCreation.create({ ...request, conversationId: third.id, kind: "other", verificationPolicy: { evaluatorAgentDefinitionRevisionId: null } }).run.verificationPolicy.runCompletionAcceptanceCriterionIds).toEqual([]);
      // Starting the Run and requesting completion works from the very first turn once the Run is running.
      const fourth = h.stores.conversations.create({ workspaceId: workspace.id, title: null });
      const c4 = seedCompletionCriterion(h, fourth.id);
      const run4 = h.runCreation.create({ ...request, conversationId: fourth.id, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [c4.criterionId] } });
      const message = h.stores.conversations.postMessage({ conversationId: fourth.id, author: "operator", content: "go", runId: run4.run.id, invocationId: null });
      const started = h.runStart.start({ runId: run4.run.id, conversationMessageId: message.id });
      expect(new CompletionFacts(h.stores).preflight(h.stores.runs.get(run4.run.id), started.prepared.invocation.id)).toEqual([]);
    } finally {
      h.close();
    }
  });
});

// `startRun` is exercised through `seedPlanningRuntime`; the import keeps the harness surface explicit for the reader.
void startRun;
