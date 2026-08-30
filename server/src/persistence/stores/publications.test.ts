/**
 * The Publication store and its database enforcement (execution-model §9.4):
 * a Publication exists only for a completed Run under its operator-resolved
 * publish Decision, applies the Run's final Changeset, moves through the
 * closed lifecycle with its prepared facts recorded once, ends immutably
 * with its report, and releases its staging obligation exactly once. The
 * unique indexes and triggers hold every rule against raw SQL too.
 */
import { ConflictError, IllegalTransitionError, InvariantViolationError, newId, type PublicationTransition } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedArtifact, seedCompletedRun, seedPublicationSnapshot, seedPublishDecision, seedRun, type Harness, type Seeded, type SeededCompletedRun } from "../test-support.ts";

function seedAll(h: Harness): { s: Seeded; completed: SeededCompletedRun } {
  const s = seedRun(h);
  return { s, completed: seedCompletedRun(h, s) };
}

function createPublication(h: Harness, s: Seeded, completed: SeededCompletedRun, options: Parameters<typeof seedPublishDecision>[3] = {}) {
  const decision = seedPublishDecision(h, s, completed, options);
  return h.stores.publications.create({ runId: s.run.id, decisionId: decision.id, changesetId: completed.finalChangeset.id, requestedStrategy: options.requestedStrategy ?? { kind: "automatic" } });
}

