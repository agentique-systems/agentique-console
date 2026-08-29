import { and, asc, eq } from "drizzle-orm";
import {
  agentDefinitionContentBytes,
  agentDefinitionContentSchema,
  agentDefinitionRevisionSchema,
  agentDefinitionSchema,
  parseOrThrow,
  type AgentDefinition,
  type AgentDefinitionContent,
  type AgentDefinitionId,
  type AgentDefinitionRevision,
  type AgentDefinitionRevisionId,
} from "@agentique-console/core";
import { sha256Hex } from "../blob-store.ts";
import type { PersistenceContext } from "../context.ts";
import { agentDefinitionRevisions, agentDefinitions } from "../schema.ts";
import { requireRow, writeMeta, type WriteOptions } from "./support.ts";

function revisionToDomain(row: typeof agentDefinitionRevisions.$inferSelect): AgentDefinitionRevision {
  return parseOrThrow(agentDefinitionRevisionSchema, row, "AgentDefinitionRevision row");
}

const SYSTEM_SCOPE = { workspaceId: null, conversationId: null, runId: null, planNodeId: null, invocationId: null, attemptId: null } as const;

/**
 * Agent Definitions (stable logical identity by name) and their immutable
 * revisions, one per content hash. Appending content that hashes to an
 * existing revision returns that revision; nothing is edited in place.
 */
export class AgentDefinitionStore {
  constructor(private readonly ctx: PersistenceContext) {}

  ensureDefinition(name: string, options?: WriteOptions): AgentDefinition {
    return this.ctx.tx.write(() => {
      const existing = this.ctx.db.select().from(agentDefinitions).where(eq(agentDefinitions.name, name)).get();
      if (existing) return parseOrThrow(agentDefinitionSchema, existing, "AgentDefinition row");
      const definition: AgentDefinition = { id: this.ctx.ids("agentDefinition"), name, createdAt: this.ctx.clock() };
      parseOrThrow(agentDefinitionSchema, definition, "AgentDefinition");
      this.ctx.db.insert(agentDefinitions).values(definition).run();
      return definition;
    });
  }

  getDefinition(id: AgentDefinitionId): AgentDefinition {
    return parseOrThrow(agentDefinitionSchema, requireRow(this.ctx.db.select().from(agentDefinitions).where(eq(agentDefinitions.id, id)).get(), "AgentDefinition", id), "AgentDefinition row");
  }

  listDefinitions(): AgentDefinition[] {
    return this.ctx.db.select().from(agentDefinitions).orderBy(asc(agentDefinitions.name)).all().map((row) => parseOrThrow(agentDefinitionSchema, row, "AgentDefinition row"));
  }

  /**
   * Appends a revision for `definitionId`. Events for definitions and
   * revisions are scoped to the Workspace or Conversation the provenance
   * names; built-ins are journaled without a scope row filter by being
   * attached to no scope, which the Event schema forbids — so built-in
   * revisions are not journaled and are discoverable through the table.
   */
  appendRevision(definitionId: AgentDefinitionId, content: AgentDefinitionContent, options?: WriteOptions): AgentDefinitionRevision {
    const valid = parseOrThrow(agentDefinitionContentSchema, content, "AgentDefinition content");
    const contentHash = sha256Hex(agentDefinitionContentBytes(valid));
    return this.ctx.tx.write(() => {
      this.getDefinition(definitionId);
      const existing = this.ctx.db
        .select()
        .from(agentDefinitionRevisions)
        .where(and(eq(agentDefinitionRevisions.definitionId, definitionId), eq(agentDefinitionRevisions.contentHash, contentHash)))
        .get();
      if (existing) return revisionToDomain(existing);
      const revision: AgentDefinitionRevision = {
        id: this.ctx.ids("agentDefinitionRevision"),
        definitionId,
        contentHash,
        ...valid,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(agentDefinitionRevisionSchema, revision, "AgentDefinitionRevision");
      const scope =
        valid.provenance.kind === "workspace_file"
          ? null
          : valid.provenance.kind === "conversation"
            ? { ...SYSTEM_SCOPE, conversationId: valid.provenance.conversationId }
            : null;
      if (scope) {
        this.ctx.journal.append({
          type: "agent_definition_revision.created",
          scope,
          subjectType: "agent_definition_revision",
          subjectId: revision.id,
          payload: revision,
          ...writeMeta(options),
        });
      }
      this.ctx.db.insert(agentDefinitionRevisions).values(revision).run();
      return revision;
    });
  }

  getRevision(id: AgentDefinitionRevisionId): AgentDefinitionRevision {
    return revisionToDomain(requireRow(this.ctx.db.select().from(agentDefinitionRevisions).where(eq(agentDefinitionRevisions.id, id)).get(), "AgentDefinitionRevision", id));
  }

  listRevisions(definitionId: AgentDefinitionId): AgentDefinitionRevision[] {
    return this.ctx.db
      .select()
      .from(agentDefinitionRevisions)
      .where(eq(agentDefinitionRevisions.definitionId, definitionId))
      .orderBy(asc(agentDefinitionRevisions.createdAt), asc(agentDefinitionRevisions.id))
      .all()
      .map(revisionToDomain);
  }
}
