/**
 * The plain-directory Workspace kind on a real directory (execution-model
 * §9; the capability matrix): the runtime never creates a repository inside
 * the directory; a console-owned shadow repository holds every imported
 * state; Snapshots are content digests (equal content, equal digest);
 * worktrees, Changesets, integration, and finalization behave as for git;
 * the directory itself is read at Run start and left untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Workspace } from "@agentique-console/core";
import type { ExecutionWorkspaceRequest } from "../execution/ports/execution-workspace.ts";
import { createWorkspacePorts } from "./index.ts";
import { shadowRepositoryDir, WorkspaceStateError } from "./paths.ts";
import { canonicalId, contentSource, layoutIn, readTree, tempDir, writeFiles } from "./test-support.ts";

function fixture() {
  const dir = tempDir("dir-ws");
  const root = path.join(dir, "plain");
  writeFiles(root, { "notes.md": "# Notes\n", "data/values.csv": "a,b\n1,2\n", "ignored.log": "noise", ".gitignore": "*.log\n" });
  const layout = layoutIn(dir);
  const ports = createWorkspacePorts(layout);
  const workspace: Workspace = { id: canonicalId("ws"), name: "plain", rootPath: root, kind: "directory", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const runId = canonicalId("run");
  return { dir, root, layout, ports, workspace, runId, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

describe("directory Workspace", () => {
  it("prepares a Run from the directory's content digest through a shadow repository under the state root, creating nothing in the directory", () => {
    const f = fixture();
    try {
      const before = readTree(f.root);
      const prepared = f.ports.preparation.prepare({ runId: f.runId as never, workspace: f.workspace, target: { kind: "directory" } });
      expect(prepared.baseSnapshot.kind).toBe("directory");
      expect(fs.existsSync(path.join(f.root, ".git"))).toBe(false);
      expect(readTree(f.root)).toEqual(before);
      expect(fs.existsSync(path.join(shadowRepositoryDir(f.layout, f.workspace.id), "HEAD"))).toBe(true);
      // The Integration Workspace holds the tracked files; ignored files are not part of the Snapshot.
      expect(readTree(prepared.integrationWorkspacePath)).toEqual({ ".gitignore": "*.log\n", "data/values.csv": "a,b\n1,2\n", "notes.md": "# Notes\n" });
      // Equal content yields an equal digest across Runs; different content a different one.
      const second = f.ports.preparation.prepare({ runId: canonicalId("run") as never, workspace: f.workspace, target: { kind: "directory" } });
      expect(second.baseSnapshot).toEqual(prepared.baseSnapshot);
      writeFiles(f.root, { "notes.md": "# Changed\n" });
      const third = f.ports.preparation.prepare({ runId: canonicalId("run") as never, workspace: f.workspace, target: { kind: "directory" } });
      expect(third.baseSnapshot).not.toEqual(prepared.baseSnapshot);
      expect(() => f.ports.preparation.prepare({ runId: canonicalId("run") as never, workspace: f.workspace, target: { kind: "branch", branch: "main" } })).toThrow(WorkspaceStateError);
    } finally {
      f.cleanup();
    }
  });

  it("runs writers in shadow worktrees, collects exact Changesets, integrates them idempotently, and inspects the Integration Workspace read-only", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      const run = f.ports.preparation.prepare({ runId: f.runId as never, workspace: f.workspace, target: { kind: "directory" } });
      const integration = run.integrationWorkspacePath;
      const request: ExecutionWorkspaceRequest = { runId: f.runId as never, invocationId: canonicalId("inv") as never, role: "worker", writes: true, integrationWorkspacePath: integration, integrationSnapshot: run.baseSnapshot };
      const prepared = f.ports.execution.prepare(request);
      expect(prepared.startingSnapshot).toEqual(run.baseSnapshot);
      writeFiles(prepared.worktreePath!, { "data/values.csv": "a,b\n1,2\n3,4\n", "new.txt": "n\n" });
      const collected = (await f.ports.execution.collectChangeset(request, prepared))!;
      expect(collected.empty).toBe(false);
      expect(collected.afterSnapshot.kind).toBe("directory");
      const changesetId = canonicalId("cs");
      const apply = () => f.ports.integration.apply({ runId: f.runId as never, changesetId: changesetId as never, integrationWorkspacePath: integration, currentSnapshot: run.baseSnapshot, changeset: { beforeSnapshot: prepared.startingSnapshot!, afterSnapshot: collected.afterSnapshot, diff: contentSource(collected.diff) } });
      const first = await apply();
      expect(first.kind).toBe("integrated");
      if (first.kind !== "integrated") throw new Error("unreachable");
      expect(first.snapshot).toEqual(collected.afterSnapshot);
      expect(readTree(integration)).toEqual({ ".gitignore": "*.log\n", "data/values.csv": "a,b\n1,2\n3,4\n", "new.txt": "n\n", "notes.md": "# Notes\n" });
      expect(await apply()).toEqual({ kind: "integrated", snapshot: first.snapshot, alreadyApplied: true });
      const inspected = await f.ports.finalization.inspect({ runId: f.runId as never, workspaceId: f.workspace.id, integrationWorkspacePath: integration, baseSnapshot: run.baseSnapshot, verifiedSnapshot: first.snapshot });
      expect(inspected).toMatchObject({ kind: "inspected", currentSnapshot: first.snapshot, workspace: { clean: true } });
      if (inspected.kind !== "inspected") throw new Error("unreachable");
      expect(Buffer.from(inspected.diff).equals(Buffer.from(collected.diff))).toBe(true);
      // The directory itself is untouched by everything above.
      expect(readTree(f.root)).toEqual({ ".gitignore": "*.log\n", "data/values.csv": "a,b\n1,2\n", "ignored.log": "noise", "notes.md": "# Notes\n" });
      f.ports.execution.release(request, prepared);
      expect(fs.existsSync(prepared.worktreePath!)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
