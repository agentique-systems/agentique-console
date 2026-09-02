import { describe, expect, it } from "vitest";
import { decisionRequestSchema, PUBLISH_OPTIONS, publishSubjectOf, type DecisionRequest, type DecisionSubject } from "./decisions.ts";
import { newId } from "./ids.ts";
import {
  canonicalPublicationReport,
  PREPARE_FAILURE_KINDS,
  PUBLICATION_FAILURE_KINDS,
  PUBLICATION_MACHINE,
  PUBLICATION_REPORT_MEDIA_TYPE,
  PUBLICATION_STATUSES,
  publicationFailureSchema,
  publicationReportSchema,
  publicationSchema,
  type Publication,
  type PublicationReport,
} from "./publication.ts";
import { evaluationSchema, type Evaluation } from "./verification.ts";
import { publicationStrategyRequestSchema } from "./workspace-state.ts";

const at = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T00:00:01.000Z";

function requested(): Publication {
  return {
    id: newId("publication"),
    runId: newId("run"),
    decisionId: newId("decision"),
    changesetId: newId("changeset"),
    requestedStrategy: { kind: "automatic" },
    strategy: null,
    targetBeforeSnapshotId: null,
    candidateSnapshotId: null,
    targetAfterSnapshotId: null,
    status: "requested",
    failure: null,
    reportArtifactId: null,
    stagingCleanup: "pending",
    createdAt: at,
    preparedAt: null,
    verifiedAt: null,
    applyingAt: null,
    endedAt: null,
    stagingReleasedAt: null,
  };
}

function prepared(): Publication {
  const candidate = newId("snapshot");
  return { ...requested(), status: "prepared", strategy: { kind: "fast_forward" }, targetBeforeSnapshotId: newId("snapshot"), candidateSnapshotId: candidate, preparedAt: later };
}

function succeeded(): Publication {
  const p = prepared();
  return { ...p, status: "succeeded", targetAfterSnapshotId: p.candidateSnapshotId, verifiedAt: later, applyingAt: later, endedAt: later, reportArtifactId: newId("artifact") };
}

