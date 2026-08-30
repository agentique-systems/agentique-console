/**
 * Shared fixtures for the `node_exit` Gate suites (execution-model §10):
 * gated Pattern expressions, scripted Workers that produce a candidate
 * Artifact with a content Changeset, scripted Gate Evaluators that answer
 * from their `gate_candidate` input, scripted Orchestrator `gate_result`
 * turns, and canonical readers over Gate, Evaluation, Invocation, and Task
 * rows. Nothing here reads a transcript or process memory of the runtime.
 */
import type { AcceptanceCriterionId, ArtifactId, Evidence, GateId, Invocation, ManifestInput, PlanExpression, PlanNodeId, Task, TaskId, Verdict } from "@agentique-console/core";
import type { FakeStep } from "../provider/fake.ts";
import { COMPLETED_RESULT, fakeSnapshot, type RuntimeHarness } from "./test-support.ts";
import type { PlanningSeed } from "./optimizer-test-support.ts";

export { finishRoot, seedCriteria, until, type PlanningSeed, type SeededCriteria } from "./optimizer-test-support.ts";

export const GATE_NODE_ALLOCATION = { costUsd: 12, tokens: 120_000, attempts: 12 };

/** A `single` worker expression, gated when `gate` is given. */
export function singleExpression(s: PlanningSeed, title: string, options: { gate?: AcceptanceCriterionId[]; allocation?: { costUsd: number; tokens: number; attempts: number }; agent?: string } = {}): PlanExpression {
  return {
    pattern: "single",
    operation: { agentDefinitionRevisionId: (options.agent ?? s.worker.id) as never, title },
    allocation: options.allocation ?? GATE_NODE_ALLOCATION,
    ...(options.gate ? { gateAcceptanceCriterionIds: options.gate as never } : {}),
  } as PlanExpression;
}

/** A `chain` of single steps, gated as a whole when `gate` is given. */
export function chainExpression(s: PlanningSeed, titles: string[], options: { gate?: AcceptanceCriterionId[] } = {}): PlanExpression {
  return {
    pattern: "chain",
    steps: titles.map((title): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title } })),
    allocation: GATE_NODE_ALLOCATION,
    ...(options.gate ? { gateAcceptanceCriterionIds: options.gate as never } : {}),
  } as PlanExpression;
}

/** A `parallel` of single items, optionally aggregated, gated as a whole when `gate` is given. */
export function parallelExpression(s: PlanningSeed, count: number, options: { gate?: AcceptanceCriterionId[]; aggregate?: boolean } = {}): PlanExpression {
  return {
    pattern: "parallel",
    items: Array.from({ length: count }, (_, i): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: `item ${i}` } })),
    ...(options.aggregate ? { aggregate: { agentDefinitionRevisionId: s.worker.id, title: "aggregate" } } : {}),
    allocation: GATE_NODE_ALLOCATION,
    ...(options.gate ? { gateAcceptanceCriterionIds: options.gate as never } : {}),
  } as PlanExpression;
}

/** A Worker step: one candidate Artifact of the Invocation plus a content Changeset (the Worker writes). */
export function workerStep(h: RuntimeHarness, label: string, options: { diff?: string } = {}): FakeStep {
  return {
    kind: "derived",
    step: (request) => {
      const invocation = h.stores.invocations.get(request.invocationId);
      const artifact = h.stores.artifacts.create({ runId: invocation.runId, mediaType: "text/plain", producer: { kind: "invocation", invocationId: invocation.id, attemptId: null }, taskId: null, title: `${label} output` }, new TextEncoder().encode(`${label} content of ${invocation.id}`));
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot(label, invocation.id), diff: new TextEncoder().encode(options.diff ?? `+${label}`), empty: false };
      return { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [artifact.id], summary: `${label} done` } };
    },
  };
}

export interface GateEvaluatorStepOptions {
  /** Per-criterion verdicts; `verdict` for the rest. */
  criteria?: Record<string, Verdict>;
  /** The criteria to report; the `gate_candidate` input's by default (a mismatch is an invalid result). */
  reportIds?: AcceptanceCriterionId[];
  evidence?: Evidence[];
}

/** A Gate Evaluator step: a completed evaluation over exactly the `gate_candidate` input's criteria (or the given ones). */
export function gateEvaluatorStep(h: RuntimeHarness, verdict: Verdict, options: GateEvaluatorStepOptions = {}): FakeStep {
  return {
    kind: "derived",
    step: (request) => {
      const manifest = h.stores.invocations.getManifest(request.invocationId).content;
      const candidate = manifest.inputs.find((i): i is Extract<ManifestInput, { kind: "gate_candidate" }> => i.kind === "gate_candidate");
      if (!candidate) throw new Error("the Evaluator manifest carries no gate_candidate input");
      const ids = options.reportIds ?? candidate.acceptanceCriterionIds;
      const evidence = options.evidence ?? [{ kind: "artifact" as const, artifactId: candidate.artifactIds[0]! }];
      return {
        kind: "succeed",
        result: { ...COMPLETED_RESULT, summary: `gate ${candidate.gateId} ${verdict}`, evaluation: { verdict, criteria: ids.map((id) => ({ acceptanceCriterionId: id, verdict: options.criteria?.[id] ?? verdict, evidence: [] })), evidence } },
      };
    },
  };
}

