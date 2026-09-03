/**
 * Shared fixtures for the publication suites (execution-model §9.4): a Run
 * completed through the real completion and signoff path (whose accepted
 * boundary carries the seeded deterministic completion criterion), a faster
 * store-built completed Run without criteria (structural candidate
 * validation only), and canonical readers over Publication, Decision,
 * Evaluation, Snapshot, and Event rows plus the fake provider's durable
 * external state. Nothing here reads a transcript or runtime memory.
 */
import type { PublicationAdvanceOutcome } from "./publication.ts";
import type { AcceptanceCriterionId, PublicationId, RunId } from "@agentique-console/core";
import { seedCompletedRun, seedRun, type Seeded } from "../persistence/test-support.ts";
import { awaitSignoff, type AwaitingSignoff } from "./signoff-test-support.ts";
import type { RuntimeHarness, RuntimeSeedOverrides } from "./test-support.ts";

export interface CompletedRun {
  runId: RunId;
  /** The deterministic completion criterion the accepted `run_completion` Gate judged (the Run's declared one), when driven through the real path. */
  criterionId: AcceptanceCriterionId | null;
}

/** Drives a Run to `completed` through the real completion and signoff path: its accepted boundary carries the seeded deterministic criterion. */
export async function completeRun(h: RuntimeHarness, options: { diff?: string | null; seed?: RuntimeSeedOverrides } = {}): Promise<CompletedRun & { boundary: AwaitingSignoff }> {
  const boundary = await awaitSignoff(h, options);
  await h.signoff.accept({ runId: boundary.runId, gateId: boundary.gate.id, decisionId: boundary.decisionId });
  const run = h.stores.runs.get(boundary.runId);
  if (run.status !== "completed") throw new Error(`Run ${run.id} is ${run.status} after acceptance`);
  const completionGate = h.stores.gates.get(boundary.gate.completionGateId!);
  return { runId: run.id, criterionId: completionGate.acceptanceCriterionIds[0] ?? null, boundary };
}

/** A completed Run built through the stores, whose accepted completion Gate carries no criteria: structural candidate validation only. */
export function completeRunStructurally(h: RuntimeHarness): CompletedRun & { seeded: Seeded } {
  const seeded = seedRun(h);
  seedCompletedRun(h, seeded);
  return { runId: seeded.run.id, criterionId: null, seeded };
}

/** Requests and resolves the publish Decision, returning the requested Publication. */
export function authorizePublication(h: RuntimeHarness, runId: RunId, requestedStrategy: Parameters<RuntimeHarness["publication"]["request"]>[0]["requestedStrategy"] = { kind: "automatic" }): PublicationId {
  const { decision } = h.publication.request({ runId, requestedStrategy });
  const outcome = h.publication.resolve({ runId, decisionId: decision.id, option: "publish" });
  if (outcome.kind !== "publishing") throw new Error(`unexpected resolution ${outcome.kind}`);
  return outcome.publicationId;
}

/** Advances one Publication until it is terminal and released (or nothing durable can happen), returning every outcome. */
export async function advanceToRelease(h: RuntimeHarness, publicationId: PublicationId): Promise<PublicationAdvanceOutcome[]> {
  const outcomes: PublicationAdvanceOutcome[] = [];
  for (let i = 0; i < 10; i += 1) {
    const outcome = await h.publication.advance(publicationId);
    outcomes.push(outcome);
    if (outcome.kind === "quiescent" || outcome.kind === "released" || outcome.kind === "infrastructure_failure") break;
  }
  return outcomes;
}

export const publicationsOf = (h: RuntimeHarness, runId: RunId) => h.stores.publications.listByRun(runId);
export const publishDecisionsOf = (h: RuntimeHarness, runId: RunId) => h.stores.decisions.publishDecisionsOf(runId);

/** Everything a repeated publication operation could duplicate, from rows and the fake provider's durable external state. */
export function publicationWork(h: RuntimeHarness, runId: RunId) {
  const run = h.stores.runs.get(runId);
  return {
    run: run.status,
    finalSnapshotId: run.finalSnapshotId,
    finalChangesetId: run.finalChangesetId,
    decisions: publishDecisionsOf(h, runId).map((d) => [d.status, d.resolution?.chosenOptionId ?? null]),
    publications: publicationsOf(h, runId).map((p) => [p.status, p.strategy?.kind ?? null, p.failure?.kind ?? null, p.stagingCleanup, p.targetAfterSnapshotId !== null]),
    evaluations: publicationsOf(h, runId).map((p) => h.stores.evaluations.publicationCriterionEvaluationsOf(p.id).map((e) => e.verdict)),
    publishSnapshots: h.stores.snapshots.listByRun(runId).filter((s) => s.reason === "publish_before" || s.reason === "publish_candidate").length,
    reports: h.stores.artifacts.listByRun(runId).filter((a) => a.mediaType.includes("publication-report")).length,
    invocations: h.stores.invocations.listByRun(runId).length,
    tasks: h.stores.tasks.listByRun(runId).length,
    events: h.ctx.journal
      .read({ runId })
      .map((e) => e.type)
      .filter((t) => t.startsWith("publication.") || t === "run.published" || t === "run.publish_failed" || t === "decision.requested" || t === "decision.resolved"),
    external: {
      mutations: h.publicationWorkspace.targetMutations.length,
      receipts: h.publicationWorkspace.receipts.size,
      staged: [...h.publicationWorkspace.staged.keys()].sort(),
      released: [...h.publicationWorkspace.released].sort(),
    },
  };
}
