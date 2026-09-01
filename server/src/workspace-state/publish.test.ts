/**
 * Publication on real repositories and directories (execution-model §9.4;
 * the capability matrix): isolated candidate preparation without touching
 * the Target, exact strategy selection and deterministic refusals, candidate
 * verification against the exact final diff, compare-and-swap against the
 * persisted Target-before identity in one reference transaction with a
 * receipt, replay by receipt after the Target moved again, no force update,
 * staging release, and the directory kind's fast-forward-only file
 * materialization with a receipt file. Every Target is a disposable fixture.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Workspace } from "@agentique-console/core";
import type { ExecutionWorkspaceRequest } from "../execution/ports/execution-workspace.ts";
import type { PublicationPrepareRequest } from "../execution/ports/publication-workspace.ts";
import { gitSync, text } from "./git.ts";
import { createWorkspacePorts, type WorkspacePorts } from "./index.ts";
import { receiptPath } from "./paths.ts";
import { PUBLICATION_RECEIPT_REF_PREFIX } from "./providers/git.ts";
import { selectStrategy } from "./publish.ts";
import { canonicalId, commitAll, contentSource, gitIdentityOf, headOf, initRepository, layoutIn, listRefs, readTree, statusOf, tempDir, writeFiles } from "./test-support.ts";

function commitIdOf(identity: { kind: string; commitId?: string }): string {
  if (identity.kind !== "git" || identity.commitId === undefined) throw new Error("a git identity was expected");
  return identity.commitId;
}

interface Completed {
  ports: WorkspacePorts;
  workspace: Workspace;
  runId: string;
  base: ReturnType<typeof gitIdentityOf>;
  final: ReturnType<typeof gitIdentityOf>;
  diff: Uint8Array;
  integration: string;
}

/** Drives a Run to an accepted final state: one writer's Changeset integrated; the final Changeset is base→final. */
async function completeRun(ports: WorkspacePorts, workspace: Workspace, target: { kind: "branch"; branch: string } | { kind: "directory" }, files: Record<string, string | null>): Promise<Completed> {
  const runId = canonicalId("run");
  const run = ports.preparation.prepare({ runId: runId as never, workspace, target });
  const request: ExecutionWorkspaceRequest = { runId: runId as never, invocationId: canonicalId("inv") as never, role: "worker", writes: true, integrationWorkspacePath: run.integrationWorkspacePath, integrationSnapshot: run.baseSnapshot };
  const prepared = ports.execution.prepare(request);
  writeFiles(prepared.worktreePath!, files);
  const collected = (await ports.execution.collectChangeset(request, prepared))!;
  const integrated = await ports.integration.apply({ runId: runId as never, changesetId: canonicalId("cs") as never, integrationWorkspacePath: run.integrationWorkspacePath, currentSnapshot: run.baseSnapshot, changeset: { beforeSnapshot: prepared.startingSnapshot!, afterSnapshot: collected.afterSnapshot, diff: contentSource(collected.diff) } });
  if (integrated.kind !== "integrated") throw new Error(integrated.kind);
  const inspected = await ports.finalization.inspect({ runId: runId as never, workspaceId: workspace.id, integrationWorkspacePath: run.integrationWorkspacePath, baseSnapshot: run.baseSnapshot, verifiedSnapshot: integrated.snapshot });
  if (inspected.kind !== "inspected") throw new Error(inspected.failure);
  return { ports, workspace, runId, base: run.baseSnapshot as never, final: integrated.snapshot as never, diff: inspected.diff, integration: run.integrationWorkspacePath };
}

function prepareRequest(c: Completed, target: PublicationPrepareRequest["target"], requestedStrategy: PublicationPrepareRequest["requestedStrategy"], publicationId = canonicalId("pub"), diff: Uint8Array = c.diff): PublicationPrepareRequest {
  return { publicationId: publicationId as never, runId: c.runId as never, workspaceId: c.workspace.id, workspaceRootPath: c.workspace.rootPath, target, baseSnapshot: c.base, requestedStrategy, changeset: { beforeSnapshot: c.base, afterSnapshot: c.final, diff: contentSource(diff) } };
}

