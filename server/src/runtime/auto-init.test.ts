/**
 * Turning a plain directory into a repository, and — more importantly —
 * knowing when not to. `rev-parse --is-inside-work-tree` alone is TRUE for any
 * subdirectory of any repo: a workspace nested in a monorepo would branch its
 * agent worktrees off the PARENT's HEAD and merge agent work into a repository
 * the operator never pointed the Console at.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "./worktree-manager.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-init-"));
  dirs.push(dir);
  return fs.realpathSync(dir);
}

function manager(): WorktreeManager {
  return new WorktreeManager({ dataDir: tmpdir() });
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("isGitRepo requires the workspace to BE the repository root", () => {
  it("is true for a repository root", () => {
    const root = tmpdir();
    git(root, ["init", "-b", "main"]);
    expect(manager().isGitRepo(root)).toBe(true);
    expect(manager().isInsideOtherRepo(root)).toBe(false);
  });

  it("is FALSE for a subdirectory of a repository", () => {
    // The whole point: agent work in `packages/app` of a monorepo must not be
    // committed and merged into the monorepo itself.
    const root = tmpdir();
    git(root, ["init", "-b", "main"]);
    const nested = path.join(root, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });

    expect(manager().isGitRepo(nested)).toBe(false);
    expect(manager().isInsideOtherRepo(nested)).toBe(true);
  });

  it("is false for a plain directory", () => {
    const root = tmpdir();
    expect(manager().isGitRepo(root)).toBe(false);
    expect(manager().isInsideOtherRepo(root)).toBe(false);
  });
});

describe("initRepo", () => {
  it("initialises a plain directory with a baseline commit", () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");

    const outcome = manager().initRepo(root);

    expect(outcome.initialized).toBe(true);
    expect(manager().isGitRepo(root)).toBe(true);
    // A HEAD must exist or worktrees have nothing to branch from.
    expect(git(root, ["rev-parse", "HEAD"]).trim()).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("REFUSES inside another repository", () => {
    const root = tmpdir();
    git(root, ["init", "-b", "main"]);
    const nested = path.join(root, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });

    const outcome = manager().initRepo(nested);

    expect(outcome.initialized).toBe(false);
    expect(outcome.reason).toMatch(/inside another git repository/);
    // And critically: it did not create one.
    expect(fs.existsSync(path.join(nested, ".git"))).toBe(false);
  });

  it("leaves an existing repository alone", () => {
    const root = tmpdir();
    git(root, ["init", "-b", "main"]);
    const outcome = manager().initRepo(root);
    expect(outcome.initialized).toBe(false);
    expect(outcome.reason).toMatch(/already a git repository/);
  });

  it("preserves an existing .gitignore byte for byte", () => {
    const root = tmpdir();
    const original = "# mine\\nbuild/\\n";
    fs.writeFileSync(path.join(root, ".gitignore"), original);

    manager().initRepo(root);

    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(original);
  });

  it("writes a minimal .gitignore only when there is none", () => {
    const root = tmpdir();
    manager().initRepo(root);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("node_modules/");
  });

  it("refuses a forbidden root", () => {
    const root = tmpdir();
    const outcome = manager().initRepo(root, { forbiddenRoots: [root] });
    expect(outcome.initialized).toBe(false);
    expect(outcome.reason).toMatch(/refusing to git init/);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
  });

  it("initialises an empty directory with an empty baseline commit", () => {
    // A brand-new workspace is the common case, and it still needs a HEAD.
    const root = tmpdir();
    const outcome = manager().initRepo(root);
    expect(outcome.initialized).toBe(true);
    expect(git(root, ["rev-parse", "HEAD"]).trim()).not.toBe("");
  });
});
