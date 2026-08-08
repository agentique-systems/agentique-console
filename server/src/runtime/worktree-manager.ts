/**
 * Console-owned git worktrees: isolated working copies for attempt and seat
 * execution, living under the Console data dir — never inside the workspace.
 * Every path component is server-generated (seat names are user-influenced
 * and may contain ".."; they must never reach the filesystem). All git
 * invocations are execFileSync with server-built argv — no shell. Commits and
 * merges carry an explicit identity so machines without a git config work.
 * Merge-back uses git's own 3-way merge as the conflict detector: on conflict
 * the merge is aborted and the workspace left untouched — never half-merged.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_IDENTITY = ["-c", "user.name=Agentique Console", "-c", "user.email=console@agentique.invalid"];
const GIT_TIMEOUT_MS = 60_000;

/**
 * The sandbox materializes empty placeholder files for host dotfiles it masks
 * (`.bashrc`, `.idea`, `.claude/settings.json`, …). An unscoped `git add -A`
 * swept 21 of them into the operator's repo in the db-live-1 run, so seat
 * commits exclude them unless the seat's declared ownership names them.
 */
const SANDBOX_STUB_EXCLUDES = [
  ":(exclude,glob).claude/**", ":(exclude).claude",
  ":(exclude).bashrc", ":(exclude).bash_profile", ":(exclude).profile",
  ":(exclude).zshrc", ":(exclude).zprofile",
  ":(exclude).gitconfig", ":(exclude).gitmodules", ":(exclude).ripgreprc",
  ":(exclude).mcp.json", ":(exclude).idea", ":(exclude).vscode",
];

export interface WorktreeRef {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface DiffCapture {
  patch: string;
  stat: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export type MergeOutcome =
  | { merged: true; commit: string }
  | { merged: false; conflicts: string[]; detail: string };

export class WorktreeManager {
  readonly #root: string;

  constructor(deps: { dataDir: string }) {
    this.#root = path.join(deps.dataDir, "worktrees");
  }

