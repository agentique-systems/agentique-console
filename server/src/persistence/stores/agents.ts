import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import {
  agentDefinitionContentBytes,
  agentDefinitionContentSchema,
  agentDefinitionRevisionSchema,
  agentDefinitionSchema,
  InvariantViolationError,
  normalizeAgentDefinitionPath,
  parseOrThrow,
  ValidationError,
  type AgentDefinition,
  type AgentDefinitionContent,
  type AgentDefinitionId,
  type AgentDefinitionRevision,
  type AgentDefinitionRevisionId,
  type ConversationId,
  type WorkspaceId,
} from "@agentique-console/core";
import { sha256Hex } from "../blob-store.ts";
import type { PersistenceContext } from "../context.ts";
import { agentDefinitionRevisions, agentDefinitions, conversations, decisions, snapshots } from "../schema.ts";
import { assertSameConversation, requireRow, writeMeta, type WriteOptions } from "./support.ts";

function revisionToDomain(row: typeof agentDefinitionRevisions.$inferSelect): AgentDefinitionRevision {
  return parseOrThrow(agentDefinitionRevisionSchema, row, "AgentDefinitionRevision row");
}

const SYSTEM_SCOPE = { workspaceId: null, conversationId: null, runId: null, planNodeId: null, invocationId: null, attemptId: null } as const;

/**
 * The revisions one Run may read about (execution-model §6.4
 * `read_agent_definitions`): the latest executable revision of every
 * definition for the Run's Workspace and Conversation, plus any executable
 * revision the Run still references (its graph, its verification policy,
 * the caller). Executability is the provenance-ownership rule of the
 * execution boundary's resolver (§11), stated once more here as a database
 * predicate so the page is bounded before any row is materialized; the
 * execution boundary re-resolves every returned row and treats a
 * disagreement as an invariant violation.
 */
export interface ExecutableRevisionQuery {
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  referencedRevisionIds: readonly AgentDefinitionRevisionId[];
  definitionId?: AgentDefinitionId;
}

