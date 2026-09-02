import { and, asc, eq, gt, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import {
  assertDecisionResolutionRules,
  budgetIncreasePermitted,
  ConflictError,
  decisionRequestSchema,
  decisionResolutionInputSchema,
  decisionSchema,
  InvariantViolationError,
  isRequestableDecisionKind,
  parseOrThrow,
  RUN_MACHINE,
  TOOL_CALL_MEDIA_TYPE,
  type ConversationId,
  type Decision,
  type DecisionId,
  type DecisionKind,
  type DecisionRequest,
  type DecisionResolutionInput,
  type DecisionStatus,
  type DecisionSubject,
  type DecisionSupersessionReason,
  type EventActor,
  type InvocationId,
  type PlanNodeId,
  type RequirementId,
  type RunId,
  type RunStatus,
  type TaskId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { artifacts, attempts, completionRequests, decisions, gates, invocations, planNodes, publications, requirementRevisions, requirements, runs, tasks } from "../schema.ts";
import { assertSameConversation, conversationScope, loadConversationRef, OPERATOR_ACTOR, requireRow, RUNTIME_ACTOR, writeMeta, type WriteOptions } from "./support.ts";
import { keysetOrder, keysetWhere, type KeysetQuery } from "./paging.ts";

type Row = typeof decisions.$inferSelect;

function toDomain(row: Row): Decision {
  return parseOrThrow(
    decisionSchema,
    {
      id: row.id,
      conversationId: row.conversationId,
      runId: row.runId,
      kind: row.kind,
      resolutionPolicy: row.resolutionPolicy,
      status: row.status,
      requestedBy: row.requestedBy,
      question: row.question,
      options: row.options,
      recommendedOptionId: row.recommendedOptionId,
      rationale: row.rationale,
      affects: row.affects,
      deadlineAt: row.deadlineAt,
      activationCondition: row.activationCondition,
      subject: row.subject,
      resolution:
        row.resolvedBy === null
          ? null
          : {
              resolvedBy: row.resolvedBy,
              chosenOptionId: row.chosenOptionId,
              rationale: row.resolutionRationale,
              artifactIds: row.resolutionArtifactIds ?? [],
              resolvedAt: row.resolvedAt,
            },
      supersedesDecisionId: row.supersedesDecisionId,
      supersededByDecisionId: row.supersededByDecisionId,
      supersessionReason: row.supersessionReason,
      createdAt: row.createdAt,
    },
    "Decision row",
  );
}

/**
 * The routes through which a Decision reaches one reader (execution-model
 * §6.4 `read_decisions`), evaluated by the database before any row is
 * materialized. `run`: every Decision of the Run (the root Orchestrator).
 * `scoped`: a Decision that affects the node, one of the admitted Tasks (the
 * node's whole ledger, or an explicit bounded list), or one of the admitted
 * Requirement ids, or that one of the admitted requesters requested (every
 * Invocation of the node, or an explicit list). `named`: no route at all.
 * Either way only the Run's own and the Conversation-level (`runId` null)
 * Decisions travel these routes; `namedDecisionIds` (the caller's manifest)
 * are visible regardless.
 */
export type DecisionRouteScope =
  | { kind: "run" }
  /** No route beyond the named ids (an Evaluator: exactly its manifest's Decisions). */
  | { kind: "named" }
  | {
      kind: "scoped";
      planNodeId: PlanNodeId;
      tasks: { kind: "node"; planNodeId: PlanNodeId } | { kind: "ids"; taskIds: readonly TaskId[] };
      requirementIds: readonly RequirementId[];
      requesters: { kind: "node"; planNodeId: PlanNodeId } | { kind: "ids"; invocationIds: readonly InvocationId[] };
    };

export interface DecisionVisibility {
  conversationId: ConversationId;
  runId: RunId;
  namedDecisionIds: readonly DecisionId[];
  routes: DecisionRouteScope;
  status?: DecisionStatus;
}

const idList = (ids: readonly string[]): SQL => sql.join(ids.map((id) => sql`${id}`), sql`, `);

function actorFor(resolvedBy: DecisionResolutionInput["resolvedBy"], decision: Decision): EventActor {
  if (resolvedBy === "operator") return OPERATOR_ACTOR;
  if (resolvedBy === "policy:use_default_after_deadline") return { kind: "policy", policy: "use_default_after_deadline" };
  return decision.requestedBy.kind === "invocation" ? { kind: "invocation", invocationId: decision.requestedBy.invocationId } : { kind: "runtime" };
}

/**
 * Decisions are append-only: a request creates one; a resolution is recorded
 * once and always writes `decision.resolved`; a later Decision may supersede
 * an earlier one by id, which is recorded on both rows; the runtime may
 * supersede an open `requirement_waiver` whose pinned Requirement went stale.
 */
export class DecisionStore {
  constructor(private readonly ctx: PersistenceContext) {}

  request(input: DecisionRequest, options?: WriteOptions): Decision {
    const valid = parseOrThrow(decisionRequestSchema, input, "Decision request");
    return this.ctx.tx.write(() => {
      const conversation = loadConversationRef(this.ctx, valid.conversationId);
      if (valid.runId !== null) {
        const run = requireRow(this.ctx.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, valid.runId)).get(), "Run", valid.runId);
        assertSameConversation("Run", valid.runId, run.conversationId, conversation.id);
      }
      this.assertAffectsOwnership(valid, conversation.id);
      // A requestable kind and the Orchestrator's own recorded `orchestrator_choice` name a running Invocation of the Run as requester.
      if (valid.requestedBy.kind === "invocation" && (isRequestableDecisionKind(valid.kind) || valid.kind === "orchestrator_choice")) this.assertRequester(valid.requestedBy.invocationId, valid.runId, valid.kind);
      if (valid.subject !== null) this.assertSubjectOwnership(valid.subject, valid.runId, conversation.id);
      const decision: Decision = {
        id: this.ctx.ids("decision"),
        ...valid,
        status: "open",
        resolution: null,
        supersededByDecisionId: null,
        supersessionReason: null,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(decisionSchema, decision, "Decision");
      this.ctx.journal.append({
        type: "decision.requested",
        scope: conversationScope(conversation, { runId: valid.runId }),
        subjectType: "decision",
        subjectId: decision.id,
        payload: decision,
        ...writeMeta(options, valid.requestedBy.kind === "invocation" ? { kind: "invocation", invocationId: valid.requestedBy.invocationId } : valid.requestedBy.kind === "operator" ? OPERATOR_ACTOR : undefined),
      });
      this.ctx.db.insert(decisions).values(this.toRow(decision)).run();
      if (valid.supersedesDecisionId !== null) {
        const superseded = this.get(valid.supersedesDecisionId);
        assertSameConversation("Decision", superseded.id, superseded.conversationId, conversation.id);
        if (superseded.status === "superseded") throw new ConflictError(`Decision ${superseded.id} is already superseded`);
        this.ctx.journal.append({
          type: "decision.superseded",
          scope: conversationScope(conversation, { runId: superseded.runId }),
          subjectType: "decision",
          subjectId: superseded.id,
          payload: { decisionId: superseded.id, supersededByDecisionId: decision.id, reason: "superseding_decision" },
          ...writeMeta(options),
        });
        this.ctx.db.update(decisions).set({ status: "superseded", supersededByDecisionId: decision.id, supersessionReason: "superseding_decision" }).where(eq(decisions.id, superseded.id)).run();
      }
      return decision;
    });
  }

  get(id: DecisionId): Decision {
    return toDomain(requireRow(this.ctx.db.select().from(decisions).where(eq(decisions.id, id)).get(), "Decision", id));
  }

  listByConversation(conversationId: ConversationId): Decision[] {
    return this.ctx.db.select().from(decisions).where(eq(decisions.conversationId, conversationId)).orderBy(asc(decisions.createdAt)).all().map(toDomain);
  }

  listOpen(conversationId: ConversationId): Decision[] {
    return this.ctx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.conversationId, conversationId), eq(decisions.status, "open")))
      .orderBy(asc(decisions.createdAt))
      .all()
      .map(toDomain);
  }

  /** Every Decision of a Run, in creation order (then id order). */
  listByRun(runId: RunId): Decision[] {
    return this.ctx.db.select().from(decisions).where(eq(decisions.runId, runId)).orderBy(asc(decisions.createdAt), asc(decisions.id)).all().map(toDomain);
  }

  /** One keyset page of a Run's Decisions by `(createdAt, id)`, optionally of one status (the open ones are one bounded page whatever the history). */
  pageByRun(runId: RunId, query: KeysetQuery, status?: DecisionStatus): Decision[] {
    const key = [decisions.createdAt, decisions.id];
    return this.ctx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.runId, runId), status === undefined ? undefined : eq(decisions.status, status), keysetWhere(key, query)))
      .orderBy(...keysetOrder(key, query))
      .limit(query.limit)
      .all()
      .map(toDomain);
  }

  /** One keyset page of a Conversation's Decisions by `(createdAt, id)`, optionally of one status. */
  pageByConversation(conversationId: ConversationId, query: KeysetQuery, status?: DecisionStatus): Decision[] {
    const key = [decisions.createdAt, decisions.id];
    return this.ctx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.conversationId, conversationId), status === undefined ? undefined : eq(decisions.status, status), keysetWhere(key, query)))
      .orderBy(...keysetOrder(key, query))
      .limit(query.limit)
      .all()
      .map(toDomain);
  }

  /**
   * One keyset page of the Decisions visible under `visibility`, in id
   * order, starting after `after` (exclusive) and holding at most `limit`
   * rows. Ownership and every route are SQL predicates over the row and the
   * Conversation's index, so a page costs one bounded query however long the
   * Conversation's Decision history is.
   */
  page(visibility: DecisionVisibility, after: DecisionId | undefined, limit: number): Decision[] {
    return this.ctx.db
      .select()
      .from(decisions)
      .where(and(this.visibleWhere(visibility), after === undefined ? undefined : gt(decisions.id, after)))
      .orderBy(asc(decisions.id))
      .limit(limit)
      .all()
      .map(toDomain);
  }

  /** Whether the Decision `id` is visible under `visibility` (one indexed lookup): the cursor and exact-id check. */
  contains(visibility: DecisionVisibility, id: DecisionId): boolean {
    return this.ctx.db.select({ id: decisions.id }).from(decisions).where(and(this.visibleWhere(visibility), eq(decisions.id, id))).get() !== undefined;
  }

  private visibleWhere(v: DecisionVisibility): SQL {
    const named = v.namedDecisionIds.length === 0 ? sql`0` : sql`${decisions.id} IN (${idList(v.namedDecisionIds)})`;
    const ownRun = sql`(${decisions.runId} = ${v.runId} OR ${decisions.runId} IS NULL)`;
    let routes: SQL;
    if (v.routes.kind === "run") {
      routes = ownRun;
    } else if (v.routes.kind === "named") {
      routes = sql`0`;
    } else {
      const r = v.routes;
      const byNode = sql`EXISTS (SELECT 1 FROM json_each(${decisions.affects}, '$.planNodeIds') WHERE json_each.value = ${r.planNodeId})`;
      const byTask =
        r.tasks.kind === "node"
          ? sql`EXISTS (SELECT 1 FROM json_each(${decisions.affects}, '$.taskIds') JOIN ${tasks} ON ${tasks.id} = json_each.value WHERE ${tasks.planNodeId} = ${r.tasks.planNodeId})`
          : r.tasks.taskIds.length === 0
            ? sql`0`
            : sql`EXISTS (SELECT 1 FROM json_each(${decisions.affects}, '$.taskIds') WHERE json_each.value IN (${idList(r.tasks.taskIds)}))`;
      const byRequirement = r.requirementIds.length === 0 ? sql`0` : sql`EXISTS (SELECT 1 FROM json_each(${decisions.affects}, '$.requirementIds') WHERE json_each.value IN (${idList(r.requirementIds)}))`;
      const byRequester =
        r.requesters.kind === "node"
          ? sql`${decisions.requesterInvocationId} IN (SELECT ${invocations.id} FROM ${invocations} WHERE ${invocations.planNodeId} = ${r.requesters.planNodeId})`
          : r.requesters.invocationIds.length === 0
            ? sql`0`
            : sql`${decisions.requesterInvocationId} IN (${idList(r.requesters.invocationIds)})`;
      routes = sql`(${ownRun} AND (${byNode} OR ${byTask} OR ${byRequirement} OR ${byRequester}))`;
    }
    const status = v.status === undefined ? sql`1` : sql`${decisions.status} = ${v.status}`;
    return sql`(${decisions.conversationId} = ${v.conversationId} AND (${named} OR ${routes}) AND ${status})`;
  }

  /** The Decisions an Invocation requested through `request_decision` (the requestable kinds it is the requester of), in creation order. */
  requestedByInvocation(invocationId: InvocationId): Decision[] {
    return this.ctx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.requesterInvocationId, invocationId), inArray(decisions.kind, ["operator_choice", "requirement_waiver"])))
      .orderBy(asc(decisions.createdAt), asc(decisions.id))
      .all()
      .map(toDomain);
  }

  /** The Run's open `use_default_after_deadline` Decisions, in creation order: what the scheduler resolves by policy once due. */
  openDefaultPolicyOf(runId: RunId): Decision[] {
    return this.ctx.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.runId, runId), eq(decisions.status, "open"), eq(decisions.resolutionPolicy, "use_default_after_deadline")))
      .orderBy(asc(decisions.createdAt), asc(decisions.id))
      .all()
      .map(toDomain);
  }

  /** The Conversation's open `requirement_waiver` Decisions naming a Requirement, in creation order. */
  openWaiversOf(conversationId: ConversationId, requirementId: string): Decision[] {
    return this.listOpen(conversationId).filter((d) => d.kind === "requirement_waiver" && d.affects.requirementIds.includes(requirementId as never));
  }

  /** The one `signoff` Decision of an `operator_signoff` Gate, or `null` before it was requested; at most one exists (a database unique index). */
  signoffOf(gateId: string): Decision | null {
    const row = this.ctx.db.select().from(decisions).where(and(eq(decisions.kind, "signoff"), eq(decisions.subjectGateId, gateId))).get();
    return row ? toDomain(row) : null;
  }

  /** Every `publish` Decision of a Run, in creation order. */
  publishDecisionsOf(runId: string): Decision[] {
    return this.ctx.db.select().from(decisions).where(and(eq(decisions.kind, "publish"), eq(decisions.runId, runId))).orderBy(asc(decisions.createdAt), asc(decisions.id)).all().map(toDomain);
  }

  /** The Run's one open `publish` Decision, or `null`; at most one exists (a database unique index). */
  openPublishOf(runId: string): Decision | null {
    const rows = this.publishDecisionsOf(runId).filter((d) => d.status === "open");
    if (rows.length > 1) throw new InvariantViolationError(`Run ${runId} has ${rows.length} open publish Decisions`, { runId });
    return rows[0] ?? null;
  }

  /** Every `budget_increase` Decision of a Run, in creation order. */
  budgetIncreaseDecisionsOf(runId: string): Decision[] {
    return this.ctx.db.select().from(decisions).where(and(eq(decisions.kind, "budget_increase"), eq(decisions.runId, runId))).orderBy(asc(decisions.createdAt), asc(decisions.id)).all().map(toDomain);
  }

  /** The Run's one open `budget_increase` Decision, or `null`; at most one exists (a database unique index). */
  openBudgetIncreaseOf(runId: string): Decision | null {
    const rows = this.budgetIncreaseDecisionsOf(runId).filter((d) => d.status === "open");
    if (rows.length > 1) throw new InvariantViolationError(`Run ${runId} has ${rows.length} open budget_increase Decisions`, { runId });
    return rows[0] ?? null;
  }

  /** Resolves an open Decision once; who may resolve what is enforced by the core rules. */
  resolve(id: DecisionId, input: DecisionResolutionInput, options?: WriteOptions): Decision {
    const resolution = parseOrThrow(decisionResolutionInputSchema, input, "Decision resolution");
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      assertDecisionResolutionRules(current, resolution);
      const conversation = loadConversationRef(this.ctx, current.conversationId);
      const resolved: Decision = {
        ...current,
        status: "resolved",
        resolution: { ...resolution, resolvedAt: this.ctx.clock() },
      };
      parseOrThrow(decisionSchema, resolved, "Decision");
      this.ctx.journal.append({
        type: "decision.resolved",
        scope: conversationScope(conversation, { runId: current.runId }),
        subjectType: "decision",
        subjectId: id,
        payload: { decisionId: id, kind: current.kind, resolution: resolved.resolution as NonNullable<Decision["resolution"]> },
        ...writeMeta(options, actorFor(resolution.resolvedBy, current)),
      });
      // Only resolution columns are written; the request columns are guarded as immutable.
      this.ctx.db
        .update(decisions)
        .set({
          status: "resolved",
          resolvedBy: resolution.resolvedBy,
          chosenOptionId: resolution.chosenOptionId,
          resolutionRationale: resolution.rationale,
          resolutionArtifactIds: resolution.artifactIds,
          resolvedAt: resolved.resolution?.resolvedAt ?? null,
        })
        .where(eq(decisions.id, id))
        .run();
      return resolved;
    });
  }

  /**
   * Supersedes an open `requirement_waiver` Decision whose pinned Requirement
   * went stale (execution-model §8.2), with no superseding Decision: the
   * runtime's one path to retire a waiver request the operator can no longer
   * meaningfully answer. Never resolves anything; writes one
   * `decision.superseded` Event.
   */
  supersede(id: DecisionId, reason: Exclude<DecisionSupersessionReason, "superseding_decision">, options?: WriteOptions): Decision {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (current.kind !== "requirement_waiver") throw new ConflictError(`Decision ${id} is a ${current.kind}; only a requirement_waiver is superseded as stale`, { decisionId: id, kind: current.kind });
      if (current.status !== "open") throw new ConflictError(`Decision ${id} is ${current.status}; only an open Decision is superseded`, { decisionId: id, status: current.status });
      const conversation = loadConversationRef(this.ctx, current.conversationId);
      const superseded: Decision = { ...current, status: "superseded", supersessionReason: reason };
      parseOrThrow(decisionSchema, superseded, "Decision");
      this.ctx.journal.append({
        type: "decision.superseded",
        scope: conversationScope(conversation, { runId: current.runId }),
        subjectType: "decision",
        subjectId: id,
        payload: { decisionId: id, supersededByDecisionId: null, reason },
        ...writeMeta(options, RUNTIME_ACTOR),
      });
      this.ctx.db.update(decisions).set({ status: "superseded", supersessionReason: reason }).where(eq(decisions.id, id)).run();
      return superseded;
    });
  }

  /** An Invocation requesting a Decision belongs to the Decision's Run and is running (execution-model §8.2). */
  private assertRequester(invocationId: InvocationId, runId: string | null, kind: DecisionKind): void {
    const invocation = requireRow(this.ctx.db.select({ runId: invocations.runId, status: invocations.status, role: invocations.role }).from(invocations).where(eq(invocations.id, invocationId)).get(), "Invocation", invocationId);
    if (runId === null || invocation.runId !== runId) throw new InvariantViolationError(`Invocation ${invocationId} belongs to Run ${invocation.runId}, not ${String(runId)}`, { invocationId, runId });
    if (invocation.status !== "running") throw new ConflictError(`Invocation ${invocationId} is ${invocation.status}; a Decision is requested by a running Invocation`, { invocationId, status: invocation.status });
    if (kind === "orchestrator_choice" && invocation.role !== "orchestrator") throw new InvariantViolationError(`Invocation ${invocationId} is a ${invocation.role}; only an Orchestrator Invocation records an orchestrator_choice`, { invocationId, role: invocation.role });
  }

  /**
   * A side-effect approval subject names the Run's own Plan Node, Invocation,
   * Attempt, and call Artifact, consistently; a signoff subject names the
   * Run's open `operator_signoff` Gate, the passed `run_completion` Gate and
   * `passed` Completion Request that Gate presents, and exactly the Gate's
   * verified Snapshot and final-report Artifact — and the Gate has no other
   * signoff Decision. A publish subject names exactly the completed Run's
   * Workspace, Target, final Snapshot, and final Changeset, and the Run has
   * no other open publish Decision, no nonterminal Publication, and no
   * succeeded Publication. A requirement_waiver subject names a Requirement
   * and a Requirement revision of the Decision's Conversation and Evidence
   * Artifacts of the Run.
   */
  private assertSubjectOwnership(subject: DecisionSubject, runId: string | null, conversationId: string): void {
    if (subject.runId !== runId) throw new InvariantViolationError(`Decision subject names Run ${subject.runId}, not ${String(runId)}`);
    if (subject.kind === "requirement_waiver") {
      const requirement = requireRow(this.ctx.db.select({ conversationId: requirements.conversationId }).from(requirements).where(eq(requirements.id, subject.requirementId)).get(), "Requirement", subject.requirementId);
      assertSameConversation("Requirement", subject.requirementId, requirement.conversationId, conversationId);
      const revision = requireRow(this.ctx.db.select({ conversationId: requirementRevisions.conversationId }).from(requirementRevisions).where(eq(requirementRevisions.id, subject.requirementRevisionId)).get(), "RequirementRevision", subject.requirementRevisionId);
      assertSameConversation("RequirementRevision", subject.requirementRevisionId, revision.conversationId, conversationId);
      if (subject.evidenceArtifactIds.length > 0) {
        const rows = this.ctx.db.select({ id: artifacts.id, runId: artifacts.runId }).from(artifacts).where(inArray(artifacts.id, subject.evidenceArtifactIds)).all();
        for (const id of subject.evidenceArtifactIds) {
          const row = requireRow(rows.find((r) => r.id === id), "Artifact", id);
          if (row.runId !== subject.runId) throw new InvariantViolationError(`Artifact ${id} belongs to Run ${row.runId}, not ${subject.runId}`, { artifactId: id });
        }
      }
      return;
    }
    if (subject.kind === "budget_increase") {
      // A budget_increase is requested for a nonterminal Run whose status admits the partition, and only one is open per Run.
      const run = requireRow(this.ctx.db.select({ status: runs.status }).from(runs).where(eq(runs.id, subject.runId)).get(), "Run", subject.runId);
      if (RUN_MACHINE.isTerminal(run.status as RunStatus)) throw new ConflictError(`Run ${subject.runId} is ${run.status}; no Budget Increase is requested for a terminal Run`, { runId: subject.runId, status: run.status });
      if (!budgetIncreasePermitted(run.status as RunStatus, subject.partition)) {
        throw new ConflictError(`Run ${subject.runId} is ${run.status}; its ${subject.partition} partition cannot be increased now`, { runId: subject.runId, status: run.status, partition: subject.partition });
      }
      const open = this.ctx.db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.kind, "budget_increase"), eq(decisions.runId, subject.runId), eq(decisions.status, "open"))).get();
      if (open) throw new ConflictError(`Run ${subject.runId} already has open budget_increase Decision ${open.id}`, { runId: subject.runId, decisionId: open.id });
      return;
    }
    if (subject.kind === "publish") {
      const run = requireRow(this.ctx.db.select({ status: runs.status, workspaceId: runs.workspaceId, target: runs.target, finalSnapshotId: runs.finalSnapshotId, finalChangesetId: runs.finalChangesetId }).from(runs).where(eq(runs.id, subject.runId)).get(), "Run", subject.runId);
      if (run.status !== "completed") throw new ConflictError(`Run ${subject.runId} is ${run.status}; a publish Decision is requested for a completed Run`, { runId: subject.runId, status: run.status });
      if (run.workspaceId !== subject.workspaceId || JSON.stringify(run.target) !== JSON.stringify(subject.target) || run.finalSnapshotId !== subject.finalSnapshotId || run.finalChangesetId !== subject.finalChangesetId) {
        throw new InvariantViolationError(`publish subject disagrees with the completed Run ${subject.runId}`, { runId: subject.runId });
      }
      const open = this.ctx.db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.kind, "publish"), eq(decisions.runId, subject.runId), eq(decisions.status, "open"))).get();
      if (open) throw new ConflictError(`Run ${subject.runId} already has open publish Decision ${open.id}`, { runId: subject.runId, decisionId: open.id });
      const active = this.ctx.db.select({ id: publications.id, status: publications.status }).from(publications).where(and(eq(publications.runId, subject.runId), notInArray(publications.status, ["succeeded", "failed"]))).get();
      if (active) throw new ConflictError(`Run ${subject.runId} has nonterminal Publication ${active.id} (${active.status})`, { runId: subject.runId, publicationId: active.id });
      const succeeded = this.ctx.db.select({ id: publications.id }).from(publications).where(and(eq(publications.runId, subject.runId), eq(publications.status, "succeeded"))).get();
      if (succeeded) throw new ConflictError(`Run ${subject.runId} was published by Publication ${succeeded.id}; a succeeded Run is never published again`, { runId: subject.runId, publicationId: succeeded.id });
      return;
    }
    if (subject.kind === "signoff") {
      const gate = requireRow(this.ctx.db.select({ runId: gates.runId, kind: gates.kind, status: gates.status, completionRequestId: gates.completionRequestId, completionGateId: gates.completionGateId, snapshotId: gates.snapshotId, reportArtifactId: gates.reportArtifactId }).from(gates).where(eq(gates.id, subject.gateId)).get(), "Gate", subject.gateId);
      if (gate.runId !== subject.runId || gate.kind !== "operator_signoff") throw new InvariantViolationError(`Gate ${subject.gateId} is not an operator_signoff Gate of Run ${subject.runId}`, { gateId: subject.gateId });
      if (gate.status !== "open") throw new ConflictError(`Gate ${subject.gateId} is ${gate.status}; a signoff Decision is requested for an open Gate`, { gateId: subject.gateId });
      if (gate.completionGateId !== subject.completionGateId || gate.completionRequestId !== subject.completionRequestId || gate.snapshotId !== subject.snapshotId || gate.reportArtifactId !== subject.reportArtifactId) {
        throw new InvariantViolationError(`signoff subject disagrees with the facts of Gate ${subject.gateId}`, { gateId: subject.gateId });
      }
      const request = requireRow(this.ctx.db.select({ status: completionRequests.status, gateId: completionRequests.gateId }).from(completionRequests).where(eq(completionRequests.id, subject.completionRequestId)).get(), "CompletionRequest", subject.completionRequestId);
      if (request.status !== "passed" || request.gateId !== subject.completionGateId) throw new InvariantViolationError(`Completion Request ${subject.completionRequestId} has not passed on Gate ${subject.completionGateId}`, { completionRequestId: subject.completionRequestId });
      const existing = this.ctx.db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.kind, "signoff"), eq(decisions.subjectGateId, subject.gateId))).get();
      if (existing) throw new ConflictError(`Gate ${subject.gateId} already has signoff Decision ${existing.id}`, { gateId: subject.gateId, decisionId: existing.id });
      return;
    }
    const node = requireRow(this.ctx.db.select({ runId: planNodes.runId }).from(planNodes).where(eq(planNodes.id, subject.planNodeId)).get(), "PlanNode", subject.planNodeId);
    if (node.runId !== subject.runId) throw new InvariantViolationError(`PlanNode ${subject.planNodeId} belongs to another Run`);
    const invocation = requireRow(this.ctx.db.select({ runId: invocations.runId, planNodeId: invocations.planNodeId }).from(invocations).where(eq(invocations.id, subject.invocationId)).get(), "Invocation", subject.invocationId);
    if (invocation.runId !== subject.runId || invocation.planNodeId !== subject.planNodeId) throw new InvariantViolationError(`Invocation ${subject.invocationId} does not belong to PlanNode ${subject.planNodeId} of Run ${subject.runId}`);
    const attempt = requireRow(this.ctx.db.select({ invocationId: attempts.invocationId }).from(attempts).where(eq(attempts.id, subject.attemptId)).get(), "Attempt", subject.attemptId);
    if (attempt.invocationId !== subject.invocationId) throw new InvariantViolationError(`Attempt ${subject.attemptId} does not belong to Invocation ${subject.invocationId}`);
    const artifact = requireRow(this.ctx.db.select({ runId: artifacts.runId, digest: artifacts.digest, mediaType: artifacts.mediaType }).from(artifacts).where(eq(artifacts.id, subject.callArtifactId)).get(), "Artifact", subject.callArtifactId);
    if (artifact.runId !== subject.runId) throw new InvariantViolationError(`Artifact ${subject.callArtifactId} belongs to another Run`);
    if (artifact.digest !== subject.callDigest || artifact.mediaType !== TOOL_CALL_MEDIA_TYPE) {
      throw new InvariantViolationError(`Artifact ${subject.callArtifactId} is not the canonical call the subject names`, { digest: artifact.digest, mediaType: artifact.mediaType });
    }
  }

  private assertAffectsOwnership(request: DecisionRequest, conversationId: string): void {
    const { requirementIds, taskIds, planNodeIds } = request.affects;
    if (requirementIds.length > 0) {
      const rows = this.ctx.db.select({ id: requirements.id, conversationId: requirements.conversationId }).from(requirements).where(inArray(requirements.id, requirementIds)).all();
      for (const id of requirementIds) {
        const row = requireRow(rows.find((r) => r.id === id), "Requirement", id);
        assertSameConversation("Requirement", id, row.conversationId, conversationId);
      }
    }
    const runIds = new Set<string>();
    if (taskIds.length > 0) {
      const rows = this.ctx.db.select({ id: tasks.id, runId: tasks.runId }).from(tasks).where(inArray(tasks.id, taskIds)).all();
      for (const id of taskIds) runIds.add(requireRow(rows.find((r) => r.id === id), "Task", id).runId);
    }
    if (planNodeIds.length > 0) {
      const rows = this.ctx.db.select({ id: planNodes.id, runId: planNodes.runId }).from(planNodes).where(inArray(planNodes.id, planNodeIds)).all();
      for (const id of planNodeIds) runIds.add(requireRow(rows.find((r) => r.id === id), "PlanNode", id).runId);
    }
    for (const runId of runIds) {
      const run = requireRow(this.ctx.db.select({ conversationId: runs.conversationId }).from(runs).where(eq(runs.id, runId)).get(), "Run", runId);
      assertSameConversation("Run", runId, run.conversationId, conversationId);
    }
  }

  private toRow(decision: Decision): typeof decisions.$inferInsert {
    return {
      id: decision.id,
      conversationId: decision.conversationId,
      runId: decision.runId,
      kind: decision.kind,
      resolutionPolicy: decision.resolutionPolicy,
      status: decision.status,
      requestedBy: decision.requestedBy,
      question: decision.question,
      options: decision.options,
      recommendedOptionId: decision.recommendedOptionId,
      rationale: decision.rationale,
      affects: decision.affects,
      deadlineAt: decision.deadlineAt,
      activationCondition: decision.activationCondition,
      subject: decision.subject,
      resolvedBy: decision.resolution?.resolvedBy ?? null,
      chosenOptionId: decision.resolution?.chosenOptionId ?? null,
      resolutionRationale: decision.resolution?.rationale ?? null,
      resolutionArtifactIds: decision.resolution?.artifactIds ?? null,
      resolvedAt: decision.resolution?.resolvedAt ?? null,
      supersedesDecisionId: decision.supersedesDecisionId,
      supersededByDecisionId: decision.supersededByDecisionId,
      supersessionReason: decision.supersessionReason,
      createdAt: decision.createdAt,
    };
  }
}
