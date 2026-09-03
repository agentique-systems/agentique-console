/**
 * Changeset content delivery (execution-model §9.2 content ownership): the
 * integration service resolves the Changeset's diff Artifact through the
 * canonical Artifact Store, verifies it, and hands the Integration Workspace
 * a content source bound to that one Artifact. Content that is missing,
 * corrupted, or inconsistent stops integration before the port is called
 * and changes no projection; content is read outside every transaction;
 * a crash between the external apply and its record is reconciled with the
 * same content; and diff bytes never leak into Events, outcomes,
 * diagnostics, projections, manifests, or error messages.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Changeset, Invocation, PlanExpression } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { openHarness } from "../persistence/test-support.ts";
import { ChangesetContentError } from "./integration-service.ts";
import { COMPLETED_RESULT, accepted, fakeSnapshot, openRuntimeHarness, planNodes, propose, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

const DIFF = new TextEncoder().encode("diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1,2 @@\n line\n+LEAK-MARKER-7f3a9c\n");
const MARKER = "LEAK-MARKER-7f3a9c";

/** A running single worker node with one succeeded writing Invocation whose Changeset (with `diff`) is pending. */
async function completedWriter(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>, diff: Uint8Array | null = DIFF, index = 0): Promise<{ invocation: Invocation; changeset: Changeset }> {
  const plan = accepted(propose(h, s, Array.from({ length: index + 1 }, (_, i) => ({ pattern: "single" as const, operation: { agentDefinitionRevisionId: s.worker.id, title: `write ${i}` }, allocation: { costUsd: 6, tokens: 60_000, attempts: 4 } }))));
  const node = plan.graph.nodes[index + 1]!;
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  h.stores.plans.transitionNode(node.id, { to: "running" });
  const { invocation } = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", continuedFromInvocationId: null, patternPosition: { kind: "single" } });
  if (diff !== null) h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("after", invocation.id), diff, empty: false };
  h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "finalized" || outcome.settlement.invocation.status !== "succeeded") throw new Error(`expected success, got ${outcome.kind}`);
  return { invocation: outcome.settlement.invocation, changeset: h.stores.changesets.listByRun(s.created.run.id).find((c) => c.invocationId === invocation.id)! };
}

/** Everything a content failure must leave untouched. */
function projection(h: RuntimeHarness, runId: Changeset["runId"]) {
  return {
    seq: h.ctx.journal.lastSeq(),
    changesets: h.stores.changesets.listByRun(runId),
    run: h.stores.runs.get(runId),
    tasks: h.stores.tasks.listByRun(runId).length,
    artifacts: h.stores.artifacts.listByRun(runId).length,
    snapshots: h.stores.snapshots.listByRun(runId).length,
    outstanding: h.integration.outstanding(runId).map((c) => c.id),
    scheduler: h.scheduler.reconcileRun(runId),
    requests: h.integrationWorkspace.requests.length,
    observed: h.integrationWorkspace.observed.length,
    applied: h.integrationWorkspace.applied.size,
  };
}

async function contentFailure(h: RuntimeHarness, changesetId: Changeset["id"]): Promise<ChangesetContentError> {
  const before = projection(h, h.stores.changesets.get(changesetId).runId);
  let caught: unknown = null;
  try {
    await h.integration.integrate(changesetId);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ChangesetContentError);
  // Nothing was applied, recorded, invented, or projected differently: the Changeset stays pending and outstanding.
  expect(projection(h, h.stores.changesets.get(changesetId).runId)).toEqual(before);
  expect(h.stores.changesets.get(changesetId).integrationStatus).toBe("pending");
  return caught as ChangesetContentError;
}