describe("Publication lifecycle", () => {
  it("has exactly the six canonical statuses and the required transitions", () => {
    expect(PUBLICATION_STATUSES).toEqual(["requested", "prepared", "verified", "applying", "succeeded", "failed"]);
    expect(PUBLICATION_MACHINE.canTransition("requested", "prepared")).toBe(true);
    expect(PUBLICATION_MACHINE.canTransition("requested", "failed")).toBe(true);
    expect(PUBLICATION_MACHINE.canTransition("prepared", "verified")).toBe(true);
    expect(PUBLICATION_MACHINE.canTransition("prepared", "failed")).toBe(true);
    expect(PUBLICATION_MACHINE.canTransition("verified", "applying")).toBe(true);
    expect(PUBLICATION_MACHINE.canTransition("applying", "succeeded")).toBe(true);
    expect(PUBLICATION_MACHINE.canTransition("applying", "failed")).toBe(true);
    // Infrastructure uncertainty is nonterminal state, not an edge: verified never fails, requested never applies, terminal states never move.
    expect(PUBLICATION_MACHINE.canTransition("verified", "failed")).toBe(false);
    expect(PUBLICATION_MACHINE.canTransition("verified", "succeeded")).toBe(false);
    expect(PUBLICATION_MACHINE.canTransition("requested", "verified")).toBe(false);
    expect(PUBLICATION_MACHINE.canTransition("requested", "applying")).toBe(false);
    expect(PUBLICATION_MACHINE.canTransition("prepared", "applying")).toBe(false);
    expect(PUBLICATION_MACHINE.isTerminal("succeeded")).toBe(true);
    expect(PUBLICATION_MACHINE.isTerminal("failed")).toBe(true);
    for (const to of PUBLICATION_STATUSES) {
      expect(PUBLICATION_MACHINE.canTransition("succeeded", to)).toBe(false);
      expect(PUBLICATION_MACHINE.canTransition("failed", to)).toBe(false);
    }
  });

  it("accepts each well-formed lifecycle stage", () => {
    expect(publicationSchema.safeParse(requested()).success).toBe(true);
    expect(publicationSchema.safeParse(prepared()).success).toBe(true);
    expect(publicationSchema.safeParse({ ...prepared(), status: "verified", verifiedAt: later }).success).toBe(true);
    expect(publicationSchema.safeParse({ ...prepared(), status: "applying", verifiedAt: later, applyingAt: later }).success).toBe(true);
    expect(publicationSchema.safeParse(succeeded()).success).toBe(true);
    // A terminal failure from requested (a prepare refusal) carries no prepared facts.
    expect(publicationSchema.safeParse({ ...requested(), status: "failed", failure: { kind: "candidate_conflict" }, reportArtifactId: newId("artifact"), endedAt: later }).success).toBe(true);
    // A verification failure keeps the prepared facts and stays before verified.
    expect(publicationSchema.safeParse({ ...prepared(), status: "failed", failure: { kind: "verification_failed", acceptanceCriterionIds: [newId("acceptanceCriterion")] }, reportArtifactId: newId("artifact"), endedAt: later }).success).toBe(true);
    // A compare-and-swap refusal comes from applying.
    expect(publicationSchema.safeParse({ ...prepared(), status: "failed", verifiedAt: later, applyingAt: later, failure: { kind: "target_changed" }, reportArtifactId: newId("artifact"), endedAt: later }).success).toBe(true);
  });

  it("binds prepared facts, terminal facts, and cleanup to the lifecycle", () => {
    // The prepared triple is recorded together.
    expect(publicationSchema.safeParse({ ...prepared(), strategy: null }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...prepared(), candidateSnapshotId: null }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...requested(), strategy: { kind: "merge" } }).success).toBe(false);
    // A verified or applying Publication needs its milestone times, monotonically.
    expect(publicationSchema.safeParse({ ...prepared(), status: "verified" }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...prepared(), status: "applying", applyingAt: later }).success).toBe(false);
    // succeeded means the Target holds exactly the prepared candidate; failed means it was not modified.
    expect(publicationSchema.safeParse({ ...succeeded(), targetAfterSnapshotId: newId("snapshot") }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...succeeded(), targetAfterSnapshotId: null }).success).toBe(false);
    const failed = { ...requested(), status: "failed" as const, failure: { kind: "candidate_invalid" as const }, reportArtifactId: newId("artifact"), endedAt: later };
    expect(publicationSchema.safeParse({ ...failed, targetAfterSnapshotId: newId("snapshot") }).success).toBe(false);
    // failure and report exactly on terminal rows.
    expect(publicationSchema.safeParse({ ...failed, failure: null }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...failed, reportArtifactId: null }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...requested(), failure: { kind: "target_changed" } }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...succeeded(), reportArtifactId: null }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...prepared(), reportArtifactId: newId("artifact") }).success).toBe(false);
    // Cleanup is released only after a terminal outcome, with its time.
    expect(publicationSchema.safeParse({ ...succeeded(), stagingCleanup: "released", stagingReleasedAt: later }).success).toBe(true);
    expect(publicationSchema.safeParse({ ...prepared(), stagingCleanup: "released", stagingReleasedAt: later }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...succeeded(), stagingCleanup: "released" }).success).toBe(false);
    // A failure kind matches the stage it can occur at.
    expect(publicationSchema.safeParse({ ...requested(), status: "failed", failure: { kind: "verification_failed", acceptanceCriterionIds: [newId("acceptanceCriterion")] }, reportArtifactId: newId("artifact"), endedAt: later }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...prepared(), status: "failed", failure: { kind: "target_changed" }, reportArtifactId: newId("artifact"), endedAt: later }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...prepared(), status: "failed", verifiedAt: later, failure: { kind: "candidate_conflict" }, reportArtifactId: newId("artifact"), endedAt: later }).success).toBe(false);
  });

  it("keeps the failure vocabulary closed and structured", () => {
    expect(PUBLICATION_FAILURE_KINDS).toEqual(["strategy_unsupported", "fast_forward_unavailable", "candidate_conflict", "verification_failed", "target_changed", "candidate_invalid"]);
    expect(PREPARE_FAILURE_KINDS).toEqual(["strategy_unsupported", "fast_forward_unavailable", "candidate_conflict", "candidate_invalid"]);
    expect(publicationFailureSchema.safeParse({ kind: "strategy_unsupported", strategy: { kind: "other", name: "octopus" } }).success).toBe(true);
    expect(publicationFailureSchema.safeParse({ kind: "verification_failed", acceptanceCriterionIds: [] }).success).toBe(false);
    expect(publicationFailureSchema.safeParse({ kind: "verification_failed", acceptanceCriterionIds: [newId("acceptanceCriterion")] }).success).toBe(true);
    // No arbitrary failure strings: an unknown kind or a free-text field is refused.
    expect(publicationFailureSchema.safeParse({ kind: "provider_exploded" }).success).toBe(false);
    expect(publicationFailureSchema.safeParse({ kind: "target_changed", message: "boom" }).success).toBe(false);
  });

  it("keeps the strategy request closed: automatic, or one exact concrete strategy", () => {
    expect(publicationStrategyRequestSchema.safeParse({ kind: "automatic" }).success).toBe(true);
    expect(publicationStrategyRequestSchema.safeParse({ kind: "exact", strategy: { kind: "fast_forward" } }).success).toBe(true);
    expect(publicationStrategyRequestSchema.safeParse({ kind: "exact", strategy: { kind: "other", name: "theirs" } }).success).toBe(true);
    expect(publicationStrategyRequestSchema.safeParse({ kind: "exact", strategy: { kind: "other", name: "" } }).success).toBe(false);
    expect(publicationStrategyRequestSchema.safeParse({ kind: "exact" }).success).toBe(false);
    expect(publicationStrategyRequestSchema.safeParse({ kind: "fast_forward" }).success).toBe(false);
  });
});

