/**
 * Shared fixtures for the agent-requested Decision suites (execution-model
 * §8.2): `request_decision` call builders, and runtime-tool ports bound to
 * a running root Orchestrator turn or a running Worker step exactly as the
 * executor binds them (the provider is never called; tests drive the port).
 */
import type { Decision, DecisionId, Invocation, PlanExpression, PlanNode, RequestDecisionInput, RequirementId, RuntimeToolCallRequest } from "@agentique-console/core";
import type { FakeStep } from "../provider/fake.ts";
import { portFor, type PlanningSeed } from "./coordinator-test-support.ts";
import { COMPLETED_RESULT, INVOCATION_ALLOCATION, planNodes, type RuntimeHarness } from "./test-support.ts";

export type OperatorChoiceInput = Extract<RequestDecisionInput, { kind: "operator_choice" }>;

/** An `operator_choice` request: two ordered options, a recommendation, a rationale, the operator required, nothing affected. */
export function choiceInput(overrides: Partial<OperatorChoiceInput> = {}): OperatorChoiceInput {
  return {
    kind: "operator_choice",
    question: "Which HTTP framework should the CLI use?",
    options: [
      { key: "fastify", label: "Fastify", description: "already a dependency" },
      { key: "express", label: "Express" },
    ],
    recommendedOptionKey: "fastify",
    rationale: "Fastify is already installed.",
    resolutionPolicy: { kind: "operator_required" },
    affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
    ...overrides,
  };
}

export const choice = (overrides: Partial<OperatorChoiceInput> = {}): RuntimeToolCallRequest => ({ tool: "request_decision", input: choiceInput(overrides) });

export const waiver = (requirementId: RequirementId, overrides: Partial<Extract<RequestDecisionInput, { kind: "requirement_waiver" }>> = {}): RuntimeToolCallRequest => ({
  tool: "request_decision",
  input: { kind: "requirement_waiver", requirementId, rationale: "The Requirement cannot be met within this Run.", ...overrides },
});

/** A provider step that submits `calls` in order and then completes (a well-behaved adapter stops after an accepted request). */
export const requesting = (calls: RuntimeToolCallRequest[], then: FakeStep = { kind: "succeed", result: COMPLETED_RESULT }): FakeStep => ({ kind: "runtime_tool_calls", calls, then });

/** The root Orchestrator's first turn with a running Attempt and the port bound to it. */
export async function rootPort(h: RuntimeHarness, s: PlanningSeed) {
  const prepared = await h.executor.prepareNextAttempt(s.invocation.id);
  if (prepared.kind !== "prepared") throw new Error(`root Attempt not prepared: ${prepared.kind}`);
  return { invocation: prepared.invocation, attempt: prepared.attempt, port: portFor(h, prepared.invocation, prepared.attempt) };
}

/** A running Worker step on a fresh single node appended to the current plan (with the given allocation and policy) and the port bound to its Attempt. */
export async function workerPort(h: RuntimeHarness, s: PlanningSeed, options: { allocation?: { costUsd: number; tokens: number; attempts: number }; policy?: "fail" | "wait" | "extend"; title?: string } = {}) {
  const title = options.title ?? "work";
  const expression: PlanExpression = { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title }, allocation: options.allocation ?? INVOCATION_ALLOCATION, ...(options.policy ? { onAllocationExhausted: options.policy } : {}) } as PlanExpression;
  const runId = s.created.run.id;
  const existing = h.stores.plans.getRevision(runId, h.stores.plans.latestRevisionNumber(runId)).source.expressions;
  const { nodes, revisionNumber } = planNodes(h, s, [...existing, expression]);
  const node = nodes.find((n) => n.kind === "pattern" && n.title === title && n.status === "pending") as (PlanNode & { kind: "pattern" }) | undefined;
  if (node === undefined) throw new Error(`no fresh single node titled ${title}`);
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  const started = h.runners.single.start(node.id, revisionNumber);
  if (started.kind !== "started") throw new Error(`worker did not start: ${started.kind}`);
  const prepared = await h.executor.prepareNextAttempt(started.invocationId);
  if (prepared.kind !== "prepared") throw new Error(`worker Attempt not prepared: ${prepared.kind}`);
  return { node, revisionNumber, invocation: prepared.invocation, attempt: prepared.attempt, port: portFor(h, prepared.invocation, prepared.attempt) };
}

/** The Decisions an Invocation requested, in creation order. */
export const requestedBy = (h: RuntimeHarness, invocation: Pick<Invocation, "id">): Decision[] => h.stores.decisions.requestedByInvocation(invocation.id);

/** The Decision an accepted `request_decision` outcome names. */
export function decisionOf(outcome: Awaited<ReturnType<ReturnType<typeof portFor>["call"]>>): DecisionId {
  if (outcome.kind !== "accepted" || outcome.result.tool !== "request_decision") throw new Error(`expected an accepted request_decision, got ${outcome.kind}`);
  return outcome.result.decisionId;
}