describe("Changeset content delivery", () => {
  it("delivers exactly the verified diff bytes, digest, and size to the Integration Workspace, read outside any transaction", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { changeset } = await completedWriter(h, s);
      const artifact = h.stores.artifacts.get(changeset.diffArtifactId);
      expect(artifact).toMatchObject({ mediaType: "text/x-diff", digest: sha256Hex(DIFF), byteSize: DIFF.byteLength });
      const outcome = await h.integration.integrate(changeset.id);
      expect(outcome.kind).toBe("integrated");
      // The adapter read the content through the source and observed exactly the stored bytes.
      expect(h.integrationWorkspace.observed).toEqual([{ changesetId: changeset.id, artifactId: artifact.id, digest: sha256Hex(DIFF), byteSize: DIFF.byteLength, inTransaction: false }]);
      const source = h.integrationWorkspace.requests[0]!.changeset.diff;
      expect({ artifactId: source.artifactId, mediaType: source.mediaType, digest: source.digest, byteSize: source.byteSize }).toEqual({ artifactId: artifact.id, mediaType: "text/x-diff", digest: artifact.digest, byteSize: artifact.byteSize });
      // The source is bound to one Artifact and exposes nothing else: no lookup, no store, no path, no bytes at rest.
      expect(Object.keys(source).sort()).toEqual(["artifactId", "byteSize", "digest", "mediaType"]);
      expect(JSON.stringify(h.integrationWorkspace.requests[0])).not.toContain(MARKER);
      // Reading again returns the same verified content; reading inside a transaction is refused.
      expect(Buffer.from(await source.read()).equals(Buffer.from(DIFF))).toBe(true);
      await expect(h.ctx.tx.write(() => source.read())).rejects.toThrow(/outside any transaction/);
      expect(h.ctx.tx.inTransaction).toBe(false);
      // A second Changeset is delivered onto the integrated Snapshot with its own content.
      const second = await completedWriter(h, s, new TextEncoder().encode("+second\n"), 1);
      expect(await h.integration.integrate(second.changeset.id)).toMatchObject({ kind: "integrated" });
      expect(h.integrationWorkspace.observed[1]).toMatchObject({ changesetId: second.changeset.id, digest: sha256Hex(new TextEncoder().encode("+second\n")), byteSize: 8, inTransaction: false });
    } finally {
      h.close();
    }
  });

  it("delivers a valid zero-byte diff and integrates it normally", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { changeset } = await completedWriter(h, s, null);
      const artifact = h.stores.artifacts.get(changeset.diffArtifactId);
      expect(artifact).toMatchObject({ mediaType: "text/x-diff", byteSize: 0, digest: sha256Hex(new Uint8Array()) });
      const outcome = await h.integration.integrate(changeset.id);
      if (outcome.kind !== "integrated") throw new Error(outcome.kind);
      expect(h.integrationWorkspace.observed).toEqual([{ changesetId: changeset.id, artifactId: artifact.id, digest: sha256Hex(new Uint8Array()), byteSize: 0, inTransaction: false }]);
      expect(outcome.snapshot.identity).toEqual(h.stores.snapshots.get(s.created.run.baseSnapshotId!).identity);
      expect(h.stores.changesets.get(changeset.id).integrationStatus).toBe("integrated");
    } finally {
      h.close();
    }
  });

  it("refuses missing content before the port is called, leaves every projection unchanged, and integrates once the content is back", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { changeset } = await completedWriter(h, s);
      const artifact = h.stores.artifacts.get(changeset.diffArtifactId);
      expect(h.blobs.remove(artifact.digest)).toBe(true);
      const error = await contentFailure(h, changeset.id);
      expect(error).toMatchObject({ name: "ChangesetContentError", failure: "content_missing", changesetId: changeset.id, artifactId: artifact.id });
      expect(error.message).toContain(artifact.digest);
      expect(error.message).not.toContain(MARKER);
      expect(h.integrationWorkspace.requests).toHaveLength(0);
      // Restoring the content (an operator restores the store) lets the same Changeset integrate without any other change.
      h.blobs.put(DIFF);
      expect(await h.integration.integrate(changeset.id)).toMatchObject({ kind: "integrated" });
      expect(h.integrationWorkspace.observed).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("refuses corrupted content — by digest or by size — before the port is called, and on every later read", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { changeset } = await completedWriter(h, s);
      const artifact = h.stores.artifacts.get(changeset.diffArtifactId);
      // Same size, different bytes: the digest no longer matches.
      const flipped = Uint8Array.from(DIFF);
      flipped[0] = flipped[0]! ^ 0xff;
      h.blobs.corrupt(artifact.digest, flipped);
      expect((await contentFailure(h, changeset.id))).toMatchObject({ failure: "content_corrupted", artifactId: artifact.id });
      // Different size: refused likewise, before any port call.
      h.blobs.corrupt(artifact.digest, DIFF.slice(0, DIFF.byteLength - 3));
      const sized = await contentFailure(h, changeset.id);
      expect(sized).toMatchObject({ failure: "content_corrupted" });
      expect(sized.message).not.toContain(MARKER);
      expect(h.integrationWorkspace.requests).toHaveLength(0);
      // Content that verifies when the source is bound but is corrupted before the adapter reads it is refused at that read:
      // the adapter applies nothing and the Changeset stays pending.
      h.blobs.corrupt(artifact.digest, DIFF);
      let release!: () => void;
      h.integrationWorkspace.gate = new Promise<void>((resolve) => (release = resolve));
      const pending = h.integration.integrate(changeset.id);
      await Promise.resolve();
      expect(h.integrationWorkspace.requests).toHaveLength(1);
      h.blobs.corrupt(artifact.digest, flipped);
      release();
      h.integrationWorkspace.gate = null;
      await expect(pending).rejects.toMatchObject({ name: "ChangesetContentError", failure: "content_corrupted" });
      expect(h.integrationWorkspace.observed).toHaveLength(0);
      expect(h.integrationWorkspace.applied.size).toBe(0);
      expect(h.stores.changesets.get(changeset.id).integrationStatus).toBe("pending");
      expect(h.stores.runs.get(s.created.run.id).integrationSnapshotId).toBeNull();
      // Verified content integrates.
      h.blobs.corrupt(artifact.digest, DIFF);
      expect(await h.integration.integrate(changeset.id)).toMatchObject({ kind: "integrated" });
      expect(h.integrationWorkspace.observed).toEqual([{ changesetId: changeset.id, artifactId: artifact.id, digest: artifact.digest, byteSize: artifact.byteSize, inTransaction: false }]);
    } finally {
      h.close();
    }
  });

  it("rejects a Changeset whose Artifact is not a diff of its own Run before the external apply", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { invocation, changeset } = await completedWriter(h, s);
      const run = s.created.run;
      // A Changeset naming an Artifact of another Run is refused by the store itself.
      const other = seedPlanningRuntime(h);
      const foreign = h.stores.artifacts.create({ runId: other.created.run.id, mediaType: "text/x-diff", producer: { kind: "runtime", component: "changeset" }, taskId: null, title: "foreign diff" }, DIFF);
      expect(() => h.stores.changesets.record({ runId: run.id, invocationId: invocation.id, beforeSnapshotId: changeset.beforeSnapshotId, afterSnapshotId: changeset.afterSnapshotId, diffArtifactId: foreign.id })).toThrow(/Artifact .* belongs to Run/);
      // An Artifact of the Run that is not a Changeset diff is refused by the service before the port is involved.
      const text = h.stores.artifacts.create({ runId: run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "changeset" }, taskId: null, title: "not a diff" }, DIFF);
      const wrong = h.stores.changesets.record({ runId: run.id, invocationId: invocation.id, beforeSnapshotId: changeset.beforeSnapshotId, afterSnapshotId: changeset.afterSnapshotId, diffArtifactId: text.id });
      const error = await contentFailure(h, wrong.id);
      expect(error).toMatchObject({ failure: "media_type", changesetId: wrong.id, artifactId: text.id });
      expect(error.message).toContain("text/plain");
      expect(h.integrationWorkspace.requests).toHaveLength(0);
      // The genuine Changeset of the same Invocation is unaffected.
      expect(await h.integration.integrate(changeset.id)).toMatchObject({ kind: "integrated", changeset: { invocationId: invocation.id } });
    } finally {
      h.close();
    }
  });

  it("reconciles a crash between the external apply and its record in the next process: the same content is read again, the apply is idempotent, and the record is written once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-content-"));
    const file = path.join(dir, "console.db");
    try {
      const first = openRuntimeHarness({ base: openHarness(file) });
      const { clock, blobs, integrationWorkspace } = first;
      let changesetId: Changeset["id"];
      let runId: Changeset["runId"];
      let seq: number;
      try {
        const s = seedPlanningRuntime(first);
        runId = s.created.run.id;
        const { changeset } = await completedWriter(first, s);
        changesetId = changeset.id;
        seq = first.ctx.journal.lastSeq();
        integrationWorkspace.crashAfterApply = true;
        await expect(first.integration.integrate(changeset.id)).rejects.toThrow(/process died/);
        expect(integrationWorkspace.applied.has(changeset.id)).toBe(true);
        expect(integrationWorkspace.observed).toHaveLength(1);
        expect(first.stores.changesets.get(changeset.id).integrationStatus).toBe("pending");
      } finally {
        first.close();
      }
      // The next process: the same database and content store, and the external Integration Workspace as it was left.
      const second = openRuntimeHarness({ base: openHarness(file, { clock, blobs }), integrationWorkspace });
      try {
        second.recovery.recover();
        expect(second.integration.outstanding(runId!).map((c) => c.id)).toEqual([changesetId!]);
        const outcome = await second.integration.integrate(changesetId!);
        expect(outcome.kind).toBe("integrated");
        if (outcome.kind !== "integrated") throw new Error("unreachable");
        // The content was read and verified again in this process; the adapter found the Changeset already applied.
        expect(integrationWorkspace.observed).toHaveLength(2);
        expect(integrationWorkspace.observed[1]).toEqual({ ...integrationWorkspace.observed[0]!, inTransaction: false });
        expect(integrationWorkspace.applied.size).toBe(1);
        expect(outcome.snapshot.identity).toEqual(integrationWorkspace.applied.get(changesetId!));
        // Recorded exactly once.
        expect(second.ctx.journal.read({ runId: runId!, afterSeq: seq! }).map((e) => e.type)).toEqual(["snapshot.taken", "changeset.integrated", "run.integrated"]);
        expect(second.stores.snapshots.listByRun(runId!).filter((x) => x.reason === "integration")).toHaveLength(1);
        expect(await second.integration.integrate(changesetId!)).toMatchObject({ kind: "already_integrated" });
        expect(integrationWorkspace.requests).toHaveLength(2);
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never leaks diff content into Events, diagnostics, scheduler outcomes and projections, manifests, Handoffs, Tasks, or errors", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const single = (title: string): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title }, allocation: { costUsd: 6, tokens: 60_000, attempts: 4 } });
      const { nodes } = planNodes(h, s, [{ pattern: "chain", steps: [single("A"), single("B")] }]);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.advanceInvocation(s.invocation.id);
      // A produces the marked diff; it is integrated before B, whose manifest carries A's Handoff.
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("a"), diff: DIFF, empty: false };
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT }, { kind: "succeed", result: COMPLETED_RESULT });
      const outcome = await h.scheduler.advanceRun(runId);
      expect(outcome.stop).toBe("quiescent");
      expect(h.stores.plans.getNode(nodes[0]!.id).status).toBe("succeeded");
      const changesets = h.stores.changesets.listByRun(runId);
      expect(changesets.map((c) => c.integrationStatus)).toEqual(["integrated", "integrated", "integrated", "integrated"]);
      // Positive control: the content exists and was delivered.
      const marked = changesets.find((c) => h.stores.artifacts.get(c.diffArtifactId).byteSize === DIFF.byteLength)!;
      expect(new TextDecoder().decode(h.stores.artifacts.read(marked.diffArtifactId).bytes)).toContain(MARKER);
      expect(h.integrationWorkspace.observed.map((o) => o.digest)).toContain(sha256Hex(DIFF));
      // Nothing observable outside the Artifact Store carries the bytes.
      const surfaces: Record<string, unknown> = {
        outcome,
        projection: h.scheduler.reconcileRun(runId),
        events: h.ctx.journal.read({ runId }),
        persistenceDiagnostics: h.diagnostics,
        executionDiagnostics: h.executionDiagnostics,
        requests: h.integrationWorkspace.requests,
        observed: h.integrationWorkspace.observed,
        manifests: h.stores.invocations.listByRun(runId).map((i) => h.stores.invocations.getManifest(i.id)),
        handoffs: h.stores.handoffs.listByRun(runId),
        tasks: h.stores.tasks.listByRun(runId),
        artifacts: h.stores.artifacts.listByRun(runId),
        changesets,
        run: h.stores.runs.get(runId),
      };
      for (const [name, surface] of Object.entries(surfaces)) expect(JSON.stringify(surface), name).not.toContain(MARKER);
      expect(h.ctx.journal.read({ runId }).length).toBeGreaterThan(10);
      // A failure over marked content reports ids and digests, never the content; a conflict report Artifact carries none either.
      const s2 = seedPlanningRuntime(h);
      const writer = await completedWriter(h, s2);
      const artifact = h.stores.artifacts.get(writer.changeset.diffArtifactId);
      h.blobs.remove(artifact.digest);
      const error = await contentFailure(h, writer.changeset.id);
      expect(JSON.stringify({ message: error.message, stack: error.stack, failure: error.failure, changesetId: error.changesetId, artifactId: error.artifactId })).not.toContain(MARKER);
      h.blobs.put(DIFF);
      h.integrationWorkspace.conflictNext.add(writer.changeset.id);
      const conflict = await h.integration.integrate(writer.changeset.id);
      if (conflict.kind !== "conflict") throw new Error(conflict.kind);
      expect(new TextDecoder().decode(h.stores.artifacts.read(conflict.artifact.id).bytes)).not.toContain(MARKER);
      expect(JSON.stringify([conflict.task, h.ctx.journal.read({ runId: s2.created.run.id })])).not.toContain(MARKER);
    } finally {
      h.close();
    }
  });
});
