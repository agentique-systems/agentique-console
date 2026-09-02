/**
 * The publication boundary (execution-model §9.4; invariant 16): exact
 * operator authorization through the `publish` Decision, staged advance
 * through prepare → verify → apply → release with the Target untouched
 * until one atomic compare-and-swap, closed terminal failures with their
 * canonical report, the bounded inspection projection, and Target safety —
 * signoff grants no publish authority, preparation and verification modify
 * nothing, a moved Target is a definite not-applied failure, and no
 * Invocation, Task, model call, or transcript is involved anywhere.
 */
import { PUBLICATION_REPORT_MEDIA_TYPE, publicationReportSchema, parseOrThrow, type PublicationReport } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { fakeSnapshot, openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";
import { advanceToRelease, authorizePublication, completeRun, completeRunStructurally, publicationsOf, publicationWork, publishDecisionsOf } from "./publication-test-support.ts";

function reportOf(h: RuntimeHarness, publicationId: string): PublicationReport {
  const publication = h.stores.publications.get(publicationId as never);
  const { bytes } = h.stores.artifacts.read(publication.reportArtifactId!);
  return parseOrThrow(publicationReportSchema, JSON.parse(new TextDecoder().decode(bytes)), "publication report");
}

describe("publish Decision", () => {
  it("signoff acceptance grants no publish authority: a completed Run has no publish Decision and no Publication until the operator asks", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId } = await completeRun(h);
      expect(publishDecisionsOf(h, runId)).toEqual([]);
      expect(publicationsOf(h, runId)).toEqual([]);
      expect(h.publicationWorkspace.prepares).toEqual([]);
      expect(h.publicationWorkspace.applies).toEqual([]);
      const projection = h.publication.inspect(runId);
      expect(projection.allowedActions).toEqual(["request_publish"]);
      expect(projection.openDecision).toBeNull();
    } finally {
      h.close();
    }
  });

  it("requests the one publish Decision with its exact subject, replays identical retries, and refuses conflicts and non-completed Runs", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId } = await completeRun(h);
      const run = h.stores.runs.get(runId);
      const { decision, replayed } = h.publication.request({ runId, requestedStrategy: { kind: "automatic" } });
      expect(replayed).toBe(false);
      expect(decision).toMatchObject({ kind: "publish", resolutionPolicy: "operator_required", status: "open", runId });
      expect(decision.options.map((o) => o.id).sort()).toEqual(["cancel", "publish"]);
      expect(decision.subject).toEqual({ kind: "publish", runId, workspaceId: run.workspaceId, target: run.target, finalSnapshotId: run.finalSnapshotId, finalChangesetId: run.finalChangesetId, requestedStrategy: { kind: "automatic" } });
      // An identical retry returns the same open Decision; a conflicting one is refused: only one open publish Decision per Run.
      const again = h.publication.request({ runId, requestedStrategy: { kind: "automatic" } });
      expect([again.decision.id, again.replayed]).toEqual([decision.id, true]);
      expect(() => h.publication.request({ runId, requestedStrategy: { kind: "exact", strategy: { kind: "merge" } } })).toThrow(expect.objectContaining({ refusal: "publish_decision_open" }));
      expect(h.publication.inspect(runId).allowedActions).toEqual(["resolve_publish"]);
      // A Run that is not completed has no publication boundary at all.
      const running = seedPlanningRuntime(h);
      expect(() => h.publication.request({ runId: running.created.run.id, requestedStrategy: { kind: "automatic" } })).toThrow(expect.objectContaining({ refusal: "run_not_completed" }));
    } finally {
      h.close();
    }
  });

  it("cancel resolves the Decision and creates no Publication; publish creates exactly one requested Publication atomically; replays are canonical and conflicts refused", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId } = await completeRun(h);
      const first = h.publication.request({ runId, requestedStrategy: { kind: "automatic" } }).decision;
      const cancelled = h.publication.resolve({ runId, decisionId: first.id, option: "cancel" });
      expect(cancelled).toEqual({ kind: "cancelled", decisionId: first.id, replayed: false });
      expect(publicationsOf(h, runId)).toEqual([]);
      expect(h.publication.resolve({ runId, decisionId: first.id, option: "cancel" })).toEqual({ kind: "cancelled", decisionId: first.id, replayed: true });
      expect(() => h.publication.resolve({ runId, decisionId: first.id, option: "publish" })).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
      // A new exact Decision authorizes exactly one Publication, created in the resolving transaction.
      const second = h.publication.request({ runId, requestedStrategy: { kind: "automatic" } }).decision;
      expect(second.id).not.toBe(first.id);
      const publishing = h.publication.resolve({ runId, decisionId: second.id, option: "publish" });
      if (publishing.kind !== "publishing") throw new Error(publishing.kind);
      expect(publishing.replayed).toBe(false);
      const publication = h.stores.publications.get(publishing.publicationId);
      expect(publication).toMatchObject({ status: "requested", decisionId: second.id, changesetId: h.stores.runs.get(runId).finalChangesetId });
      // Identical replay returns the same Publication; a conflicting replay is refused; one Decision never authorizes two.
      expect(h.publication.resolve({ runId, decisionId: second.id, option: "publish" })).toEqual({ kind: "publishing", decisionId: second.id, publicationId: publication.id, replayed: true });
      expect(() => h.publication.resolve({ runId, decisionId: second.id, option: "cancel" })).toThrow(expect.objectContaining({ refusal: "conflicting_resolution" }));
      expect(publicationsOf(h, runId)).toHaveLength(1);
      // While it is nonterminal, no further request is possible.
      expect(() => h.publication.request({ runId, requestedStrategy: { kind: "automatic" } })).toThrow(expect.objectContaining({ refusal: "publication_active" }));
      // Resolving one Run's Decision never acts on another Run: a foreign Run refuses the Decision outright.
      const other = await completeRun(h, { diff: "+other" });
      expect(() => h.publication.resolve({ runId: other.runId, decisionId: second.id, option: "publish" })).toThrow(expect.objectContaining({ refusal: "decision_mismatch" }));
      expect(publicationsOf(h, other.runId)).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("publication advance", () => {
  it("publishes a fast-forward candidate: prepare without touching the Target, verify the accepted deterministic criteria on the candidate, persist applying, one atomic compare-and-swap with a durable receipt, then release staging", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, criterionId } = await completeRun(h, { diff: "+feature" });
      const run = h.stores.runs.get(runId);
      const publicationId = authorizePublication(h, runId);
      const invocationsBefore = h.stores.invocations.listByRun(runId).length;
      // requested → prepared: the port inspected the Target and staged the candidate; the Target is unmodified.
      expect(await h.publication.advance(publicationId)).toEqual({ kind: "prepared", publicationId });
      const prepared = h.stores.publications.get(publicationId);
      expect(prepared.strategy).toEqual({ kind: "fast_forward" });
      const before = h.stores.snapshots.get(prepared.targetBeforeSnapshotId!);
      const candidate = h.stores.snapshots.get(prepared.candidateSnapshotId!);
      expect(before.reason).toBe("publish_before");
      expect(candidate.reason).toBe("publish_candidate");
      expect(before.identity).toEqual(h.stores.snapshots.get(run.baseSnapshotId!).identity);
      expect(candidate.identity).toEqual(h.stores.snapshots.get(run.finalSnapshotId!).identity);
      expect(h.publicationWorkspace.currentTarget({ workspaceId: run.workspaceId, target: run.target })).toEqual(before.identity);
      expect(h.publicationWorkspace.targetMutations).toEqual([]);
      // prepared → verified: the accepted completion Gate's deterministic criterion runs on the candidate, outside every transaction,
      // in a view derived from the staging workspace — one canonical publication Evaluation, no Evaluator, no model call.
      expect(await h.publication.advance(publicationId)).toEqual({ kind: "verified", publicationId, checks: 1 });
      const evaluations = h.stores.evaluations.publicationCriterionEvaluationsOf(publicationId);
      expect(evaluations).toHaveLength(1);
      expect(evaluations[0]).toMatchObject({ verdict: "pass", producedBy: { kind: "runtime" }, snapshotId: prepared.candidateSnapshotId, gateId: null, planNodeId: null });
      expect(evaluations[0]!.subject).toEqual({ kind: "acceptance_criterion", acceptanceCriterionId: criterionId });
      const observed = h.criterionExecution.observed.filter((o) => o.publicationId === publicationId);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ inTransaction: false, round: null, gateId: null });
      expect(observed[0]!.viewPath).toContain(`.agentique/publications/${publicationId}`);
      expect(h.publicationWorkspace.targetMutations).toEqual([]);
      expect(h.publicationWorkspace.applies).toEqual([]);
      // verified → applying is the durable commitment, persisted before any Target call.
      expect(await h.publication.advance(publicationId)).toEqual({ kind: "applying", publicationId });
      expect(h.publicationWorkspace.applies).toEqual([]);
      // applying → succeeded: one atomic compare-and-swap plus receipt; the Target-after is exactly the candidate.
      expect(await h.publication.advance(publicationId)).toEqual({ kind: "succeeded", publicationId, targetAfterSnapshotId: prepared.candidateSnapshotId, alreadyApplied: false, checkout: { kind: "not_checked_out" } });
      const succeeded = h.stores.publications.get(publicationId);
      expect(succeeded.targetAfterSnapshotId).toBe(prepared.candidateSnapshotId);
      expect(h.publicationWorkspace.currentTarget({ workspaceId: run.workspaceId, target: run.target })).toEqual(candidate.identity);
      expect(h.publicationWorkspace.targetMutations).toHaveLength(1);
      expect(h.publicationWorkspace.receipts.get(publicationId)).toEqual({ targetSnapshot: candidate.identity });
      expect(h.publicationWorkspace.observedTransactions.every((t) => t === false)).toBe(true);
      // The canonical report is a bounded versioned Artifact; the report references the verification Evaluations.
      const report = reportOf(h, publicationId);
      expect(report).toMatchObject({ version: 1, outcome: "succeeded", failure: null, targetAfterSnapshotId: prepared.candidateSnapshotId, evaluationIds: [evaluations[0]!.id] });
      expect(h.stores.artifacts.get(succeeded.reportArtifactId!).mediaType).toBe(PUBLICATION_REPORT_MEDIA_TYPE);
      // Terminal, then release staging; a further advance is quiescent.
      expect(await h.publication.advance(publicationId)).toEqual({ kind: "released", publicationId });
      expect(h.publicationWorkspace.released.has(publicationId)).toBe(true);
      expect(await h.publication.advance(publicationId)).toEqual({ kind: "quiescent", publicationId });
      // The completed Run stayed completed; publication created no Invocation, Task, or model call, and no publication_result turn exists.
      expect(h.stores.runs.get(runId).status).toBe("completed");
      expect(h.stores.invocations.listByRun(runId)).toHaveLength(invocationsBefore);
      expect(h.stores.invocations.listByRun(runId).every((i) => i.purpose !== ("publication_result" as never))).toBe(true);
      // Events: one per boundary, plus the Run-scoped terminal event.
      const events = h.ctx.journal.read({ runId }).map((e) => e.type);
      for (const type of ["publication.requested", "publication.prepared", "publication.verified", "publication.applying", "publication.succeeded", "run.published", "publication.workspace_released"]) {
        expect(events.filter((t) => t === type), type).toHaveLength(1);
      }
      // A succeeded Run cannot be published again.
      expect(() => h.publication.request({ runId, requestedStrategy: { kind: "automatic" } })).toThrow(expect.objectContaining({ refusal: "run_already_published" }));
    } finally {
      h.close();
    }
  });

  it("selects merge automatically when the Target moved and the merge is clean; an exact strategy is honored exactly or refused, never widened", async () => {
    const h = openRuntimeHarness();
    try {
      // Moved Target + automatic → merge candidate distinct from the final Snapshot.
      const a = completeRunStructurally(h);
      const runA = h.stores.runs.get(a.runId);
      const moved = fakeSnapshot("operator", "moved", a.runId);
      h.publicationWorkspace.moveTarget({ workspaceId: runA.workspaceId, target: runA.target }, moved);
      const pubA = authorizePublication(h, a.runId);
      expect(await h.publication.advance(pubA)).toEqual({ kind: "prepared", publicationId: pubA });
      const preparedA = h.stores.publications.get(pubA);
      expect(preparedA.strategy).toEqual({ kind: "merge" });
      expect(h.stores.snapshots.get(preparedA.targetBeforeSnapshotId!).identity).toEqual(moved);
      expect(h.stores.snapshots.get(preparedA.candidateSnapshotId!).identity).not.toEqual(h.stores.snapshots.get(runA.finalSnapshotId!).identity);
      // No deterministic criteria on this boundary: structural candidate validation moves prepared → verified.
      expect(await h.publication.advance(pubA)).toEqual({ kind: "verified", publicationId: pubA, checks: 0 });
      await h.publication.advance(pubA);
      const applied = await h.publication.advance(pubA);
      expect(applied.kind).toBe("succeeded");
      expect(h.publicationWorkspace.currentTarget({ workspaceId: runA.workspaceId, target: runA.target })).toEqual(h.stores.snapshots.get(preparedA.candidateSnapshotId!).identity);
      // Moved Target + exact fast_forward → refused terminally, the Target untouched, with a report and a released staging obligation.
      const b = completeRunStructurally(h);
      const runB = h.stores.runs.get(b.runId);
      h.publicationWorkspace.moveTarget({ workspaceId: runB.workspaceId, target: runB.target }, fakeSnapshot("operator", "moved", b.runId));
      const pubB = authorizePublication(h, b.runId, { kind: "exact", strategy: { kind: "fast_forward" } });
      const failed = await h.publication.advance(pubB);
      expect(failed).toEqual({ kind: "failed", publicationId: pubB, failure: { kind: "fast_forward_unavailable" } });
      expect(h.stores.publications.get(pubB)).toMatchObject({ status: "failed", strategy: null, targetAfterSnapshotId: null });
      expect(h.publicationWorkspace.targetMutations.filter((m) => m.publicationId === pubB)).toEqual([]);
      expect(reportOf(h, pubB)).toMatchObject({ outcome: "failed", failure: { kind: "fast_forward_unavailable" } });
      expect(await h.publication.advance(pubB)).toEqual({ kind: "released", publicationId: pubB });
      // An unsupported provider-named strategy is strategy_unsupported with the exact refused strategy.
      const c = completeRunStructurally(h);
      const pubC = authorizePublication(h, c.runId, { kind: "exact", strategy: { kind: "other", name: "octopus" } });
      expect(await h.publication.advance(pubC)).toEqual({ kind: "failed", publicationId: pubC, failure: { kind: "strategy_unsupported", strategy: { kind: "other", name: "octopus" } } });
      // A supported provider-named strategy is honored exactly.
      const d = completeRunStructurally(h);
      h.publicationWorkspace.supportedOther.add("octopus");
      const pubD = authorizePublication(h, d.runId, { kind: "exact", strategy: { kind: "other", name: "octopus" } });
      expect(await h.publication.advance(pubD)).toEqual({ kind: "prepared", publicationId: pubD });
      expect(h.stores.publications.get(pubD).strategy).toEqual({ kind: "other", name: "octopus" });
    } finally {
      h.close();
    }
  });

  it("fails terminally on a candidate conflict and on a failing deterministic criterion, leaving the Target unchanged; a retry needs a new exact publish Decision", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, criterionId } = await completeRun(h, { diff: "+feature" });
      const run = h.stores.runs.get(runId);
      // Candidate conflict during preparation.
      const pub1 = authorizePublication(h, runId);
      h.publicationWorkspace.conflictNext.add(pub1);
      expect(await h.publication.advance(pub1)).toEqual({ kind: "failed", publicationId: pub1, failure: { kind: "candidate_conflict" } });
      const report1 = reportOf(h, pub1);
      expect(report1.failure).toEqual({ kind: "candidate_conflict" });
      // The bounded raw diagnostic lives in its own Artifact, referenced by id — never in the report, the failure, or an Event.
      expect(report1.diagnosticArtifactId).not.toBeNull();
      expect(new TextDecoder().decode(h.stores.artifacts.read(report1.diagnosticArtifactId!).bytes)).toContain("CONFLICT");
      const eventPayloads = JSON.stringify(h.ctx.journal.read({ runId }).map((e) => e.payload));
      expect(eventPayloads).not.toContain("CONFLICT");
      await h.publication.advance(pub1);
      // Verification failure: the criterion fails on the candidate; the Target stays unchanged.
      const pub2 = authorizePublication(h, runId);
      h.criterionExecution.script(criterionId!, { kind: "exit", exitCode: 1, output: "1 test failed\n" });
      expect(await h.publication.advance(pub2)).toEqual({ kind: "prepared", publicationId: pub2 });
      expect(await h.publication.advance(pub2)).toEqual({ kind: "failed", publicationId: pub2, failure: { kind: "verification_failed", acceptanceCriterionIds: [criterionId] } });
      expect(h.stores.evaluations.publicationCriterionEvaluationsOf(pub2).map((e) => e.verdict)).toEqual(["fail"]);
      expect(h.publicationWorkspace.targetMutations).toEqual([]);
      expect(h.publicationWorkspace.applies).toEqual([]);
      expect(h.publicationWorkspace.currentTarget({ workspaceId: run.workspaceId, target: run.target })).toEqual(h.stores.snapshots.get(run.baseSnapshotId!).identity);
      // The raw command output lives only in the Artifact Store.
      expect(JSON.stringify(h.ctx.journal.read({ runId }).map((e) => e.payload))).not.toContain("1 test failed");
      await h.publication.advance(pub2);
      // The old Decisions are resolved history: replaying one returns its canonical (failed) Publication and never authorizes a second.
      expect(h.publication.resolve({ runId, decisionId: publishDecisionsOf(h, runId)[0]!.id, option: "publish" })).toMatchObject({ kind: "publishing", publicationId: pub1, replayed: true });
      expect(publicationsOf(h, runId)).toHaveLength(2);
      // Retrying publication needs a new exact publish Decision, which succeeds on the unchanged Target.
      const pub3 = authorizePublication(h, runId);
      const outcomes = await advanceToRelease(h, pub3);
      expect(outcomes.map((o) => o.kind)).toEqual(["prepared", "verified", "applying", "succeeded", "released"]);
      expect(h.publicationWorkspace.targetMutations).toHaveLength(1);
      expect(h.stores.runs.get(runId).status).toBe("completed");
    } finally {
      h.close();
    }
  });

  it("records the definite not-applied target_changed when the Target moved between preparation and apply, and never force-updates", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId } = completeRunStructurally(h);
      const run = h.stores.runs.get(runId);
      const publicationId = authorizePublication(h, runId);
      await h.publication.advance(publicationId);
      await h.publication.advance(publicationId);
      expect(await h.publication.advance(publicationId)).toEqual({ kind: "applying", publicationId });
      // The operator pushes to the Target after preparation, before the compare-and-swap.
      const moved = fakeSnapshot("operator", "pushed", runId);
      h.publicationWorkspace.moveTarget({ workspaceId: run.workspaceId, target: run.target }, moved);
      expect(await h.publication.advance(publicationId)).toEqual({ kind: "failed", publicationId, failure: { kind: "target_changed" } });
      expect(h.publicationWorkspace.currentTarget({ workspaceId: run.workspaceId, target: run.target })).toEqual(moved);
      expect(h.publicationWorkspace.targetMutations).toEqual([]);
      expect(h.publicationWorkspace.receipts.size).toBe(0);
      expect(h.stores.publications.get(publicationId)).toMatchObject({ status: "failed", targetAfterSnapshotId: null });
      expect(h.stores.runs.get(runId).status).toBe("completed");
    } finally {
      h.close();
    }
  });

  it("treats provider unavailability as retryable nonterminal state at every stage, never a terminal failure", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId } = completeRunStructurally(h);
      const publicationId = authorizePublication(h, runId);
      // Prepare unavailable: stays requested.
      h.publicationWorkspace.prepareUnavailableNext = 1;
      const p = await h.publication.advance(publicationId);
      expect(p).toMatchObject({ kind: "infrastructure_failure", stage: "prepare" });
      expect(h.stores.publications.get(publicationId).status).toBe("requested");
      expect(await h.publication.advance(publicationId)).toEqual({ kind: "prepared", publicationId });
      await h.publication.advance(publicationId);
      await h.publication.advance(publicationId);
      // Apply unavailable: the result is unknown; stays applying and reconciles later.
      h.publicationWorkspace.applyUnavailableNext = 1;
      expect(await h.publication.advance(publicationId)).toMatchObject({ kind: "infrastructure_failure", stage: "apply" });
      expect(h.stores.publications.get(publicationId).status).toBe("applying");
      const done = await h.publication.advance(publicationId);
      expect(done.kind).toBe("succeeded");
      // Release failure: the outcome never changes; the obligation stays pending and is retried until released.
      h.publicationWorkspace.releaseFailNext = 1;
      expect(await h.publication.advance(publicationId)).toMatchObject({ kind: "infrastructure_failure", stage: "release" });
      expect(h.stores.publications.get(publicationId)).toMatchObject({ status: "succeeded", stagingCleanup: "pending" });
      expect((await h.publication.releaseOutstanding()).map((o) => o.kind)).toEqual(["released"]);
      expect(h.stores.publications.get(publicationId).stagingCleanup).toBe("released");
      expect(h.executionDiagnostics.filter((d) => d.kind === "publication_provider_unavailable")).toHaveLength(2);
      expect(h.executionDiagnostics.filter((d) => d.kind === "publication_staging_release_failed")).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("projects a bounded inspection: ids, statuses, strategies, failure codes, report facts, and allowed actions — no content, output, paths, or receipts", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId } = completeRunStructurally(h);
      const publicationId = authorizePublication(h, runId);
      await advanceToRelease(h, publicationId);
      const projection = h.publication.inspect(runId);
      expect(projection.runStatus).toBe("completed");
      expect(projection.publications).toHaveLength(1);
      const entry = projection.publications[0]!;
      expect(entry).toMatchObject({ publicationId, status: "succeeded", strategy: { kind: "fast_forward" }, failure: null, stagingCleanup: "released" });
      expect(entry.report?.mediaType).toBe(PUBLICATION_REPORT_MEDIA_TYPE);
      expect(projection.allowedActions).toEqual([]);
      // Bounded: no Artifact bytes, no command output, no repository path, no provider receipt, no Event history.
      const raw = JSON.stringify(projection);
      expect(raw).not.toContain("/.agentique/");
      expect(raw).not.toContain("receipt");
      expect(raw).not.toMatch(/transcript|events/i);
    } finally {
      h.close();
    }
  });
});
