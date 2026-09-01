import { and, asc, desc, eq } from "drizzle-orm";
import {
  ConflictError,
  InvariantViolationError,
  parseOrThrow,
  requirementProposalSchema,
  type InvocationId,
  type ProposedRequirement,
  type RequirementProposal,
  type RequirementProposalId,
  type RequirementRevisionId,
  type RunId,
} from "@agentique-console/core";
import type { PersistenceContext } from "../context.ts";
import { invocations, requirementProposals, requirementRevisions } from "../schema.ts";
import { assertSameRun, loadRunRef, OPERATOR_ACTOR, requireRow, runScope, writeMeta, type WriteOptions } from "./support.ts";

type Row = typeof requirementProposals.$inferSelect;

function toDomain(row: Row): RequirementProposal {
  return parseOrThrow(
    requirementProposalSchema,
    {
      id: row.id,
      conversationId: row.conversationId,
      runId: row.runId,
      invocationId: row.invocationId,
      status: row.status,
      entries: row.entries,
      rationale: row.rationale,
      resolution:
        row.resolutionStatus === null
          ? null
          : { status: row.resolutionStatus, requirementRevisionId: row.requirementRevisionId, edited: row.resolutionEdited ?? false, rationale: row.resolutionRationale, resolvedAt: row.resolvedAt },
      supersededByProposalId: row.supersededByProposalId,
      createdAt: row.createdAt,
    },
    "RequirementProposal row",
  );
}

function toRow(proposal: RequirementProposal): Row {
  return {
    id: proposal.id,
    conversationId: proposal.conversationId,
    runId: proposal.runId,
    invocationId: proposal.invocationId,
    status: proposal.status,
    entries: proposal.entries,
    rationale: proposal.rationale,
    resolutionStatus: proposal.resolution?.status ?? null,
    requirementRevisionId: proposal.resolution?.requirementRevisionId ?? null,
    resolutionEdited: proposal.resolution?.edited ?? null,
    resolutionRationale: proposal.resolution?.rationale ?? null,
    resolvedAt: proposal.resolution?.resolvedAt ?? null,
    supersededByProposalId: proposal.supersededByProposalId,
    createdAt: proposal.createdAt,
  };
}

export interface RequirementProposalInput {
  runId: RunId;
  /** The running Orchestrator Invocation whose accepted `propose_requirements` call creates the proposal. */
  invocationId: InvocationId;
  entries: ProposedRequirement[];
  rationale: string;
}

/**
 * Requirement proposals (execution-model §8.1): the Orchestrator's bounded
 * proposals and the operator's resolutions, append-only in identity. `create`
 * records a `proposed` row and supersedes the Run's earlier open one in the
 * same transaction (one open proposal per Run — the database holds the rule
 * too); `approve` names the exact revision the approval created; `reject`
 * records the operator's rationale. A resolved or superseded proposal never
 * changes again.
 */
export class RequirementProposalStore {
  constructor(private readonly ctx: PersistenceContext) {}

  create(input: RequirementProposalInput, options?: WriteOptions): RequirementProposal {
    return this.ctx.tx.write(() => {
      const run = loadRunRef(this.ctx, input.runId);
      const invocation = requireRow(
        this.ctx.db.select({ runId: invocations.runId, role: invocations.role, status: invocations.status }).from(invocations).where(eq(invocations.id, input.invocationId)).get(),
        "Invocation",
        input.invocationId,
      );
      assertSameRun("Invocation", input.invocationId, invocation.runId, run.id);
      if (invocation.role !== "orchestrator") throw new InvariantViolationError(`Invocation ${input.invocationId} is a ${invocation.role}; only an Orchestrator Invocation proposes Requirements`, { invocationId: input.invocationId });
      if (invocation.status !== "running") throw new ConflictError(`Invocation ${input.invocationId} is ${invocation.status}; a proposal is recorded from a running Invocation`, { invocationId: input.invocationId });
      const open = this.openFor(run.id);
      const proposal: RequirementProposal = {
        id: this.ctx.ids("requirementProposal"),
        conversationId: run.conversationId,
        runId: run.id,
        invocationId: input.invocationId,
        status: "proposed",
        entries: input.entries,
        rationale: input.rationale,
        resolution: null,
        supersededByProposalId: null,
        createdAt: this.ctx.clock(),
      };
      parseOrThrow(requirementProposalSchema, proposal, "RequirementProposal");
      const meta = writeMeta(options, { kind: "invocation", invocationId: input.invocationId });
      if (open !== null) {
        // The earlier open proposal is superseded first, so the one-open-per-Run index admits the new row.
        const superseded: RequirementProposal = { ...open, status: "superseded", supersededByProposalId: proposal.id };
        parseOrThrow(requirementProposalSchema, superseded, "RequirementProposal");
        this.ctx.journal.append({
          type: "requirement_proposal.superseded",
          scope: runScope(run, { invocationId: input.invocationId }),
          subjectType: "requirement_proposal",
          subjectId: open.id,
          payload: { proposalId: open.id, supersededByProposalId: proposal.id },
          ...meta,
        });
        this.ctx.db.update(requirementProposals).set({ status: "superseded", supersededByProposalId: proposal.id }).where(eq(requirementProposals.id, open.id)).run();
      }
      this.ctx.journal.append({
        type: "requirement_proposal.created",
        scope: runScope(run, { invocationId: input.invocationId }),
        subjectType: "requirement_proposal",
        subjectId: proposal.id,
        payload: proposal,
        ...meta,
      });
      this.ctx.db.insert(requirementProposals).values(toRow(proposal)).run();
      return proposal;
    });
  }