function seedCriterion(h: Harness, s: Seeded) {
  const revision = h.stores.requirements.currentRevision(s.conversation.id)!;
  const parents = new Set(revision.tree.map((e) => e.parentId).filter((id) => id !== null));
  const leaf = revision.tree.find((e) => !parents.has(e.id))!;
  return h.stores.requirements.createAcceptanceCriterion({ conversationId: s.conversation.id, requirementId: leaf.id, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
}

function prepare(h: Harness, s: Seeded, publicationId: ReturnType<typeof createPublication>["id"], strategy: Extract<PublicationTransition, { to: "prepared" }>["strategy"] = { kind: "fast_forward" }) {
  const before = seedPublicationSnapshot(h, s, "publish_before", "1".repeat(40));
  const candidate = seedPublicationSnapshot(h, s, "publish_candidate", "2".repeat(40));
  return h.stores.publications.transition(publicationId, { to: "prepared", strategy, targetBeforeSnapshotId: before.id, candidateSnapshotId: candidate.id });
}

describe("publication creation", () => {
  it("admits a requested Publication only for a completed Run under its operator-resolved publish Decision, applying the final Changeset", () => {
    const h = openHarness();
    try {
      const { s, completed } = seedAll(h);
      // An unresolved or cancel-resolved Decision authorizes nothing.
      const open = seedPublishDecision(h, s, completed, { resolve: null });
      expect(() => h.stores.publications.create({ runId: s.run.id, decisionId: open.id, changesetId: completed.finalChangeset.id, requestedStrategy: { kind: "automatic" } })).toThrow(/not resolved 'publish'/);
      const cancelled = h.stores.decisions.resolve(open.id, { resolvedBy: "operator", chosenOptionId: "cancel", rationale: null, artifactIds: [] });
      expect(() => h.stores.publications.create({ runId: s.run.id, decisionId: cancelled.id, changesetId: completed.finalChangeset.id, requestedStrategy: { kind: "automatic" } })).toThrow(/not resolved 'publish'/);
      // A different changeset, or a strategy the subject did not name, is refused.
      const decision = seedPublishDecision(h, s, completed);
      const foreign = h.ctx.tx.write(() => {
        const artifact = seedArtifact(h, s, "other");
        return artifact;
      });
      expect(() => h.stores.publications.create({ runId: s.run.id, decisionId: decision.id, changesetId: newId("changeset"), requestedStrategy: { kind: "automatic" } })).toThrow(/final Changeset/);
      expect(foreign.runId).toBe(s.run.id);
      expect(() => h.stores.publications.create({ runId: s.run.id, decisionId: decision.id, changesetId: completed.finalChangeset.id, requestedStrategy: { kind: "exact", strategy: { kind: "merge" } } })).toThrow(/does not authorize/);
      const publication = h.stores.publications.create({ runId: s.run.id, decisionId: decision.id, changesetId: completed.finalChangeset.id, requestedStrategy: { kind: "automatic" } });
      expect(publication).toMatchObject({ status: "requested", strategy: null, stagingCleanup: "pending", failure: null });
      expect(h.ctx.journal.read({ runId: s.run.id, type: "publication.requested" })).toHaveLength(1);
      // One Publication per Decision.
      expect(() => h.stores.publications.create({ runId: s.run.id, decisionId: decision.id, changesetId: completed.finalChangeset.id, requestedStrategy: { kind: "automatic" } })).toThrow(/already authorized/);
      // The completed Run stays completed.
      expect(h.stores.runs.get(s.run.id).status).toBe("completed");
    } finally {
      h.close();
    }
  });

  it("refuses a Publication for a Run that is not completed, at the store and at the database", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      expect(() => h.stores.publications.create({ runId: s.run.id, decisionId: newId("decision"), changesetId: newId("changeset"), requestedStrategy: { kind: "automatic" } })).toThrow(ConflictError);
      // The trigger holds against raw SQL too.
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO publications (id, run_id, decision_id, changeset_id, requested_strategy, status, staging_cleanup, created_at) VALUES (?, ?, ?, ?, ?, 'requested', 'pending', ?)")
          .run(newId("publication"), s.run.id, newId("decision"), newId("changeset"), JSON.stringify({ kind: "automatic" }), "2026-01-01T00:00:00.000Z"),
      ).toThrow(/completed run/);
    } finally {
      h.close();
    }
  });

  it("permits at most one nonterminal and one succeeded Publication per Run; a published Run is never published again", () => {
    const h = openHarness();
    try {
      const { s, completed } = seedAll(h);
      const first = createPublication(h, s, completed);
      // A second publish Decision cannot even be requested while one is open or a Publication is active.
      expect(() => seedPublishDecision(h, s, completed)).toThrow(/nonterminal Publication/);
      // Fail the first terminally, then a new Decision and Publication are permitted.
      const report = seedArtifact(h, s, "report one");
      h.stores.publications.transition(first.id, { to: "failed", failure: { kind: "candidate_conflict" }, reportArtifactId: report.id });
      expect(h.stores.publications.get(first.id).status).toBe("failed");
      const second = createPublication(h, s, completed);
      const prepared = prepare(h, s, second.id);
      h.stores.publications.transition(second.id, { to: "verified" });
      h.stores.publications.transition(second.id, { to: "applying" });
      const succeeded = h.stores.publications.transition(second.id, { to: "succeeded", reportArtifactId: seedArtifact(h, s, "report two").id });
      expect(succeeded.targetAfterSnapshotId).toBe(prepared.candidateSnapshotId);
      // A succeeded Run is never published again: neither a new Decision nor a new Publication.
      expect(() => seedPublishDecision(h, s, completed)).toThrow(/never published again/);
      expect(h.stores.publications.succeededOf(s.run.id)?.id).toBe(second.id);
      expect(h.stores.publications.activeOf(s.run.id)).toBeNull();
      expect(h.stores.runs.get(s.run.id).status).toBe("completed");
    } finally {
      h.close();
    }
  });

  it("permits only one open publish Decision per Run, enforced by the database", () => {
    const h = openHarness();
    try {
      const { s, completed } = seedAll(h);
      const open = seedPublishDecision(h, s, completed, { resolve: null });
      expect(() => seedPublishDecision(h, s, completed, { resolve: null })).toThrow(/already has open publish Decision/);
      expect(h.stores.decisions.openPublishOf(s.run.id)?.id).toBe(open.id);
      // The unique index holds against raw SQL too.
      const subject = JSON.stringify({ kind: "publish", runId: s.run.id, workspaceId: s.workspace.id, target: completed.run.target, finalSnapshotId: completed.run.finalSnapshotId, finalChangesetId: completed.run.finalChangesetId, requestedStrategy: { kind: "automatic" } });
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO decisions (id, conversation_id, run_id, kind, resolution_policy, status, requested_by, question, options, affects, subject, created_at) VALUES (?, ?, ?, 'publish', 'operator_required', 'open', ?, 'q', ?, ?, ?, ?)")
          .run(newId("decision"), s.conversation.id, s.run.id, JSON.stringify({ kind: "operator" }), JSON.stringify([{ id: "publish", label: "Publish", description: null }, { id: "cancel", label: "Cancel", description: null }]), JSON.stringify({ requirementIds: [], taskIds: [], planNodeIds: [] }), subject, "2026-01-01T00:00:00.000Z"),
      ).toThrow(/UNIQUE/);
    } finally {
      h.close();
    }
  });
});

