/**
 * Changeset integration (execution-model §9.2; invariant 16 the Target is
 * never modified): clean and empty application recorded atomically after
 * the external apply, conflicts persisted through the Changeset lifecycle
 * with a bounded Artifact and one canonical Task, crash reconciliation by
 * Changeset id, idempotent replay, serialization within a Run, and the
 * integrated Snapshot becoming the next worktree's starting state.
 */
import { type Changeset, type Invocation } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { COMPLETED_RESULT, accepted, fakeSnapshot, openRuntimeHarness, propose, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

/** A running single worker node with one succeeded writing Invocation whose Changeset is pending. */
async function completedWriter(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>, options: { empty?: boolean; index?: number } = {}): Promise<{ node: ReturnType<typeof h.stores.plans.getNode>; invocation: Invocation; changeset: Changeset }> {
  const index = options.index ?? 0;
  // Earlier writer nodes are re-proposed unchanged so they are reused; the new one is appended.
  const plan = accepted(propose(h, s, Array.from({ length: index + 1 }, (_, i) => ({ pattern: "single" as const, operation: { agentDefinitionRevisionId: s.worker.id, title: `write ${i}` }, allocation: { costUsd: 6, tokens: 60_000, attempts: 4 } }))));
  const node = plan.graph.nodes[index + 1]!;
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  h.stores.plans.transitionNode(node.id, { to: "running" });
  const { invocation } = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", continuedFromInvocationId: null, patternPosition: { kind: "single" } });
  if (!options.empty) h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("after", invocation.id), diff: new TextEncoder().encode(`diff --git a/x b/x\n+${invocation.id}\n`), empty: false };
  h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "finalized" || outcome.settlement.invocation.status !== "succeeded") throw new Error(`expected success, got ${outcome.kind}`);
  const changeset = h.stores.changesets.listByRun(s.created.run.id).find((c) => c.invocationId === invocation.id)!;
  return { node: h.stores.plans.getNode(node.id), invocation: outcome.settlement.invocation, changeset };
}

