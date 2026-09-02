/**
 * Requirement proposals (execution-model §8.1 `propose_requirements`): the
 * executable handler that records the Orchestrator's bounded proposal, and
 * the operator boundary that approves it (verbatim or edited), or rejects
 * it. Only the approval creates a Requirement revision — with stable ids
 * for the Requirements the proposal keeps, fresh ids for the new ones, the
 * removed ones retired by the revision store, and the proposed Acceptance
 * Criteria authored in the new revision — in one transaction with the
 * proposal's resolution and the typed `requirement_proposal_resolution`
 * input queued for the Orchestrator's next turn. The proposal id is the
 * canonical identity throughout; a repeated approval or rejection replays.
 */
import {
  canonicalJson,
  DomainError,
  NotFoundError,
  proposedRequirementTreeSchema,
  RUN_MACHINE,
  runIsRunningOrDraining,
  runtimeToolHandlerBound,
  type AcceptanceCriterion,
  type ConversationId,
  type ProposedRequirement,
  type ProposeRequirementsInput,
  type RequirementId,
  type RequirementProposal,
  type RequirementProposalId,
  type RequirementRevision,
  type RequirementRevisionId,
  type RequirementTreeEntry,
  type Run,
} from "@agentique-console/core";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import { OPERATOR_ACTOR, type WriteOptions } from "../persistence/stores/support.ts";
import type { HandlerOutcome, RuntimeToolCaller } from "./task-proposals.ts";

export const REQUIREMENT_PROPOSAL_REFUSAL_CODES = [
  /** The proposal does not exist. */
  "proposal_not_found",
  /** The proposal was rejected or superseded; a resolved proposal is never resolved again another way. */
  "conflicting_resolution",
  /** An operator resolution needs an operator actor. */
  "operator_required",
  /** The proposal's Run ended; nothing is resolved for a terminal Run. */
  "run_terminal",
  /** The (edited) tree is structurally invalid or keeps a Requirement that is not a live Requirement of the Conversation. */
  "proposal_invalid",
] as const;
export type RequirementProposalRefusalCode = (typeof REQUIREMENT_PROPOSAL_REFUSAL_CODES)[number];

export class RequirementProposalRefusedError extends DomainError {
  readonly refusal: RequirementProposalRefusalCode;

  constructor(refusal: RequirementProposalRefusalCode, message: string, details: Record<string, unknown> = {}) {
    super("conflict", message, { refusal, ...details });
    this.refusal = refusal;
  }
}

export interface RequirementProposalApproveInput {
  proposalId: RequirementProposalId;
  /** The operator's edited tree, replacing the proposed one; omitted approves the proposal verbatim. */
  entries?: ProposedRequirement[];
  rationale?: string | null;
}

export interface RequirementProposalRejectInput {
  proposalId: RequirementProposalId;
  rationale?: string | null;
}

export type RequirementProposalResolutionOutcome =
  | { kind: "approved"; proposalId: RequirementProposalId; requirementRevisionId: RequirementRevisionId; edited: boolean; replayed: boolean }
  | { kind: "rejected"; proposalId: RequirementProposalId; replayed: boolean };

function rejected(code: Extract<HandlerOutcome, { kind: "rejected" }>["reasons"][number]["code"], message: string, path: string | null = null): HandlerOutcome {
  return { kind: "rejected", reasons: [{ code, message, path }] };
}