/**
 * Scripts provider answers by the role of the Invocation each request executes, whatever order the scheduler executes
 * them in: every request consumes the next step queued for its role. Exactly as many dispatching steps are queued as
 * role steps were given; a request for a role whose queue is empty fails the test.
 */
export function scriptByRole(h: RuntimeHarness, queues: { worker?: FakeStep[]; evaluator?: FakeStep[]; orchestrator?: FakeStep[]; coordinator?: FakeStep[] }): void {
  const remaining = { worker: [...(queues.worker ?? [])], evaluator: [...(queues.evaluator ?? [])], orchestrator: [...(queues.orchestrator ?? [])], coordinator: [...(queues.coordinator ?? [])] };
  const total = Object.values(remaining).reduce((n, q) => n + q.length, 0);
  const dispatch: FakeStep = {
    kind: "derived",
    step: (request) => {
      const role = h.stores.invocations.get(request.invocationId).role as keyof typeof remaining;
      const next = remaining[role]?.shift();
      if (!next) throw new Error(`no step scripted for a ${role} Invocation`);
      return next;
    },
  };
  h.provider.script(...Array.from({ length: total }, () => dispatch));
}

export interface OrchestratorStepOptions {
  /** Produce an output Artifact attributed to each of these Tasks (the remediation replaced the output). */
  outputsFor?: TaskId[];
  /** Write a content Changeset (the Orchestrator worked directly). */
  diff?: string;
  /** Report these Tasks in the result with the given status. */
  reports?: { taskId: TaskId; status: "completed" | "blocked" | "failed" }[];
  status?: "completed" | "failed";
}

/** An Orchestrator `gate_result` turn step; `options` may be computed from the remediation Tasks the turn was given (in Task id order). */
export function orchestratorStep(h: RuntimeHarness, given: OrchestratorStepOptions | ((tasks: Task[]) => OrchestratorStepOptions) = {}): FakeStep {
  return {
    kind: "derived",
    step: (request) => {
      const invocation = h.stores.invocations.get(request.invocationId);
      const given_ = h.stores.invocations.getManifest(invocation.id).content.inputs.flatMap((i) => (i.kind === "gate_result" && i.remediationTaskId !== null ? [h.stores.tasks.get(i.remediationTaskId)] : [])).sort((a, b) => (a.id < b.id ? -1 : 1));
      const options = typeof given === "function" ? given(given_) : given;
      const artifactIds: ArtifactId[] = (options.outputsFor ?? []).map((taskId) => h.stores.artifacts.create({ runId: invocation.runId, mediaType: "text/plain", producer: { kind: "invocation", invocationId: invocation.id, attemptId: null }, taskId, title: `remediated ${taskId}` }, new TextEncoder().encode(`remediated content for ${taskId}`)).id);
      if (options.diff !== undefined) h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("remediation", invocation.id), diff: new TextEncoder().encode(options.diff), empty: false };
      const reports = (options.reports ?? []).map((r) => ({ taskId: r.taskId, status: r.status, evidence: r.status === "completed" ? [{ kind: "artifact" as const, artifactId: artifactIds[0]! }] : [], blocker: r.status === "blocked" ? "cannot address" : null }));
      const result = options.status === "failed" ? { ...COMPLETED_RESULT, status: "failed" as const, summary: "could not remediate", artifactIds: [], tasks: [] } : { ...COMPLETED_RESULT, artifactIds, tasks: reports, summary: "remediated" };
      return { kind: "succeed", result };
    },
  };
}

export const gatesOf = (h: RuntimeHarness, nodeId: PlanNodeId) => h.stores.gates.listByPlanNode(nodeId);
export const evaluatorsOf = (h: RuntimeHarness, gateId: GateId): Invocation[] => h.stores.invocations.listByGate(gateId);
export const remediationOf = (h: RuntimeHarness, gateId: GateId) => h.stores.tasks.remediationTaskOf(gateId);
export const rootTurnsOf = (h: RuntimeHarness, runId: string) => h.stores.invocations.listAtPosition(h.stores.plans.rootNode(runId as never).id, "orchestrator");
export const criterionVerdictsOf = (h: RuntimeHarness, gateId: GateId) => Object.fromEntries(h.stores.evaluations.gateCriterionEvaluationsOf(gateId).map((e) => [e.subject.kind === "acceptance_criterion" ? e.subject.acceptanceCriterionId : "", e.verdict]));