  #git(cwd: string, args: string[], opts: { allowFailure?: boolean } = {}): string {
    try {
      return execFileSync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      if (opts.allowFailure) throw error;
      const stderr = (error as { stderr?: string }).stderr ?? "";
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || (error instanceof Error ? error.message : String(error))}`);
    }
  }

  isGitRepo(workspaceRoot: string): boolean {
    try {
      return this.#git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
    } catch {
      return false;
    }
  }

  isDirty(workspaceRoot: string): boolean {
    return this.#git(workspaceRoot, ["status", "--porcelain"]).trim() !== "";
  }

  headCommit(workspaceRoot: string): string {
    return this.#git(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  }

  /**
   * Creates a worktree + branch at HEAD. `dirName` and `branchPath` must be
   * server-generated (the branch becomes `agentique/<branchPath>`). Throws
   * with an operator-actionable message when the workspace is not a git repo.
   */
  addWorktree(workspaceRoot: string, agentSessionId: string, dirName: string, branchPath: string): WorktreeRef {
    if (!this.isGitRepo(workspaceRoot)) {
      throw new Error(`worktree isolation requires the workspace to be a git repository; ${workspaceRoot} is not one (git init it, or run without isolation)`);
    }
    const worktreePath = path.join(this.#root, agentSessionId, dirName);
    const branch = `agentique/${branchPath}`;
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const baseCommit = this.headCommit(workspaceRoot);
    this.#git(workspaceRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    return { path: worktreePath, branch, baseCommit };
  }

  /**
   * Stage and commit the seat's work; null when nothing changed. Sandbox
   * placeholder dotfiles are excluded unless `owns` explicitly names a path
   * under them — a seat that legitimately owns `.claude/settings.json` still
   * gets it committed, but no seat leaks the harness's scaffolding.
   */
  commitAll(worktreePath: string, message: string, owns: string[] = []): string | null {
    const claimsExcluded = owns.some((scope) => SANDBOX_STUB_EXCLUDES.some((rule) => {
      const bare = rule.replace(/^:\((?:exclude,glob|exclude)\)/, "").replace(/\/\*\*$/, "");
      return scope === bare || scope.startsWith(`${bare}/`);
    }));
    this.#git(worktreePath, ["add", "-A", "--", ".", ...(claimsExcluded ? [] : SANDBOX_STUB_EXCLUDES)]);
    // Must test the INDEX, not the worktree: excluded stubs stay permanently
    // untracked, so `status --porcelain` is never empty once they exist and a
    // stub-only turn would try (and fail) to commit nothing.
    if (this.#git(worktreePath, ["diff", "--cached", "--name-only"]).trim() === "") return null;
    this.#git(worktreePath, [...GIT_IDENTITY, "commit", "-m", message, "--no-gpg-sign"]);
    return this.#git(worktreePath, ["rev-parse", "HEAD"]).trim();
  }

  captureDiff(workspaceRoot: string, baseCommit: string, branch: string): DiffCapture {
    const patch = this.#git(workspaceRoot, ["diff", "--binary", "-M", `${baseCommit}..${branch}`]);
    const stat = this.#git(workspaceRoot, ["diff", "--shortstat", `${baseCommit}..${branch}`]).trim();
    const numstat = this.#git(workspaceRoot, ["diff", "--numstat", `${baseCommit}..${branch}`]).trim();
    let filesChanged = 0, insertions = 0, deletions = 0;
    for (const line of numstat === "" ? [] : numstat.split("\n")) {
      const [added, removed] = line.split("\t");
      filesChanged += 1;
      insertions += Number(added) || 0;
      deletions += Number(removed) || 0;
    }
    return { patch, stat, filesChanged, insertions, deletions };
  }

  /** --no-ff so --abort semantics are clean and branch commits stay reachable. */
  mergeBranch(workspaceRoot: string, branch: string, message: string): MergeOutcome {
    try {
      this.#git(workspaceRoot, [...GIT_IDENTITY, "merge", "--no-ff", "--no-gpg-sign", "-m", message, branch], { allowFailure: true });
      return { merged: true, commit: this.headCommit(workspaceRoot) };
    } catch (error) {
      const stderr = ((error as { stderr?: string }).stderr ?? "") + ((error as { stdout?: string }).stdout ?? "");
      // Capture conflicted paths BEFORE aborting — the abort clears them.
      let conflicts: string[] = [];
      try {
        const unmerged = this.#git(workspaceRoot, ["diff", "--name-only", "--diff-filter=U"]).trim();
        conflicts = unmerged === "" ? [] : unmerged.split("\n");
      } catch { /* refused pre-merge: no unmerged paths exist */ }
      try { this.#git(workspaceRoot, ["merge", "--abort"]); } catch { /* no MERGE_HEAD: git refused before starting */ }
      return { merged: false, conflicts, detail: stderr.trim() || "merge failed" };
    }
  }

  /** Removes the worktree and its branch; archiveBranch renames instead of deleting. */
  remove(workspaceRoot: string, worktreePath: string, branch: string, opts: { archiveBranch?: boolean } = {}): void {
    try { this.#git(workspaceRoot, ["worktree", "remove", "--force", worktreePath]); } catch { fs.rmSync(worktreePath, { recursive: true, force: true }); }
    try {
      if (opts.archiveBranch) this.#git(workspaceRoot, ["branch", "-m", branch, branch.replace(/^agentique\//, "agentique/archive/")]);
      else this.#git(workspaceRoot, ["branch", "-D", branch]);
    } catch { /* branch already gone */ }
    try { this.#git(workspaceRoot, ["worktree", "prune"]); } catch { /* best effort */ }
  }

  /**
   * Boot pass: removes worktree directories whose owner is no longer live.
   * `isLive(agentSessionId, dirName)` decides; `workspaceRootOf` resolves the
   * repo to prune against (null = just delete the directory).
   */
  recoverOrphans(isLive: (agentSessionId: string, dirName: string) => boolean, workspaceRootOf: (agentSessionId: string) => string | null): number {
    if (!fs.existsSync(this.#root)) return 0;
    let removed = 0;
    for (const sessionDir of fs.readdirSync(this.#root, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue;
      const sessionPath = path.join(this.#root, sessionDir.name);
      for (const entry of fs.readdirSync(sessionPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || isLive(sessionDir.name, entry.name)) continue;
        const worktreePath = path.join(sessionPath, entry.name);
        const workspaceRoot = workspaceRootOf(sessionDir.name);
        if (workspaceRoot !== null && this.isGitRepo(workspaceRoot)) {
          try { this.#git(workspaceRoot, ["worktree", "remove", "--force", worktreePath]); } catch { fs.rmSync(worktreePath, { recursive: true, force: true }); }
          try { this.#git(workspaceRoot, ["worktree", "prune"]); } catch { /* best effort */ }
        } else {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
        removed += 1;
      }
      if (fs.readdirSync(sessionPath).length === 0) fs.rmdirSync(sessionPath);
    }
    return removed;
  }
}