describe("publication report", () => {
  const report = (): PublicationReport => {
    const p = succeeded();
    return {
      version: 1,
      publicationId: p.id,
      runId: p.runId,
      decisionId: p.decisionId,
      changesetId: p.changesetId,
      requestedStrategy: p.requestedStrategy,
      strategy: p.strategy,
      targetBeforeSnapshotId: p.targetBeforeSnapshotId,
      candidateSnapshotId: p.candidateSnapshotId,
      targetAfterSnapshotId: p.targetAfterSnapshotId,
      outcome: "succeeded",
      failure: null,
      evaluationIds: [newId("evaluation")],
      diagnosticArtifactId: null,
      checkout: { kind: "synchronized" },
    };
  };

  it("is versioned, canonical, and pairs the failure with the outcome", () => {
    expect(PUBLICATION_REPORT_MEDIA_TYPE).toBe("application/vnd.agentique.publication-report.v1+json");
    const r = report();
    expect(publicationReportSchema.safeParse(r).success).toBe(true);
    expect(canonicalPublicationReport(r)).toBe(canonicalPublicationReport({ ...r }));
    expect(canonicalPublicationReport(r).startsWith('{"candidateSnapshotId"')).toBe(true);
    expect(publicationReportSchema.safeParse({ ...r, failure: { kind: "target_changed" } }).success).toBe(false);
    expect(publicationReportSchema.safeParse({ ...r, outcome: "failed", failure: null }).success).toBe(false);
    expect(publicationReportSchema.safeParse({ ...r, outcome: "failed", failure: { kind: "target_changed" }, checkout: null }).success).toBe(true);
    // The checkout fact is reported exactly for a successful Target update, and only as one of its closed shapes.
    expect(publicationReportSchema.safeParse({ ...r, outcome: "failed", failure: { kind: "target_changed" } }).success).toBe(false);
    expect(publicationReportSchema.safeParse({ ...r, checkout: null }).success).toBe(false);
    expect(publicationReportSchema.safeParse({ ...r, checkout: { kind: "unchanged", reason: "local_changes" } }).success).toBe(true);
    expect(publicationReportSchema.safeParse({ ...r, checkout: { kind: "reset" } }).success).toBe(false);
    // Evaluation ids are canonical and unique; raw output has no field to hide in.
    const ids = [newId("evaluation"), newId("evaluation")].sort().reverse();
    expect(publicationReportSchema.safeParse({ ...r, evaluationIds: ids }).success).toBe(false);
    expect(publicationReportSchema.safeParse({ ...r, output: "raw" }).success).toBe(false);
  });
});

