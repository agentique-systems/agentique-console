/**
 * Signoff Resolutions and final Changesets at the store and at the
 * database (execution-model §9.3, §10 `operator_signoff`): the final
 * Changeset is recorded once, only over the open signoff boundary, from the
 * base Snapshot to the verified Snapshot, with a `text/x-diff` Artifact, and
 * never changes; a completed Run's final references agree with it and exist
 * on no other Run; a Signoff Resolution exists exactly once per signoff Gate
 * and per signoff Decision, only while both are open and agree, names the
 * final Changeset or the operator's message by outcome, links its follow-up
 * Invocation once, and is append-only.
 */
import { ConflictError, IllegalTransitionError, InvariantViolationError, NotFoundError, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedArtifact, seedFinalChangeset, seedInvocation, seedRun, seedSignoffBoundary, seedSnapshot, type Harness } from "../test-support.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function rawResolution(h: Harness, values: Record<string, string | null>) {
  return h.database.sqlite
    .prepare("INSERT INTO signoff_resolutions (id, run_id, gate_id, decision_id, outcome, operator_message_id, final_changeset_id, follow_up_invocation_id, resolved_at) VALUES (@id, @run_id, @gate_id, @decision_id, @outcome, @operator_message_id, @final_changeset_id, @follow_up_invocation_id, @resolved_at)")
    .run({ id: `sres_${Math.random().toString(16).slice(2, 26).padEnd(24, "0")}`, operator_message_id: null, final_changeset_id: null, follow_up_invocation_id: null, resolved_at: NOW, ...values });
}

