/**
 * Console-owned git worktrees: isolated working copies for agent execution,
 * living under the Console data dir — never inside the workspace.
 * Every path component is server-generated (agent names are user-influenced
 * and may contain ".."; they must never reach the filesystem). All git
 * invocations are execFileSync with server-built argv — no shell. Commits and
 * merges carry an explicit identity so machines without a git config work.
 * Merge-back uses git's own 3-way merge as the conflict detector: on conflict
 * the merge is aborted and the workspace left untouched — never half-merged.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Compares resolved paths so a symlinked or trailing-slash root still matches. */
function samePath(a: string, b: string): boolean {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}

const GIT_IDENTITY = ["-c", "user.name=Agentique Console", "-c", "user.email=console@agentique.invalid"];
const GIT_TIMEOUT_MS = 60_000;

/**
 * The sandbox materializes empty placeholder files for host dotfiles it masks
 * (`.bashrc`, `.idea`, `.claude/settings.json`, …). An unscoped `git add -A`
 * would sweep them into the operator's repo, so agent commits exclude them
 * unless the agent's declared ownership names them.
 */
const SANDBOX_STUB_EXCLUDES = [
  ":(exclude,glob).claude/**", ":(exclude).claude",
  ":(exclude).bashrc", ":(exclude).bash_profile", ":(exclude).profile",
  ":(exclude).zshrc", ":(exclude).zprofile",
  ":(exclude).gitconfig", ":(exclude).gitmodules", ":(exclude).ripgreprc",
  ":(exclude).mcp.json", ":(exclude).idea", ":(exclude).vscode",
  // An MCP server's scratch output. Playwright's writes every snapshot and
  // screenshot into `.playwright-mcp/` under the seat's cwd — which IS the
  // worktree — so without this every verification screenshot would merge into
  // the operator's repository alongside the actual deliverable.
  ":(exclude,glob).playwright-mcp/**", ":(exclude).playwright-mcp",
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

  /**
   * Whether the workspace is a repository ROOT — not merely somewhere inside
   * one.
   *
   * `--is-inside-work-tree` is true for any subdirectory of any repo, so on its
   * own it would happily report `true` for a workspace nested in a monorepo.
   * The agent worktrees would then branch off the PARENT repo's HEAD, and
   * `#onSeatWorktreePost` would merge an agent's work straight into the parent —
   * a repository the operator never pointed the Console at.
   *
   * Requiring the toplevel to BE the workspace root is what makes isolation a
   * containment guarantee rather than a naming convention.
   */
  isGitRepo(workspaceRoot: string): boolean {
    try {
      if (this.#git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return false;
      const toplevel = this.#git(workspaceRoot, ["rev-parse", "--show-toplevel"]).trim();
      return samePath(toplevel, workspaceRoot);
    } catch {
      return false;
    }
  }

  /**
   * Inside somebody else's repository. Distinct from "not a repo at all",
   * because the two want opposite treatment: a plain directory can be safely
   * `git init`ed, and a nested one absolutely cannot.
   */
  isInsideOtherRepo(workspaceRoot: string): boolean {
    try {
      if (this.#git(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return false;
      const toplevel = this.#git(workspaceRoot, ["rev-parse", "--show-toplevel"]).trim();
      return !samePath(toplevel, workspaceRoot);
    } catch {
      return false;
    }
  }

  /**
   * Turn a plain directory into a repository so agent isolation can engage.
   * Every refusal below is a case where initialising would be worse than doing
   * nothing. Returns what happened so the caller can say so out loud.
   */
  initRepo(workspaceRoot: string, opts: { forbiddenRoots?: readonly string[] } = {}):
    { initialized: boolean; reason: string } {
    if (this.isGitRepo(workspaceRoot)) return { initialized: false, reason: "already a git repository" };
    // The containment hazard. Initialising here would leave a repo inside a
    // repo; NOT initialising leaves agent work merging into somebody else's.
    // Neither is acceptable, so isolation stays off and says why.
    if (this.isInsideOtherRepo(workspaceRoot)) {
      return { initialized: false, reason: "inside another git repository; seat isolation is disabled to avoid committing into it" };
    }
    for (const forbidden of [os.homedir(), ...(opts.forbiddenRoots ?? [])]) {
      if (samePath(workspaceRoot, forbidden)) {
        return { initialized: false, reason: `refusing to git init ${forbidden}` };
      }
    }
    // A tree this size is a signal the workspace is not what the operator
    // thinks it is — a home directory, a mounted volume, node_modules.
    try {
      const entries = fs.readdirSync(workspaceRoot, { recursive: true }) as string[];
      if (entries.length > 20_000) {
        return { initialized: false, reason: `${entries.length} files; too large to initialise safely` };
      }
    } catch { /* unreadable is handled by the init attempt below */ }
    try {
      this.#git(workspaceRoot, ["init", "-b", "main"]);
      const gitignore = path.join(workspaceRoot, ".gitignore");
      // An existing .gitignore is the operator's, byte for byte.
      if (!fs.existsSync(gitignore)) {
        fs.writeFileSync(gitignore, "node_modules/\n.env\ndist/\n.DS_Store\n", "utf8");
      }
      this.#git(workspaceRoot, ["add", "-A", "--", ".", ...SANDBOX_STUB_EXCLUDES]);
      if (this.#git(workspaceRoot, ["diff", "--cached", "--name-only"]).trim() === "") {
        // An empty workspace still needs a HEAD for worktrees to branch from.
        this.#git(workspaceRoot, [...GIT_IDENTITY, "commit", "--allow-empty", "-m", "Agentique Console: workspace baseline", "--no-gpg-sign"]);
      } else {
        this.#git(workspaceRoot, [...GIT_IDENTITY, "commit", "-m", "Agentique Console: workspace baseline", "--no-gpg-sign"]);
      }
      return { initialized: true, reason: "initialised with a baseline commit" };
    } catch (error) {
      return { initialized: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  isDirty(workspaceRoot: string): boolean {
    return this.#git(workspaceRoot, ["status", "--porcelain"]).trim() !== "";
  }

  headCommit(workspaceRoot: string): string {
    return this.#git(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  }

  /**
   * Creates a worktree + branch. `dirName` and `branchPath` must be
   * server-generated (the branch becomes `agentique/<branchPath>`). Throws
   * with an operator-actionable message when the workspace is not a git repo.
   *
   * `base` branches from another ref instead of the workspace HEAD — a reviewer
   * must be cut from the branch it is reviewing. Without it a reviewer gets a
   * snapshot that provably does not contain the work it was sent, which is what
   * happened live: the judge found nothing at the shared path and had to read
   * the file out of the generator's branch with raw git. An unresolvable ref
   * falls back to HEAD rather than failing the spawn.
   */
  addWorktree(workspaceRoot: string, agentSessionId: string, dirName: string, branchPath: string, opts: { base?: string } = {}): WorktreeRef {
    if (!this.isGitRepo(workspaceRoot)) {
      throw new Error(`worktree isolation requires the workspace to be a git repository; ${workspaceRoot} is not one (git init it, or run without isolation)`);
    }
    const worktreePath = path.join(this.#root, agentSessionId, dirName);
    const branch = `agentique/${branchPath}`;
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const startPoint = opts.base === undefined ? "HEAD" : this.#resolvable(workspaceRoot, opts.base) ? opts.base : "HEAD";
    // The base commit is the START POINT, not the workspace HEAD: every diff
    // this seat produces is measured against what it actually started from.
    const baseCommit = this.#git(workspaceRoot, ["rev-parse", startPoint]).trim();
    this.#git(workspaceRoot, ["worktree", "add", "-b", branch, worktreePath, startPoint]);
    return { path: worktreePath, branch, baseCommit };
  }

  #resolvable(workspaceRoot: string, ref: string): boolean {
    try { this.#git(workspaceRoot, ["rev-parse", "--verify", `${ref}^{commit}`]); return true; } catch { return false; }
  }

  /**
   * Stage and commit the agent's work; null when nothing changed. Sandbox
   * placeholder dotfiles are excluded unless `owns` explicitly names a path
   * under them — an agent that legitimately owns `.claude/settings.json` still
   * gets it committed, but no agent leaks the harness's scaffolding.
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

  /**
   * Counts only, one `git diff --numstat` subprocess. The prompt hot paths
   * (roster work-state, checkpoint reconstruction) need the numbers, not the
   * patch — `captureDiff` materializes the full `--binary` patch, which is
   * real cost on every agent wake.
   */
  captureDiffStats(workspaceRoot: string, baseCommit: string, branch: string): { filesChanged: number; insertions: number; deletions: number } {
    const numstat = this.#git(workspaceRoot, ["diff", "--numstat", `${baseCommit}..${branch}`]).trim();
    let filesChanged = 0, insertions = 0, deletions = 0;
    for (const line of numstat === "" ? [] : numstat.split("\n")) {
      const [added, removed] = line.split("\t");
      filesChanged += 1;
      insertions += Number(added) || 0;
      deletions += Number(removed) || 0;
    }
    return { filesChanged, insertions, deletions };
  }

  captureDiff(workspaceRoot: string, baseCommit: string, branch: string): DiffCapture {
    const patch = this.#git(workspaceRoot, ["diff", "--binary", "-M", `${baseCommit}..${branch}`]);
    const stat = this.#git(workspaceRoot, ["diff", "--shortstat", `${baseCommit}..${branch}`]).trim();
    return { patch, stat, ...this.captureDiffStats(workspaceRoot, baseCommit, branch) };
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
