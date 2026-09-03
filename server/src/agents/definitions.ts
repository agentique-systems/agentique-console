/**
 * Workspace-file Agent Definitions (execution-model §11; migration-contract
 * §6): every `.claude/agents/<name>.md` of a Workspace, read from the exact
 * pinned Snapshot — never from the live working directory — and appended
 * as an immutable revision with provenance `workspace_file` (normalized
 * path, Snapshot), a content hash, and a logical identity derived from the
 * file's path and native name. Loading the same Snapshot again finds the
 * same revisions; a changed file at a later Snapshot is a new revision of
 * the same logical definition; a file that uses a native field the console
 * cannot execute faithfully is rejected explicitly and creates nothing.
 *
 * Files are read through git object access (a blob at a commit), so a
 * symlink, a nested directory, a non-UTF-8 or oversized file, and a path
 * outside `.claude/agents/` never become a definition. The SDK itself is
 * configured to discover no agent files (provider adapter), so the pinned
 * revision is the only version that executes.
 */
import { normalizeAgentDefinitionPath, type AgentDefinitionId, type AgentDefinitionRevisionId, type RunTarget, type Snapshot, type SnapshotId, type WorkspaceId } from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import { gitSync, text } from "../workspace-state/git.ts";
import type { WorkspaceStateLayout } from "../workspace-state/paths.ts";
import { assertDirectoryRootSync, importDirectorySync, shadowRepositoryOf } from "../workspace-state/providers/directory.ts";
import { assertRepositoryRootSync, branchCommitSync, branchRefOf } from "../workspace-state/providers/git.ts";
import { commitOfIdentitySync, identityOfCommitSync } from "../workspace-state/snapshots.ts";
import { BUILTIN_DEFINITION_NAMES } from "./builtins.ts";
import { evaluateNativeAgent, parseNativeAgentFile, type FieldReason, type NativeAgentDefaults } from "./native-agent-file.ts";

export const AGENT_DEFINITIONS_DIRECTORY = ".claude/agents";
/** A definition file larger than this is rejected, never truncated. */
export const AGENT_DEFINITION_FILE_MAX_BYTES = 262_144;

export type LoadedDefinitionFile =
  | { kind: "loaded"; path: string; name: string; definitionId: AgentDefinitionId; revisionId: AgentDefinitionRevisionId; /** True when the revision already existed (the same content at the same Snapshot). */ reused: boolean; informational: string[] }
  | { kind: "rejected"; path: string; reasons: FieldReason[] };

export interface AgentDefinitionLoadReport {
  workspaceId: WorkspaceId;
  snapshotId: SnapshotId;
  files: LoadedDefinitionFile[];
}

interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