export class RequirementProposalService {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
  ) {}

  // ---------------------------------------------------------------------------
  // The propose_requirements handler (inside the call's transaction)
  // ---------------------------------------------------------------------------

  propose(caller: RuntimeToolCaller, input: ProposeRequirementsInput, options: WriteOptions): HandlerOutcome {
    const { invocation, node } = caller;
    if (invocation.role !== "orchestrator" || !runtimeToolHandlerBound("propose_requirements", invocation.role, invocation.purpose)) return rejected("caller_not_permitted", `a ${invocation.role} Invocation with purpose ${invocation.purpose} never proposes Requirements`);
    if (invocation.gateId !== null) return rejected("caller_not_permitted", `Invocation ${invocation.id} is Gate-owned; a Gate evaluation never proposes Requirements`);
    if (invocation.status !== "running" || invocation.planNodeId !== node.id) return rejected("caller_not_running", `Invocation ${invocation.id} is ${invocation.status} or does not belong to PlanNode ${node.id}`);
    const run = this.stores.runs.get(invocation.runId);
    if (!runIsRunningOrDraining(run)) return rejected("caller_not_permitted", `Run ${run.id} is ${run.status}${run.operatorPause === null ? "" : ` and paused (${run.operatorPause})`}; Requirements are proposed in a running Run`);
    if (node.status !== "running") return rejected("caller_not_permitted", `PlanNode ${node.id} is ${node.status}; Requirements are proposed from running work`);
    const kept = this.keptRequirementDefect(run, input.requirements);
    if (kept !== null) return rejected("proposal_invalid", kept.message, kept.path);
    const proposal = this.stores.requirementProposals.create({ runId: run.id, invocationId: invocation.id, entries: input.requirements, rationale: input.rationale }, options);
    return { kind: "applied", result: { tool: "propose_requirements", proposalId: proposal.id, status: "proposed" } };
  }

  // ---------------------------------------------------------------------------
  // The operator boundary
  // ---------------------------------------------------------------------------

  approve(input: RequirementProposalApproveInput, options: WriteOptions = {}): RequirementProposalResolutionOutcome {
    if (options.actor !== undefined && options.actor.kind !== "operator") throw new RequirementProposalRefusedError("operator_required", `a Requirement proposal is approved by the operator, not ${options.actor.kind}`, { proposalId: input.proposalId });
    return this.ctx.tx.write((): RequirementProposalResolutionOutcome => {
      const proposal = this.proposal(input.proposalId);
      if (proposal.status === "approved") return { kind: "approved", proposalId: proposal.id, requirementRevisionId: proposal.resolution!.requirementRevisionId!, edited: proposal.resolution!.edited, replayed: true };
      if (proposal.status !== "proposed") throw new RequirementProposalRefusedError("conflicting_resolution", `RequirementProposal ${proposal.id} is ${proposal.status}`, { proposalId: proposal.id, status: proposal.status });
      const run = this.stores.runs.get(proposal.runId);
      if (RUN_MACHINE.isTerminal(run.status)) throw new RequirementProposalRefusedError("run_terminal", `Run ${run.id} is ${run.status}; nothing is approved for a terminal Run`, { proposalId: proposal.id, runId: run.id });
      let entries = proposal.entries;
      let edited = false;
      if (input.entries !== undefined) {
        const parsed = proposedRequirementTreeSchema.safeParse(input.entries);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new RequirementProposalRefusedError("proposal_invalid", issue?.message ?? "the edited tree is invalid", { proposalId: proposal.id, path: issue?.path.map(String).join(".") ?? null });
        }
        entries = parsed.data;
        edited = canonicalJson(entries) !== canonicalJson(proposal.entries);
      }
      const kept = this.keptRequirementDefect(run, entries);
      if (kept !== null) throw new RequirementProposalRefusedError("proposal_invalid", kept.message, { proposalId: proposal.id, path: kept.path });
      const meta: WriteOptions = { actor: OPERATOR_ACTOR, correlationId: options.correlationId ?? proposal.id, causationSeq: options.causationSeq ?? null };
      const chained = (): WriteOptions => ({ ...meta, causationSeq: this.ctx.journal.lastSeq() });
      const tree = this.treeOf(entries);
      const revision = this.stores.requirements.createRevision({ conversationId: run.conversationId, tree: tree.map((t) => t.entry), approvedByDecisionId: null }, meta);
      for (const { proposed, entry } of tree) {
        for (const check of proposed.acceptanceCriteria) {
          this.stores.requirements.createAcceptanceCriterion({ conversationId: run.conversationId, requirementId: entry.id, requirementRevisionId: revision.id, taskId: null, check }, chained());
        }
      }
      const rationale = input.rationale ?? null;
      this.stores.requirementProposals.approve(proposal.id, { requirementRevisionId: revision.id, edited, rationale }, chained());
      this.stores.orchestratorInputs.enqueue(run.id, { kind: "requirement_proposal_resolution", proposalId: proposal.id, status: "approved", requirementRevisionId: revision.id, edited, rationale }, chained());
      return { kind: "approved", proposalId: proposal.id, requirementRevisionId: revision.id, edited, replayed: false };
    });
  }

  reject(input: RequirementProposalRejectInput, options: WriteOptions = {}): RequirementProposalResolutionOutcome {
    if (options.actor !== undefined && options.actor.kind !== "operator") throw new RequirementProposalRefusedError("operator_required", `a Requirement proposal is rejected by the operator, not ${options.actor.kind}`, { proposalId: input.proposalId });
    return this.ctx.tx.write((): RequirementProposalResolutionOutcome => {
      const proposal = this.proposal(input.proposalId);
      if (proposal.status === "rejected") return { kind: "rejected", proposalId: proposal.id, replayed: true };
      if (proposal.status !== "proposed") throw new RequirementProposalRefusedError("conflicting_resolution", `RequirementProposal ${proposal.id} is ${proposal.status}`, { proposalId: proposal.id, status: proposal.status });
      const run = this.stores.runs.get(proposal.runId);
      if (RUN_MACHINE.isTerminal(run.status)) throw new RequirementProposalRefusedError("run_terminal", `Run ${run.id} is ${run.status}; nothing is rejected for a terminal Run`, { proposalId: proposal.id, runId: run.id });
      const meta: WriteOptions = { actor: OPERATOR_ACTOR, correlationId: options.correlationId ?? proposal.id, causationSeq: options.causationSeq ?? null };
      const rationale = input.rationale ?? null;
      this.stores.requirementProposals.reject(proposal.id, { rationale }, meta);
      this.stores.orchestratorInputs.enqueue(run.id, { kind: "requirement_proposal_resolution", proposalId: proposal.id, status: "rejected", requirementRevisionId: null, edited: false, rationale }, { ...meta, causationSeq: this.ctx.journal.lastSeq() });
      return { kind: "rejected", proposalId: proposal.id, replayed: false };
    });
  }

  /**
   * The operator authors a Requirement revision directly (execution-model §8.1): the same tree contract as an approved
   * proposal — kept Requirements name their id and keep it, new ones are minted, removed ones are retired by the revision
   * store, and the proposed Acceptance Criteria are authored in the new revision — in one transaction, with no Decision
   * (an operator-authored revision needs no approval) and no queued Orchestrator input (the operator steers by message).
   */
  author(input: { conversationId: ConversationId; entries: ProposedRequirement[]; rationale: string | null }, options: WriteOptions = {}): { revision: RequirementRevision; criteria: AcceptanceCriterion[] } {
    if (options.actor !== undefined && options.actor.kind !== "operator") throw new RequirementProposalRefusedError("operator_required", `a Requirement revision is authored by the operator, not ${options.actor.kind}`, { conversationId: input.conversationId });
    const parsed = proposedRequirementTreeSchema.safeParse(input.entries);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RequirementProposalRefusedError("proposal_invalid", issue?.message ?? "the tree is invalid", { conversationId: input.conversationId, path: issue?.path.map(String).join(".") ?? null });
    }
    const entries = parsed.data;
    return this.ctx.tx.write(() => {
      const conversation = this.stores.conversations.get(input.conversationId);
      const live = new Set(this.stores.requirements.listByConversation(conversation.id).filter((r) => r.status !== "retired").map((r) => r.id));
      for (const [i, entry] of entries.entries()) {
        if (entry.requirementId !== null && !live.has(entry.requirementId)) throw new RequirementProposalRefusedError("proposal_invalid", `Requirement ${entry.requirementId} is not a live Requirement of this Conversation`, { conversationId: conversation.id, path: `entries.${i}.requirementId` });
      }
      const meta: WriteOptions = { actor: OPERATOR_ACTOR, correlationId: options.correlationId ?? conversation.id, causationSeq: options.causationSeq ?? null };
      const chained = (): WriteOptions => ({ ...meta, causationSeq: this.ctx.journal.lastSeq() });
      const tree = this.treeOf(entries);
      const revision = this.stores.requirements.createRevision({ conversationId: conversation.id, tree: tree.map((t) => t.entry), approvedByDecisionId: null }, meta);
      const criteria: AcceptanceCriterion[] = [];
      for (const { proposed, entry } of tree) {
        for (const check of proposed.acceptanceCriteria) {
          criteria.push(this.stores.requirements.createAcceptanceCriterion({ conversationId: conversation.id, requirementId: entry.id, requirementRevisionId: revision.id, taskId: null, check }, chained()));
        }
      }
      return { revision, criteria };
    });
  }

  /** The Run's open proposal, if any, and every proposal of the Run — the operator's projection. */
  inspect(runId: Run["id"]): { open: RequirementProposal | null; proposals: RequirementProposal[] } {
    return { open: this.stores.requirementProposals.openFor(runId), proposals: this.stores.requirementProposals.listByRun(runId) };
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  private proposal(id: RequirementProposalId): RequirementProposal {
    try {
      return this.stores.requirementProposals.get(id);
    } catch (error) {
      if (error instanceof NotFoundError) throw new RequirementProposalRefusedError("proposal_not_found", `RequirementProposal ${id} does not exist`, { proposalId: id });
      throw error;
    }
  }

  /** A kept Requirement must be a live (unretired) Requirement of the Run's Conversation. */
  private keptRequirementDefect(run: Run, entries: readonly ProposedRequirement[]): { message: string; path: string } | null {
    const live = new Set(this.stores.requirements.listByConversation(run.conversationId).filter((r) => r.status !== "retired").map((r) => r.id));
    for (const [i, entry] of entries.entries()) {
      if (entry.requirementId !== null && !live.has(entry.requirementId)) return { message: `Requirement ${entry.requirementId} is not a live Requirement of this Conversation`, path: `requirements.${i}.requirementId` };
    }
    return null;
  }

  /** The revision tree in parent-first order: kept Requirements keep their ids, new ones are minted, positions follow the order. */
  private treeOf(entries: readonly ProposedRequirement[]): { proposed: ProposedRequirement; entry: RequirementTreeEntry }[] {
    const ids = new Map<string, RequirementId>(entries.map((e) => [e.key, e.requirementId ?? this.ctx.ids("requirement")] as const));
    const ordered: ProposedRequirement[] = [];
    const visit = (parentKey: string | null) => {
      for (const entry of entries) if (entry.parentKey === parentKey) {
        ordered.push(entry);
        visit(entry.key);
      }
    };
    visit(null);
    return ordered.map((proposed, position) => ({
      proposed,
      entry: { id: ids.get(proposed.key)!, parentId: proposed.parentKey === null ? null : ids.get(proposed.parentKey)!, composition: proposed.composition, statement: proposed.statement, position, acceptanceCriterionIds: [] },
    }));
  }
}
