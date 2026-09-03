/**
 * Snapshot-pinned Agent Definition loading on a real repository
 * (execution-model §11; migration-contract §6): files are read from the
 * exact Snapshot (a later change to the working tree or a later commit is
 * invisible until a new Snapshot is pinned), repeated loading finds the same
 * revisions, changed files become new revisions of the same logical
 * definition, malformed or unsupported files are rejected and create
 * nothing, symlinks and nested paths never become definitions, a built-in's
 * name cannot be taken, and a revision pinned to another Workspace's
 * Snapshot is not executable for a Run of this Workspace.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExecutableAgentDefinitionRevision } from "../execution/agent-definitions.ts";
import { openHarness } from "../persistence/test-support.ts";
import { gitSync } from "../workspace-state/git.ts";
import { canonicalId, commitAll, initRepository, layoutIn, tempDir, writeFiles } from "../workspace-state/test-support.ts";
import { ensureBuiltinDefinitions } from "./builtins.ts";
import { WorkspaceAgentDefinitionLoader } from "./definitions.ts";

const DEFAULTS = { model: "claude-fable-5", effort: "medium" as const, maxContextOccupancy: 0.8, allocation: { costUsd: 2, tokens: 20_000, attempts: 2 }, maxWallClockMs: 600_000 };

const GOOD = "---\nname: reviewer-two\ndescription: Reviews carefully\ntools: Read, Grep\n---\nReview the change.\n";

function fixture() {
  const dir = tempDir("agent-defs");
  const root = path.join(dir, "repo");
  initRepository(root, { "README.md": "# Fixture\n", ".claude/agents/careful.md": GOOD, ".claude/agents/broken.md": "---\nname: broken\nhooks: {}\n---\nbody\n", ".claude/agents/notes.txt": "not a definition", ".claude/agents/nested/deep.md": GOOD });
  const h = openHarness();
  const workspace = h.stores.workspaces.create({ name: "fixture", rootPath: root, kind: "git" });
  const layout = layoutIn(dir);
  const loader = new WorkspaceAgentDefinitionLoader(h.ctx, h.stores, layout, DEFAULTS);
  return { dir, root, h, workspace, layout, loader, cleanup: () => { h.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } };
}

describe("WorkspaceAgentDefinitionLoader", () => {
  it("loads definitions from the exact pinned Snapshot: accepted files become revisions with workspace_file provenance, rejected files create nothing, non-files and nested paths are reported, and repeated loading reuses the same revisions", () => {
    const f = fixture();
    try {
      ensureBuiltinDefinitions(f.h.stores, { ...DEFAULTS, orchestratorAllocation: DEFAULTS.allocation });
      const report = f.loader.loadCurrent(f.workspace.id, { kind: "branch", branch: "main" });
      const snapshot = f.h.stores.snapshots.get(report.snapshotId);
      expect(snapshot).toMatchObject({ workspaceId: f.workspace.id, runId: null, reason: "agent_definition_read" });
      expect(report.files.map((file) => [file.kind, file.path])).toEqual([
        ["rejected", ".claude/agents/broken.md"],
        ["loaded", ".claude/agents/careful.md"],
        ["rejected", ".claude/agents/nested"],
        ["rejected", ".claude/agents/notes.txt"],
      ]);
      const loaded = report.files.find((file) => file.kind === "loaded");
      if (loaded?.kind !== "loaded") throw new Error("unreachable");
      expect(loaded).toMatchObject({ name: "careful:reviewer-two", reused: false, informational: ["description"] });
      const revision = f.h.stores.agents.getRevision(loaded.revisionId);
      expect(revision).toMatchObject({
        provenance: { kind: "workspace_file", path: ".claude/agents/careful.md", snapshotId: report.snapshotId },
        instructions: "Review the change.\n",
        capabilities: { tools: ["read", "search"], mcpServers: [] },
        toolPolicy: { read: "allowed", search: "allowed" },
        modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
      });
      expect(revision.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const broken = report.files.find((file) => file.path === ".claude/agents/broken.md");
      expect(broken).toMatchObject({ kind: "rejected", reasons: [{ field: "hooks" }] });
      expect(f.h.stores.agents.listDefinitions().map((d) => d.name).sort()).toEqual(["careful:reviewer-two", "orchestrator", "reviewer", "worker"]);
      // Repeated loading at the same Snapshot: the same revision, reused.
      const again = f.loader.loadAtSnapshot(f.workspace.id, report.snapshotId);
      const reloaded = again.files.find((file) => file.kind === "loaded");
      expect(reloaded).toMatchObject({ kind: "loaded", revisionId: loaded.revisionId, reused: true });
      expect(f.h.stores.agents.listRevisions(loaded.definitionId)).toHaveLength(1);
      // The pinned revision is executable for a Run of this Workspace and refused for another Workspace's Run.
      const conversation = f.h.stores.conversations.create({ workspaceId: f.workspace.id, title: "c" });
      expect(resolveExecutableAgentDefinitionRevision(f.h.stores, { workspaceId: f.workspace.id, conversationId: conversation.id }, loaded.revisionId)).toMatchObject({ ok: true, revision: { provenanceKind: "workspace_file", definitionName: "careful:reviewer-two" } });
      const other = f.h.stores.workspaces.create({ name: "other", rootPath: path.join(f.dir, "other"), kind: "git" });
      const otherConversation = f.h.stores.conversations.create({ workspaceId: other.id, title: "o" });
      expect(resolveExecutableAgentDefinitionRevision(f.h.stores, { workspaceId: other.id, conversationId: otherConversation.id }, loaded.revisionId)).toMatchObject({ ok: false });
    } finally {
      f.cleanup();
    }
  });

  it("reads the pinned Snapshot, not the working tree or a later commit: a file changed after pinning is invisible until a new Snapshot is taken, which yields a new revision of the same logical definition", () => {
    const f = fixture();
    try {
      const first = f.loader.loadCurrent(f.workspace.id, { kind: "branch", branch: "main" });
      const loaded = first.files.find((file) => file.kind === "loaded");
      if (loaded?.kind !== "loaded") throw new Error("unreachable");
      // The working tree changes, then a later commit changes the file: neither reaches a load at the pinned Snapshot.
      writeFiles(f.root, { ".claude/agents/careful.md": GOOD.replace("Review the change.", "Review it very carefully."), ".claude/agents/new.md": "---\nname: new\n---\nNew one.\n" });
      const pinnedAgain = f.loader.loadAtSnapshot(f.workspace.id, first.snapshotId);
      expect(pinnedAgain.files.filter((file) => file.kind === "loaded").map((file) => [file.path, file.kind === "loaded" && file.revisionId])).toEqual([[".claude/agents/careful.md", loaded.revisionId]]);
      commitAll(f.root, "change the definition");
      const stillPinned = f.loader.loadAtSnapshot(f.workspace.id, first.snapshotId);
      expect(stillPinned.files.filter((file) => file.kind === "loaded")).toHaveLength(1);
      expect(f.h.stores.agents.getRevision(loaded.revisionId).instructions).toBe("Review the change.\n");
      // A new Snapshot of the Target sees the change: a second revision of the same definition, and the new file's definition.
      const second = f.loader.loadCurrent(f.workspace.id, { kind: "branch", branch: "main" });
      expect(second.snapshotId).not.toBe(first.snapshotId);
      const changed = second.files.find((file) => file.path === ".claude/agents/careful.md");
      if (changed?.kind !== "loaded") throw new Error("unreachable");
      expect(changed.definitionId).toBe(loaded.definitionId);
      expect(changed.revisionId).not.toBe(loaded.revisionId);
      expect(changed.reused).toBe(false);
      expect(f.h.stores.agents.listRevisions(loaded.definitionId).map((r) => r.instructions)).toEqual(["Review the change.\n", "Review it very carefully.\n"]);
      expect(second.files.find((file) => file.path === ".claude/agents/new.md")).toMatchObject({ kind: "loaded", name: "new" });
    } finally {
      f.cleanup();
    }
  });

  it("never turns a symlink, a foreign path, an oversized or non-UTF-8 file, or a built-in's name into a definition", () => {
    const f = fixture();
    try {
      // A symlink committed as a git symlink object (mode 120000), a file outside the directory, an oversized file, and a built-in's name.
      writeFiles(f.root, { ".claude/agents/huge.md": `---\nname: huge\n---\n${"x".repeat(300_000)}\n`, ".claude/agents/worker.md": "---\nname: worker\n---\nI am the worker.\n", ".claude/agents/latin1.md": Uint8Array.from([0x2d, 0x2d, 0x2d, 0x0a, 0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xe9, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a, 0x62, 0x0a]), "agents/outside.md": GOOD });
      gitSync(["add", "-A", "--", "."], { cwd: f.root });
      // A symlink object is created through the index so the test does not depend on filesystem symlink support.
      const blob = gitSync(["hash-object", "-w", "--stdin"], { cwd: f.root, input: new TextEncoder().encode("careful.md") }).stdout.toString().trim();
      gitSync(["update-index", "--add", "--cacheinfo", `120000,${blob},.claude/agents/link.md`], { cwd: f.root });
      gitSync(["commit", "--quiet", "--no-verify", "-m", "edge cases"], { cwd: f.root, identity: true });
      ensureBuiltinDefinitions(f.h.stores, { ...DEFAULTS, orchestratorAllocation: DEFAULTS.allocation });
      const report = f.loader.loadCurrent(f.workspace.id, { kind: "branch", branch: "main" });
      const byPath = Object.fromEntries(report.files.map((file) => [file.path, file]));
      expect(byPath[".claude/agents/link.md"]).toMatchObject({ kind: "rejected", reasons: [{ field: "path", reason: expect.stringMatching(/symbolic link/) }] });
      expect(byPath[".claude/agents/huge.md"]).toMatchObject({ kind: "rejected", reasons: [{ field: "file", reason: expect.stringMatching(/bytes/) }] });
      expect(byPath[".claude/agents/latin1.md"]).toMatchObject({ kind: "rejected", reasons: [{ field: "file", reason: expect.stringMatching(/UTF-8/) }] });
      expect(byPath[".claude/agents/worker.md"]).toMatchObject({ kind: "rejected", reasons: [{ field: "name", reason: expect.stringMatching(/built-in/) }] });
      expect(byPath["agents/outside.md"]).toBeUndefined();
      expect(f.h.stores.agents.listDefinitions().map((d) => d.name).sort()).toEqual(["careful:reviewer-two", "orchestrator", "reviewer", "worker"]);
      expect(f.h.stores.agents.listRevisions(f.h.stores.agents.listDefinitions().find((d) => d.name === "worker")!.id)).toHaveLength(1);
      // A Snapshot of another Workspace is refused outright.
      const other = f.h.stores.workspaces.create({ name: "other", rootPath: path.join(f.dir, "other"), kind: "git" });
      const foreign = f.h.stores.snapshots.record({ workspaceId: other.id, runId: null, identity: { kind: "git", commitId: "a".repeat(40), treeId: "b".repeat(40) }, reason: "agent_definition_read" });
      expect(() => f.loader.loadAtSnapshot(f.workspace.id, foreign.id)).toThrow(/another Workspace/);
      expect(canonicalId("x")).toMatch(/^x_[0-9a-f]{24}$/);
    } finally {
      f.cleanup();
    }
  });
});
