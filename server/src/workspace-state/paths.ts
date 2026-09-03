/**
 * Where the runtime keeps everything it owns for a Workspace, outside the
 * Workspace itself (glossary "Workspace"): one state root, one directory
 * per Workspace id, one per Run id, with stable, identity-derived paths for
 * the Integration Workspace, every Invocation worktree, every check view,
 * every publication staging area, and — for a plain-directory Workspace —
 * the console-owned shadow repository.
 *
 *   <stateRoot>/workspaces/<workspaceId>/
 *     shadow.git/                       the directory kind's shadow repository
 *     runs/<runId>/
 *       integration/                    the Run's Integration Workspace
 *       worktrees/<invocationId>/       a writing Invocation's worktree
 *       checks/<key digest>/            a disposable check view
 *       publications/<publicationId>/   a Publication's staging (marker + worktree)
 *
 * Every id is a canonical id (a prefix and 24 hex characters), so no path
 * component is ever operator- or model-influenced, and every destructive
 * operation first proves its path lies under the state root: the providers
 * never delete anything else.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CANONICAL_ID = /^[a-z]+_[0-9a-f]{24}$/;

export class WorkspaceStateError extends Error {
  constructor(
    readonly code: "invalid_id" | "path_not_owned" | "not_a_repository" | "target_mismatch" | "unknown_snapshot" | "workspace_missing" | "drifted" | "unsupported" | "invalid_layout",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceStateError";
  }
}

export interface WorkspaceStateLayout {
  /** The console's state directory for Workspace state; every owned path lies under `<stateRoot>/workspaces`. */
  stateRoot: string;
}

function id(value: string, what: string): string {
  if (!CANONICAL_ID.test(value)) throw new WorkspaceStateError("invalid_id", `${what} ${JSON.stringify(value)} is not a canonical id`);
  return value;
}

export function workspacesRoot(layout: WorkspaceStateLayout): string {
  return path.resolve(layout.stateRoot, "workspaces");
}

export function workspaceDir(layout: WorkspaceStateLayout, workspaceId: string): string {
  return path.join(workspacesRoot(layout), id(workspaceId, "Workspace id"));
}

export function shadowRepositoryDir(layout: WorkspaceStateLayout, workspaceId: string): string {
  return path.join(workspaceDir(layout, workspaceId), "shadow.git");
}

export function runDir(layout: WorkspaceStateLayout, workspaceId: string, runId: string): string {
  return path.join(workspaceDir(layout, workspaceId), "runs", id(runId, "Run id"));
}

export function integrationDir(layout: WorkspaceStateLayout, workspaceId: string, runId: string): string {
  return path.join(runDir(layout, workspaceId, runId), "integration");
}

/** The Run directory an Integration Workspace path belongs to (`<runDir>/integration`), proven to lie under the state root. */
export function runDirOfIntegration(layout: WorkspaceStateLayout, integrationWorkspacePath: string): string {
  const resolved = assertOwned(layout, integrationWorkspacePath);
  if (path.basename(resolved) !== "integration") throw new WorkspaceStateError("invalid_layout", "the Integration Workspace path is not the runtime's integration directory");
  return path.dirname(resolved);
}

export function worktreeDir(runDirectory: string, invocationId: string): string {
  return path.join(runDirectory, "worktrees", id(invocationId, "Invocation id"));
}

export function checkViewDir(runDirectory: string, isolationKey: string): string {
  return path.join(runDirectory, "checks", createHash("sha256").update(isolationKey).digest("hex").slice(0, 32));
}

/**
 * The Run directory an owned Run-scoped path lies under (`<stateRoot>/workspaces/<ws>/runs/<run>`): the integration
 * checkout, a worktree, or a publication's staging all derive their check views there, so a view's path stays as short
 * as the integration checkout's whatever the base — Windows bounds a repository path at 260 characters.
 */
export function runDirectoryOf(layout: WorkspaceStateLayout, ownedPath: string): string {
  let cursor = assertOwned(layout, ownedPath);
  const root = workspacesRoot(layout);
  while (cursor !== root && cursor !== path.dirname(cursor)) {
    const parent = path.dirname(cursor);
    if (path.basename(parent) === "runs" && path.basename(path.dirname(parent)).startsWith("ws_")) return cursor;
    cursor = parent;
  }
  throw new WorkspaceStateError("invalid_layout", `${JSON.stringify(ownedPath)} lies under no Run directory of the state root`);
}

export function publicationDir(layout: WorkspaceStateLayout, workspaceId: string, runId: string, publicationId: string): string {
  return path.join(runDir(layout, workspaceId, runId), "publications", id(publicationId, "Publication id"));
}

/** Resolves `target` and proves it lies strictly under the state root's Workspace directory; the guard before every removal. */
export function assertOwned(layout: WorkspaceStateLayout, target: string): string {
  const root = workspacesRoot(layout);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new WorkspaceStateError("path_not_owned", "the path is not owned by the runtime's Workspace state");
  return resolved;
}

/** Removes an owned directory tree if it exists; never touches anything outside the state root. */
export function removeOwned(layout: WorkspaceStateLayout, target: string): void {
  const resolved = assertOwned(layout, target);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

export function exists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}