const revisionColumns = (t: string) => ({ provenance: sql.raw(`${t}.provenance`), definitionId: sql.raw(`${t}.definition_id`), createdAt: sql.raw(`${t}.created_at`), id: sql.raw(`${t}.id`) });

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
   * Appends a revision for `definitionId`, verifying the canonical targets
   * its provenance names: a `workspace_file` revision must pin an existing
   * Snapshot and name a normalized definition file path (`.claude/agents/
   * <name>.md`); a `conversation` revision must name an existing
   * Conversation and an `operator_choice` Decision of that Conversation
   * resolved by the operator. Which Runs may execute the revision is decided
   * by the execution boundary's resolver from these facts. Events for
   * revisions are scoped to the Conversation the provenance names; built-in
   * and Workspace-file revisions have no Conversation scope and are
   * discoverable through the table.
   */
  appendRevision(definitionId: AgentDefinitionId, content: AgentDefinitionContent, options?: WriteOptions): AgentDefinitionRevision {
    const valid = parseOrThrow(agentDefinitionContentSchema, content, "AgentDefinition content");
    if (valid.provenance.kind === "workspace_file") {
      const normalized = normalizeAgentDefinitionPath(valid.provenance.path);
      if (normalized === null) {
        throw new ValidationError(`${valid.provenance.path} is not an Agent Definition file path (.claude/agents/<name>.md)`, { path: valid.provenance.path });
      }
      valid.provenance = { ...valid.provenance, path: normalized };
    }
    const contentHash = sha256Hex(agentDefinitionContentBytes(valid));
    return this.ctx.tx.write(() => {
      this.getDefinition(definitionId);
      this.assertProvenanceTargets(valid.provenance);
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

  private assertProvenanceTargets(provenance: AgentDefinitionContent["provenance"]): void {
    switch (provenance.kind) {
      case "builtin":
        return;
      case "workspace_file":
        requireRow(this.ctx.db.select({ id: snapshots.id }).from(snapshots).where(eq(snapshots.id, provenance.snapshotId)).get(), "Snapshot", provenance.snapshotId);
        return;
      case "conversation": {
        requireRow(this.ctx.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, provenance.conversationId)).get(), "Conversation", provenance.conversationId);
        const decision = requireRow(
          this.ctx.db.select({ conversationId: decisions.conversationId, kind: decisions.kind, status: decisions.status, resolvedBy: decisions.resolvedBy }).from(decisions).where(eq(decisions.id, provenance.approvedByDecisionId)).get(),
          "Decision",
          provenance.approvedByDecisionId,
        );
        assertSameConversation("Decision", provenance.approvedByDecisionId, decision.conversationId, provenance.conversationId);
        if (decision.kind !== "operator_choice") {
          throw new InvariantViolationError(`Decision ${provenance.approvedByDecisionId} is a ${decision.kind}; a Conversation-authored definition is approved by an operator_choice Decision`, { kind: decision.kind });
        }
        if (decision.status !== "resolved" || decision.resolvedBy !== "operator") {
          throw new InvariantViolationError(`Decision ${provenance.approvedByDecisionId} has not been resolved by the operator`, { status: decision.status, resolvedBy: decision.resolvedBy });
        }
        return;
      }
    }
  }

  /** The definitions with the given ids, in one bounded query. */
  getDefinitions(ids: readonly AgentDefinitionId[]): AgentDefinition[] {
    if (ids.length === 0) return [];
    return this.ctx.db.select().from(agentDefinitions).where(inArray(agentDefinitions.id, [...ids])).all().map((row) => parseOrThrow(agentDefinitionSchema, row, "AgentDefinition row"));
  }

  /** One keyset page of the revisions `query` admits, in revision id order after `after` (exclusive), at most `limit` rows: one bounded query. */
  pageExecutable(query: ExecutableRevisionQuery, after: AgentDefinitionRevisionId | undefined, limit: number): AgentDefinitionRevision[] {
    return this.ctx.db
      .select()
      .from(agentDefinitionRevisions)
      .where(and(this.executableWhere(query), after === undefined ? undefined : gt(agentDefinitionRevisions.id, after)))
      .orderBy(asc(agentDefinitionRevisions.id))
      .limit(limit)
      .all()
      .map(revisionToDomain);
  }

  /** Whether revision `id` is one `query` admits (one indexed lookup): the cursor check. */
  containsExecutable(query: ExecutableRevisionQuery, id: AgentDefinitionRevisionId): boolean {
    return this.ctx.db.select({ id: agentDefinitionRevisions.id }).from(agentDefinitionRevisions).where(and(this.executableWhere(query), eq(agentDefinitionRevisions.id, id))).get() !== undefined;
  }

  private executableWhere(query: ExecutableRevisionQuery): SQL {
    // The provenance-ownership rule (§11): builtin anywhere; a Workspace file only where its Snapshot's Workspace is the Run's; a
    // Conversation-authored revision only in that Conversation.
    const executable = (t: ReturnType<typeof revisionColumns>): SQL =>
      sql`(json_extract(${t.provenance}, '$.kind') = 'builtin' OR (json_extract(${t.provenance}, '$.kind') = 'workspace_file' AND EXISTS (SELECT 1 FROM ${snapshots} WHERE ${snapshots.id} = json_extract(${t.provenance}, '$.snapshotId') AND ${snapshots.workspaceId} = ${query.workspaceId})) OR (json_extract(${t.provenance}, '$.kind') = 'conversation' AND json_extract(${t.provenance}, '$.conversationId') = ${query.conversationId}))`;
    const self = revisionColumns("agent_definition_revisions");
    const newer = revisionColumns("newer");
    const latest = sql`NOT EXISTS (SELECT 1 FROM agent_definition_revisions AS newer WHERE ${newer.definitionId} = ${self.definitionId} AND ${executable(newer)} AND (${newer.createdAt} > ${self.createdAt} OR (${newer.createdAt} = ${self.createdAt} AND ${newer.id} > ${self.id})))`;
    const referenced = query.referencedRevisionIds.length === 0 ? sql`0` : sql`${agentDefinitionRevisions.id} IN (${sql.join(query.referencedRevisionIds.map((id) => sql`${id}`), sql`, `)})`;
    const definition = query.definitionId === undefined ? sql`1` : sql`${agentDefinitionRevisions.definitionId} = ${query.definitionId}`;
    return sql`(${executable(self)} AND (${latest} OR ${referenced}) AND ${definition})`;
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
