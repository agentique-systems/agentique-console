/**
 * requirement_revisions, requirement_nodes, requirement_status_changes,
 * requirement_delegations — the requirement graph's persistence.
 *
 * Split of labor with RequirementService: the SERVICE computes policy (the
 * approval diff, derivation, subtree checks); this store applies computed row
 * operations, transactionally where a crash between writes could strand the
 * graph (approval, status change). Statements live here, policy does not.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  requirementDelegations,
  requirementNodes,
  requirementRevisions,
  requirementStatusChanges,
} from "../schema.ts";
import { newId, nowIso } from "../../ids.ts";

export type RequirementRevisionRow = typeof requirementRevisions.$inferSelect;
export type RequirementNodeRow = typeof requirementNodes.$inferSelect;
export type RequirementStatusChangeRow = typeof requirementStatusChanges.$inferSelect;
export type RequirementDelegationRow = typeof requirementDelegations.$inferSelect;

export type RequirementNodeStatus = RequirementNodeRow["status"];

/** One computed node operation inside an approval transaction. */
export interface ApprovalNodeOps {
  /** Fresh committed nodes (ids already minted by the service). */
  inserts: {
    id: string;
    parentId: string | null;
    ord: number;
    statement: string;
    composition: "all" | "any";
  }[];
  /** Surviving nodes whose shape moved (statement/composition/parent/ord). */
  updates: {
    id: string;
    patch: Partial<Pick<RequirementNodeRow, "parentId" | "ord" | "statement" | "composition" | "origin" | "introducedInRevision">>;
    /** True when the statement text changed: status resets to open, journaled. */
    resetStatus: boolean;
  }[];
  /** Ids no longer present in the approved document. */
  retires: string[];
}

export class RequirementStore {
  readonly #db: Db;
  readonly #sqlite: { transaction<T>(fn: () => T): () => T };

  constructor(db: Db, sqlite: { transaction<T>(fn: () => T): () => T }) {
    this.#db = db;
    this.#sqlite = sqlite;
  }

  // ── revisions ────────────────────────────────────────────────────────────

  getRevision(id: string): RequirementRevisionRow | undefined {
    return this.#db.select().from(requirementRevisions).where(eq(requirementRevisions.id, id)).get();
  }

  listRevisions(userSessionId: string): RequirementRevisionRow[] {
    return this.#db.select().from(requirementRevisions)
      .where(eq(requirementRevisions.userSessionId, userSessionId))
      .orderBy(requirementRevisions.revision).all();
  }

  latestApproved(userSessionId: string): RequirementRevisionRow | undefined {
    return this.#db.select().from(requirementRevisions)
      .where(and(eq(requirementRevisions.userSessionId, userSessionId), eq(requirementRevisions.status, "approved")))
      .orderBy(desc(requirementRevisions.revision)).get();
  }

  nextRevision(userSessionId: string): number {
    const latest = this.#db.select().from(requirementRevisions)
      .where(eq(requirementRevisions.userSessionId, userSessionId))
      .orderBy(desc(requirementRevisions.revision)).get();
    return (latest?.revision ?? 0) + 1;
  }

  insertDraft(input: {
    userSessionId: string;
    document: string;
    graph: Record<string, unknown>;
    changeNote?: string | null;
  }): RequirementRevisionRow {
    const row: RequirementRevisionRow = {
      id: newId("req"),
      userSessionId: input.userSessionId,
      revision: this.nextRevision(input.userSessionId),
      document: input.document,
      graph: input.graph,
      changeNote: input.changeNote ?? null,
      status: "draft",
      origin: "main",
      interactionId: null,
      createdAt: nowIso(),
      approvedAt: null,
    };
    this.#db.insert(requirementRevisions).values(row).run();
    return row;
  }

  reject(id: string): void {
    this.#db.update(requirementRevisions).set({ status: "rejected" }).where(eq(requirementRevisions.id, id)).run();
  }

