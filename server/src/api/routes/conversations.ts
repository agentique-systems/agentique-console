import { acceptanceCriterionBodySchema, conversationCreateBodySchema, conversationUpdateBodySchema, listConversationsQuerySchema, messageBodySchema, pageOf, proposalApproveBodySchema, proposalRejectBodySchema, requirementRevisionBodySchema, runCreateBodySchema, type MessagePostResponse, type RequirementProposalResolveResponse, type RequirementRevisionResponse } from "@agentique-console/core";
import { decisionView, requirementView, requirementsResponse, runOverview } from "../../operator/projections.ts";
import { ApiError } from "../errors.ts";
import { admit, created, id, notify, page, parse, type RouteHandlers } from "./support.ts";
import { conversationResponse } from "./workspaces.ts";

export const conversationRoutes: Pick<
  RouteHandlers,
  | "listConversations"
  | "createConversation"
  | "getConversation"
  | "updateConversation"
  | "listConversationMessages"
  | "postConversationMessage"
  | "listConversationRequirements"
  | "createRequirementRevision"
  | "listConversationDecisions"
  | "listConversationRuns"
  | "createRun"
  | "getRequirement"
  | "createAcceptanceCriterion"
  | "getAcceptanceCriterion"
  | "listRunRequirementProposals"
  | "getRequirementProposal"
  | "approveRequirementProposal"
  | "rejectRequirementProposal"