function gitFixture() {
  const dir = tempDir("publish-git");
  const root = path.join(dir, "repo");
  const { headCommit } = initRepository(root, { "README.md": "# Fixture\n", "src/app.js": "v1\n" });
  const ports = createWorkspacePorts(layoutIn(dir));
  const workspace: Workspace = { id: canonicalId("ws"), name: "fixture", rootPath: root, kind: "git", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  return { dir, root, headCommit, ports, workspace, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

describe("publication: strategy selection", () => {
  it("selects exactly as §9.4 specifies for both kinds", () => {
    expect(selectStrategy("git", { kind: "automatic" }, true)).toEqual({ kind: "selected", strategy: { kind: "fast_forward" } });
    expect(selectStrategy("git", { kind: "automatic" }, false)).toEqual({ kind: "selected", strategy: { kind: "merge" } });
    expect(selectStrategy("directory", { kind: "automatic" }, false)).toMatchObject({ kind: "refused", refusal: "strategy_unsupported", strategy: { kind: "merge" } });
    expect(selectStrategy("git", { kind: "exact", strategy: { kind: "fast_forward" } }, false)).toMatchObject({ kind: "refused", refusal: "fast_forward_unavailable", strategy: null });
    expect(selectStrategy("git", { kind: "exact", strategy: { kind: "other", name: "rebase" } }, true)).toMatchObject({ kind: "refused", refusal: "strategy_unsupported", strategy: { kind: "other", name: "rebase" } });
    expect(selectStrategy("directory", { kind: "exact", strategy: { kind: "merge" } }, true)).toMatchObject({ kind: "refused", refusal: "strategy_unsupported" });
    expect(selectStrategy("directory", { kind: "exact", strategy: { kind: "fast_forward" } }, true)).toEqual({ kind: "selected", strategy: { kind: "fast_forward" } });
  });
});

describe("publication: git Target", () => {
  it("prepares a fast-forward candidate in isolated staging without touching the Target, replays the preparation, applies through one reference transaction with a receipt ref, replays by receipt after the Target moved again, and releases only the staging", { timeout: 180_000 }, async () => {
    const f = gitFixture();
    try {
      const c = await completeRun(f.ports, f.workspace, { kind: "branch", branch: "main" }, { "src/app.js": "v2\n", "docs/notes.md": "notes\n" });
      const target = { kind: "branch" as const, branch: "main" };
      const publicationId = canonicalId("pub");
      const prepared = await f.ports.publication.prepare(prepareRequest(c, target, { kind: "automatic" }, publicationId));
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") throw new Error("unreachable");
      expect(prepared).toMatchObject({ strategy: { kind: "fast_forward" }, targetBeforeSnapshot: c.base, candidateSnapshot: c.final, alreadyPrepared: false });
      expect(prepared.verificationWorkspacePath).not.toBeNull();
      expect(readTree(prepared.verificationWorkspacePath!)).toEqual({ "README.md": "# Fixture\n", "docs/notes.md": "notes\n", "src/app.js": "v2\n" });
      // The Target and the operator's checkout are untouched.
      expect(headOf(f.root, "refs/heads/main")).toBe(f.headCommit);
      expect(readTree(f.root)["src/app.js"]).toBe("v1\n");
      // A replay returns the same prepared facts.
      expect(await f.ports.publication.prepare(prepareRequest(c, target, { kind: "automatic" }, publicationId))).toEqual({ ...prepared, alreadyPrepared: true });
      // Apply: the Target moves to the candidate and the receipt ref exists, in one transaction; the checked-out clean working copy follows.
      const identity = { publicationId: publicationId as never, runId: c.runId as never, workspaceId: c.workspace.id, workspaceRootPath: f.root, target };
      const applied = await f.ports.publication.apply({ ...identity, expectedTargetSnapshot: prepared.targetBeforeSnapshot, candidateSnapshot: prepared.candidateSnapshot, strategy: prepared.strategy });
      expect(applied).toEqual({ kind: "applied", targetSnapshot: c.final, alreadyApplied: false });
      expect(headOf(f.root, "refs/heads/main")).toBe(commitIdOf(c.final));
      expect(listRefs(f.root, PUBLICATION_RECEIPT_REF_PREFIX)).toEqual([`${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId}`]);
      expect(headOf(f.root, `${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId}`)).toBe(commitIdOf(c.final));
      expect(readTree(f.root)["src/app.js"]).toBe("v2\n");
      expect(statusOf(f.root)).toBe("");
      // A replay after the operator moved the Target again returns the receipt's identity, never the moved one.
      writeFiles(f.root, { "later.txt": "later\n" });
      const moved = commitAll(f.root, "operator work after publication");
      expect(await f.ports.publication.apply({ ...identity, expectedTargetSnapshot: prepared.targetBeforeSnapshot, candidateSnapshot: prepared.candidateSnapshot, strategy: prepared.strategy })).toEqual({ kind: "applied", targetSnapshot: c.final, alreadyApplied: true });
      expect(headOf(f.root, "refs/heads/main")).toBe(moved);
      // Release removes the staging and nothing else.
      expect(await f.ports.publication.release(identity)).toEqual({ kind: "released" });
      expect(fs.existsSync(prepared.verificationWorkspacePath!)).toBe(false);
      expect(await f.ports.publication.release(identity)).toEqual({ kind: "released" });
      expect(fs.existsSync(c.integration)).toBe(true);
      expect(headOf(f.root, `${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId}`)).toBe(commitIdOf(c.final));
    } finally {
      f.cleanup();
    }
  });

  it("refuses a compare-and-swap definitely when the Target moved before apply (no force update), leaves a dirty checked-out working copy alone, and merges when the Target diverged", { timeout: 180_000 }, async () => {
    const f = gitFixture();
    try {
      const c = await completeRun(f.ports, f.workspace, { kind: "branch", branch: "main" }, { "src/app.js": "v2\n" });
      const target = { kind: "branch" as const, branch: "main" };
      const publicationId = canonicalId("pub");
      const prepared = await f.ports.publication.prepare(prepareRequest(c, target, { kind: "exact", strategy: { kind: "fast_forward" } }, publicationId));
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      // The operator commits to main between prepare and apply (a different file): the CAS refuses, nothing moves.
      writeFiles(f.root, { "docs/operator.md": "operator\n" });
      const operatorCommit = commitAll(f.root, "operator");
      const identity = { publicationId: publicationId as never, runId: c.runId as never, workspaceId: c.workspace.id, workspaceRootPath: f.root, target };
      const refused = await f.ports.publication.apply({ ...identity, expectedTargetSnapshot: prepared.targetBeforeSnapshot, candidateSnapshot: prepared.candidateSnapshot, strategy: prepared.strategy });
      expect(refused).toEqual({ kind: "target_changed", currentTargetSnapshot: gitIdentityOf(f.root, operatorCommit) });
      expect(headOf(f.root, "refs/heads/main")).toBe(operatorCommit);
      expect(listRefs(f.root, PUBLICATION_RECEIPT_REF_PREFIX)).toEqual([]);
      await f.ports.publication.release(identity);
      // A new Publication: automatic now selects merge; the candidate is a merge commit of the Target and the final Snapshot.
      const second = canonicalId("pub");
      const merged = await f.ports.publication.prepare(prepareRequest(c, target, { kind: "automatic" }, second));
      expect(merged.kind).toBe("prepared");
      if (merged.kind !== "prepared") throw new Error("unreachable");
      expect(merged.strategy).toEqual({ kind: "merge" });
      expect(merged.targetBeforeSnapshot).toEqual(gitIdentityOf(f.root, operatorCommit));
      const candidate = merged.candidateSnapshot.kind === "git" ? merged.candidateSnapshot.commitId : "";
      expect(text(gitSync(["rev-list", "--parents", "-1", candidate], { cwd: f.root })).split(" ").slice(1).sort()).toEqual([operatorCommit, commitIdOf(c.final)].sort());
      expect(readTree(merged.verificationWorkspacePath!)).toEqual({ "README.md": "# Fixture\n", "docs/operator.md": "operator\n", "src/app.js": "v2\n" });
      // A dirty operator checkout: the ref moves atomically, the working copy is left alone.
      writeFiles(f.root, { "wip.txt": "uncommitted\n" });
      const applied = await f.ports.publication.apply({ publicationId: second as never, runId: c.runId as never, workspaceId: c.workspace.id, workspaceRootPath: f.root, target, expectedTargetSnapshot: merged.targetBeforeSnapshot, candidateSnapshot: merged.candidateSnapshot, strategy: merged.strategy });
      expect(applied).toEqual({ kind: "applied", targetSnapshot: merged.candidateSnapshot, alreadyApplied: false });
      expect(headOf(f.root, "refs/heads/main")).toBe(candidate);
      expect(fs.readFileSync(path.join(f.root, "wip.txt"), "utf8")).toBe("uncommitted\n");
      expect(fs.readFileSync(path.join(f.root, "src/app.js"), "utf8")).toBe("v1\n");
    } finally {
      f.cleanup();
    }
  });

  it("refuses deterministically: a conflicting merge leaves no staging, an exact fast-forward off the base is unavailable, an unknown strategy is unsupported, a diff that is not the base-to-final diff is invalid, and a missing Target branch is invalid", { timeout: 180_000 }, async () => {
    const f = gitFixture();
    try {
      const c = await completeRun(f.ports, f.workspace, { kind: "branch", branch: "main" }, { "src/app.js": "v2\n" });
      const target = { kind: "branch" as const, branch: "main" };
      // The operator edits the same lines: a merge conflict.
      writeFiles(f.root, { "src/app.js": "operator edit\n" });
      commitAll(f.root, "conflicting operator edit");
      const conflict = await f.ports.publication.prepare(prepareRequest(c, target, { kind: "automatic" }));
      expect(conflict).toMatchObject({ kind: "refused", refusal: "candidate_conflict", strategy: { kind: "merge" } });
      const runPublications = path.join(path.dirname(c.integration), "publications");
      expect(fs.existsSync(runPublications) ? fs.readdirSync(runPublications) : []).toEqual([]);
      expect(await f.ports.publication.prepare(prepareRequest(c, target, { kind: "exact", strategy: { kind: "fast_forward" } }))).toMatchObject({ kind: "refused", refusal: "fast_forward_unavailable" });
      expect(await f.ports.publication.prepare(prepareRequest(c, target, { kind: "exact", strategy: { kind: "other", name: "squash" } }))).toMatchObject({ kind: "refused", refusal: "strategy_unsupported", strategy: { kind: "other", name: "squash" } });
      const tampered = new TextEncoder().encode("--- a/x\n+++ b/x\n");
      const invalid = await f.ports.publication.prepare(prepareRequest(c, target, { kind: "exact", strategy: { kind: "merge" } }, canonicalId("pub"), tampered));
      expect(invalid).toMatchObject({ kind: "refused", refusal: "candidate_invalid" });
      expect(await f.ports.publication.prepare(prepareRequest(c, { kind: "branch", branch: "does-not-exist" }, { kind: "automatic" }))).toMatchObject({ kind: "refused", refusal: "candidate_invalid" });
      // Nothing above touched the Target.
      expect(readTree(f.root)["src/app.js"]).toBe("operator edit\n");
      expect(listRefs(f.root, PUBLICATION_RECEIPT_REF_PREFIX)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
});

describe("publication: directory Target", () => {
  it("fast-forwards the directory's content after a digest compare-and-swap, applies deletions, writes a receipt file, replays by receipt, refuses a changed directory, and never merges", { timeout: 180_000 }, async () => {
    const dir = tempDir("publish-dir");
    try {
      const root = path.join(dir, "plain");
      writeFiles(root, { "keep.txt": "keep\n", "change.txt": "old\n", "remove/gone.txt": "gone\n" });
      const layout = layoutIn(dir);
      const ports = createWorkspacePorts(layout);
      const workspace: Workspace = { id: canonicalId("ws"), name: "plain", rootPath: root, kind: "directory", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      const c = await completeRun(ports, workspace, { kind: "directory" }, { "change.txt": "new\n", "remove/gone.txt": null, "added/file.txt": "added\n" });
      const publicationId = canonicalId("pub");
      const prepared = await ports.publication.prepare(prepareRequest(c, { kind: "directory" }, { kind: "automatic" }, publicationId));
      expect(prepared).toMatchObject({ kind: "prepared", strategy: { kind: "fast_forward" }, targetBeforeSnapshot: c.base, candidateSnapshot: c.final, alreadyPrepared: false });
      if (prepared.kind !== "prepared") throw new Error("unreachable");
      expect(readTree(root)).toEqual({ "change.txt": "old\n", "keep.txt": "keep\n", "remove/gone.txt": "gone\n" });
      const identity = { publicationId: publicationId as never, runId: c.runId as never, workspaceId: workspace.id, workspaceRootPath: root, target: { kind: "directory" as const } };
      const applied = await ports.publication.apply({ ...identity, expectedTargetSnapshot: prepared.targetBeforeSnapshot, candidateSnapshot: prepared.candidateSnapshot, strategy: prepared.strategy });
      expect(applied).toEqual({ kind: "applied", targetSnapshot: c.final, alreadyApplied: false });
      expect(readTree(root)).toEqual({ "added/file.txt": "added\n", "change.txt": "new\n", "keep.txt": "keep\n" });
      expect(fs.existsSync(path.join(root, "remove"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
      expect(fs.existsSync(receiptPath(layout, workspace.id, publicationId))).toBe(true);
      // The directory changed afterwards: the replay still answers from the receipt.
      writeFiles(root, { "operator.txt": "later\n" });
      expect(await ports.publication.apply({ ...identity, expectedTargetSnapshot: prepared.targetBeforeSnapshot, candidateSnapshot: prepared.candidateSnapshot, strategy: prepared.strategy })).toEqual({ kind: "applied", targetSnapshot: c.final, alreadyApplied: true });
      expect(await ports.publication.release(identity)).toEqual({ kind: "released" });
      expect(fs.existsSync(prepared.verificationWorkspacePath!)).toBe(false);
      // A second Run against the changed directory: automatic cannot merge, and a fresh fast-forward is refused when the directory moved.
      const d = await completeRun(ports, workspace, { kind: "directory" }, { "keep.txt": "keep2\n" });
      writeFiles(root, { "moved.txt": "moved\n" });
      expect(await ports.publication.prepare(prepareRequest(d, { kind: "directory" }, { kind: "automatic" }))).toMatchObject({ kind: "refused", refusal: "strategy_unsupported", strategy: { kind: "merge" } });
      expect(await ports.publication.prepare(prepareRequest(d, { kind: "directory" }, { kind: "exact", strategy: { kind: "fast_forward" } }))).toMatchObject({ kind: "refused", refusal: "fast_forward_unavailable" });
      // A prepared fast-forward whose Target moves before apply is refused as changed, and nothing is written.
      fs.rmSync(path.join(root, "moved.txt"));
      const again = canonicalId("pub");
      const preparedAgain = await ports.publication.prepare(prepareRequest(d, { kind: "directory" }, { kind: "exact", strategy: { kind: "fast_forward" } }, again));
      expect(preparedAgain.kind).toBe("prepared");
      if (preparedAgain.kind !== "prepared") throw new Error("unreachable");
      writeFiles(root, { "moved.txt": "moved again\n" });
      const before = readTree(root);
      const changed = await ports.publication.apply({ publicationId: again as never, runId: d.runId as never, workspaceId: workspace.id, workspaceRootPath: root, target: { kind: "directory" }, expectedTargetSnapshot: preparedAgain.targetBeforeSnapshot, candidateSnapshot: preparedAgain.candidateSnapshot, strategy: preparedAgain.strategy });
      expect(changed.kind).toBe("target_changed");
      expect(readTree(root)).toEqual(before);
      expect(fs.existsSync(receiptPath(layout, workspace.id, again))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
