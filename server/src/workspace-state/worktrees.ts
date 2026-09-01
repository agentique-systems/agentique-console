/**
 * Worktree mechanics shared by every provider: an isolated checkout of one
 * commit at an owned path (detached, or on a Run-owned branch), created from
 * whichever worktree of the repository the caller stands in, and removed
 * idempotently. A stale directory at the same owned path is cleared first,
 * because the identities that derive the path are unique and a leftover can
 * only be a previous process's unfinished work. Removal proves ownership
 * before deleting anything and never touches another worktree.
 */
import fs from "node:fs";
import path from "node:path";
import { git, gitSync } from "./git.ts";
import { assertOwned, exists, removeOwned, type WorkspaceStateLayout } from "./paths.ts";

export interface WorktreeAddRequest {
  /** A directory of the repository (the Workspace root, the shadow repository, the Integration Workspace, a staging area). */
  fromCwd: string;
  worktreePath: string;
  commit: string;
  /** A Run-owned branch to create (reset if a stale one exists) and check out; detached when absent. */
  branch?: string;
}

function clearStale(layout: WorkspaceStateLayout, fromCwd: string, worktreePath: string): void {
  const owned = assertOwned(layout, worktreePath);
  if (!exists(owned)) return;
  gitSync(["worktree", "remove", "--force", owned], { cwd: fromCwd, allowFailure: true });
  if (exists(owned)) removeOwned(layout, owned);
  gitSync(["worktree", "prune"], { cwd: fromCwd, allowFailure: true });
}

/** Synchronous, for preparation inside a transaction. */
export function addWorktreeSync(layout: WorkspaceStateLayout, request: WorktreeAddRequest): void {
  const owned = assertOwned(layout, request.worktreePath);
  clearStale(layout, request.fromCwd, owned);
  fs.mkdirSync(path.dirname(owned), { recursive: true });
  gitSync(request.branch === undefined ? ["worktree", "add", "--detach", owned, request.commit] : ["worktree", "add", "-B", request.branch, owned, request.commit], { cwd: request.fromCwd });
}

export async function addWorktree(layout: WorkspaceStateLayout, request: WorktreeAddRequest): Promise<void> {
  const owned = assertOwned(layout, request.worktreePath);
  clearStale(layout, request.fromCwd, owned);
  fs.mkdirSync(path.dirname(owned), { recursive: true });
  await git(request.branch === undefined ? ["worktree", "add", "--detach", owned, request.commit] : ["worktree", "add", "-B", request.branch, owned, request.commit], { cwd: request.fromCwd });
}

/**
 * Removes one owned worktree: `git worktree remove --force`, the directory
 * itself when git no longer knows it, then a prune so the repository forgets
 * it. A worktree already gone is not an error.
 */
export function removeWorktreeSync(layout: WorkspaceStateLayout, fromCwd: string, worktreePath: string): void {
  const owned = assertOwned(layout, worktreePath);
  if (exists(owned) && exists(fromCwd)) gitSync(["worktree", "remove", "--force", owned], { cwd: fromCwd, allowFailure: true });
  if (exists(owned)) removeOwned(layout, owned);
  if (exists(fromCwd)) gitSync(["worktree", "prune"], { cwd: fromCwd, allowFailure: true });
}

export async function removeWorktree(layout: WorkspaceStateLayout, fromCwd: string, worktreePath: string): Promise<void> {
  const owned = assertOwned(layout, worktreePath);
  if (exists(owned) && exists(fromCwd)) await git(["worktree", "remove", "--force", owned], { cwd: fromCwd, allowFailure: true });
  if (exists(owned)) removeOwned(layout, owned);
  if (exists(fromCwd)) await git(["worktree", "prune"], { cwd: fromCwd, allowFailure: true });
}
