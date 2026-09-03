/**
 * The plain-directory Workspace kind (glossary "Workspace provider"): the
 * Workspace is a directory with no repository of its own, and the Target is
 * that directory's content. The runtime never initializes a repository
 * inside it. Instead a console-owned bare **shadow repository** under the
 * state root receives every imported state as a commit: a Snapshot is the
 * content digest of the imported tree, the Integration Workspace and every
 * Invocation worktree are worktrees of the shadow. A plain directory offers no atomic
 * update-plus-receipt, so the kind publishes nothing: a publication request
 * is refused before the directory is touched (`capabilities.ts`). The shadow
 * is storage housekeeping: nothing canonical depends on it beyond the
 * identities it reproduces.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunTarget, SnapshotIdentity } from "@agentique-console/core";
import { git, gitSync, text, type GitOptions } from "../git.ts";
import { exists, shadowRepositoryDir, WorkspaceStateError, type WorkspaceStateLayout } from "../paths.ts";
import { identityOfCommit, identityOfCommitSync } from "../snapshots.ts";

export function assertDirectoryTarget(target: RunTarget): void {
  if (target.kind !== "directory") throw new WorkspaceStateError("target_mismatch", "a directory Workspace publishes to the directory itself");
}

export function assertDirectoryRootSync(root: string): void {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new WorkspaceStateError("workspace_missing", "the Workspace root is not a directory");
  if (samePath(root, os.homedir())) throw new WorkspaceStateError("unsupported", "a home directory is not a Workspace");
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** The shadow repository of a Workspace, created bare on first use. */
export function ensureShadowRepositorySync(layout: WorkspaceStateLayout, workspaceId: string): string {
  const shadow = shadowRepositoryDir(layout, workspaceId);
  if (!exists(path.join(shadow, "HEAD"))) {
    fs.mkdirSync(shadow, { recursive: true });
    gitSync(["init", "--bare", "--quiet", "--initial-branch=shadow", shadow], { cwd: path.dirname(shadow) });
    // Every worktree of the shadow is the runtime's; nothing here is an operator checkout.
    gitSync(["config", "core.autocrlf", "false"], { cwd: shadow });
  }
  return shadow;
}

export function shadowRepositoryOf(layout: WorkspaceStateLayout, workspaceId: string): string {
  const shadow = shadowRepositoryDir(layout, workspaceId);
  if (!exists(path.join(shadow, "HEAD"))) throw new WorkspaceStateError("workspace_missing", "the Workspace has no shadow repository yet");
  return shadow;
}

/** Environment that points a git command at the shadow repository, the directory as its working tree, and a private index. */
function importEnvironment(shadow: string, root: string, indexFile: string): Record<string, string> {
  return { GIT_DIR: shadow, GIT_WORK_TREE: root, GIT_INDEX_FILE: indexFile };
}

function withPrivateIndex<T>(layout: WorkspaceStateLayout, workspaceId: string, use: (indexFile: string) => T): T {
  const dir = path.join(shadowRepositoryDir(layout, workspaceId), "agentique-tmp");
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, `index-${randomUUID()}`);
  try {
    return use(indexFile);
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

export interface ImportedDirectory {
  commit: string;
  tree: string;
  identity: SnapshotIdentity;
}

/**
 * Imports the directory's tracked files (everything not ignored by its own
 * `.gitignore` files) as one commit of the shadow repository, synchronously,
 * without creating anything inside the directory. The directory is read only.
 */
export function importDirectorySync(layout: WorkspaceStateLayout, workspaceId: string, root: string, message: string): ImportedDirectory {
  const shadow = ensureShadowRepositorySync(layout, workspaceId);
  return withPrivateIndex(layout, workspaceId, (indexFile) => {
    const env = importEnvironment(shadow, root, indexFile);
    const options: GitOptions = { cwd: root, env };
    gitSync(["-c", "core.excludesfile=", "add", "-A", "--", "."], options);
    const tree = text(gitSync(["write-tree"], options));
    const commit = text(gitSync(["commit-tree", tree, "-m", message], { ...options, identity: true }));
    return { commit, tree, identity: identityOfCommitSync(shadow, commit, "directory") };
  });
}

export async function importDirectory(layout: WorkspaceStateLayout, workspaceId: string, root: string, message: string): Promise<ImportedDirectory> {
  const shadow = ensureShadowRepositorySync(layout, workspaceId);
  const dir = path.join(shadow, "agentique-tmp");
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, `index-${randomUUID()}`);
  try {
    const env = importEnvironment(shadow, root, indexFile);
    const options: GitOptions = { cwd: root, env };
    await git(["-c", "core.excludesfile=", "add", "-A", "--", "."], options);
    const tree = text(await git(["write-tree"], options));
    const commit = text(await git(["commit-tree", tree, "-m", message], { ...options, identity: true }));
    return { commit, tree, identity: await identityOfCommit(shadow, commit, "directory") };
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}