describe("final Changeset", () => {
  it("is recorded once over the open signoff boundary from the base to the verified Snapshot with a text/x-diff Artifact, and never changes", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      // No final Changeset before signoff acceptance: the Run is running, no boundary exists.
      const early = seedSnapshot(h, s);
      const earlyDiff = h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/x-diff", producer: { kind: "runtime", component: "changeset" }, taskId: null, title: null }, new Uint8Array());
      expect(() => h.stores.changesets.recordFinal({ runId: s.run.id, beforeSnapshotId: early.id, afterSnapshotId: early.id, diffArtifactId: earlyDiff.id })).toThrow(ConflictError);
      const boundary = seedSignoffBoundary(h, s, { distinctIntegrationSnapshot: true });
      expect(boundary.baseSnapshotId).not.toBe(boundary.verifiedSnapshotId);
      // Wrong before (not the base), wrong after (not the verified Snapshot), wrong media type: refused, nothing written.
      const plain = seedArtifact(h, s, "not a diff");
      expect(() => h.stores.changesets.recordFinal({ runId: s.run.id, beforeSnapshotId: boundary.verifiedSnapshotId, afterSnapshotId: boundary.verifiedSnapshotId, diffArtifactId: earlyDiff.id })).toThrow(/starts at the Run's base Snapshot/);
      expect(() => h.stores.changesets.recordFinal({ runId: s.run.id, beforeSnapshotId: boundary.baseSnapshotId, afterSnapshotId: boundary.baseSnapshotId, diffArtifactId: earlyDiff.id })).toThrow(/ends at the verified Snapshot/);
      expect(() => h.stores.changesets.recordFinal({ runId: s.run.id, beforeSnapshotId: boundary.baseSnapshotId, afterSnapshotId: boundary.verifiedSnapshotId, diffArtifactId: plain.id })).toThrow(/not a text\/x-diff/);
      const other = seedRun(h);
      const foreign = h.stores.artifacts.create({ runId: other.run.id, mediaType: "text/x-diff", producer: { kind: "runtime", component: "changeset" }, taskId: null, title: null }, new TextEncoder().encode("+x"));
      expect(() => h.stores.changesets.recordFinal({ runId: s.run.id, beforeSnapshotId: boundary.baseSnapshotId, afterSnapshotId: boundary.verifiedSnapshotId, diffArtifactId: foreign.id })).toThrow(InvariantViolationError);
      expect(h.stores.changesets.finalOf(s.run.id)).toBeNull();
      // The one final Changeset: kind final, recorded, no Invocation, exact Snapshots, digest and size of the exact bytes.
      const { artifact, changeset } = seedFinalChangeset(h, s, boundary, "+final content");
      expect(changeset).toMatchObject({ kind: "final", invocationId: null, integrationStatus: "recorded", beforeSnapshotId: boundary.baseSnapshotId, afterSnapshotId: boundary.verifiedSnapshotId, diffArtifactId: artifact.id, integratedSnapshotId: null, conflictTaskId: null, integratedAt: null });
      expect(artifact).toMatchObject({ mediaType: "text/x-diff", byteSize: 14 });
      expect(h.stores.artifacts.read(artifact.id).bytes).toEqual(new TextEncoder().encode("+final content"));
      expect(h.stores.changesets.finalOf(s.run.id)).toEqual(changeset);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "changeset.recorded" }).map((e) => (e.payload as { kind: string }).kind)).toEqual(["final"]);
      // At most one per Run: the store and the unique index both refuse a second.
      expect(() => seedFinalChangeset(h, s, boundary, "+again")).toThrow(ConflictError);
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO changesets (id, run_id, kind, invocation_id, before_snapshot_id, after_snapshot_id, diff_artifact_id, integration_status, integrated_snapshot_id, conflict_task_id, created_at, integrated_at) VALUES (?, ?, 'final', NULL, ?, ?, ?, 'recorded', NULL, NULL, ?, NULL)")
          .run(`cs_${"1".repeat(24)}`, s.run.id, boundary.baseSnapshotId, boundary.verifiedSnapshotId, artifact.id, NOW),
      ).toThrow(/UNIQUE constraint failed: changesets\.run_id/);
      // No integration lifecycle, no mutation, no deletion.
      expect(() => h.stores.changesets.transition(changeset.id, { to: "integrated", integratedSnapshotId: boundary.verifiedSnapshotId })).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("UPDATE changesets SET integration_status = 'integrated', integrated_snapshot_id = ?, integrated_at = ? WHERE id = ?").run(boundary.verifiedSnapshotId, NOW, changeset.id)).toThrow(/recorded once and never changes/);
      expect(() => h.database.sqlite.prepare("DELETE FROM changesets WHERE id = ?").run(changeset.id)).toThrow(/never deleted/);
    } finally {
      h.close();
    }
  });

  it("is enforced by the database: kind shape, no final Changeset outside the open boundary, and immutable invocation Changesets", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const before = seedSnapshot(h, s);
      const after = seedSnapshot(h, s, "integration");
      const diff = h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/x-diff", producer: { kind: "runtime", component: "changeset" }, taskId: null, title: null }, new TextEncoder().encode("+x"));
      const insert = (kind: string, invocationId: string | null, status: string) =>
        h.database.sqlite
          .prepare("INSERT INTO changesets (id, run_id, kind, invocation_id, before_snapshot_id, after_snapshot_id, diff_artifact_id, integration_status, integrated_snapshot_id, conflict_task_id, created_at, integrated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)")
          .run(`cs_${Math.random().toString(16).slice(2, 26).padEnd(24, "0")}`, s.run.id, kind, invocationId, before.id, after.id, diff.id, status, NOW);
      const writer = seedInvocation(h, s);
      // An invocation Changeset cannot claim the final state or lack its Invocation; a final Changeset cannot be pending or name an Invocation.
      expect(() => insert("invocation", writer.id, "recorded")).toThrow(/changesets_kind_shape/);
      expect(() => insert("invocation", null, "pending")).toThrow(/changesets_kind_shape/);
      expect(() => insert("other", writer.id, "pending")).toThrow(/changesets_kind/);
      // The trigger runs before the CHECKs: a final Changeset outside the open signoff boundary is refused by the trigger first.
      expect(() => insert("final", null, "recorded")).toThrow(/recorded for a run awaiting signoff/);
      expect(() => insert("final", null, "pending")).toThrow(/recorded for a run awaiting signoff/);
      expect(() => insert("invocation", writer.id, "pending")).not.toThrow();
      // The store records invocation Changesets only with their writing Invocation.
      expect(() => h.stores.changesets.record({ runId: s.run.id, invocationId: null as never, beforeSnapshotId: before.id, afterSnapshotId: after.id, diffArtifactId: diff.id })).toThrow(ValidationError);
    } finally {
      h.close();
    }
  });

  it("a Run carries its final references only when completed, agreeing with its final Changeset", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const boundary = seedSignoffBoundary(h, s, { distinctIntegrationSnapshot: true });
      // A non-completed Run cannot carry either reference (CHECK).
      expect(() => h.database.sqlite.prepare("UPDATE runs SET final_snapshot_id = ? WHERE id = ?").run(boundary.verifiedSnapshotId, s.run.id)).toThrow(/runs_completed_has_final/);
      const { changeset } = seedFinalChangeset(h, s, boundary);
      expect(() => h.database.sqlite.prepare("UPDATE runs SET final_changeset_id = ? WHERE id = ?").run(changeset.id, s.run.id)).toThrow(/runs_completed_has_final|final changeset/);
      // The store refuses a Changeset that is not the Run's final one, or disagrees with the final Snapshot.
      const writer = seedInvocation(h, s);
      const invocationChangeset = h.stores.changesets.record({ runId: s.run.id, invocationId: writer.id, beforeSnapshotId: boundary.baseSnapshotId, afterSnapshotId: boundary.verifiedSnapshotId, diffArtifactId: h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/x-diff", producer: { kind: "runtime", component: "changeset" }, taskId: null, title: null }, new TextEncoder().encode("+i")).id });
      expect(() => h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: boundary.verifiedSnapshotId, finalChangesetId: invocationChangeset.id })).toThrow(/not the Run's final Changeset/);
      expect(() => h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: boundary.baseSnapshotId, finalChangesetId: changeset.id })).toThrow(/ends at Snapshot/);
      expect(() => h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: boundary.verifiedSnapshotId, finalChangesetId: `cs_${"0".repeat(24)}` })).toThrow(NotFoundError);
      // The database refuses a completed Run whose final Changeset disagrees, whoever writes it.
      expect(() => h.database.sqlite.prepare("UPDATE runs SET status = 'completed', ended_at = ?, final_snapshot_id = ?, final_changeset_id = ? WHERE id = ?").run(NOW, boundary.baseSnapshotId, changeset.id, s.run.id)).toThrow(/names its own final changeset/);
      const completed = h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: boundary.verifiedSnapshotId, finalChangesetId: changeset.id });
      expect(completed).toMatchObject({ status: "completed", finalSnapshotId: boundary.verifiedSnapshotId, finalChangesetId: changeset.id });
      expect(h.ctx.journal.read({ runId: s.run.id, type: "run.completed" }).map((e) => e.payload)).toEqual([{ from: "awaiting_signoff", to: "completed", finalSnapshotId: boundary.verifiedSnapshotId, finalChangesetId: changeset.id }]);
      // Both references are immutable afterwards.
      expect(() => h.database.sqlite.prepare("UPDATE runs SET final_snapshot_id = ? WHERE id = ?").run(boundary.baseSnapshotId, s.run.id)).toThrow(/final references never change/);
    } finally {
      h.close();
    }
  });
});

