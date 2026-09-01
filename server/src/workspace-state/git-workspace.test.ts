/**
 * The git Workspace kind on real repositories (execution-model §9.1–§9.3):
 * preparation takes the Target's base Snapshot and creates the Integration
 * Workspace without touching the Target or the operator's checkout; writers
 * get isolated worktrees a retry reattaches to; Changesets are exact binary
 * diffs (text, binary, deletion, empty); integration applies exactly the
 * verified bytes, is idempotent by Changeset id across a lost response and a
 * crash before the record, leaves nothing partial on conflict, and refuses a
 * drifted workspace; finalization observes read-only; release removes only
 * the runtime's own resources.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionWorkspaceRequest } from "../execution/ports/execution-workspace.ts";
import type { Workspace } from "@agentique-console/core";
import { gitSync, text } from "./git.ts";
import { createWorkspacePorts } from "./index.ts";
import { integrationDir, WorkspaceStateError } from "./paths.ts";
import { INTEGRATION_REF_PREFIX } from "./providers/git.ts";
import { canonicalId, commitAll, contentSource, gitIdentityOf, headOf, initRepository, layoutIn, listRefs, readTree, statusOf, tempDir, writeFiles } from "./test-support.ts";

function fixture() {
  const dir = tempDir("git-ws");
  const root = path.join(dir, "repo");
  const { headCommit } = initRepository(root, { "README.md": "# Fixture\n", "src/index.js": "console.log('v1');\n", "bin/blob.bin": Uint8Array.from([0, 1, 2, 255, 254, 0, 10, 13]) });
  const layout = layoutIn(dir);
  const ports = createWorkspacePorts(layout);
  const workspace: Workspace = { id: canonicalId("ws"), name: "fixture", rootPath: root, kind: "git", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const runId = canonicalId("run");
  return { dir, root, headCommit, layout, ports, workspace, runId, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

function writerRequest(f: ReturnType<typeof fixture>, integrationWorkspacePath: string, integrationSnapshot: ReturnType<typeof gitIdentityOf>, invocationId = canonicalId("inv")): ExecutionWorkspaceRequest {
  return { runId: f.runId as never, invocationId: invocationId as never, role: "worker", writes: true, integrationWorkspacePath, integrationSnapshot };
}

describe("git Workspace: preparation", () => {
  it("takes the Target branch's base Snapshot, creates the Integration Workspace on a Run-owned branch under the state root, and leaves the Target and the operator's checkout untouched", () => {
    const f = fixture();
    try {
      const before = { head: headOf(f.root), status: statusOf(f.root), branches: listRefs(f.root, "refs/heads/") };
      const prepared = f.ports.preparation.prepare({ runId: f.runId as never, workspace: f.workspace, target: { kind: "branch", branch: "main" } });
      expect(prepared.baseSnapshot).toEqual(gitIdentityOf(f.root, f.headCommit));
      expect(prepared.integrationWorkspacePath).toBe(integrationDir(f.layout, f.workspace.id, f.runId));
      expect(path.relative(f.root, prepared.integrationWorkspacePath).startsWith("..")).toBe(true);
      expect(fs.existsSync(path.join(prepared.integrationWorkspacePath, "src/index.js"))).toBe(true);
      expect(headOf(prepared.integrationWorkspacePath)).toBe(f.headCommit);
      expect(text(gitSync(["symbolic-ref", "HEAD"], { cwd: prepared.integrationWorkspacePath }))).toBe(`refs/heads/agentique/run/${f.runId}`);
      expect({ head: headOf(f.root), status: statusOf(f.root) }).toEqual({ head: before.head, status: before.status });
      expect(listRefs(f.root, "refs/heads/")).toEqual([...before.branches, `refs/heads/agentique/run/${f.runId}`].sort());
      // Discard removes exactly what was created.
      f.ports.preparation.discard({ runId: f.runId as never, workspace: f.workspace, target: { kind: "branch", branch: "main" } }, prepared);
      expect(fs.existsSync(prepared.integrationWorkspacePath)).toBe(false);
      expect(listRefs(f.root, "refs/heads/")).toEqual(before.branches);
      expect(fs.existsSync(path.join(f.root, "src/index.js"))).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a missing Target branch, a directory Target, a non-root Workspace path, and a reserved branch name, creating nothing", () => {
    const f = fixture();
    try {
      const request = (target: { kind: "branch"; branch: string } | { kind: "directory" }, rootPath = f.root) => ({ runId: f.runId as never, workspace: { ...f.workspace, rootPath }, target });
      expect(() => f.ports.preparation.prepare(request({ kind: "branch", branch: "nope" }))).toThrow(WorkspaceStateError);
      expect(() => f.ports.preparation.prepare(request({ kind: "directory" }))).toThrow(/branch Target/);
      expect(() => f.ports.preparation.prepare(request({ kind: "branch", branch: "main" }, path.join(f.root, "src")))).toThrow(/repository root/);
      expect(() => f.ports.preparation.prepare(request({ kind: "branch", branch: "agentique/run/x" }))).toThrow(/plain branch/);
      expect(fs.existsSync(path.join(f.layout.stateRoot, "workspaces", f.workspace.id, "runs", f.runId))).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});

describe("git Workspace: execution worktrees and Changesets", () => {
  it("gives a writer an isolated detached worktree at the integration Snapshot, a reader the Integration Workspace itself, collects exact text, binary, and deletion diffs, and reports an untouched worktree as an empty Changeset", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      const prepared = f.ports.preparation.prepare({ runId: f.runId as never, workspace: f.workspace, target: { kind: "branch", branch: "main" } });
      const integration = prepared.integrationWorkspacePath;
      const reader = f.ports.execution.prepare({ ...writerRequest(f, integration, prepared.baseSnapshot as never), writes: false, role: "evaluator" });
      expect(reader).toEqual({ worktreePath: integration, startingSnapshot: null });
      const request = writerRequest(f, integration, prepared.baseSnapshot as never);
      const writer = f.ports.execution.prepare(request);
      expect(writer.startingSnapshot).toEqual(prepared.baseSnapshot);
      expect(writer.worktreePath).toBe(path.join(path.dirname(integration), "worktrees", request.invocationId));
      expect(text(gitSync(["rev-parse", "HEAD"], { cwd: writer.worktreePath! }))).toBe(f.headCommit);
      expect(gitSync(["symbolic-ref", "-q", "HEAD"], { cwd: writer.worktreePath!, allowFailure: true }).exitCode).not.toBe(0);
      // Nothing written yet: an empty Changeset.
      expect(await f.ports.execution.collectChangeset(request, writer)).toEqual({ afterSnapshot: prepared.baseSnapshot, diff: new Uint8Array(), empty: true });
      // Text edit, binary edit, a new file, a deletion.
      writeFiles(writer.worktreePath!, { "src/index.js": "console.log('v2');\n", "bin/blob.bin": Uint8Array.from([9, 8, 7, 0, 255]), "docs/new.md": "new\n", "README.md": null });
      const collected = await f.ports.execution.collectChangeset(request, writer);
      expect(collected).not.toBeNull();
      expect(collected!.empty).toBe(false);
      expect(collected!.afterSnapshot).not.toEqual(prepared.baseSnapshot);
      const patch = Buffer.from(collected!.diff).toString("utf8");
      expect(patch).toMatch(/GIT binary patch/);
      expect(patch).toMatch(/deleted file mode/);
      expect(patch).toMatch(/\+console\.log\('v2'\);/);
      expect(patch).toMatch(/docs\/new\.md/);
      // The Integration Workspace and the Target saw nothing.
      expect(headOf(integration)).toBe(f.headCommit);
      expect(statusOf(integration)).toBe("");
      expect(headOf(f.root)).toBe(f.headCommit);
      // A retry reattaches to the same worktree: nothing is re-prepared between Attempts, the state is still there.
      expect(fs.readFileSync(path.join(writer.worktreePath!, "src/index.js"), "utf8")).toBe("console.log('v2');\n");
      // Release removes the worktree and is idempotent; the Integration Workspace stays.
      f.ports.execution.release(request, writer);
      expect(fs.existsSync(writer.worktreePath!)).toBe(false);
      f.ports.execution.release(request, writer);
      expect(fs.existsSync(integration)).toBe(true);
      expect(text(gitSync(["worktree", "list", "--porcelain"], { cwd: f.root }))).not.toContain(request.invocationId);
    } finally {
      f.cleanup();
    }
  });

  it("clears a stale worktree left at the same owned path, refuses paths outside the state root, and never removes an operator's own worktree", () => {
    const f = fixture();
    try {
      const prepared = f.ports.preparation.prepare({ runId: f.runId as never, workspace: f.workspace, target: { kind: "branch", branch: "main" } });
      const request = writerRequest(f, prepared.integrationWorkspacePath, prepared.baseSnapshot as never);
      const first = f.ports.execution.prepare(request);
      writeFiles(first.worktreePath!, { "stale.txt": "left by a dead process" });
      // The same Invocation id prepared again (a crash before the record): the stale directory is cleared.
      const again = f.ports.execution.prepare(request);
      expect(again.worktreePath).toBe(first.worktreePath);
      expect(fs.existsSync(path.join(again.worktreePath!, "stale.txt"))).toBe(false);
      // An operator worktree of the same repository is not the runtime's to touch.
      const operatorWorktree = path.join(f.dir, "operator-wt");
      gitSync(["worktree", "add", "--detach", operatorWorktree, "HEAD"], { cwd: f.root });
      expect(() => f.ports.execution.release({ ...request }, { worktreePath: operatorWorktree, startingSnapshot: first.startingSnapshot })).toThrow(/not owned/);
      expect(fs.existsSync(operatorWorktree)).toBe(true);
      expect(() => f.ports.execution.prepare({ ...request, integrationWorkspacePath: f.root })).toThrow(/not owned/);
    } finally {
      f.cleanup();
    }
  });
});

describe("git Workspace: integration", () => {
  async function writerChangeset(f: ReturnType<typeof fixture>, integration: string, snapshot: ReturnType<typeof gitIdentityOf>, files: Record<string, string | Uint8Array | null>) {
    const request = writerRequest(f, integration, snapshot);
    const prepared = f.ports.execution.prepare(request);
    writeFiles(prepared.worktreePath!, files);
    const collected = (await f.ports.execution.collectChangeset(request, prepared))!;
    return { request, prepared, collected, changesetId: canonicalId("cs") };
  }

  it("applies exactly the verified bytes onto the Integration Workspace, advances its Snapshot, records the integration ref, and answers a repeated apply and a crash-before-record as already applied without re-reading commits", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      const run = f.ports.preparation.prepare({ runId: f.runId as never, workspace: f.workspace, target: { kind: "branch", branch: "main" } });
      const integration = run.integrationWorkspacePath;
      const a = await writerChangeset(f, integration, run.baseSnapshot as never, { "src/index.js": "console.log('v2');\n", "docs/new.md": "new\n" });
      const source = contentSource(a.collected.diff);
      const apply = () => f.ports.integration.apply({ runId: f.runId as never, changesetId: a.changesetId as never, integrationWorkspacePath: integration, currentSnapshot: run.baseSnapshot, changeset: { beforeSnapshot: a.prepared.startingSnapshot!, afterSnapshot: a.collected.afterSnapshot, diff: source } });
      const first = await apply();
      expect(first.kind).toBe("integrated");
      if (first.kind !== "integrated") throw new Error("unreachable");
      expect(first.alreadyApplied).toBe(false);
      expect(first.snapshot).not.toEqual(run.baseSnapshot);
      expect(readTree(integration)["src/index.js"]).toBe("console.log('v2');\n");
      expect(readTree(integration)["docs/new.md"]).toBe("new\n");
      expect(statusOf(integration)).toBe("");
      expect(headOf(integration)).toBe(first.snapshot.kind === "git" ? first.snapshot.commitId : "");
      expect(listRefs(f.root, INTEGRATION_REF_PREFIX)).toEqual([`${INTEGRATION_REF_PREFIX}${f.runId}/${a.changesetId}`]);
      expect(text(gitSync(["log", "-1", "--format=%(trailers:key=Agentique-Changeset,valueonly)"], { cwd: integration }))).toBe(a.changesetId);
      // The Target is untouched.
      expect(headOf(f.root)).toBe(f.headCommit);
      // A lost response: the same apply returns the same Snapshot as already applied and reads no more content than needed.
      const readsBefore = source.reads;
      const replay = await apply();
      expect(replay).toEqual({ kind: "integrated", snapshot: first.snapshot, alreadyApplied: true });
      expect(source.reads).toBe(readsBefore);
      // A crash between the commit and the ref: the trailer answers, and the ref is repaired.
      gitSync(["update-ref", "-d", `${INTEGRATION_REF_PREFIX}${f.runId}/${a.changesetId}`], { cwd: f.root });
      const repaired = await apply();
      expect(repaired).toEqual({ kind: "integrated", snapshot: first.snapshot, alreadyApplied: true });
      expect(listRefs(f.root, INTEGRATION_REF_PREFIX)).toHaveLength(1);
      // A second Changeset from the advanced Snapshot integrates in order.
      const b = await writerChangeset(f, integration, first.snapshot as never, { "src/other.js": "export const two = 2;\n" });
      const second = await f.ports.integration.apply({ runId: f.runId as never, changesetId: b.changesetId as never, integrationWorkspacePath: integration, currentSnapshot: first.snapshot, changeset: { beforeSnapshot: b.prepared.startingSnapshot!, afterSnapshot: b.collected.afterSnapshot, diff: contentSource(b.collected.diff) } });
      expect(second.kind).toBe("integrated");
      expect(Object.keys(readTree(integration)).sort()).toEqual(["README.md", "bin/blob.bin", "docs/new.md", "src/index.js", "src/other.js"]);
    } finally {
      f.cleanup();
    }
  });

  it("integrates an empty Changeset to the current Snapshot, applies a Changeset written from an older Snapshot with a three-way merge, and leaves the workspace unchanged on a conflict", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      const run = f.ports.preparation.prepare({ runId: f.runId as never, workspace: f.workspace, target: { kind: "branch", branch: "main" } });
      const integration = run.integrationWorkspacePath;
      // Two writers start from the base: one edits index.js, the other adds a file (independent), a third edits index.js differently (conflict).
      const a = await writerChangeset(f, integration, run.baseSnapshot as never, { "src/index.js": "console.log('from a');\n" });
      const b = await writerChangeset(f, integration, run.baseSnapshot as never, { "docs/b.md": "b\n" });
      const c = await writerChangeset(f, integration, run.baseSnapshot as never, { "src/index.js": "console.log('from c');\n" });
      const empty = await writerChangeset(f, integration, run.baseSnapshot as never, {});
      const applyOf = (w: Awaited<ReturnType<typeof writerChangeset>>, current: ReturnType<typeof gitIdentityOf>) => f.ports.integration.apply({ runId: f.runId as never, changesetId: w.changesetId as never, integrationWorkspacePath: integration, currentSnapshot: current, changeset: { beforeSnapshot: w.prepared.startingSnapshot!, afterSnapshot: w.collected.afterSnapshot, diff: contentSource(w.collected.diff) } });
      const emptied = await applyOf(empty, run.baseSnapshot as never);
      expect(emptied).toEqual({ kind: "integrated", snapshot: run.baseSnapshot, alreadyApplied: false });
      const first = await applyOf(a, run.baseSnapshot as never);
      if (first.kind !== "integrated") throw new Error(first.kind);
      // b was written against the base but applies onto a's result: the three-way apply merges it.
      const second = await applyOf(b, first.snapshot as never);
      if (second.kind !== "integrated") throw new Error(second.kind);
      expect(readTree(integration)).toMatchObject({ "src/index.js": "console.log('from a');\n", "docs/b.md": "b\n" });
      // c edits the same lines a did: a conflict; the workspace holds exactly the previous Snapshot afterwards, clean.
      const conflict = await applyOf(c, second.snapshot as never);
      expect(conflict.kind).toBe("conflict");
      if (conflict.kind !== "conflict") throw new Error("unreachable");
      expect(conflict.report.length).toBeGreaterThan(0);
      expect(conflict.report).not.toMatch(/from c/);
      expect(headOf(integration)).toBe(second.snapshot.kind === "git" ? second.snapshot.commitId : "");
      expect(statusOf(integration)).toBe("");
      expect(readTree(integration)["src/index.js"]).toBe("console.log('from a');\n");
      expect(listRefs(f.root, INTEGRATION_REF_PREFIX)).toHaveLength(3);
    } finally {
      f.cleanup();
    }
  });

  it("refuses to guess when the Integration Workspace does not hold the recorded Snapshot, and reports a missing workspace as an infrastructure error", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      const run = f.ports.preparation.prepare({ runId: f.runId as never, workspace: f.workspace, target: { kind: "branch", branch: "main" } });
      const integration = run.integrationWorkspacePath;
      const a = await writerChangeset(f, integration, run.baseSnapshot as never, { "x.txt": "x\n" });
      // Something moved the Integration Workspace outside the runtime.
      writeFiles(integration, { "stray.txt": "stray\n" });
      const drifted = commitAll(integration, "stray");
      await expect(f.ports.integration.apply({ runId: f.runId as never, changesetId: a.changesetId as never, integrationWorkspacePath: integration, currentSnapshot: run.baseSnapshot, changeset: { beforeSnapshot: a.prepared.startingSnapshot!, afterSnapshot: a.collected.afterSnapshot, diff: contentSource(a.collected.diff) } })).rejects.toThrow(/drifted|not the recorded/);
      expect(headOf(integration)).toBe(drifted);
      await expect(f.ports.integration.apply({ runId: f.runId as never, changesetId: a.changesetId as never, integrationWorkspacePath: path.join(f.dir, "missing"), currentSnapshot: run.baseSnapshot, changeset: { beforeSnapshot: a.prepared.startingSnapshot!, afterSnapshot: a.collected.afterSnapshot, diff: contentSource(a.collected.diff) } })).rejects.toThrow(/no Integration Workspace/);
    } finally {
      f.cleanup();
    }
  });
});

describe("git Workspace: finalization", () => {
  it("observes the Integration Workspace read-only: the current Snapshot, cleanliness, and the exact base-to-verified diff; reports drift, a dirty tree, and a missing workspace", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      const run = f.ports.preparation.prepare({ runId: f.runId as never, workspace: f.workspace, target: { kind: "branch", branch: "main" } });
      const integration = run.integrationWorkspacePath;
      const request = writerRequest(f, integration, run.baseSnapshot as never);
      const prepared = f.ports.execution.prepare(request);
      writeFiles(prepared.worktreePath!, { "src/index.js": "console.log('final');\n" });
      const collected = (await f.ports.execution.collectChangeset(request, prepared))!;
      const changesetId = canonicalId("cs");
      const integrated = await f.ports.integration.apply({ runId: f.runId as never, changesetId: changesetId as never, integrationWorkspacePath: integration, currentSnapshot: run.baseSnapshot, changeset: { beforeSnapshot: prepared.startingSnapshot!, afterSnapshot: collected.afterSnapshot, diff: contentSource(collected.diff) } });
      if (integrated.kind !== "integrated") throw new Error(integrated.kind);
      const headBefore = headOf(integration);
      const inspected = await f.ports.finalization.inspect({ runId: f.runId as never, workspaceId: f.workspace.id, integrationWorkspacePath: integration, baseSnapshot: run.baseSnapshot, verifiedSnapshot: integrated.snapshot });
      expect(inspected.kind).toBe("inspected");
      if (inspected.kind !== "inspected") throw new Error("unreachable");
      expect(inspected.currentSnapshot).toEqual(integrated.snapshot);
      expect(inspected.workspace.clean).toBe(true);
      const expected = gitSync(["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-renames", f.headCommit, headBefore], { cwd: integration }).stdout;
      expect(Buffer.from(inspected.diff).equals(expected)).toBe(true);
      expect(inspected.diff.byteLength).toBeGreaterThan(0);
      // Read-only: nothing moved, nothing was written.
      expect(headOf(integration)).toBe(headBefore);
      expect(statusOf(integration)).toBe("");
      // A dirty tree is reported; a drifted Snapshot is reported as the current one, never reinterpreted.
      writeFiles(integration, { "untracked.txt": "x" });
      const dirty = await f.ports.finalization.inspect({ runId: f.runId as never, workspaceId: f.workspace.id, integrationWorkspacePath: integration, baseSnapshot: run.baseSnapshot, verifiedSnapshot: integrated.snapshot });
      expect(dirty).toMatchObject({ kind: "inspected", workspace: { clean: false } });
      const drifted = commitAll(integration, "drift");
      const drift = await f.ports.finalization.inspect({ runId: f.runId as never, workspaceId: f.workspace.id, integrationWorkspacePath: integration, baseSnapshot: run.baseSnapshot, verifiedSnapshot: integrated.snapshot });
      expect(drift).toMatchObject({ kind: "inspected", currentSnapshot: gitIdentityOf(integration, drifted), workspace: { clean: true } });
      const missing = await f.ports.finalization.inspect({ runId: f.runId as never, workspaceId: f.workspace.id, integrationWorkspacePath: path.join(f.dir, "gone"), baseSnapshot: run.baseSnapshot, verifiedSnapshot: integrated.snapshot });
      expect(missing).toMatchObject({ kind: "failed", failure: "workspace_unavailable" });
      const unknown = await f.ports.finalization.inspect({ runId: f.runId as never, workspaceId: f.workspace.id, integrationWorkspacePath: integration, baseSnapshot: run.baseSnapshot, verifiedSnapshot: { kind: "git", commitId: "f".repeat(40), treeId: "f".repeat(40) } });
      expect(unknown).toMatchObject({ kind: "failed", failure: "diff_unavailable" });
    } finally {
      f.cleanup();
    }
  });
});
