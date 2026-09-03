/**
 * Test support for evaluator_optimizer scenarios: a Requirement tree with
 * deterministic and evaluated Acceptance Criteria, inline and composite
 * optimizer nodes gated on them, and scripted producer and Evaluator steps
 * derived from each Invocation's manifest.
 */
import type { AcceptanceCriterionId, ArtifactId, Evaluation, Invocation, ManifestInput, PlanExpression, PlanNode, PlanNodeId, RequirementId, RequirementRevisionId, Verdict } from "@agentique-console/core";
import type { FakeStep } from "../provider/fake.ts";
import { COMPLETED_RESULT, fakeSnapshot, planNodes, seedPlanningRuntime, seedReadOnlyWorker, type RuntimeHarness } from "./test-support.ts";

export type PlanningSeed = ReturnType<typeof seedPlanningRuntime>;

export const OPTIMIZER_ALLOCATION = { costUsd: 20, tokens: 200_000, attempts: 20 };
/** The allocation of every node of an unrolled optimizer (producer rounds, evaluate-only rounds, successors), so several rounds fit the Run's ordinary pool. */
export const UNROLLED_ALLOCATION = { costUsd: 4, tokens: 40_000, attempts: 4 };

export interface SeededCriteria {
  rootId: RequirementId;
  revisionId: RequirementRevisionId;
  /** Deterministic criteria in id order (the canonical check order). */
  deterministic: AcceptanceCriterionId[];
  /** Evaluated criteria in id order. */
  evaluated: AcceptanceCriterionId[];
  all: AcceptanceCriterionId[];
}

/** A one-leaf Requirement tree of the Conversation with `deterministic` command criteria and `evaluated` question criteria on the leaf. */
export function seedCriteria(h: RuntimeHarness, s: PlanningSeed, counts: { deterministic?: number; evaluated?: number } = {}): SeededCriteria {
  const conversationId = s.created.run.conversationId;
  const rootId = h.ctx.ids("requirement");
  const revision = h.stores.requirements.createRevision({ conversationId, approvedByDecisionId: null, tree: [{ id: rootId, parentId: null, composition: null, statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] }] });
  const deterministic = Array.from({ length: counts.deterministic ?? 0 }, (_, i) => h.stores.requirements.createAcceptanceCriterion({ conversationId, requirementId: rootId, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: `npm run check-${i}`, expectedExitCode: 0 } }).id).sort();
  const evaluated = Array.from({ length: counts.evaluated ?? 0 }, (_, i) => h.stores.requirements.createAcceptanceCriterion({ conversationId, requirementId: rootId, requirementRevisionId: revision.id, taskId: null, check: { kind: "evaluated", question: `Is the output correct (${i})?`, rubric: null } }).id).sort();
  return { rootId, revisionId: revision.id, deterministic, evaluated, all: [...deterministic, ...evaluated].sort() };
}

export interface OptimizerNodeOptions {
  maxRounds?: number;
  /** The Gate criteria of the optimizer expression (every evaluate-only round inherits them); the seeded criteria by default. */
  gate?: AcceptanceCriterionId[];
  /** A composite producer: a chain of these leaf titles; a leaf producer otherwise. */
  producerSteps?: string[];
  /** Expressions after the optimizer in the enclosing chain. */
  after?: string[];
  allocation?: { costUsd: number; tokens: number; attempts: number };
  evaluator?: string;
}

/** An evaluator_optimizer node (inline or unrolled) gated on the seeded criteria, in a chain with optional successors. */
export function optimizerNodes(h: RuntimeHarness, s: PlanningSeed, criteria: SeededCriteria, options: OptimizerNodeOptions = {}) {
  const evaluator = options.evaluator ?? seedReadOnlyWorker(h, "evaluator").id;
  const leaf = (title: string): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title } });
  const unrolled = options.producerSteps !== undefined;
  const allocation = options.allocation ?? (unrolled ? UNROLLED_ALLOCATION : OPTIMIZER_ALLOCATION);
  const producer: PlanExpression = options.producerSteps === undefined ? leaf("draft") : { pattern: "chain", steps: options.producerSteps.map(leaf), allocation };
  const optimizer: PlanExpression = {
    pattern: "evaluator_optimizer",
    producer,
    evaluator: { agentDefinitionRevisionId: evaluator as never, title: "judge" },
    maxRounds: options.maxRounds ?? 2,
    allocation,
    gateAcceptanceCriterionIds: options.gate ?? criteria.all,
  };
  const after = (options.after ?? []).map((title): PlanExpression => ({ ...leaf(title), allocation }));
  const expressions: PlanExpression[] = after.length === 0 ? [optimizer] : [{ pattern: "chain", steps: [optimizer, ...after] }];
  const { nodes, revisionNumber, outcome } = planNodes(h, s, expressions);
  const byPath = Object.fromEntries(nodes.map((n) => [n.sourcePath, n])) as Record<string, PlanNode>;
  return { nodes, revisionNumber, graph: outcome.graph, byPath, evaluator };
}

