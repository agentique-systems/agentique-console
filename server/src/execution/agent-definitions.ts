/**
 * The authoritative resolver for Agent Definition revisions a Run may
 * execute (execution-model §11). Both Run creation (the Orchestrator
 * revision) and every plan revision (every referenced revision) resolve
 * through it; the pure compiler receives only revision facts that passed.
 *
 * Provenance ownership rules:
 * - `builtin`: usable by any Workspace and Conversation; never treated as
 *   Workspace-owned.
 * - `workspace_file`: usable only by a Run whose Workspace owns the pinned
 *   Snapshot; a revision pinned to another Workspace's Snapshot is rejected
 *   even though its id exists.
 * - `conversation`: usable only by a Run of the Conversation that authored
 *   and approved it.
 * Role and Tool Policy restrictions apply on top of ownership.
 */
import {
  NotFoundError,
  type AgentCapabilities,
  type AgentDefaultLimits,
  type AgentDefinitionProvenance,
  type AgentDefinitionRevisionId,
  type ConversationId,
  type ToolPolicy,
  type WorkspaceId,
} from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";

/** The immutable facts of a resolved revision that compilation and role-policy validation need. */
export interface ExecutableAgentDefinitionRevision {
  id: AgentDefinitionRevisionId;
  definitionName: string;
  provenanceKind: AgentDefinitionProvenance["kind"];
  capabilities: AgentCapabilities;
  toolPolicy: ToolPolicy;
  defaultLimits: AgentDefaultLimits;
}

export interface ExecutionOwner {
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
}

export type AgentDefinitionResolution =
  | { ok: true; revision: ExecutableAgentDefinitionRevision }
  | { ok: false; revisionId: string; message: string };

/**
 * Resolves one revision for execution by `owner`, or explains why it cannot
 * be executed there. Never throws for a missing or foreign revision; an
 * infrastructure failure still throws.
 */
export function resolveExecutableAgentDefinitionRevision(stores: Stores, owner: ExecutionOwner, revisionId: string): AgentDefinitionResolution {
  let revision;
  try {
    revision = stores.agents.getRevision(revisionId as AgentDefinitionRevisionId);
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, revisionId, message: `Agent Definition revision ${revisionId} does not exist` };
    throw error;
  }
  const definition = stores.agents.getDefinition(revision.definitionId);
  const provenance = revision.provenance;
  switch (provenance.kind) {
    case "builtin":
      break;
    case "workspace_file": {
      let snapshot;
      try {
        snapshot = stores.snapshots.get(provenance.snapshotId);
      } catch (error) {
        if (error instanceof NotFoundError) return { ok: false, revisionId, message: `Agent Definition revision ${revisionId} is pinned to Snapshot ${provenance.snapshotId}, which does not exist` };
        throw error;
      }
      if (snapshot.workspaceId !== owner.workspaceId) {
        return { ok: false, revisionId, message: `Agent Definition revision ${revisionId} is a file of another Workspace (Snapshot ${provenance.snapshotId})` };
      }
      break;
    }
    case "conversation":
      if (provenance.conversationId !== owner.conversationId) {
        return { ok: false, revisionId, message: `Agent Definition revision ${revisionId} was authored in another Conversation (${provenance.conversationId})` };
      }
      break;
  }
  return {
    ok: true,
    revision: {
      id: revision.id,
      definitionName: definition.name,
      provenanceKind: provenance.kind,
      capabilities: revision.capabilities,
      toolPolicy: revision.toolPolicy,
      defaultLimits: revision.defaultLimits,
    },
  };
}
