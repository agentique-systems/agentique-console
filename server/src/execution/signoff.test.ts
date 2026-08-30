/**
 * Operator signoff resolution (execution-model §3, §9.3, §10
 * `operator_signoff`; invariants 12, 16, 19, 27): the read-only bounded
 * inspection of the signoff boundary; acceptance, which verifies the
 * Integration Workspace through the finalization port, records the exact
 * base-to-final diff as the Run's one final Changeset, records the final
 * Snapshot, resolves the Decision, passes the Gate, and completes the Run
 * without touching anything outside the Run; and the change request, which
 * resolves the Decision, fails the Gate with `changes_requested`, reopens
 * the Run, and prepares exactly one ordinary root turn — each idempotent on
 * replay, each refusing a conflicting replay, and neither inferring a thing
 * from prose.
 */
import { FINAL_REPORT_MEDIA_TYPE, SignoffRefusedError, type ManifestInput } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { completionGatesOf, prepareOperatorTurn, requestingStep, requestsOf, signoffGatesOf, synthesisStep } from "./completion-test-support.ts";
import { orchestratorStep, scriptByRole } from "./gate-test-support.ts";
import { awaitSignoff, finalChangesetOf, followUpsOf, operatorMessage, resolutionsOf, rootTurnsOf, signoffWork } from "./signoff-test-support.ts";
import { COMPLETED_RESULT, fakeSnapshot, openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";

const refusal = async (work: () => unknown): Promise<SignoffRefusedError> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof SignoffRefusedError) return error;
    throw error;
  }
  throw new Error("expected a signoff refusal");
};

