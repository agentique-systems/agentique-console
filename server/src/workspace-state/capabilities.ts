/**
 * The capability matrix of the two Workspace kinds (execution-model §9;
 * glossary "Workspace provider"): what each kind supports, exactly, so no
 * kind is silently dropped and no git semantics are fabricated for a plain
 * directory. Tests assert the providers behave as the matrix says; the
 * architecture documentation reproduces it.
 */
import type { PublicationStrategy, WorkspaceKind } from "@agentique-console/core";

export interface WorkspaceKindCapabilities {
  kind: WorkspaceKind;
  /** How a Snapshot identifies a state. */
  snapshotIdentity: "commit and tree" | "content digest of the tracked files";
  /** Where the runtime's copies live. */
  isolation: string;
  /** How a Changeset is applied to the Integration Workspace. */
  integration: string;
  /** The publication Target. */
  target: "branch" | "directory";
  /** The publication strategies the kind can honor. */
  publicationStrategies: PublicationStrategy["kind"][];
  /** How the Target is updated. */
  publicationApply: string;
  /** Whether the Target update and its receipt are one atomic operation. */
  atomicPublication: boolean;
}

export const WORKSPACE_CAPABILITIES: Readonly<Record<WorkspaceKind, WorkspaceKindCapabilities>> = Object.freeze({
  git: {
    kind: "git",
    snapshotIdentity: "commit and tree",
    isolation: "worktrees of the operator's repository under the runtime's state root: the Integration Workspace on a Run-owned branch, one detached worktree per writing Invocation, disposable check views, and publication staging",
    integration: "the exact verified diff bytes applied with a three-way `git apply --index` and committed onto the Integration Workspace; conflicts leave it unchanged; idempotent by a Changeset-keyed integration ref and commit trailer",
    target: "branch",
    publicationStrategies: ["fast_forward", "merge"],
    publicationApply: "one reference transaction moves the Target branch to the candidate (compare-and-swap on the persisted Target-before commit) and creates the publication receipt ref; afterwards a checked-out working copy of the Target branch is brought forward non-destructively (a two-tree fast-forward of index and files that git refuses over local changes) and is otherwise left unchanged and reported as such; nothing is ever reset",
    atomicPublication: true,
  },
  directory: {
    kind: "directory",
    snapshotIdentity: "content digest of the tracked files",
    isolation: "a console-owned shadow repository under the runtime's state root holds every imported state; the Integration Workspace, Invocation worktrees, check views, and publication staging are worktrees of it; the directory itself is read at Run start and at publication only",
    integration: "the same three-way apply onto the Integration Workspace worktree of the shadow repository; identical idempotence",
    target: "directory",
    publicationStrategies: [],
    publicationApply: "none: a plain directory offers no atomic update-plus-receipt, so every publication request is refused as strategy_unsupported before the Target is touched; the accepted result stays available as the Run's final Changeset and its Integration Workspace",
    atomicPublication: false,
  },
});

export function supportsStrategy(kind: WorkspaceKind, strategy: PublicationStrategy): boolean {
  return WORKSPACE_CAPABILITIES[kind].publicationStrategies.includes(strategy.kind);
}

/** Whether the kind can publish at all: at least one strategy performs the atomic update-plus-receipt. */
export function supportsPublication(kind: WorkspaceKind): boolean {
  return WORKSPACE_CAPABILITIES[kind].publicationStrategies.length > 0;
}