  /** Records the operator's approval and the one revision it created (of the proposal's Conversation); refused unless the proposal is `proposed`. */
  approve(id: RequirementProposalId, resolution: { requirementRevisionId: RequirementRevisionId; edited: boolean; rationale: string | null }, options?: WriteOptions): RequirementProposal {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (current.status !== "proposed") throw new ConflictError(`RequirementProposal ${id} is ${current.status}; only a proposed proposal is approved`, { proposalId: id, status: current.status });
      const revision = requireRow(
        this.ctx.db.select({ conversationId: requirementRevisions.conversationId }).from(requirementRevisions).where(eq(requirementRevisions.id, resolution.requirementRevisionId)).get(),
        "RequirementRevision",
        resolution.requirementRevisionId,
      );
      if (revision.conversationId !== current.conversationId) throw new InvariantViolationError(`RequirementRevision ${resolution.requirementRevisionId} belongs to another Conversation`, { proposalId: id });
      const run = loadRunRef(this.ctx, current.runId);
      const approved: RequirementProposal = { ...current, status: "approved", resolution: { status: "approved", requirementRevisionId: resolution.requirementRevisionId, edited: resolution.edited, rationale: resolution.rationale, resolvedAt: this.ctx.clock() } };
      parseOrThrow(requirementProposalSchema, approved, "RequirementProposal");
      this.ctx.journal.append({
        type: "requirement_proposal.approved",
        scope: runScope(run, { invocationId: current.invocationId }),
        subjectType: "requirement_proposal",
        subjectId: id,
        payload: { proposalId: id, requirementRevisionId: resolution.requirementRevisionId, edited: resolution.edited, rationale: resolution.rationale },
        ...writeMeta(options, OPERATOR_ACTOR),
      });
      this.ctx.db.update(requirementProposals).set(toRow(approved)).where(eq(requirementProposals.id, id)).run();
      return approved;
    });
  }

  /** Records the operator's rejection; refused unless the proposal is `proposed`. */
  reject(id: RequirementProposalId, resolution: { rationale: string | null }, options?: WriteOptions): RequirementProposal {
    return this.ctx.tx.write(() => {
      const current = this.get(id);
      if (current.status !== "proposed") throw new ConflictError(`RequirementProposal ${id} is ${current.status}; only a proposed proposal is rejected`, { proposalId: id, status: current.status });
      const run = loadRunRef(this.ctx, current.runId);
      const rejected: RequirementProposal = { ...current, status: "rejected", resolution: { status: "rejected", requirementRevisionId: null, edited: false, rationale: resolution.rationale, resolvedAt: this.ctx.clock() } };
      parseOrThrow(requirementProposalSchema, rejected, "RequirementProposal");
      this.ctx.journal.append({
        type: "requirement_proposal.rejected",
        scope: runScope(run, { invocationId: current.invocationId }),
        subjectType: "requirement_proposal",
        subjectId: id,
        payload: { proposalId: id, rationale: resolution.rationale },
        ...writeMeta(options, OPERATOR_ACTOR),
      });
      this.ctx.db.update(requirementProposals).set(toRow(rejected)).where(eq(requirementProposals.id, id)).run();
      return rejected;
    });
  }

  get(id: RequirementProposalId): RequirementProposal {
    return toDomain(requireRow(this.ctx.db.select().from(requirementProposals).where(eq(requirementProposals.id, id)).get(), "RequirementProposal", id));
  }

  /** The Run's one `proposed` proposal, or `null`. */
  openFor(runId: RunId): RequirementProposal | null {
    const row = this.ctx.db.select().from(requirementProposals).where(and(eq(requirementProposals.runId, runId), eq(requirementProposals.status, "proposed"))).get();
    return row === undefined ? null : toDomain(row);
  }

  /** Every proposal of the Run, oldest first. */
  listByRun(runId: RunId): RequirementProposal[] {
    return this.ctx.db.select().from(requirementProposals).where(eq(requirementProposals.runId, runId)).orderBy(asc(requirementProposals.createdAt), asc(requirementProposals.id)).all().map(toDomain);
  }

  /** The proposals an Invocation's accepted calls created, newest first. */
  listByInvocation(invocationId: InvocationId): RequirementProposal[] {
    return this.ctx.db.select().from(requirementProposals).where(eq(requirementProposals.invocationId, invocationId)).orderBy(desc(requirementProposals.createdAt), desc(requirementProposals.id)).all().map(toDomain);
  }
}
