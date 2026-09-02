/**
 * Every operator mutation, one hook each; on success the scoped queries are
 * invalidated at once (the live subscription refreshes them again as the
 * Events arrive).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AcceptanceCriterionBody, BudgetIncreaseRequestBody, BudgetIncreaseResolveBody, ConversationCreateBody, DecisionResolveBody, MessageBody, ProposalApproveBody, ProposalRejectBody, PublicationRequestBody, PublicationResolveBody, RequirementRevisionBody, RunCreateBody, RunPauseBody, RunStartBody, SignoffAcceptBody, SignoffRequestChangesBody, WorkspaceCreateBody } from "@agentique-console/core";
import { api } from "./client";
import { keys } from "./keys";

function useInvalidate() {
  const client = useQueryClient();
  return (...prefixes: readonly (readonly unknown[])[]) => Promise.all(prefixes.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function useCreateWorkspace() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: WorkspaceCreateBody) => api("createWorkspace", { body }), onSuccess: () => invalidate(keys.workspaces) });
}

export function useCreateConversation() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: ConversationCreateBody) => api("createConversation", { body }), onSuccess: (c) => invalidate(keys.workspaceConversations(c.conversation.workspaceId)) });
}

export function usePostMessage(conversationId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: MessageBody) => api("postConversationMessage", { params: { conversationId }, body }), onSuccess: () => invalidate(keys.conversationMessages(conversationId)) });
}

export function useCreateRun(conversationId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: RunCreateBody) => api("createRun", { params: { conversationId }, body }), onSuccess: () => invalidate(keys.conversation(conversationId), keys.conversationRuns(conversationId), keys.conversationMessages(conversationId), keys.conversationRequirements(conversationId)) });
}

export function useStartRun(runId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: RunStartBody) => api("startRun", { params: { runId }, body }), onSuccess: () => invalidate(keys.run(runId)) });
}

export function useRunControl(runId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate(keys.run(runId));
  return {
    cancel: useMutation({ mutationFn: () => api("cancelRun", { params: { runId }, body: {} }), onSuccess: done }),
    pause: useMutation({ mutationFn: (body: RunPauseBody) => api("pauseRun", { params: { runId }, body }), onSuccess: done }),
    resume: useMutation({ mutationFn: () => api("resumeRun", { params: { runId }, body: {} }), onSuccess: done }),
  };
}

export function useAuthorRequirements(conversationId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (body: RequirementRevisionBody) => api("createRequirementRevision", { params: { conversationId }, body }), onSuccess: () => invalidate(keys.conversationRequirements(conversationId)) });
}

export function useCreateCriterion(conversationId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: { requirementId: string; body: AcceptanceCriterionBody }) => api("createAcceptanceCriterion", { params: { requirementId: input.requirementId }, body: input.body }), onSuccess: () => invalidate(keys.conversationRequirements(conversationId)) });
}

export function useProposalReview(runId: string, conversationId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate(keys.run(runId), keys.conversationRequirements(conversationId));
  return {
    approve: useMutation({ mutationFn: (input: { proposalId: string; body: ProposalApproveBody }) => api("approveRequirementProposal", { params: { proposalId: input.proposalId }, body: input.body }), onSuccess: done }),
    reject: useMutation({ mutationFn: (input: { proposalId: string; body: ProposalRejectBody }) => api("rejectRequirementProposal", { params: { proposalId: input.proposalId }, body: input.body }), onSuccess: done }),
  };
}

export function useDecisionActions(runId: string | null) {
  const invalidate = useInvalidate();
  const done = () => (runId === null ? Promise.resolve([]) : invalidate(keys.run(runId)));
  return {
    resolve: useMutation({ mutationFn: (input: { decisionId: string; body: DecisionResolveBody }) => api("resolveDecision", { params: { decisionId: input.decisionId }, body: input.body }), onSuccess: done }),
    supersede: useMutation({ mutationFn: (input: { decisionId: string; body: DecisionResolveBody }) => api("supersedeDecision", { params: { decisionId: input.decisionId }, body: input.body }), onSuccess: done }),
  };
}

export function useBudgetActions(runId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate(keys.run(runId));
  return {
    request: useMutation({ mutationFn: (body: BudgetIncreaseRequestBody) => api("requestBudgetIncrease", { params: { runId }, body }), onSuccess: done }),
    resolve: useMutation({ mutationFn: (input: { decisionId: string; body: BudgetIncreaseResolveBody }) => api("resolveBudgetIncrease", { params: { runId, decisionId: input.decisionId }, body: input.body }), onSuccess: done }),
  };
}

export function useSignoffActions(runId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate(keys.run(runId));
  return {
    accept: useMutation({ mutationFn: (body: SignoffAcceptBody) => api("acceptSignoff", { params: { runId }, body }), onSuccess: done }),
    requestChanges: useMutation({ mutationFn: (body: SignoffRequestChangesBody) => api("requestSignoffChanges", { params: { runId }, body }), onSuccess: done }),
  };
}

export function usePublicationActions(runId: string) {
  const invalidate = useInvalidate();
  const done = () => invalidate(keys.run(runId));
  return {
    request: useMutation({ mutationFn: (body: PublicationRequestBody) => api("requestPublication", { params: { runId }, body }), onSuccess: done }),
    resolve: useMutation({ mutationFn: (input: { decisionId: string; body: PublicationResolveBody }) => api("resolvePublication", { params: { runId, decisionId: input.decisionId }, body: input.body }), onSuccess: done }),
    advance: useMutation({ mutationFn: (publicationId: string) => api("advancePublication", { params: { publicationId }, body: {} }), onSuccess: done }),
  };
}

export function useLoadWorkspaceAgents(workspaceId: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => api("loadWorkspaceAgentDefinitions", { params: { workspaceId }, body: {} }), onSuccess: () => invalidate(keys.workspaceAgents(workspaceId)) });
}