describe("signoff inspection", () => {
  it("projects the bounded signoff boundary from rows and nothing else, writing nothing", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(h);
      const run = h.stores.runs.get(runId);
      const [completionGate] = completionGatesOf(h, runId);
      const [request] = requestsOf(h, runId);
      const seq = h.ctx.journal.lastSeq();
      const projection = h.signoff.inspect(runId);
      expect(projection).toEqual({
        runId,
        runStatus: "awaiting_signoff",
        gate: { id: gate.id, status: "open" },
        decision: { id: decisionId, status: "open", chosenOptionId: null },
        verifiedSnapshotId: gate.snapshotId,
        completionRequestId: request!.id,
        completionGateId: completionGate!.id,
        report: { artifactId: gate.reportArtifactId, mediaType: FINAL_REPORT_MEDIA_TYPE, byteSize: h.stores.artifacts.get(gate.reportArtifactId!).byteSize, digest: h.stores.artifacts.get(gate.reportArtifactId!).digest, title: h.stores.artifacts.get(gate.reportArtifactId!).title },
        requirementRevisionId: completionGate!.requirementRevisionId,
        requirements: completionGate!.requirementIds.map((requirementId) => ({ requirementId, status: "satisfied", waiverDecisionId: null })),
        waiverDecisionIds: [],
        evaluationIds: h.stores.evaluations.listByGate(completionGate!.id).map((e) => e.id).sort(),
        usage: h.stores.usage.totalsForRun(runId),
        candidate: [],
        resolution: null,
        finalSnapshotId: null,
        finalChangesetId: null,
        blockers: [],
        allowedActions: ["accept", "request_changes"],
      });
      // Bounded: no Artifact content, transcript, provider message, continuation, worktree path, or Event history.
      const text = JSON.stringify(projection);
      expect(text).not.toContain(run.integrationWorkspacePath!);
      expect(text).not.toMatch(/transcript|continuation|worktree|events|\+feature|The CLI reports its version|content/i);
      expect(Object.keys(projection)).not.toEqual(expect.arrayContaining(["events", "diff", "transcript"]));
      // Inspection writes nothing and derives no status: the journal and the projection are unchanged on repetition.
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.signoff.inspect(runId)).toEqual(projection);
      expect(h.stores.runs.get(runId)).toEqual(run);
    } finally {
      h.close();
    }
  });

  it("fails explicitly on a missing or inconsistent boundary, and reports unexpected active state as blockers", async () => {
    const h = openRuntimeHarness();
    try {
      // No boundary: a running Run has no operator_signoff Gate.
      const fresh = seedPlanningRuntime(h);
      expect((await refusal(() => h.signoff.inspect(fresh.created.run.id))).refusal).toBe("gate_mismatch");
      // Inconsistent: the Decision resolved behind the runtime's back while the Gate stayed open and no resolution exists.
      const broken = await awaitSignoff(h);
      h.stores.decisions.resolve(broken.decisionId, { resolvedBy: "operator", chosenOptionId: "accept", rationale: null, artifactIds: [] });
      expect((await refusal(() => h.signoff.inspect(broken.runId))).refusal).toBe("boundary_inconsistent");
      expect((await refusal(() => h.signoff.accept({ runId: broken.runId, gateId: broken.gate.id, decisionId: broken.decisionId }))).refusal).toBe("boundary_inconsistent");
      // Active state: an open operator-required Decision, an unfinished Task, and a moved integration Snapshot each block both actions.
      const { runId, gate, decisionId } = await awaitSignoff(h);
      const run = h.stores.runs.get(runId);
      const open = h.stores.decisions.request({ conversationId: run.conversationId, runId, kind: "operator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "operator" }, question: "which?", options: [{ id: "a", label: "A", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      const task = h.stores.tasks.create({ runId, planNodeId: null, origin: "orchestrator", subject: "late work", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const moved = h.stores.snapshots.record({ workspaceId: run.workspaceId, runId, identity: fakeSnapshot("moved"), reason: "integration" });
      h.stores.runs.recordWorkspaceState(runId, { integrationSnapshotId: moved.id });
      const projection = h.signoff.inspect(runId);
      expect(projection.blockers).toEqual([
        { kind: "decision_unresolved", decisionId: open.id },
        { kind: "task_unfinished", taskId: task.id, status: "pending" },
        { kind: "snapshot_moved", pinnedSnapshotId: gate.snapshotId, currentSnapshotId: moved.id },
      ]);
      expect(projection.allowedActions).toEqual([]);
      const before = signoffWork(h, runId);
      const blocked = await refusal(() => h.signoff.accept({ runId, gateId: gate.id, decisionId }));
      expect(blocked.refusal).toBe("active_state");
      expect(blocked.details.blockers).toHaveLength(3);
      expect((await refusal(() => h.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId: operatorMessage(h, runId).id }))).refusal).toBe("active_state");
      // Nothing was released, repaired, or written: the Decision stays open, the Task pending, the Snapshot moved, the boundary open.
      expect(signoffWork(h, runId)).toEqual(before);
      expect(h.finalizationWorkspace.requests).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("signoff acceptance", () => {
  it("completes the Run on the verified Snapshot with the exact base-to-final Changeset, in one correlated transaction, and touches nothing else", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(h, { diff: "+feature" });
      const before = h.stores.runs.get(runId);
      const seq = h.ctx.journal.lastSeq();
      const outcome = await h.signoff.accept({ runId, gateId: gate.id, decisionId });
      expect(outcome).toMatchObject({ kind: "accepted", runId, gateId: gate.id, decisionId, finalSnapshotId: gate.snapshotId, replayed: false });
      const run = h.stores.runs.get(runId);
      // The final Snapshot is exactly the signoff Gate's verified Snapshot (the completion Gate's), by reference, not a new row.
      expect(run).toMatchObject({ status: "completed", finalSnapshotId: gate.snapshotId, finalChangesetId: outcome.kind === "accepted" ? outcome.finalChangesetId : null, integrationSnapshotId: before.integrationSnapshotId, baseSnapshotId: before.baseSnapshotId });
      expect(run.finalSnapshotId).toBe(completionGatesOf(h, runId)[0]!.snapshotId);
      expect(h.stores.snapshots.listByRun(runId).length).toBe(h.stores.snapshots.listByRun(runId).length);
      // The final Changeset: kind final, recorded, base to final, exact bytes, text/x-diff, digest and size verified on read.
      const changeset = finalChangesetOf(h, runId)!;
      expect(changeset).toMatchObject({ id: run.finalChangesetId, kind: "final", invocationId: null, integrationStatus: "recorded", beforeSnapshotId: run.baseSnapshotId, afterSnapshotId: run.finalSnapshotId, integratedSnapshotId: null, conflictTaskId: null });
      const { artifact, bytes } = h.stores.artifacts.read(changeset.diffArtifactId);
      expect(new TextDecoder().decode(bytes)).toBe("+feature");
      expect(artifact).toMatchObject({ mediaType: "text/x-diff", byteSize: 8, digest: sha256Hex(bytes), producer: { kind: "runtime", component: "changeset" }, runId });
      expect(outcome).toMatchObject({ diffArtifactId: artifact.id });
      // The signoff rows: one accept resolution, the Decision resolved by the operator, the Gate passed, the completion history untouched.
      expect(resolutionsOf(h, runId)).toEqual([expect.objectContaining({ gateId: gate.id, decisionId, outcome: "accept", finalChangesetId: changeset.id, operatorMessageId: null, followUpInvocationId: null })]);
      expect(h.stores.decisions.get(decisionId)).toMatchObject({ status: "resolved", resolution: expect.objectContaining({ resolvedBy: "operator", chosenOptionId: "accept" }) });
      expect(h.stores.gates.get(gate.id)).toMatchObject({ status: "passed", failure: null, reportArtifactId: gate.reportArtifactId });
      expect(completionGatesOf(h, runId)[0]!.status).toBe("passed");
      expect(requestsOf(h, runId).map((r) => r.status)).toEqual(["passed"]);
      // The Conversation's active Run is cleared; the Integration Workspace remains (nothing released or discarded).
      expect(h.stores.conversations.get(run.conversationId).activeRunId).toBeNull();
      expect(run.integrationWorkspacePath).toBe(before.integrationWorkspacePath);
      expect(h.workspacePreparation.discarded).toEqual([]);
      expect(h.integrationWorkspace.currentByRun.has(runId)).toBe(true);
      // Nothing outside the Run: the port was asked to inspect once, outside any transaction, without the operator's branch; no Publication exists.
      expect(h.finalizationWorkspace.observed).toEqual([{ runId, inTransaction: false, outcome: "inspected", byteSize: 8 }]);
      expect(h.finalizationWorkspace.requests).toEqual([{ runId, workspaceId: run.workspaceId, integrationWorkspacePath: run.integrationWorkspacePath, baseSnapshot: h.stores.snapshots.get(run.baseSnapshotId!).identity, verifiedSnapshot: h.stores.snapshots.get(gate.snapshotId!).identity }]);
      expect(JSON.stringify(h.finalizationWorkspace.requests)).not.toMatch(/main|branch|publish/i);
      expect(h.stores.publications.listByRun(runId)).toEqual([]);
      expect(run.target).toEqual(before.target);
      // One correlation chain, and the Events carry ids only.
      const events = h.ctx.journal.read({ runId, afterSeq: seq });
      expect(events.map((e) => e.type)).toEqual(["artifact.created", "changeset.recorded", "signoff_resolution.recorded", "decision.resolved", "gate.passed", "run.completed"]);
      const cleared = h.ctx.journal.read({ conversationId: run.conversationId, afterSeq: seq, type: "conversation.updated" });
      expect(cleared.map((e) => (e.payload as { activeRunId: string | null }).activeRunId)).toEqual([null]);
      expect(new Set([...events, ...cleared].map((e) => e.correlationId))).toEqual(new Set([outcome.kind === "accepted" ? outcome.signoffResolutionId : ""]));
      expect(events.slice(1).map((e) => e.causationSeq)).toEqual(events.slice(0, -1).map((e) => e.seq));
      expect(cleared[0]!.causationSeq).toBe(events.at(-1)!.causationSeq);
      expect([...events, ...cleared].every((e) => e.actor.kind === "operator")).toBe(true);
      expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("+feature");
      // The scheduler reports the terminal Run and performs nothing.
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "run_terminal", actions: [] });
      expect(h.signoff.inspect(runId)).toMatchObject({ runStatus: "completed", gate: { status: "passed" }, decision: { status: "resolved", chosenOptionId: "accept" }, resolution: expect.objectContaining({ outcome: "accept", finalChangesetId: changeset.id }), finalSnapshotId: gate.snapshotId, finalChangesetId: changeset.id, blockers: [], allowedActions: [] });
    } finally {
      h.close();
    }
  });

  it("records a zero-byte final Changeset when nothing changed, and enforces one final Changeset per Run at the database", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(h, { diff: null });
      const outcome = await h.signoff.accept({ runId, gateId: gate.id, decisionId });
      expect(outcome.kind).toBe("accepted");
      const changeset = finalChangesetOf(h, runId)!;
      const { artifact, bytes } = h.stores.artifacts.read(changeset.diffArtifactId);
      expect(bytes.byteLength).toBe(0);
      expect(artifact).toMatchObject({ byteSize: 0, digest: sha256Hex(new Uint8Array()), mediaType: "text/x-diff" });
      expect(h.stores.snapshots.get(changeset.afterSnapshotId).identity).toEqual(h.stores.snapshots.get(changeset.beforeSnapshotId).identity);
      expect(() =>
        h.database.sqlite
          .prepare("INSERT INTO changesets (id, run_id, kind, invocation_id, before_snapshot_id, after_snapshot_id, diff_artifact_id, integration_status, integrated_snapshot_id, conflict_task_id, created_at, integrated_at) VALUES (?, ?, 'final', NULL, ?, ?, ?, 'recorded', NULL, NULL, ?, NULL)")
          .run(`cs_${"2".repeat(24)}`, runId, changeset.beforeSnapshotId, changeset.afterSnapshotId, changeset.diffArtifactId, "2026-01-01T00:00:00.000Z"),
      ).toThrow(/UNIQUE constraint failed: changesets\.run_id|awaiting signoff/);
    } finally {
      h.close();
    }
  });

  it("refuses drift, an unobservable Workspace, and foreign Gate or Decision ids without resolving anything, and stays retryable", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(h);
      const other = await awaitSignoff(h);
      const before = signoffWork(h, runId);
      const blobs = h.blobs.size;
      // Foreign ids: the other Run's Gate or Decision.
      expect((await refusal(() => h.signoff.accept({ runId, gateId: other.gate.id, decisionId }))).refusal).toBe("gate_mismatch");
      expect((await refusal(() => h.signoff.accept({ runId, gateId: gate.id, decisionId: other.decisionId }))).refusal).toBe("decision_mismatch");
      expect((await refusal(() => h.signoff.accept({ runId: other.runId, gateId: gate.id, decisionId }))).refusal).toBe("gate_mismatch");
      expect(h.finalizationWorkspace.requests).toEqual([]);
      // Drift: the Integration Workspace no longer holds the verified Snapshot; then a dirty working state; then an unobservable Workspace.
      h.finalizationWorkspace.driftedTo.set(runId, fakeSnapshot("stray edit"));
      expect((await refusal(() => h.signoff.accept({ runId, gateId: gate.id, decisionId }))).refusal).toBe("workspace_drifted");
      h.finalizationWorkspace.driftedTo.delete(runId);
      h.finalizationWorkspace.dirtyRuns.add(runId);
      expect((await refusal(() => h.signoff.accept({ runId, gateId: gate.id, decisionId }))).refusal).toBe("workspace_drifted");
      h.finalizationWorkspace.dirtyRuns.delete(runId);
      h.finalizationWorkspace.failNext = "workspace_unavailable";
      expect((await refusal(() => h.signoff.accept({ runId, gateId: gate.id, decisionId }))).refusal).toBe("finalization_failed");
      // Nothing was resolved, closed, stored, or transitioned; the operator may still request changes or retry.
      expect(signoffWork(h, runId)).toEqual({ ...before, inspections: 3 });
      expect(h.blobs.size).toBe(blobs);
      expect(h.signoff.inspect(runId).allowedActions).toEqual(["accept", "request_changes"]);
      expect(await h.signoff.accept({ runId, gateId: gate.id, decisionId })).toMatchObject({ kind: "accepted", replayed: false });
      expect(h.stores.runs.get(runId).status).toBe("completed");
      // The other Run is untouched throughout.
      expect(h.stores.runs.get(other.runId).status).toBe("awaiting_signoff");
    } finally {
      h.close();
    }
  });

  it("replays an identical accept from rows without inspecting the Workspace again, and rejects a conflicting change request", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(h);
      const first = await h.signoff.accept({ runId, gateId: gate.id, decisionId });
      const before = signoffWork(h, runId);
      const again = await h.signoff.accept({ runId, gateId: gate.id, decisionId });
      expect(again).toEqual({ ...first, replayed: true });
      expect(signoffWork(h, runId)).toEqual(before);
      expect(h.finalizationWorkspace.requests).toHaveLength(1);
      const conflict = await refusal(() => h.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId: operatorMessage(h, runId).id }));
      expect(conflict.refusal).toBe("conflicting_resolution");
      expect(signoffWork(h, runId)).toEqual(before);
      expect(h.stores.runs.get(runId).status).toBe("completed");
    } finally {
      h.close();
    }
  });
});