export class WorkspaceAgentDefinitionLoader {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly layout: WorkspaceStateLayout,
    private readonly defaults: NativeAgentDefaults,
  ) {}

  /** Takes a Snapshot of the Target's current state (reason `agent_definition_read`) and loads the definitions pinned to it. */
  loadCurrent(workspaceId: WorkspaceId, target: RunTarget, options: WriteOptions = {}): AgentDefinitionLoadReport {
    const workspace = this.stores.workspaces.get(workspaceId);
    let identity;
    if (workspace.kind === "git") {
      assertRepositoryRootSync(workspace.rootPath);
      const commit = branchCommitSync(workspace.rootPath, branchRefOf(target));
      if (commit === null) throw new Error(`the Target branch does not exist in ${workspace.name}`);
      identity = identityOfCommitSync(workspace.rootPath, commit, "git");
    } else {
      if (target.kind !== "directory") throw new Error("a directory Workspace has a directory Target");
      assertDirectoryRootSync(workspace.rootPath);
      identity = importDirectorySync(this.layout, workspace.id, workspace.rootPath, "Agentique Console: Agent Definition read").identity;
    }
    const snapshot = this.stores.snapshots.record({ workspaceId: workspace.id, runId: null, identity, reason: "agent_definition_read" }, options);
    return this.loadAtSnapshot(workspace.id, snapshot.id, options);
  }

  /** Reads every definition file at exactly `snapshotId` and appends (or finds) one revision per accepted file. */
  loadAtSnapshot(workspaceId: WorkspaceId, snapshotId: SnapshotId, options: WriteOptions = {}): AgentDefinitionLoadReport {
    const workspace = this.stores.workspaces.get(workspaceId);
    const snapshot = this.stores.snapshots.get(snapshotId);
    if (snapshot.workspaceId !== workspaceId) throw new Error(`Snapshot ${snapshotId} belongs to another Workspace`);
    const repository = workspace.kind === "git" ? workspace.rootPath : shadowRepositoryOf(this.layout, workspace.id);
    const commit = commitOfIdentitySync(repository, snapshot.identity);
    const files = this.listDefinitionFiles(repository, commit);
    const report: AgentDefinitionLoadReport = { workspaceId, snapshotId, files: [] };
    return this.ctx.tx.write(() => {
      for (const entry of files) report.files.push(this.loadOne(repository, entry, snapshot, options));
      return report;
    });
  }

  /** The blobs under `.claude/agents/` at the commit, in path order; anything that is not a regular file is reported as rejected. */
  private listDefinitionFiles(repository: string, commit: string): TreeEntry[] {
    const listing = gitSync(["ls-tree", "-z", commit, "--", `${AGENT_DEFINITIONS_DIRECTORY}/`], { cwd: repository, allowFailure: true });
    if (listing.exitCode !== 0) return [];
    const entries: TreeEntry[] = [];
    for (const line of listing.stdout.toString("utf8").split("\0")) {
      if (line === "") continue;
      const tab = line.indexOf("\t");
      const [mode, type, object] = line.slice(0, tab).split(" ");
      entries.push({ mode: mode ?? "", type: type ?? "", object: object ?? "", path: line.slice(tab + 1) });
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private loadOne(repository: string, entry: TreeEntry, snapshot: Snapshot, options: WriteOptions): LoadedDefinitionFile {
    const rejected = (reasons: FieldReason[]): LoadedDefinitionFile => ({ kind: "rejected", path: entry.path, reasons });
    if (entry.type !== "blob") return rejected([{ field: "path", reason: `${entry.path} is a ${entry.type}, not a definition file (nested directories are not read)` }]);
    if (entry.mode === "120000") return rejected([{ field: "path", reason: "a symbolic link is not a definition file" }]);
    const normalized = normalizeAgentDefinitionPath(entry.path);
    if (normalized === null) return rejected([{ field: "path", reason: `${entry.path} is not a definition file path (.claude/agents/<name>.md)` }]);
    const blob = gitSync(["cat-file", "blob", entry.object], { cwd: repository });
    if (blob.stdout.byteLength > AGENT_DEFINITION_FILE_MAX_BYTES) return rejected([{ field: "file", reason: `the file is ${blob.stdout.byteLength} bytes; at most ${AGENT_DEFINITION_FILE_MAX_BYTES}` }]);
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(blob.stdout);
    } catch {
      return rejected([{ field: "file", reason: "the file is not valid UTF-8" }]);
    }
    const parsed = parseNativeAgentFile(source);
    if (!parsed.formatValid) return rejected([{ field: "frontmatter", reason: parsed.error }]);
    const evaluation = evaluateNativeAgent(parsed.fields, parsed.body, this.defaults);
    if (!evaluation.ok) return rejected(evaluation.reasons);
    const stem = normalized.slice(AGENT_DEFINITIONS_DIRECTORY.length + 1, -".md".length);
    const name = evaluation.agent.nativeName === null || evaluation.agent.nativeName === stem ? stem : `${stem}:${evaluation.agent.nativeName}`;
    if ((BUILTIN_DEFINITION_NAMES as readonly string[]).includes(name)) return rejected([{ field: "name", reason: `${name} is a built-in definition; a Workspace file cannot take its identity` }]);
    const definition = this.stores.agents.ensureDefinition(name, options);
    const before = this.stores.agents.listRevisions(definition.id).length;
    const revision = this.stores.agents.appendRevision(definition.id, { provenance: { kind: "workspace_file", path: normalized, snapshotId: snapshot.id }, ...evaluation.agent.content }, options);
    const reused = this.stores.agents.listRevisions(definition.id).length === before;
    return { kind: "loaded", path: normalized, name, definitionId: definition.id, revisionId: revision.id, reused, informational: evaluation.agent.informational };
  }
}

export { text };
