import { acceptanceCriterionBodySchema, conversationCreateBodySchema, conversationUpdateBodySchema, listConversationsQuerySchema, listDecisionsQuerySchema, listProposalsQuerySchema, messageBodySchema, proposalApproveBodySchema, proposalRejectBodySchema, requirementRevisionBodySchema, runCreateBodySchema, type MessagePostResponse, type RequirementProposalResolveResponse, type RequirementRevisionResponse } from "@agentique-console/core";
import { decisionView, requirementView, requirementsResponse, runOverview } from "../../operator/projections.ts";
import { ApiError } from "../errors.ts";
import { admit, CREATED_ID, created, id, notify, page, pageResponse, parse, type RouteHandlers } from "./support.ts";
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
    return pageResponse(query, (q) =>
      (query.workspaceId === undefined ? stores.conversations.pageAll(q) : stores.conversations.pageByWorkspace(query.workspaceId, q)).map((c) => conversationResponse(ctx.app.runtime, c.id)), { scope: `conversations:${query.workspaceId ?? "*"}`, keyOf: (c) => [c.conversation.createdAt, c.conversation.id], shape: CREATED_ID },
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
    return pageResponse(page(request.query), (q) => ctx.app.runtime.stores.conversations.pageMessages(conversationId, q), { scope: `messages:${conversationId}`, keyOf: (m) => [m.createdAt, m.id], shape: CREATED_ID });
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
    const query = parse(listDecisionsQuerySchema, request.query, "query");
    return pageResponse(query, (q) => ctx.app.runtime.stores.decisions.pageByConversation(conversationId, q, query.status).map(decisionView), { scope: `decisions:${conversationId}:${query.status ?? "*"}`, keyOf: (d) => [d.decision.createdAt, d.decision.id], shape: CREATED_ID });
  },
  listConversationRuns: (request, ctx) => {
    const conversationId = id("conversation", request.params.conversationId);
    ctx.app.runtime.stores.conversations.get(conversationId);
    return pageResponse(page(request.query), (q) => ctx.app.runtime.stores.runs.pageByConversation(conversationId, q), { scope: `runs:${conversationId}`, keyOf: (r) => [r.createdAt, r.id], shape: CREATED_ID });
  },
  createRun: (request, ctx) => {
    admit(ctx);
    const conversationId = id("conversation", request.params.conversationId);
    const body = parse(runCreateBodySchema, request.body, "body");
    const launched = ctx.app.launch.launch(conversationId, body);
    notify(ctx, launched.run.id);
    return created(request.reply, runOverview(ctx.app.runtime, ctx.app.runtime.stores.runs.get(launched.run.id)));
  },
  getRequirement: (request, ctx) => requirementView(ctx.app.runtime, ctx.app.runtime.stores.requirements.get(id("requirement", request.params.requirementId)), "single"),
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
    const query = parse(listProposalsQuerySchema, request.query, "query");
    return pageResponse(query, (q) => ctx.app.runtime.stores.requirementProposals.pageByRun(runId, q, query.status), { scope: `requirement-proposals:${runId}:${query.status ?? "*"}`, keyOf: (p) => [p.createdAt, p.id], shape: CREATED_ID });
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