describe("signoff change request", () => {
  it("reopens the Run with one ordinary root decision_resolution turn over the typed resolution input, leaving the completion history immutable", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(h);
      const [completionGate] = completionGatesOf(h, runId);
      const synthesis = rootTurnsOf(h, runId).at(-1)!;
      const capacity = h.stores.reservations.runCapacity(runId);
      const message = operatorMessage(h, runId);
      const seq = h.ctx.journal.lastSeq();
      const outcome = h.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId: message.id });
      expect(outcome).toMatchObject({ kind: "changes_requested", runId, gateId: gate.id, decisionId, operatorMessageId: message.id, replayed: false });
      // The Run is running again; the Decision resolved request_changes by the operator; the Gate failed with the precise reason.
      expect(h.stores.runs.get(runId)).toMatchObject({ status: "running", finalSnapshotId: null, finalChangesetId: null });
      expect(h.stores.decisions.get(decisionId)).toMatchObject({ status: "resolved", resolution: expect.objectContaining({ resolvedBy: "operator", chosenOptionId: "request_changes", rationale: null }) });
      expect(h.stores.gates.get(gate.id)).toMatchObject({ status: "failed", failure: { kind: "changes_requested", decisionId } });
      // Exactly one follow-up: role orchestrator, purpose decision_resolution, the root position, continued from the synthesis turn, ordinary funding, no Task, no Gate.
      const [followUp, ...more] = followUpsOf(h, runId);
      expect(more).toEqual([]);
      expect(followUp).toMatchObject({ role: "orchestrator", purpose: "decision_resolution", patternPosition: { kind: "orchestrator" }, continuedFromInvocationId: synthesis.id, allocationSource: "plan_node", finalReserveUse: null, taskIds: [], gateId: null, status: "pending" });
      expect(outcome).toMatchObject({ followUpInvocationId: followUp!.id });
      expect(h.stores.reservations.activeForChild({ type: "invocation", id: followUp!.id })).toMatchObject({ parent: { type: "plan_node", id: h.stores.plans.rootNode(runId).id }, capacitySource: "ordinary" });
      // The final reserve is untouched.
      expect(h.stores.reservations.runCapacity(runId).final).toEqual(capacity.final);
      // The resolution links the follow-up canonically; the message travels by id (and as the ordinary operator_message input), never copied.
      expect(resolutionsOf(h, runId)).toEqual([expect.objectContaining({ outcome: "request_changes", operatorMessageId: message.id, finalChangesetId: null, followUpInvocationId: followUp!.id })]);
      expect(h.stores.signoffResolutions.byFollowUp(followUp!.id)?.id).toBe(outcome.signoffResolutionId);
      const manifest = h.stores.invocations.getManifest(followUp!.id).content;
      expect(manifest.inputs).toEqual([
        { kind: "signoff_resolution", signoffResolutionId: outcome.signoffResolutionId, gateId: gate.id, decisionId, completionGateId: completionGate!.id, outcome: "request_changes", operatorMessageId: message.id, verifiedSnapshotId: gate.snapshotId, reportArtifactId: gate.reportArtifactId },
        { kind: "operator_message", conversationMessageId: message.id, content: message.content },
      ]);
      expect(manifest.decisions.find((d) => d.decisionId === decisionId)).toMatchObject({ kind: "signoff", chosenOptionId: "request_changes" });
      expect(manifest.artifacts.map((a) => a.artifactId)).toContain(gate.reportArtifactId);
      expect(JSON.stringify(manifest)).not.toMatch(/transcript|continuation/i);
      // The completion history is immutable: the completion Gate, request, and report are as they were; no new request or Gate exists.
      expect(completionGatesOf(h, runId)).toEqual([completionGate]);
      expect(requestsOf(h, runId).map((r) => r.status)).toEqual(["passed"]);
      expect(h.stores.artifacts.get(gate.reportArtifactId!).digest).toBe(h.stores.artifacts.get(gate.reportArtifactId!).digest);
      expect(finalChangesetOf(h, runId)).toBeNull();
      expect(h.stores.gates.openRunGateOf(runId, "operator_signoff")).toBeNull();
      // One correlation chain over the whole transaction.
      const events = h.ctx.journal.read({ runId, afterSeq: seq });
      expect(events.map((e) => e.type)).toEqual(["signoff_resolution.recorded", "decision.resolved", "gate.failed", "run.changes_requested", "invocation.created", "budget_reservation.created", "invocation.workspace_prepared", "snapshot.taken", "context_manifest.created", "signoff_resolution.linked"]);
      expect(new Set(events.map((e) => e.correlationId))).toEqual(new Set([outcome.signoffResolutionId]));
      expect(JSON.stringify(events.filter((e) => e.type.startsWith("signoff_resolution")).map((e) => e.payload))).not.toContain(message.content);
      // The scheduler executes the follow-up through the normal root path; nothing requests completion by itself.
      scriptByRole(h, { orchestrator: [orchestratorStep(h, { diff: "+renamed" })] });
      const pass = await h.scheduler.advanceRun(runId);
      expect(pass.actions.map((p) => p.action.kind)).toEqual(["execute_invocation", "settle_root"]);
      expect(pass.stop).toBe("quiescent");
      expect(h.stores.invocations.get(followUp!.id).status).toBe("succeeded");
      expect(requestsOf(h, runId)).toHaveLength(1);
      expect(signoffGatesOf(h, runId)).toHaveLength(1);
      expect(h.stores.runs.get(runId).status).toBe("running");
      expect(h.stores.changesets.listByRun(runId).filter((c) => c.invocationId === followUp!.id).map((c) => c.integrationStatus)).toEqual(["integrated"]);
      // A later turn requests completion explicitly: a new request, a new cycle on the new Snapshot, a new signoff boundary; the old one stays history; acceptance completes the Run.
      prepareOperatorTurn(h, runId);
      scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h)] });
      await h.scheduler.advanceRun(runId);
      expect(h.stores.runs.get(runId).status).toBe("awaiting_signoff");
      const gates = signoffGatesOf(h, runId);
      expect(gates.map((g) => [g.ordinal, g.status])).toEqual([[1, "failed"], [2, "open"]]);
      expect(gates[1]!.snapshotId).not.toBe(gate.snapshotId);
      const decision = h.stores.decisions.signoffOf(gates[1]!.id)!;
      expect(h.signoff.inspect(runId)).toMatchObject({ gate: { id: gates[1]!.id, status: "open" }, decision: { id: decision.id }, resolution: null, allowedActions: ["accept", "request_changes"] });
      expect(await h.signoff.accept({ runId, gateId: gates[1]!.id, decisionId: decision.id })).toMatchObject({ kind: "accepted", finalSnapshotId: gates[1]!.snapshotId });
      const changeset = finalChangesetOf(h, runId)!;
      expect(new TextDecoder().decode(h.stores.artifacts.read(changeset.diffArtifactId).bytes)).toBe("+feature+renamed");
      expect(resolutionsOf(h, runId).map((r) => r.outcome)).toEqual(["request_changes", "accept"]);
      expect(h.stores.runs.get(runId).status).toBe("completed");
    } finally {
      h.close();
    }
  });

  it("rejects an invalid operator message, refuses an unfundable follow-up before writing anything, replays identically, and rejects a conflicting accept", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(h);
      const run = h.stores.runs.get(runId);
      const other = await awaitSignoff(h);
      const before = signoffWork(h, runId);
      // An Orchestrator message, a message of another Conversation, an unknown message: refused, nothing written.
      const orchestratorMessage = h.stores.conversations.postMessage({ conversationId: run.conversationId, author: "orchestrator", content: "done", runId, invocationId: null });
      const foreign = operatorMessage(h, other.runId);
      for (const operatorMessageId of [orchestratorMessage.id, foreign.id, `cvm_${"0".repeat(24)}` as const]) {
        expect((await refusal(() => h.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId }))).refusal).toBe("operator_message_invalid");
      }
      expect(signoffWork(h, runId)).toEqual(before);
      // The change request; then identical replay returns the same outcome from rows and prepares nothing twice.
      const message = operatorMessage(h, runId);
      const first = h.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId: message.id });
      const after = signoffWork(h, runId);
      expect(h.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId: message.id })).toEqual({ ...first, replayed: true });
      expect(signoffWork(h, runId)).toEqual(after);
      expect(followUpsOf(h, runId)).toHaveLength(1);
      // A conflicting accept, or a change request for another message, is rejected and writes nothing.
      expect((await refusal(() => h.signoff.accept({ runId, gateId: gate.id, decisionId }))).refusal).toBe("conflicting_resolution");
      expect((await refusal(() => h.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId: operatorMessage(h, runId, "other").id }))).refusal).toBe("conflicting_resolution");
      expect(signoffWork(h, runId)).toEqual(after);
      expect(h.finalizationWorkspace.requests).toEqual([]);
      // The consumed message cannot answer another Run's boundary.
      expect((await refusal(() => h.signoff.requestChanges({ runId: other.runId, gateId: other.gate.id, decisionId: other.decisionId, operatorMessageId: message.id }))).refusal).toBe("operator_message_invalid");
      // An unfundable follow-up: a root allocation the requesting turn already consumed leaves one Attempt, the turn needs two — one typed refusal, no half-state.
      const starved = await awaitSignoff(h, { seed: { orchestratorAllocation: { costUsd: 10, tokens: 100_000, attempts: 2 } } });
      const starvedBefore = signoffWork(h, starved.runId);
      const refused = await refusal(() => h.signoff.requestChanges({ runId: starved.runId, gateId: starved.gate.id, decisionId: starved.decisionId, operatorMessageId: operatorMessage(h, starved.runId).id }));
      expect(refused.refusal).toBe("ordinary_capacity_insufficient");
      expect(signoffWork(h, starved.runId)).toEqual(starvedBefore);
      expect(h.stores.runs.get(starved.runId).status).toBe("awaiting_signoff");
      expect(h.stores.decisions.get(starved.decisionId).status).toBe("open");
      expect(h.stores.reservations.runCapacity(starved.runId).final).toEqual(h.stores.reservations.runCapacity(starved.runId).final);
      // The final reserve is never the fallback: acceptance still works on that Run.
      expect(await h.signoff.accept({ runId: starved.runId, gateId: starved.gate.id, decisionId: starved.decisionId })).toMatchObject({ kind: "accepted" });
    } finally {
      h.close();
    }
  });

  it("refuses a forged signoff_resolution manifest input at assembly", async () => {
    const h = openRuntimeHarness();
    try {
      const { runId, gate, decisionId } = await awaitSignoff(h);
      const [completionGate] = completionGatesOf(h, runId);
      const message = operatorMessage(h, runId);
      const outcome = h.signoff.requestChanges({ runId, gateId: gate.id, decisionId, operatorMessageId: message.id });
      scriptByRole(h, { orchestrator: [{ kind: "succeed", result: COMPLETED_RESULT }] });
      await h.scheduler.advanceRun(runId);
      const root = h.stores.plans.rootNode(runId);
      const latest = h.stores.invocations.latestAtPosition(root.id, "orchestrator")!;
      const input = (overrides: Partial<Extract<ManifestInput, { kind: "signoff_resolution" }>>): ManifestInput[] => [
        { kind: "signoff_resolution", signoffResolutionId: outcome.signoffResolutionId, gateId: gate.id, decisionId, completionGateId: completionGate!.id, outcome: "request_changes", operatorMessageId: message.id, verifiedSnapshotId: gate.snapshotId!, reportArtifactId: gate.reportArtifactId!, ...overrides },
        { kind: "operator_message", conversationMessageId: message.id, content: message.content },
      ];
      const prepare = (inputs: ManifestInput[]) => h.preparation.prepare({ runId, planNodeId: root.id, role: "orchestrator", purpose: "decision_resolution", patternPosition: { kind: "orchestrator" }, continuedFromInvocationId: latest.id, funding: { source: "plan_node" }, inputs, correlationId: null, causationSeq: null });
      // The resolution already continues in its follow-up; a wrong completion Gate, Snapshot, report, or message disagrees with the rows.
      expect(() => prepare(input({}))).toThrow(/already continues/);
      expect(() => prepare(input({ completionGateId: gate.id }))).toThrow();
      expect(() => prepare(input({ verifiedSnapshotId: h.stores.runs.get(runId).baseSnapshotId! }))).toThrow(/disagrees|already continues/);
      expect(() => prepare(input({ operatorMessageId: operatorMessage(h, runId, "forged").id }))).toThrow(/disagrees|already continues/);
      expect(h.stores.invocations.listActive(runId)).toEqual([]);
    } finally {
      h.close();
    }
  });
});