/** A producer step: one candidate Artifact of the Invocation plus a content Changeset. */
export function producerStep(h: RuntimeHarness, label: string): FakeStep {
  return {
    kind: "derived",
    step: (request) => {
      const invocation = h.stores.invocations.get(request.invocationId);
      const artifact = h.stores.artifacts.create({ runId: invocation.runId, mediaType: "text/plain", producer: { kind: "invocation", invocationId: invocation.id, attemptId: null }, taskId: null, title: `${label} candidate` }, new TextEncoder().encode(`${label} content of ${invocation.id}`));
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot(label, invocation.id), diff: new TextEncoder().encode(`+${label}`), empty: false };
      return { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: [artifact.id], summary: `${label} produced` } };
    },
  };
}

export interface EvaluatorStepOptions {
  /** Per-criterion verdicts by evaluated criterion id; every criterion the manifest names defaults to the overall verdict. */
  criteria?: Partial<Record<string, Verdict>>;
  /** Override the reported criterion ids (to script an invalid result). */
  reportIds?: AcceptanceCriterionId[];
  /** Override the overall Evidence; defaults to an artifact reference to the first candidate Artifact. */
  evidence?: ManifestInput extends never ? never : Evaluation["evidence"];
  summary?: string;
}

/** An Evaluator step: a valid typed evaluation derived from the Invocation's `optimizer_candidate` manifest input. */
export function evaluatorStep(h: RuntimeHarness, verdict: Verdict, options: EvaluatorStepOptions = {}): FakeStep {
  return {
    kind: "derived",
    step: (request) => {
      const manifest = h.stores.invocations.getManifest(request.invocationId).content;
      const candidate = manifest.inputs.find((i): i is Extract<ManifestInput, { kind: "optimizer_candidate" }> => i.kind === "optimizer_candidate");
      if (!candidate) throw new Error("the Evaluator manifest carries no optimizer_candidate input");
      const ids = options.reportIds ?? candidate.acceptanceCriterionIds;
      const evidence = options.evidence ?? (candidate.artifactIds.length > 0 ? [{ kind: "artifact" as const, artifactId: candidate.artifactIds[0]! }] : [{ kind: "snapshot" as const, snapshotId: candidate.snapshotId }]);
      return {
        kind: "succeed",
        result: {
          ...COMPLETED_RESULT,
          summary: options.summary ?? `round ${candidate.round} ${verdict}`,
          evaluation: { verdict, criteria: ids.map((id) => ({ acceptanceCriterionId: id, verdict: options.criteria?.[id] ?? verdict, evidence: [] })), evidence },
        },
      };
    },
  };
}

export const producersOf = (h: RuntimeHarness, node: PlanNode | PlanNodeId) => h.stores.invocations.listByPlanNode(typeof node === "string" ? node : node.id).filter((i) => i.patternPosition?.kind === "producer_round");
export const evaluatorsOf = (h: RuntimeHarness, node: PlanNode | PlanNodeId) => h.stores.invocations.listByPlanNode(typeof node === "string" ? node : node.id).filter((i) => i.patternPosition?.kind === "evaluator_round");
export const verdictsOf = (h: RuntimeHarness, node: PlanNode | PlanNodeId) => h.stores.evaluations.optimizerVerdictsOfNode(typeof node === "string" ? node : node.id);
export const criterionEvaluationsOf = (h: RuntimeHarness, node: PlanNode | PlanNodeId, round: number) => h.stores.evaluations.optimizerCriterionEvaluationsOf(typeof node === "string" ? node : node.id, round);
export const candidateOf = (invocation: Invocation): ArtifactId[] => invocation.result?.artifactIds ?? [];

/** Finishes the root Orchestrator turn so a pass starts with the plan. */
export async function finishRoot(h: RuntimeHarness, s: PlanningSeed) {
  h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
  await h.executor.advanceInvocation(s.invocation.id);
}

/** Yields to the event loop until `done` holds, never sleeping on a timer. */
export async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000; i += 1) {
    if (done()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("the pass did not reach the expected state");
}
