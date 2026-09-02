/**
 * Workspaces as the operator manages them (glossary "Workspace"): creation
 * under the configured browse roots with the kind detected from the
 * directory (a repository root is `git`, anything else `directory`), the
 * provider's capability matrix beside every Workspace, and the default
 * Target of a new Run. Every canonical write goes through the Workspace
 * store; the filesystem is read through the browse rules only.
 */
import fs from "node:fs";
import path from "node:path";
import { ValidationError, type RunTarget, type Workspace, type WorkspaceCapabilities, type WorkspaceCreateBody, type WorkspaceId, type WorkspaceKind, type WorkspaceResponse } from "@agentique-console/core";
import type { WorkspaceStore } from "../persistence/stores/workspaces.ts";
import { WORKSPACE_CAPABILITIES } from "../workspace-state/capabilities.ts";
import { gitSync, text } from "../workspace-state/git.ts";
import { resolveNewPath, resolveRoots } from "../workspaces/fs-browse.ts";

export function capabilitiesOf(kind: WorkspaceKind): WorkspaceCapabilities {
  const matrix = WORKSPACE_CAPABILITIES[kind];
  return { kind, target: matrix.target, snapshotIdentity: matrix.snapshotIdentity, publicationStrategies: [...matrix.publicationStrategies], atomicPublication: matrix.atomicPublication, publicationApply: matrix.publicationApply };
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** `git` exactly when the directory is a repository's own top level; a directory inside another repository is a plain directory. */
export function detectKind(rootPath: string): WorkspaceKind {
  const inside = gitSync(["rev-parse", "--is-inside-work-tree"], { cwd: rootPath, allowFailure: true });
  if (inside.exitCode !== 0 || text(inside) !== "true") return "directory";
  const toplevel = gitSync(["rev-parse", "--show-toplevel"], { cwd: rootPath, allowFailure: true });
  return toplevel.exitCode === 0 && samePath(text(toplevel), rootPath) ? "git" : "directory";
}

/** The Target a new Run of the Workspace publishes to by default: the checked-out branch of a git Workspace, the directory itself otherwise. */
export function defaultTargetOf(workspace: Workspace): RunTarget | null {
  if (workspace.kind === "directory") return { kind: "directory" };
  if (!fs.existsSync(workspace.rootPath)) return null;
  const head = gitSync(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: workspace.rootPath, allowFailure: true });
  if (head.exitCode === 0 && text(head) !== "") return { kind: "branch", branch: text(head) };
  const branches = gitSync(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], { cwd: workspace.rootPath, allowFailure: true });
  const first = branches.exitCode === 0 ? text(branches).split(/\r?\n/).find((line) => line !== "" && !line.startsWith("agentique/")) : undefined;
  return first === undefined ? null : { kind: "branch", branch: first };
}

export class WorkspaceService {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly roots: readonly string[],
  ) {}

  view(workspace: Workspace): WorkspaceResponse {
    return { workspace, capabilities: capabilitiesOf(workspace.kind), defaultTarget: defaultTargetOf(workspace) };
  }

  list(): WorkspaceResponse[] {
    return this.store.list().map((w) => this.view(w));
  }

  get(id: WorkspaceId): WorkspaceResponse {
    return this.view(this.store.get(id));
  }

  async create(body: WorkspaceCreateBody): Promise<WorkspaceResponse> {
    const roots = await resolveRoots(this.roots);
    const rootPath = await resolveNewPath(body.rootPath, roots);
    if (!fs.existsSync(rootPath)) {
      if (body.create !== true) throw new ValidationError("the directory does not exist (pass create: true to create it)", { path: rootPath });
      fs.mkdirSync(rootPath, { recursive: true });
    } else if (!fs.statSync(rootPath).isDirectory()) {
      throw new ValidationError("the path is not a directory", { path: rootPath });
    }
    if (this.store.list().some((w) => samePath(w.rootPath, rootPath))) throw new ValidationError("a Workspace already uses this directory", { path: rootPath });
    const detected = detectKind(rootPath);
    if (body.kind !== undefined && body.kind !== detected) throw new ValidationError(`the directory is a ${detected} Workspace, not ${body.kind}`, { kind: detected });
    const name = body.name?.trim() || path.basename(rootPath) || rootPath;
    return this.view(this.store.create({ name, rootPath, kind: detected }));
  }

  update(id: WorkspaceId, patch: { name: string }): WorkspaceResponse {
    return this.view(this.store.update(id, { name: patch.name.trim() }));
  }
}
