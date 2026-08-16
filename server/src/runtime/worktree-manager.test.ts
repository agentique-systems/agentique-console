/** WorktreeManager over real git repositories in temp directories. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "./worktree-manager.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t.invalid", ...args], { cwd, encoding: "utf8" });

function makeRepo(): { repo: string; manager: WorktreeManager } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-wt-"));
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init", "--no-gpg-sign");
  return { repo, manager: new WorktreeManager({ dataDir: path.join(base, "data") }) };
}

describe("WorktreeManager", () => {
  it("detects non-repos and refuses with an actionable message", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-plain-"));
    const manager = new WorktreeManager({ dataDir: path.join(plain, "data") });
    expect(manager.isGitRepo(plain)).toBe(false);
    expect(() => manager.addWorktree(plain, "as_1", "g-1", "g/1")).toThrow(/requires the workspace to be a git repository/);
  });

  it("keeps sandbox placeholder dotfiles out of the agent's commit", () => {
    // The sandbox materializes empty stand-ins for masked host dotfiles; an
    // unscoped `git add -A` would sweep them into the operator's repo.
    const { repo, manager } = makeRepo();
    const ref = manager.addWorktree(repo, "as_1", "g-1", "g/1");
    for (const stub of [".bashrc", ".zshrc", ".gitconfig", ".mcp.json", ".idea", ".vscode", ".ripgreprc"]) {
      fs.writeFileSync(path.join(ref.path, stub), "");
    }
    fs.mkdirSync(path.join(ref.path, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(ref.path, ".claude", "settings.json"), "");
    fs.mkdirSync(path.join(ref.path, "src"), { recursive: true });
    fs.writeFileSync(path.join(ref.path, "src", "game.js"), "export const start = () => {};\n");

    const commit = manager.commitAll(ref.path, "seat renderer: reported completed", ["src/game.js"]);
    expect(commit).not.toBeNull();
    const tracked = git(ref.path, "ls-tree", "-r", "HEAD", "--name-only").trim().split("\n");
    expect(tracked).toContain("src/game.js");
    // Only what the base commit already carried, plus the agent's own file.
    expect(tracked.filter((file) => file.startsWith("."))).toEqual([".gitignore"]);
    expect(tracked).toHaveLength(3);

    // Stub-only churn must read as "nothing to land", not as an empty commit.
    fs.writeFileSync(path.join(ref.path, ".profile"), "");
    expect(manager.commitAll(ref.path, "stubs only", ["src/game.js"])).toBeNull();
  });

  it("still commits an excluded path when the agent explicitly owns it", () => {
    const { repo, manager } = makeRepo();
    const ref = manager.addWorktree(repo, "as_2", "g-2", "g/2");
    fs.mkdirSync(path.join(ref.path, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(ref.path, ".claude", "settings.json"), '{"model":"opus"}\n');
    expect(manager.commitAll(ref.path, "config work", [".claude/settings.json"])).not.toBeNull();
    expect(git(ref.path, "ls-tree", "-r", "HEAD", "--name-only")).toContain(".claude/settings.json");
  });

  it("isolates edits, honors .gitignore in capture, and commits identity-free", () => {
    const { repo, manager } = makeRepo();
    const ref = manager.addWorktree(repo, "as_1", "g-1", "g/1");
    fs.writeFileSync(path.join(ref.path, "feature.txt"), "new work\n");
    fs.writeFileSync(path.join(ref.path, "ignored.log"), "junk\n");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
    const commit = manager.commitAll(ref.path, "attempt work");
    expect(commit).not.toBeNull();
    expect(manager.commitAll(ref.path, "nothing left")).toBeNull();
    const diff = manager.captureDiff(repo, ref.baseCommit, ref.branch);
    expect(diff.patch).toContain("feature.txt");
    expect(diff.patch).not.toContain("ignored.log");
    expect(diff.filesChanged).toBe(1);
    expect(diff.insertions).toBe(1);
  });

  it("merges a winner cleanly with --no-ff", () => {
    const { repo, manager } = makeRepo();
    const ref = manager.addWorktree(repo, "as_1", "g-1", "g/1");
    fs.writeFileSync(path.join(ref.path, "feature.txt"), "winner\n");
    manager.commitAll(ref.path, "attempt work");
    const outcome = manager.mergeBranch(repo, ref.branch, "Merge best-of-N winner");
    expect(outcome).toMatchObject({ merged: true });
    expect(fs.readFileSync(path.join(repo, "feature.txt"), "utf8")).toBe("winner\n");
  });

  it("aborts a conflicting merge and leaves the workspace untouched", () => {
    const { repo, manager } = makeRepo();
    const ref = manager.addWorktree(repo, "as_1", "g-1", "g/1");
    fs.writeFileSync(path.join(ref.path, "README.md"), "attempt version\n");
    manager.commitAll(ref.path, "attempt work");
    fs.writeFileSync(path.join(repo, "README.md"), "diverged on main\n");
    git(repo, "commit", "-am", "diverge", "--no-gpg-sign");
    const outcome = manager.mergeBranch(repo, ref.branch, "Merge winner");
    expect(outcome).toMatchObject({ merged: false, kind: "conflict" });
    if (!outcome.merged) expect(outcome.conflicts).toContain("README.md");
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("diverged on main\n");
  });

  it("re-provisions over a stale directory at the same stable path", () => {
    const { repo, manager } = makeRepo();
    // Stable per-seat dir names mean a crash (or a deferred removal) can leave
    // the previous cycle's directory in place; the next provision must clear
    // and reuse the path instead of failing the spawn.
    const first = manager.addWorktree(repo, "as_1", "seat-dev", "seat/as_1/dev-0");
    fs.writeFileSync(path.join(first.path, "leftover.txt"), "stale\n");
    const second = manager.addWorktree(repo, "as_1", "seat-dev", "seat/as_1/dev-1");
    expect(second.path).toBe(first.path);
    expect(fs.existsSync(path.join(second.path, "leftover.txt"))).toBe(false);
    expect(second.branch).toBe("agentique/seat/as_1/dev-1");
  });

  it("stashes dirty workspace files, merges, and preserves the local edit", () => {
    const { repo, manager } = makeRepo();
    const ref = manager.addWorktree(repo, "as_1", "g-1", "g/1");
    fs.writeFileSync(path.join(ref.path, "README.md"), "attempt version\n");
    manager.commitAll(ref.path, "attempt work");
    fs.writeFileSync(path.join(repo, "README.md"), "uncommitted local edit\n");
    // Previously this REFUSED the merge outright — a live run failed the same
    // land four times on one stray edit until the operator ran git by hand.
    const outcome = manager.mergeBranch(repo, ref.branch, "Merge winner");
    expect(outcome.merged).toBe(true);
    // The seat's work landed; the local edit survives — in place when the pop
    // is clean, otherwise as the newest stash entry (announced via stashNote).
    if (outcome.merged && outcome.stashNote !== undefined) {
      expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("attempt version\n");
      expect(git(repo, "stash", "list")).toContain("agentique-console: pre-merge stash");
    } else {
      expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("uncommitted local edit\n");
    }
  });


  it("removes worktrees and branches; archiveBranch renames instead", () => {
    const { repo, manager } = makeRepo();
    const a = manager.addWorktree(repo, "as_1", "g-1", "g/1");
    const b = manager.addWorktree(repo, "as_1", "g-2", "g/2");
    fs.writeFileSync(path.join(b.path, "big.txt"), "kept in git\n");
    manager.commitAll(b.path, "oversized attempt");
    manager.remove(repo, a.path, a.branch);
    manager.remove(repo, b.path, b.branch, { archiveBranch: true });
    const branches = git(repo, "branch", "--list", "--all");
    expect(branches).not.toContain("agentique/g/1");
    expect(branches).not.toContain("agentique/g/2");
    expect(branches).toContain("agentique/archive/g/2");
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(b.path)).toBe(false);
  });

  it("recoverOrphans removes dead worktrees and keeps live ones", () => {
    const { repo, manager } = makeRepo();
    const live = manager.addWorktree(repo, "as_live", "g-1", "live/1");
    const dead = manager.addWorktree(repo, "as_dead", "g-1", "dead/1");
    const removed = manager.recoverOrphans(
      (agentSessionId) => agentSessionId === "as_live",
      () => repo,
    );
    expect(removed).toBe(1);
    expect(fs.existsSync(live.path)).toBe(true);
    expect(fs.existsSync(dead.path)).toBe(false);
  });
});
