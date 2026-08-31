/**
 * Shared fixtures for the agent-requested Decision suites (execution-model
 * §8.2): `request_decision` call builders, and runtime-tool ports bound to
 * a running root Orchestrator turn or a running Worker step exactly as the
 * executor binds them (the provider is never called; tests drive the port).
 */
import { TRANSCRIPT_MEDIA_TYPE, type Decision, type DecisionId, type Invocation, type ManifestInput, type PlanExpression, type PlanNode, type RequestDecisionInput, type RequestedDecisionAffects, type RequirementId, type RunId, type RuntimeToolCallRequest } from "@agentique-console/core";
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

/** Advances the Run until a pass performs nothing more (or `passes` elapse); returns the last pass. */
export async function drain(h: RuntimeHarness, runId: RunId, passes = 16) {
  let last = await h.scheduler.advanceRun(runId);
  for (let i = 1; i < passes && last.actions.length > 0; i += 1) last = await h.scheduler.advanceRun(runId);
  return last;
}

/** A plain structural check (this file is not a test file, so it carries no test-runner dependency): throws with both values. */
function same(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

/**
 * The one successor of `blocked`: the same Run, Plan Node, role, purpose, exact Pattern position, Task ownership, and Gate,
 * continuing from it with a fresh manifest, and exactly one `decision_resolution` input naming `decisionId`.
 */
export function expectSuccessor(h: RuntimeHarness, blocked: Invocation, decisionId: DecisionId): Invocation {
  const successors = h.stores.invocations.listByRun(blocked.runId).filter((i) => i.continuedFromInvocationId === blocked.id);
  same("successors of the blocked Invocation", successors.map((i) => i.id).length, 1);
  const successor = successors[0]!;
  const identity = (i: Invocation) => ({ runId: i.runId, planNodeId: i.planNodeId, role: i.role, purpose: i.purpose, patternPosition: i.patternPosition, taskIds: i.taskIds, gateId: i.gateId });
  same("successor identity", identity(successor), identity(blocked));
  if (successor.id === blocked.id) throw new Error("the successor is the blocked Invocation itself");
  if (h.stores.invocations.getManifest(successor.id).id === h.stores.invocations.getManifest(blocked.id).id) throw new Error("the successor reuses the predecessor's manifest");
  const resolutions = h.stores.invocations.getManifest(successor.id).content.inputs.filter((i): i is Extract<ManifestInput, { kind: "decision_resolution" }> => i.kind === "decision_resolution");
  same("decision_resolution inputs", resolutions.map((r) => [r.decisionId, r.decisionKind]), [[decisionId, h.stores.decisions.get(decisionId).kind]]);
  return successor;
}

/**
 * The successor's manifest is minimal: exactly `inputKinds` in order (the position's operation-defining inputs once, one
 * `decision_resolution`), the predecessor's Handoffs and no other, no transcript Artifact, and no Decision but the resolved one
 * beyond those the predecessor's manifest already carried for other reasons.
 */
export function expectSuccessorManifest(h: RuntimeHarness, successor: Invocation, inputKinds: ManifestInput["kind"][]) {
  const content = h.stores.invocations.getManifest(successor.id).content;
  const predecessor = h.stores.invocations.getManifest(successor.continuedFromInvocationId!).content;
  same("successor input kinds", content.inputs.map((i) => i.kind), inputKinds);
  const resolutions = content.inputs.filter((i): i is Extract<ManifestInput, { kind: "decision_resolution" }> => i.kind === "decision_resolution");
  same("decision_resolution count", resolutions.length, 1);
  same("successor Handoffs", content.handoffs.map((x) => x.handoffId), predecessor.handoffs.map((x) => x.handoffId));
  same("transcript Artifacts in the successor manifest", content.artifacts.filter((a) => h.stores.artifacts.get(a.artifactId).mediaType === TRANSCRIPT_MEDIA_TYPE), []);
  same("manifest continuedFromInvocationId", content.continuedFromInvocationId, successor.continuedFromInvocationId);
  // The resolved Decision is delivered; no other Decision arrives on account of the continuation alone.
  if (!content.decisions.some((d) => d.decisionId === resolutions[0]!.decisionId)) throw new Error("the resolved Decision is not delivered");
  const inherited = new Set(predecessor.decisions.map((d) => d.decisionId));
  same("Decisions delivered on account of the continuation alone", content.decisions.map((d) => d.decisionId).filter((id) => id !== resolutions[0]!.decisionId && !inherited.has(id)), []);
  return content;
}

/** A role dispatcher that requests once at the first Invocation `pick` selects (the successor at the same position gets `otherwise`). */
export function requestOnceAt(pick: (invocation: Invocation) => boolean, otherwise: (invocation: Invocation) => FakeStep, affects: (invocation: Invocation) => RequestedDecisionAffects = (i) => ({ requirementIds: [], taskIds: [], planNodeIds: [i.planNodeId] })): (invocation: Invocation) => FakeStep {
  let asked = false;
  return (invocation) => {
    if (!asked && pick(invocation)) {
      asked = true;
      return requesting([choice({ affects: affects(invocation) })]);
    }
    return otherwise(invocation);
  };
}

/** Scripts one dispatcher per role for the whole scenario (steps are chosen from rows, never from a queue position). */
export function dispatchByRole(h: RuntimeHarness, byRole: Partial<Record<Invocation["role"], (invocation: Invocation) => FakeStep>>, count = 24): void {
  const step: FakeStep = {
    kind: "derived",
    step: (request) => {
      const invocation = h.stores.invocations.get(request.invocationId);
      const chosen = byRole[invocation.role];
      if (!chosen) throw new Error(`no step for a ${invocation.role} Invocation`);
      return chosen(invocation);
    },
  };
  h.provider.script(...Array.from({ length: count }, () => step));
}

/** The position, or `null`. */
export const positionOf = (i: Invocation) => i.patternPosition;