> = {
  listConversations: (request, ctx) => {
    const query = parse(listConversationsQuerySchema, request.query, "query");
    const { stores } = ctx.app.runtime;
    const conversations = query.workspaceId === undefined ? stores.workspaces.list().flatMap((w) => stores.conversations.listByWorkspace(w.id)) : stores.conversations.listByWorkspace(query.workspaceId);
    return pageOf(
      conversations.map((c) => conversationResponse(ctx.app.runtime, c.id)),
      (c) => c.conversation.id,
      query,
    );
  },
  createConversation: (request, ctx) => {
    admit(ctx);
    const body = parse(conversationCreateBodySchema, request.body, "body");
    const conversation = ctx.app.runtime.stores.conversations.create({ workspaceId: body.workspaceId, title: body.title ?? null });
    return created(request.reply, conversationResponse(ctx.app.runtime, conversation.id));
  },
  getConversation: (request, ctx) => conversationResponse(ctx.app.runtime, id("conversation", request.params.conversationId)),
  updateConversation: (request, ctx) => {
    admit(ctx);
    const conversationId = id("conversation", request.params.conversationId);
    ctx.app.runtime.stores.conversations.update(conversationId, parse(conversationUpdateBodySchema, request.body, "body"));
    return conversationResponse(ctx.app.runtime, conversationId);
  },
  listConversationMessages: (request, ctx) => {
    const conversationId = id("conversation", request.params.conversationId);
    ctx.app.runtime.stores.conversations.get(conversationId);
    return pageOf(ctx.app.runtime.stores.conversations.listMessages(conversationId), (m) => `${m.createdAt}/${m.id}`, page(request.query));
  },
  postConversationMessage: (request, ctx): MessagePostResponse => {
    admit(ctx);
    const conversationId = id("conversation", request.params.conversationId);
    const body = parse(messageBodySchema, request.body, "body");
    const { runtime } = ctx.app;
    const conversation = runtime.stores.conversations.get(conversationId);
    if (conversation.activeRunId !== null) {
      // While a Run is active the message is operator steering: queued as a typed input of the Orchestrator's next turn.
      const posted = runtime.orchestratorInputs.postOperatorMessage({ runId: conversation.activeRunId, content: body.content });
      notify(ctx, conversation.activeRunId);
      return created(request.reply, { message: posted.message, queued: posted.queued });
    }
    const message = runtime.stores.conversations.postMessage({ conversationId, author: "operator", content: body.content, runId: null, invocationId: null });
    return created(request.reply, { message, queued: null });
  },
  listConversationRequirements: (request, ctx) => {
    const conversationId = id("conversation", request.params.conversationId);
    ctx.app.runtime.stores.conversations.get(conversationId);
    return requirementsResponse(ctx.app.runtime, conversationId);
  },
  createRequirementRevision: (request, ctx): RequirementRevisionResponse => {
    admit(ctx);
    const conversationId = id("conversation", request.params.conversationId);
    const body = parse(requirementRevisionBodySchema, request.body, "body");
    const authored = ctx.app.runtime.requirementProposals.author({ conversationId, entries: body.entries, rationale: body.rationale ?? null });
    const conversation = ctx.app.runtime.stores.conversations.get(conversationId);
    if (conversation.activeRunId !== null) notify(ctx, conversation.activeRunId);
    return created(request.reply, authored);
  },
  listConversationDecisions: (request, ctx) => {
    const conversationId = id("conversation", request.params.conversationId);
    ctx.app.runtime.stores.conversations.get(conversationId);
    return pageOf(ctx.app.runtime.stores.decisions.listByConversation(conversationId).map(decisionView), (d) => d.decision.id, page(request.query));
  },
  listConversationRuns: (request, ctx) => {
    const conversationId = id("conversation", request.params.conversationId);
    ctx.app.runtime.stores.conversations.get(conversationId);
    return pageOf(ctx.app.runtime.stores.runs.listByConversation(conversationId), (r) => r.id, page(request.query));
  },
  createRun: (request, ctx) => {
    admit(ctx);
    const conversationId = id("conversation", request.params.conversationId);
    const body = parse(runCreateBodySchema, request.body, "body");
    const launched = ctx.app.launch.launch(conversationId, body);
    notify(ctx, launched.run.id);
    return created(request.reply, runOverview(ctx.app.runtime, ctx.app.runtime.stores.runs.get(launched.run.id)));
  },
  getRequirement: (request, ctx) => requirementView(ctx.app.runtime, ctx.app.runtime.stores.requirements.get(id("requirement", request.params.requirementId))),
  createAcceptanceCriterion: (request, ctx) => {
    admit(ctx);
    const requirementId = id("requirement", request.params.requirementId);
    const body = parse(acceptanceCriterionBodySchema, request.body, "body");
    const { stores } = ctx.app.runtime;
    const requirement = stores.requirements.get(requirementId);
    if (requirement.status === "retired") throw new ApiError("conflict", `Requirement ${requirementId} is retired`, { requirementId });
    const revision = stores.requirements.currentRevision(requirement.conversationId);
    if (revision === null || !revision.tree.some((e) => e.id === requirementId)) throw new ApiError("conflict", `Requirement ${requirementId} is not in the current revision`, { requirementId });
    return created(request.reply, stores.requirements.createAcceptanceCriterion({ conversationId: requirement.conversationId, requirementId, requirementRevisionId: revision.id, taskId: null, check: body.check }));
  },
  getAcceptanceCriterion: (request, ctx) => ctx.app.runtime.stores.requirements.getAcceptanceCriterion(id("acceptanceCriterion", request.params.acceptanceCriterionId)),
  listRunRequirementProposals: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return pageOf(ctx.app.runtime.stores.requirementProposals.listByRun(runId), (p) => p.id, page(request.query));
  },
  getRequirementProposal: (request, ctx) => ctx.app.runtime.stores.requirementProposals.get(id("requirementProposal", request.params.proposalId, "proposalId")),
  approveRequirementProposal: (request, ctx): RequirementProposalResolveResponse => {
    admit(ctx);
    const proposalId = id("requirementProposal", request.params.proposalId, "proposalId");
    const body = parse(proposalApproveBodySchema, request.body, "body");
    const outcome = ctx.app.runtime.requirementProposals.approve({ proposalId, ...(body.entries === undefined ? {} : { entries: body.entries }), rationale: body.rationale ?? null });
    notify(ctx, ctx.app.runtime.stores.requirementProposals.get(proposalId).runId);
    return { kind: "approved", proposalId, requirementRevisionId: outcome.kind === "approved" ? outcome.requirementRevisionId : null, edited: outcome.kind === "approved" ? outcome.edited : false, replayed: outcome.replayed };
  },
  rejectRequirementProposal: (request, ctx): RequirementProposalResolveResponse => {
    admit(ctx);
    const proposalId = id("requirementProposal", request.params.proposalId, "proposalId");
    const body = parse(proposalRejectBodySchema, request.body, "body");
    const outcome = ctx.app.runtime.requirementProposals.reject({ proposalId, rationale: body.rationale ?? null });
    notify(ctx, ctx.app.runtime.stores.requirementProposals.get(proposalId).runId);
    return { kind: "rejected", proposalId, requirementRevisionId: null, edited: false, replayed: outcome.replayed };
  },
};