  /**
   * Approve one revision with the operator's final text AND apply the node
   * diff in ONE transaction, superseding the previous approved revision — a
   * crash mid-approval must never leave the session with half a graph or zero
   * approved revisions (the SpecStore.approve rationale, extended to nodes).
   * Status resets and retirements journal console-actor status changes so the
   * history explains every mechanical transition.
   */
  applyApproval(input: {
    revisionId: string;
    document: string;
    graph: Record<string, unknown>;
    edited: boolean;
    interactionId?: string | null;
    ops: ApprovalNodeOps;
  }): RequirementRevisionRow {
    return this.#sqlite.transaction(() => {
      const row = this.getRevision(input.revisionId);
      if (!row) throw new Error(`no requirement revision ${input.revisionId}`);
      const previous = this.latestApproved(row.userSessionId);
      if (previous && previous.id !== input.revisionId) {
        this.#db.update(requirementRevisions).set({ status: "superseded" })
          .where(eq(requirementRevisions.id, previous.id)).run();
      }
      this.#db.update(requirementRevisions).set({
        document: input.document,
        graph: input.graph,
        status: "approved",
        origin: input.edited ? "operator_edited" : "main",
        interactionId: input.interactionId ?? null,
        approvedAt: nowIso(),
      }).where(eq(requirementRevisions.id, input.revisionId)).run();

      const now = nowIso();
      const { userSessionId } = row;
      for (const insert of input.ops.inserts) {
        this.#db.insert(requirementNodes).values({
          id: insert.id,
          userSessionId,
          parentId: insert.parentId,
          ord: insert.ord,
          statement: insert.statement,
          composition: insert.composition,
          status: "open",
          origin: "committed",
          introducedInRevision: row.revision,
          retiredInRevision: null,
          refinedByAgentSessionId: null,
          createdAt: now,
          updatedAt: now,
        }).run();
      }
      for (const update of input.ops.updates) {
        const node = this.getNode(userSessionId, update.id);
        if (!node) throw new Error(`approval updates unknown requirement ${update.id}`);
        this.#db.update(requirementNodes)
          .set({ ...update.patch, ...(update.resetStatus ? { status: "open" as const } : {}), updatedAt: now })
          .where(and(eq(requirementNodes.userSessionId, userSessionId), eq(requirementNodes.id, update.id))).run();
        if (update.resetStatus && node.status !== "open") {
          this.#insertStatusChangeRow({
            userSessionId, requirementId: update.id, fromStatus: node.status, toStatus: "open",
            evidence: [], verifiedBy: "console", actor: "console", agentSessionId: null,
            atRevision: row.revision, note: `statement amended in rev ${row.revision}`, createdAt: now,
          });
        }
      }
      for (const retireId of input.ops.retires) {
        const node = this.getNode(userSessionId, retireId);
        if (!node || node.retiredInRevision !== null) continue;
        this.#db.update(requirementNodes)
          .set({ status: "retired", retiredInRevision: row.revision, updatedAt: now })
          .where(and(eq(requirementNodes.userSessionId, userSessionId), eq(requirementNodes.id, retireId))).run();
        this.#insertStatusChangeRow({
          userSessionId, requirementId: retireId, fromStatus: node.status, toStatus: "retired",
          evidence: [], verifiedBy: "console", actor: "console", agentSessionId: null,
          atRevision: row.revision, note: `retired by rev ${row.revision}`, createdAt: now,
        });
      }
      return this.getRevision(input.revisionId)!;
    })();
  }

  // ── nodes ────────────────────────────────────────────────────────────────

  getNode(userSessionId: string, id: string): RequirementNodeRow | undefined {
    return this.#db.select().from(requirementNodes)
      .where(and(eq(requirementNodes.userSessionId, userSessionId), eq(requirementNodes.id, id))).get();
  }

  /** Every node ever, retired included — the id-mint scan and history reads. */
  listNodes(userSessionId: string): RequirementNodeRow[] {
    return this.#db.select().from(requirementNodes)
      .where(eq(requirementNodes.userSessionId, userSessionId))
      .orderBy(requirementNodes.ord).all();
  }

  liveNodes(userSessionId: string): RequirementNodeRow[] {
    return this.#db.select().from(requirementNodes)
      .where(and(eq(requirementNodes.userSessionId, userSessionId), isNull(requirementNodes.retiredInRevision)))
      .orderBy(requirementNodes.ord).all();
  }

  /** Highest minted numeric id ("r7" → 7); ids are never reused, retired included. */
  maxNodeNumber(userSessionId: string): number {
    let max = 0;
    for (const node of this.listNodes(userSessionId)) {
      const match = /^r(\d+)/.exec(node.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
  }

  /** Refinement nodes minted mid-run below a delegated (or committed) parent. */
  insertRefinementNodes(input: {
    userSessionId: string;
    parentId: string;
    agentSessionId: string | null;
    children: { id: string; ord: number; statement: string; composition: "all" | "any" }[];
  }): RequirementNodeRow[] {
    const now = nowIso();
    const rows: RequirementNodeRow[] = input.children.map((child) => ({
      id: child.id,
      userSessionId: input.userSessionId,
      parentId: input.parentId,
      ord: child.ord,
      statement: child.statement,
      composition: child.composition,
      status: "open",
      origin: "refinement",
      introducedInRevision: 0,
      retiredInRevision: null,
      refinedByAgentSessionId: input.agentSessionId,
      createdAt: now,
      updatedAt: now,
    }));
    for (const row of rows) this.#db.insert(requirementNodes).values(row).run();
    return rows;
  }

  // ── status changes ───────────────────────────────────────────────────────

  /**
   * Record one status transition: journal row + node update in one
   * transaction. Returns the change with the node's PRIOR status filled in.
   */
  applyStatusChange(input: {
    userSessionId: string;
    requirementId: string;
    toStatus: Exclude<RequirementNodeStatus, "retired">;
    evidence: { kind: string; ref: string; label?: string }[];
    verifiedBy: "self" | "independent" | "operator" | "console";
    actor: string;
    agentSessionId?: string | null;
    atRevision: number;
    note?: string | null;
  }): { change: RequirementStatusChangeRow; node: RequirementNodeRow } {
    return this.#sqlite.transaction(() => {
      const node = this.getNode(input.userSessionId, input.requirementId);
      if (!node) throw new Error(`no requirement ${input.requirementId}`);
      const now = nowIso();
      const change = this.#insertStatusChangeRow({
        userSessionId: input.userSessionId,
        requirementId: input.requirementId,
        fromStatus: node.status,
        toStatus: input.toStatus,
        evidence: input.evidence,
        verifiedBy: input.verifiedBy,
        actor: input.actor,
        agentSessionId: input.agentSessionId ?? null,
        atRevision: input.atRevision,
        note: input.note ?? null,
        createdAt: now,
      });
      this.#db.update(requirementNodes).set({ status: input.toStatus, updatedAt: now })
        .where(and(eq(requirementNodes.userSessionId, input.userSessionId), eq(requirementNodes.id, input.requirementId)))
        .run();
      return { change, node: this.getNode(input.userSessionId, input.requirementId)! };
    })();
  }

  #insertStatusChangeRow(row: Omit<RequirementStatusChangeRow, "id">): RequirementStatusChangeRow {
    const full: RequirementStatusChangeRow = { id: newId("rqs"), ...row };
    this.#db.insert(requirementStatusChanges).values(full).run();
    return full;
  }

  listStatusChanges(userSessionId: string, requirementId?: string): RequirementStatusChangeRow[] {
    const where = requirementId === undefined
      ? eq(requirementStatusChanges.userSessionId, userSessionId)
      : and(eq(requirementStatusChanges.userSessionId, userSessionId), eq(requirementStatusChanges.requirementId, requirementId));
    return this.#db.select().from(requirementStatusChanges).where(where)
      .orderBy(requirementStatusChanges.createdAt).all();
  }

  /** Latest change per requirement, for verification chips. */
  latestChanges(userSessionId: string): Map<string, RequirementStatusChangeRow> {
    const latest = new Map<string, RequirementStatusChangeRow>();
    for (const change of this.listStatusChanges(userSessionId)) latest.set(change.requirementId, change);
    return latest;
  }

  // ── delegations ──────────────────────────────────────────────────────────

  /** Idempotent per (session, requirement) — re-delegation is a no-op. */
  insertDelegations(input: {
    userSessionId: string;
    agentSessionId: string;
    requirementIds: string[];
    source: "commission" | "assignment" | "child";
    handoffId?: string | null;
  }): RequirementDelegationRow[] {
    const now = nowIso();
    const inserted: RequirementDelegationRow[] = [];
    for (const requirementId of input.requirementIds) {
      const row: RequirementDelegationRow = {
        id: newId("rqd"),
        userSessionId: input.userSessionId,
        agentSessionId: input.agentSessionId,
        requirementId,
        source: input.source,
        handoffId: input.handoffId ?? null,
        createdAt: now,
      };
      const result = this.#db.insert(requirementDelegations).values(row).onConflictDoNothing().run();
      if (result.changes > 0) inserted.push(row);
    }
    return inserted;
  }

  delegationsFor(agentSessionId: string): RequirementDelegationRow[] {
    return this.#db.select().from(requirementDelegations)
      .where(eq(requirementDelegations.agentSessionId, agentSessionId)).all();
  }

  delegationsForUserSession(userSessionId: string): RequirementDelegationRow[] {
    return this.#db.select().from(requirementDelegations)
      .where(eq(requirementDelegations.userSessionId, userSessionId)).all();
  }
}