describe("publish Decision", () => {
  const subject = (runId = newId("run")): Extract<DecisionSubject, { kind: "publish" }> => ({
    kind: "publish",
    runId,
    workspaceId: newId("workspace"),
    target: { kind: "branch", branch: "main" },
    finalSnapshotId: newId("snapshot"),
    finalChangesetId: newId("changeset"),
    requestedStrategy: { kind: "automatic" },
  });

  const request = (runId = newId("run")): DecisionRequest => ({
    conversationId: newId("conversation"),
    runId,
    kind: "publish",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "operator" },
    question: "Publish the accepted result to main?",
    options: [
      { id: "publish", label: "Publish", description: null },
      { id: "cancel", label: "Cancel", description: null },
    ],
    recommendedOptionId: null,
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
    deadlineAt: null,
    activationCondition: null,
    subject: subject(runId),
    supersedesDecisionId: null,
  });

  it("carries exactly the publish subject, the two options, and operator_required", () => {
    expect(PUBLISH_OPTIONS).toEqual(["publish", "cancel"]);
    const runId = newId("run");
    expect(decisionRequestSchema.safeParse(request(runId)).success).toBe(true);
    expect(decisionRequestSchema.safeParse({ ...request(), subject: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request(runId), subject: subject(newId("run")) }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request(), runId: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request(), options: [{ id: "publish", label: "Publish", description: null }] }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request(), resolutionPolicy: "use_default_after_deadline", recommendedOptionId: "publish", deadlineAt: at, rationale: "r" }).success).toBe(false);
    // No other kind may carry a publish subject.
    expect(decisionRequestSchema.safeParse({ ...request(), kind: "operator_choice" }).success).toBe(false);
    const r = request(newId("run"));
    expect(publishSubjectOf({ id: newId("decision"), kind: "publish", subject: r.subject })).toEqual(r.subject);
    expect(() => publishSubjectOf({ id: newId("decision"), kind: "signoff", subject: null })).toThrow(/not a publish/);
  });
});

describe("publication Evaluation context", () => {
  const evaluation = (): Evaluation => ({
    id: newId("evaluation"),
    runId: newId("run"),
    planNodeId: null,
    gateId: null,
    subject: { kind: "acceptance_criterion", acceptanceCriterionId: newId("acceptanceCriterion") },
    context: { kind: "publication", publicationId: newId("publication") },
    verdict: "pass",
    evidence: [],
    producedBy: { kind: "runtime" },
    artifactIds: [],
    snapshotId: newId("snapshot"),
    createdAt: at,
  });

  it("owns one deterministic check of one Publication's candidate: runtime producer, no Gate, no Plan Node, the candidate Snapshot", () => {
    expect(evaluationSchema.safeParse(evaluation()).success).toBe(true);
    expect(evaluationSchema.safeParse({ ...evaluation(), planNodeId: newId("planNode") }).success).toBe(false);
    expect(evaluationSchema.safeParse({ ...evaluation(), gateId: newId("gate") }).success).toBe(false);
    expect(evaluationSchema.safeParse({ ...evaluation(), snapshotId: null }).success).toBe(false);
    expect(evaluationSchema.safeParse({ ...evaluation(), subject: { kind: "rubric", rubric: "quality" } }).success).toBe(false);
    expect(evaluationSchema.safeParse({ ...evaluation(), producedBy: { kind: "evaluator", invocationId: newId("invocation"), agentDefinitionRevisionId: newId("agentDefinitionRevision") } }).success).toBe(false);
  });
});