describe("publication lifecycle", () => {
  it("moves requested → prepared → verified → applying → succeeded with the prepared facts recorded once and every Event journaled", () => {
    const h = openHarness();
    try {
      const { s, completed } = seedAll(h);
      const publication = createPublication(h, s, completed);
      const prepared = prepare(h, s, publication.id);
      expect(prepared).toMatchObject({ status: "prepared", strategy: { kind: "fast_forward" } });
      expect(prepared.preparedAt).not.toBeNull();
      // requested → verified/applying and prepared → applying are not legal; prepared facts never change.
      expect(() => h.stores.publications.transition(publication.id, { to: "applying" })).toThrow(IllegalTransitionError);
      expect(() =>
        h.database.sqlite.prepare("UPDATE publications SET strategy = ? WHERE id = ?").run(JSON.stringify({ kind: "merge" }), publication.id),
      ).toThrow(/prepared facts once/);
      const verified = h.stores.publications.transition(publication.id, { to: "verified" });
      expect(verified.verifiedAt).not.toBeNull();
      const applying = h.stores.publications.transition(publication.id, { to: "applying" });
      expect(applying.applyingAt).not.toBeNull();
      const report = seedArtifact(h, s, "publication report");
      const succeeded = h.stores.publications.transition(publication.id, { to: "succeeded", reportArtifactId: report.id });
      expect(succeeded).toMatchObject({ status: "succeeded", targetAfterSnapshotId: prepared.candidateSnapshotId, reportArtifactId: report.id });
      for (const type of ["publication.requested", "publication.prepared", "publication.verified", "publication.applying", "publication.succeeded", "run.published"] as const) {
        expect(h.ctx.journal.read({ runId: s.run.id, type }), type).toHaveLength(1);
      }
      // Terminal rows never change again (store and trigger), except the cleanup obligation.
      expect(() => h.stores.publications.transition(publication.id, { to: "failed", failure: { kind: "target_changed" }, reportArtifactId: report.id })).toThrow(IllegalTransitionError);
      expect(() => h.database.sqlite.prepare("UPDATE publications SET status = 'failed' WHERE id = ?").run(publication.id)).toThrow(/terminal publication/);
      expect(() => h.database.sqlite.prepare("DELETE FROM publications WHERE id = ?").run(publication.id)).toThrow(/append-only/);
      const released = h.stores.publications.recordStagingReleased(publication.id);
      expect(released.stagingCleanup).toBe("released");
      expect(h.ctx.journal.read({ runId: s.run.id, type: "publication.workspace_released" })).toHaveLength(1);
      expect(() => h.stores.publications.recordStagingReleased(publication.id)).toThrow(/already released/);
      expect(() => h.database.sqlite.prepare("UPDATE publications SET staging_cleanup = 'pending', staging_released_at = NULL WHERE id = ?").run(publication.id)).toThrow(/released once/);
    } finally {
      h.close();
    }
  });

  it("honors an exact strategy request exactly and fails only with a failure the stage permits", () => {
    const h = openHarness();
    try {
      const { s, completed } = seedAll(h);
      const exact = createPublication(h, s, completed, { requestedStrategy: { kind: "exact", strategy: { kind: "merge" } } });
      // The selected strategy must equal the exact request; it is never silently widened or replaced.
      expect(() => prepare(h, s, exact.id, { kind: "fast_forward" })).toThrow(/does not honor/);
      const prepared = prepare(h, s, exact.id, { kind: "merge" });
      expect(prepared.strategy).toEqual({ kind: "merge" });
      // A prepared Publication cannot fail with an apply-stage or prepare-stage-only fact.
      const report = seedArtifact(h, s, "report");
      expect(() => h.stores.publications.transition(exact.id, { to: "failed", failure: { kind: "target_changed" }, reportArtifactId: report.id })).toThrow(/cannot fail with target_changed/);
      expect(() => h.stores.publications.transition(exact.id, { to: "failed", failure: { kind: "strategy_unsupported", strategy: { kind: "merge" } }, reportArtifactId: report.id })).toThrow(/cannot fail with strategy_unsupported/);
      const criterion = seedCriterion(h, s);
      const failed = h.stores.publications.transition(exact.id, { to: "failed", failure: { kind: "verification_failed", acceptanceCriterionIds: [criterion.id] }, reportArtifactId: report.id });
      expect(failed.failure).toEqual({ kind: "verification_failed", acceptanceCriterionIds: [criterion.id] });
      // The Target was not modified: no after Snapshot on a failed row.
      expect(failed.targetAfterSnapshotId).toBeNull();
      expect(h.ctx.journal.read({ runId: s.run.id, type: "run.publish_failed" })).toHaveLength(1);
      // Staging cleanup is released only after a terminal outcome.
      const again = createPublication(h, s, completed);
      expect(() => h.stores.publications.recordStagingReleased(again.id)).toThrow(/terminal outcome/);
    } finally {
      h.close();
    }
  });

  it("keeps publication Evaluations owned by one prepared Publication, one per criterion, runtime-produced, on the candidate Snapshot", () => {
    const h = openHarness();
    try {
      const { s, completed } = seedAll(h);
      const publication = createPublication(h, s, completed);
      const criterion = seedCriterion(h, s).id;
      const input = (snapshotId: string, publicationId = publication.id) => ({
        runId: s.run.id,
        planNodeId: null,
        gateId: null,
        subject: { kind: "acceptance_criterion" as const, acceptanceCriterionId: criterion },
        context: { kind: "publication" as const, publicationId },
        verdict: "pass" as const,
        evidence: [],
        producedBy: { kind: "runtime" as const },
        artifactIds: [],
        snapshotId,
      });
      // Verification runs only on a prepared Publication's exact candidate.
      const stray = seedPublicationSnapshot(h, s, "publish_candidate", "9".repeat(40));
      expect(() => h.stores.evaluations.record(input(stray.id) as never)).toThrow(/candidate verification runs while it is prepared/);
      const prepared = prepare(h, s, publication.id);
      expect(() => h.stores.evaluations.record(input(stray.id) as never)).toThrow(/prepared candidate/);
      const recorded = h.stores.evaluations.record(input(prepared.candidateSnapshotId!) as never);
      expect(recorded.context).toEqual({ kind: "publication", publicationId: publication.id });
      expect(h.stores.evaluations.publicationCriterionEvaluationsOf(publication.id)).toHaveLength(1);
      // One Evaluation per Publication and criterion — store and database.
      expect(() => h.stores.evaluations.record(input(prepared.candidateSnapshotId!) as never)).toThrow(/already checked/);
      expect(() => h.stores.evaluations.record({ ...input(prepared.candidateSnapshotId!), context: { kind: "publication", publicationId: newId("publication") } } as never)).toThrow(/not found|Publication/);
    } finally {
      h.close();
    }
  });
});