describe("ChangesetIntegrationService", () => {
  it("applies a pending Changeset outside any transaction, then records the integration Snapshot, the Changeset, and the Run atomically", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { invocation, changeset } = await completedWriter(h, s);
      const run = h.stores.runs.get(s.created.run.id);
      const base = h.stores.snapshots.get(run.baseSnapshotId!);
      expect(changeset.integrationStatus).toBe("pending");
      expect(run.integrationSnapshotId).toBeNull();
      // The port is awaited with no transaction open.
      let release!: () => void;
      h.integrationWorkspace.gate = new Promise<void>((resolve) => (release = resolve));
      const pending = h.integration.integrate(changeset.id);
      await Promise.resolve();
      expect(h.ctx.tx.inTransaction).toBe(false);
      expect(h.integrationWorkspace.requests).toHaveLength(1);
      expect(h.integrationWorkspace.requests[0]).toEqual({
        runId: run.id,
        changesetId: changeset.id,
        integrationWorkspacePath: run.integrationWorkspacePath,
        currentSnapshot: base.identity,
        changeset: { beforeSnapshot: h.stores.snapshots.get(changeset.beforeSnapshotId).identity, afterSnapshot: h.stores.snapshots.get(changeset.afterSnapshotId).identity, diffArtifactId: changeset.diffArtifactId, diffDigest: h.stores.artifacts.get(changeset.diffArtifactId).digest, diffByteSize: h.stores.artifacts.get(changeset.diffArtifactId).byteSize, empty: false },
      });
      // Nothing about the Target reaches the port, and the Target is unchanged.
      expect(Object.keys(h.integrationWorkspace.requests[0]!)).not.toContain("target");
      const seq = h.ctx.journal.lastSeq();
      release();
      const outcome = await pending;
      expect(outcome.kind).toBe("integrated");
      if (outcome.kind !== "integrated") throw new Error("unreachable");
      expect(outcome.snapshot).toMatchObject({ reason: "integration", runId: run.id, identity: fakeSnapshot(base.identity.kind === "git" ? base.identity.commitId : "", changeset.id) });
      expect(outcome.changeset).toMatchObject({ integrationStatus: "integrated", integratedSnapshotId: outcome.snapshot.id, conflictTaskId: null });
      expect(outcome.changeset.integratedAt).not.toBeNull();
      const after = h.stores.runs.get(run.id);
      expect(after.integrationSnapshotId).toBe(outcome.snapshot.id);
      expect(after.target).toEqual(run.target);
      expect(after.baseSnapshotId).toBe(run.baseSnapshotId);
      expect(h.ctx.journal.read({ runId: run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["snapshot.taken", "changeset.integrated", "run.integrated"]);
      expect(h.ctx.journal.read({ runId: run.id, type: "run.integrated" })[0]!.payload).toEqual({ runId: run.id, changesetId: changeset.id, integrationSnapshotId: outcome.snapshot.id });
      expect(h.workspacePreparation.prepared).toHaveLength(1);
      // Replay is a no-op: nothing applied, nothing written.
      expect(await h.integration.integrate(changeset.id)).toEqual({ kind: "already_integrated", changeset: outcome.changeset });
      expect(h.integrationWorkspace.requests).toHaveLength(1);
      expect(h.ctx.journal.lastSeq()).toBe(seq + 3);
      expect(h.integration.outstanding(run.id)).toEqual([]);
      // The next writing Invocation on any node starts from the integrated Snapshot, not the base.
      const next = h.preparation.prepare({ runId: run.id, planNodeId: invocation.planNodeId, role: "worker", purpose: "step", continuedFromInvocationId: invocation.id, patternPosition: { kind: "single" } });
      expect(h.stores.snapshots.get(next.manifest.content.startingSnapshotId!).identity).toEqual(outcome.snapshot.identity);
      expect(h.executionWorkspace.prepared.at(-1)!.request.integrationSnapshot).toEqual(outcome.snapshot.identity);
    } finally {
      h.close();
    }
  });

  it("integrates an empty Changeset trivially, keeping the integration Snapshot's identity", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { changeset } = await completedWriter(h, s, { empty: true });
      expect(h.stores.artifacts.get(changeset.diffArtifactId).byteSize).toBe(0);
      const outcome = await h.integration.integrate(changeset.id);
      if (outcome.kind !== "integrated") throw new Error(outcome.kind);
      expect(h.integrationWorkspace.requests[0]!.changeset.empty).toBe(true);
      const base = h.stores.snapshots.get(s.created.run.baseSnapshotId!);
      expect(outcome.snapshot.identity).toEqual(base.identity);
      expect(outcome.snapshot.id).not.toBe(base.id);
      expect(h.stores.runs.get(s.created.run.id).integrationSnapshotId).toBe(outcome.snapshot.id);
    } finally {
      h.close();
    }
  });

  it("persists a conflict as the Changeset lifecycle, a bounded Artifact, and one runtime Task on the node; integrates once the Task completed; reports the rest unresolved", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { node, changeset } = await completedWriter(h, s);
      h.integrationWorkspace.conflictNext.add(changeset.id);
      const seq = h.ctx.journal.lastSeq();
      const outcome = await h.integration.integrate(changeset.id);
      expect(outcome.kind).toBe("conflict");
      if (outcome.kind !== "conflict") throw new Error("unreachable");
      expect(outcome.changeset).toMatchObject({ integrationStatus: "conflict", conflictTaskId: outcome.task.id, integratedSnapshotId: null });
      expect(outcome.task).toMatchObject({ origin: "runtime", planNodeId: node.id, status: "pending", inputArtifactIds: [outcome.artifact.id, changeset.diffArtifactId], subject: `Resolve the integration conflict of Changeset ${changeset.id}` });
      expect(outcome.artifact).toMatchObject({ mediaType: "text/plain", producer: { kind: "runtime", component: "changeset" }, runId: s.created.run.id });
      expect(new TextDecoder().decode(h.stores.artifacts.read(outcome.artifact.id).bytes)).toContain("CONFLICT");
      expect(h.stores.runs.get(s.created.run.id).integrationSnapshotId).toBeNull();
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["artifact.created", "task.created", "changeset.conflicted"]);
      // Nothing applied, nothing repeated: while the Task is open every call reports the pending conflict without touching the port.
      expect(h.integrationWorkspace.applied.size).toBe(0);
      expect(await h.integration.integrate(changeset.id)).toMatchObject({ kind: "conflict_pending", task: { id: outcome.task.id } });
      expect(h.integrationWorkspace.requests).toHaveLength(1);
      expect(h.integration.outstanding(s.created.run.id)).toEqual([]);
      // The Task completes (the later resolution phase): the Changeset is integrated on the next reconciliation.
      h.stores.tasks.transition(outcome.task.id, { to: "ready" });
      h.stores.tasks.transition(outcome.task.id, { to: "running", invocationId: s.invocation.id });
      h.stores.tasks.transition(outcome.task.id, { to: "completed", evidence: [{ kind: "artifact", artifactId: outcome.artifact.id }], outputArtifactIds: [] });
      expect(h.integration.outstanding(s.created.run.id).map((c) => c.id)).toEqual([changeset.id]);
      const integrated = await h.integration.integrate(changeset.id);
      expect(integrated).toMatchObject({ kind: "integrated", changeset: { integrationStatus: "integrated", conflictTaskId: null } });
      expect(h.integrationWorkspace.requests).toHaveLength(2);
    } finally {
      h.close();
    }
    // A conflict Task that ends without completing, or a Changeset that conflicts again after it completed, is unresolved: no automatic resolution is invented.
    const u = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(u);
      const { changeset } = await completedWriter(u, s);
      u.integrationWorkspace.conflictAlways.add(changeset.id);
      const conflict = await u.integration.integrate(changeset.id);
      if (conflict.kind !== "conflict") throw new Error(conflict.kind);
      u.stores.tasks.transition(conflict.task.id, { to: "cancelled" });
      expect(await u.integration.integrate(changeset.id)).toMatchObject({ kind: "conflict_unresolved", cause: "task_cancelled" });
      expect(u.integrationWorkspace.requests).toHaveLength(1);
      const s2 = seedPlanningRuntime(u);
      const second = await completedWriter(u, s2);
      u.integrationWorkspace.conflictAlways.add(second.changeset.id);
      const again = await u.integration.integrate(second.changeset.id);
      if (again.kind !== "conflict") throw new Error(again.kind);
      u.stores.tasks.transition(again.task.id, { to: "ready" });
      u.stores.tasks.transition(again.task.id, { to: "running", invocationId: second.invocation.id });
      u.stores.tasks.transition(again.task.id, { to: "completed", evidence: [{ kind: "artifact", artifactId: again.artifact.id }], outputArtifactIds: [] });
      expect(await u.integration.integrate(second.changeset.id)).toMatchObject({ kind: "conflict_unresolved", cause: "conflicted_again" });
      expect(u.stores.changesets.get(second.changeset.id).integrationStatus).toBe("conflict");
    } finally {
      u.close();
    }
  });

  it("reconciles a crash after the external apply and before persistence by Changeset id, applying nothing twice", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { changeset } = await completedWriter(h, s);
      const seq = h.ctx.journal.lastSeq();
      h.integrationWorkspace.crashAfterApply = true;
      await expect(h.integration.integrate(changeset.id)).rejects.toThrow(/process died/);
      // The external state moved; the canonical state did not.
      expect(h.integrationWorkspace.applied.has(changeset.id)).toBe(true);
      expect(h.stores.changesets.get(changeset.id).integrationStatus).toBe("pending");
      expect(h.stores.runs.get(s.created.run.id).integrationSnapshotId).toBeNull();
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.integration.outstanding(s.created.run.id).map((c) => c.id)).toEqual([changeset.id]);
      // Reconciliation asks the port again; the port reports the already-applied Snapshot; persistence catches up once.
      const outcome = await h.integration.integrate(changeset.id);
      expect(outcome.kind).toBe("integrated");
      if (outcome.kind !== "integrated") throw new Error("unreachable");
      expect(outcome.snapshot.identity).toEqual(h.integrationWorkspace.applied.get(changeset.id));
      expect(h.integrationWorkspace.requests).toHaveLength(2);
      expect(h.stores.snapshots.listByRun(s.created.run.id).filter((x) => x.reason === "integration")).toHaveLength(1);
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["snapshot.taken", "changeset.integrated", "run.integrated"]);
      // A persistence failure after a successful apply is the same case: the next call records without re-applying.
      const s2 = seedPlanningRuntime(h);
      const second = await completedWriter(h, s2);
      const record = h.stores.runs.recordIntegration.bind(h.stores.runs);
      h.stores.runs.recordIntegration = () => {
        throw new Error("disk full");
      };
      await expect(h.integration.integrate(second.changeset.id)).rejects.toThrow("disk full");
      h.stores.runs.recordIntegration = record;
      expect(h.stores.changesets.get(second.changeset.id).integrationStatus).toBe("pending");
      expect(await h.integration.integrate(second.changeset.id)).toMatchObject({ kind: "integrated" });
      expect(h.integrationWorkspace.requests.filter((r) => r.changesetId === second.changeset.id)).toHaveLength(2);
      expect(h.stores.snapshots.listByRun(s2.created.run.id).filter((x) => x.reason === "integration")).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("serializes integration within one Run, integrates in call order, and never runs inside a transaction", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const first = await completedWriter(h, s);
      const second = await completedWriter(h, s, { index: 1 });
      let release!: () => void;
      h.integrationWorkspace.gate = new Promise<void>((resolve) => (release = resolve));
      const a = h.integration.integrate(first.changeset.id);
      const b = h.integration.integrate(second.changeset.id);
      await Promise.resolve();
      expect(h.integrationWorkspace.requests.map((r) => r.changesetId)).toEqual([first.changeset.id]);
      release();
      h.integrationWorkspace.gate = null;
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.kind).toBe("integrated");
      expect(rb.kind).toBe("integrated");
      expect(h.integrationWorkspace.maxConcurrentByRun.get(s.created.run.id)).toBe(1);
      expect(h.integrationWorkspace.requests.map((r) => r.changesetId)).toEqual([first.changeset.id, second.changeset.id]);
      // The second application was onto the first's integrated Snapshot: the chain of Snapshots is sequential.
      if (ra.kind !== "integrated" || rb.kind !== "integrated") throw new Error("unreachable");
      expect(h.integrationWorkspace.requests[1]!.currentSnapshot).toEqual(ra.snapshot.identity);
      expect(h.stores.runs.get(s.created.run.id).integrationSnapshotId).toBe(rb.snapshot.id);
      expect(() => h.ctx.tx.write(() => h.integration.integrate(first.changeset.id))).toThrow(/never runs inside a transaction/);
    } finally {
      h.close();
    }
  });
});