describe("Signoff Resolution store", () => {
  it("records exactly one accept per signoff Gate and Decision, naming the final Changeset, and never changes or deletes it", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const boundary = seedSignoffBoundary(h, s);
      const { changeset } = seedFinalChangeset(h, s, boundary);
      // Wrong Gate kind, a foreign Run's Gate, a non-final Changeset, a Changeset of another Snapshot: refused before any write.
      const other = seedRun(h);
      const otherBoundary = seedSignoffBoundary(h, other);
      expect(() => h.stores.signoffResolutions.record({ runId: s.run.id, gateId: boundary.completionGate.id, decisionId: boundary.decision.id, outcome: "accept", finalChangesetId: changeset.id })).toThrow(/not an operator_signoff Gate|operator_signoff/);
      expect(() => h.stores.signoffResolutions.record({ runId: s.run.id, gateId: otherBoundary.gate.id, decisionId: boundary.decision.id, outcome: "accept", finalChangesetId: changeset.id })).toThrow(InvariantViolationError);
      expect(() => h.stores.signoffResolutions.record({ runId: s.run.id, gateId: boundary.gate.id, decisionId: otherBoundary.decision.id, outcome: "accept", finalChangesetId: changeset.id })).toThrow(InvariantViolationError);
      const writer = seedInvocation(h, s);
      const invocationChangeset = h.stores.changesets.record({ runId: s.run.id, invocationId: writer.id, beforeSnapshotId: boundary.baseSnapshotId, afterSnapshotId: boundary.verifiedSnapshotId, diffArtifactId: h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/x-diff", producer: { kind: "runtime", component: "changeset" }, taskId: null, title: null }, new TextEncoder().encode("+i")).id });
      const seq = h.ctx.journal.lastSeq();
      expect(() => h.stores.signoffResolutions.record({ runId: s.run.id, gateId: boundary.gate.id, decisionId: boundary.decision.id, outcome: "accept", finalChangesetId: invocationChangeset.id })).toThrow(/not the Run's final Changeset/);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.signoffResolutions.byGate(boundary.gate.id)).toBeNull();
      const resolution = h.stores.signoffResolutions.record({ runId: s.run.id, gateId: boundary.gate.id, decisionId: boundary.decision.id, outcome: "accept", finalChangesetId: changeset.id });
      expect(resolution).toMatchObject({ runId: s.run.id, gateId: boundary.gate.id, decisionId: boundary.decision.id, outcome: "accept", finalChangesetId: changeset.id, operatorMessageId: null, followUpInvocationId: null });
      expect(h.stores.signoffResolutions.byGate(boundary.gate.id)).toEqual(resolution);
      expect(h.stores.signoffResolutions.byDecision(boundary.decision.id)).toEqual(resolution);
      expect(h.stores.signoffResolutions.listByRun(s.run.id)).toEqual([resolution]);
      const events = h.ctx.journal.read({ runId: s.run.id, afterSeq: seq });
      expect(events.map((e) => [e.type, e.actor])).toEqual([["signoff_resolution.recorded", { kind: "operator" }]]);
      expect(events[0]!.payload).toEqual(resolution);
      // Exactly one per Gate and per Decision: the store and the unique indexes both refuse a second, with either outcome.
      expect(() => h.stores.signoffResolutions.record({ runId: s.run.id, gateId: boundary.gate.id, decisionId: boundary.decision.id, outcome: "accept", finalChangesetId: changeset.id })).toThrow(ConflictError);
      const message = h.stores.conversations.postMessage({ conversationId: s.conversation.id, author: "operator", content: "change it", runId: s.run.id, invocationId: null });
      expect(() => h.stores.signoffResolutions.record({ runId: s.run.id, gateId: boundary.gate.id, decisionId: boundary.decision.id, outcome: "request_changes", operatorMessageId: message.id })).toThrow(ConflictError);
      expect(() => rawResolution(h, { run_id: s.run.id, gate_id: boundary.gate.id, decision_id: boundary.decision.id, outcome: "accept", final_changeset_id: changeset.id })).toThrow(/UNIQUE constraint failed: signoff_resolutions\./);
      // Identity and outcome are immutable; an accept never links a follow-up; rows are never deleted.
      expect(() => h.database.sqlite.prepare("UPDATE signoff_resolutions SET outcome = 'request_changes' WHERE id = ?").run(resolution.id)).toThrow(/immutable/);
      expect(() => h.database.sqlite.prepare("UPDATE signoff_resolutions SET final_changeset_id = NULL WHERE id = ?").run(resolution.id)).toThrow(/immutable/);
      expect(() => h.stores.signoffResolutions.link(resolution.id, writer.id)).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("UPDATE signoff_resolutions SET follow_up_invocation_id = ? WHERE id = ?").run(writer.id, resolution.id)).toThrow(/request_changes signoff resolution links/);
      expect(() => h.database.sqlite.prepare("DELETE FROM signoff_resolutions WHERE id = ?").run(resolution.id)).toThrow(/append-only/);
    } finally {
      h.close();
    }
  });

  it("records a request_changes naming an unconsumed operator message of the Conversation and links its follow-up Invocation once", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const boundary = seedSignoffBoundary(h, s);
      const other = seedRun(h);
      const message = h.stores.conversations.postMessage({ conversationId: s.conversation.id, author: "operator", content: "please rename the flag", runId: s.run.id, invocationId: null });
      const orchestratorMessage = h.stores.conversations.postMessage({ conversationId: s.conversation.id, author: "orchestrator", content: "ok", runId: null, invocationId: null });
      const foreignMessage = h.stores.conversations.postMessage({ conversationId: other.conversation.id, author: "operator", content: "elsewhere", runId: null, invocationId: null });
      const input = { runId: s.run.id, gateId: boundary.gate.id, decisionId: boundary.decision.id, outcome: "request_changes" as const };
      expect(() => h.stores.signoffResolutions.record({ ...input, operatorMessageId: orchestratorMessage.id })).toThrow(/not an operator message/);
      expect(() => h.stores.signoffResolutions.record({ ...input, operatorMessageId: foreignMessage.id })).toThrow(/another Conversation/);
      expect(() => h.stores.signoffResolutions.record({ ...input, operatorMessageId: `cvm_${"0".repeat(24)}` })).toThrow(NotFoundError);
      expect(() => rawResolution(h, { run_id: s.run.id, gate_id: boundary.gate.id, decision_id: boundary.decision.id, outcome: "request_changes", operator_message_id: orchestratorMessage.id })).toThrow(/signoff resolution resolves an open operator_signoff gate/);
      expect(() => rawResolution(h, { run_id: s.run.id, gate_id: boundary.gate.id, decision_id: boundary.decision.id, outcome: "request_changes", operator_message_id: null })).toThrow(/signoff resolution resolves an open operator_signoff gate|request_changes_shape/);
      const resolution = h.stores.signoffResolutions.record({ ...input, operatorMessageId: message.id });
      expect(resolution).toMatchObject({ outcome: "request_changes", operatorMessageId: message.id, finalChangesetId: null, followUpInvocationId: null });
      // The Event carries ids and the outcome only, never the operator's prose.
      const event = h.ctx.journal.read({ runId: s.run.id, type: "signoff_resolution.recorded" }).at(-1)!;
      expect(JSON.stringify(event.payload)).not.toContain("rename the flag");
      // The follow-up link: only a root decision_resolution Orchestrator Invocation of the Run, recorded once.
      const worker = seedInvocation(h, s, { role: "orchestrator", purpose: "operator_input" });
      expect(() => h.stores.signoffResolutions.link(resolution.id, worker.id)).toThrow(/not a root decision_resolution/);
      expect(() => h.database.sqlite.prepare("UPDATE signoff_resolutions SET follow_up_invocation_id = ? WHERE id = ?").run(worker.id, resolution.id)).toThrow(/request_changes signoff resolution links/);
      h.stores.invocations.transition(worker.id, { to: "cancelled" });
      const followUp = seedInvocation(h, s, { role: "orchestrator", purpose: "decision_resolution", continuedFromInvocationId: worker.id });
      const foreignFollowUp = seedInvocation(h, other, { role: "orchestrator", purpose: "decision_resolution" });
      expect(() => h.stores.signoffResolutions.link(resolution.id, foreignFollowUp.id)).toThrow(InvariantViolationError);
      const linked = h.stores.signoffResolutions.link(resolution.id, followUp.id);
      expect(linked.followUpInvocationId).toBe(followUp.id);
      expect(h.stores.signoffResolutions.byFollowUp(followUp.id)).toEqual(linked);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "signoff_resolution.linked" }).map((e) => e.payload)).toEqual([{ signoffResolutionId: resolution.id, followUpInvocationId: followUp.id }]);
      expect(() => h.stores.signoffResolutions.link(resolution.id, followUp.id)).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("UPDATE signoff_resolutions SET follow_up_invocation_id = ? WHERE id = ?").run(followUp.id, resolution.id)).toThrow(/links its follow-up invocation once/);
      // A second Run's boundary cannot reuse the consumed message.
      const boundary2 = seedSignoffBoundary(h, other);
      const sharedMessage = h.stores.conversations.postMessage({ conversationId: other.conversation.id, author: "operator", content: "again", runId: null, invocationId: null });
      h.stores.signoffResolutions.record({ runId: other.run.id, gateId: boundary2.gate.id, decisionId: boundary2.decision.id, outcome: "request_changes", operatorMessageId: sharedMessage.id });
      // The message is consumed: a second resolution answering it is refused at the database (one Run per Conversation is active, so directly).
      expect(() => rawResolution(h, { run_id: other.run.id, gate_id: boundary2.gate.id, decision_id: boundary2.decision.id, outcome: "request_changes", operator_message_id: sharedMessage.id })).toThrow(/UNIQUE constraint failed/);
    } finally {
      h.close();
    }
  });

  it("refuses a resolution once the Gate or the Decision is no longer open, or when they do not reference each other", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const boundary = seedSignoffBoundary(h, s);
      const message = h.stores.conversations.postMessage({ conversationId: s.conversation.id, author: "operator", content: "change", runId: s.run.id, invocationId: null });
      // The Decision resolved first: the store and the trigger both refuse.
      h.stores.decisions.resolve(boundary.decision.id, { resolvedBy: "operator", chosenOptionId: "request_changes", rationale: null, artifactIds: [] });
      expect(() => h.stores.signoffResolutions.record({ runId: s.run.id, gateId: boundary.gate.id, decisionId: boundary.decision.id, outcome: "request_changes", operatorMessageId: message.id })).toThrow(/is resolved/);
      expect(() => rawResolution(h, { run_id: s.run.id, gate_id: boundary.gate.id, decision_id: boundary.decision.id, outcome: "request_changes", operator_message_id: message.id })).toThrow(/signoff resolution resolves an open operator_signoff gate/);
      // The Gate closed: refused likewise.
      const other = seedRun(h);
      const boundary2 = seedSignoffBoundary(h, other);
      h.stores.gates.close(boundary2.gate.id, "failed", { kind: "changes_requested", decisionId: boundary2.decision.id });
      const message2 = h.stores.conversations.postMessage({ conversationId: other.conversation.id, author: "operator", content: "change", runId: other.run.id, invocationId: null });
      expect(() => h.stores.signoffResolutions.record({ runId: other.run.id, gateId: boundary2.gate.id, decisionId: boundary2.decision.id, outcome: "request_changes", operatorMessageId: message2.id })).toThrow(/is failed/);
      // A changes_requested failure belongs to an operator_signoff Gate alone, and it is the only failure such a Gate records.
      expect(() => h.stores.gates.close(boundary.completionGate.id, "failed", { kind: "changes_requested", decisionId: boundary.decision.id })).toThrow(IllegalTransitionError);
      const third = seedRun(h);
      const boundary3 = seedSignoffBoundary(h, third);
      expect(() => h.stores.gates.close(boundary3.gate.id, "failed", { kind: "evaluator_failed", invocationId: `inv_${"0".repeat(24)}` })).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("UPDATE gates SET status = 'failed', closed_at = ?, failure = ? WHERE id = ?").run(NOW, JSON.stringify({ kind: "evaluator_failed", invocationId: `inv_${"0".repeat(24)}` }), boundary3.gate.id)).toThrow(/gates_failure_by_kind/);
    } finally {
      h.close();
    }
  });
});
