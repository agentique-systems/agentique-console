import { budgetIncreaseRequestBodySchema, budgetIncreaseResolveBodySchema, listDecisionsQuerySchema, planNodeScopedPageQuerySchema, publicationRequestBodySchema, publicationResolveBodySchema, runPauseBodySchema, runStartBodySchema, signoffAcceptBodySchema, signoffRequestChangesBodySchema, type BudgetIncreaseResolveResponse, type PublicationRequestResponse, type PublicationResolveResponse, type RunControlResponse, type SignoffResolveResponse, type TaskLedgerResponse } from "@agentique-console/core";
import { budgetResponse, decisionView, planResponse, publicationsResponse, runOverview, signoffResponse, taskViews, usageResponse } from "../../operator/projections.ts";
import { supportsPublication, WORKSPACE_CAPABILITIES } from "../../workspace-state/capabilities.ts";
import { ApiError } from "../errors.ts";
import { admit, CREATED_ID, id, notify, ORDINAL, page, pageResponse, parse, type RouteHandlers } from "./support.ts";

export const runRoutes: Pick<
  RouteHandlers,
  | "getRun"
  | "startRun"
  | "cancelRun"
  | "pauseRun"
  | "resumeRun"
  | "getRunPlan"
  | "listRunPlanRevisions"
  | "listRunInvocations"
  | "listRunTasks"
  | "listRunHandoffs"
  | "listRunDecisions"
  | "getRunBudget"
  | "requestBudgetIncrease"
  | "resolveBudgetIncrease"
  | "listRunEvaluations"
  | "listRunGates"
  | "listRunSnapshots"
  | "listRunChangesets"
  | "listRunArtifacts"
  | "getRunUsage"
  | "listRunCompletionRequests"
  | "listRunOrchestratorInputs"
  | "getRunSignoff"
  | "acceptSignoff"
  | "requestSignoffChanges"
  | "getRunPublications"
  | "requestPublication"
  | "resolvePublication"
> = {
  getRun: (request, ctx) => runOverview(ctx.app.runtime, ctx.app.runtime.stores.runs.get(id("run", request.params.runId))),
  startRun: (request, ctx) => {
    admit(ctx);
    const run = ctx.app.runtime.stores.runs.get(id("run", request.params.runId));
    const body = parse(runStartBodySchema, request.body, "body");
    if (run.status !== "created") throw new ApiError("conflict", `Run ${run.id} is ${run.status}; only a created Run starts`, { runId: run.id, status: run.status });
    const started = ctx.app.launch.start(run, body.message);
    notify(ctx, started.id);
    return runOverview(ctx.app.runtime, ctx.app.runtime.stores.runs.get(started.id));
  },
  cancelRun: (request, ctx): RunControlResponse => {
    admit(ctx);
    const runId = id("run", request.params.runId);
    const outcome = ctx.app.runtime.runControl.cancel({ runId });
    notify(ctx, runId);
    return { run: ctx.app.runtime.stores.runs.get(runId), outcome: { ...outcome } };
  },
  pauseRun: (request, ctx): RunControlResponse => {
    admit(ctx);
    const runId = id("run", request.params.runId);
    const body = parse(runPauseBodySchema, request.body, "body");
    const outcome = ctx.app.runtime.runControl.pause({ runId, mode: body.mode });
    notify(ctx, runId);
    return { run: ctx.app.runtime.stores.runs.get(runId), outcome: { ...outcome } };
  },
  resumeRun: (request, ctx): RunControlResponse => {
    admit(ctx);
    const runId = id("run", request.params.runId);
    const outcome = ctx.app.runtime.runControl.resume({ runId });
    notify(ctx, runId);
    return { run: ctx.app.runtime.stores.runs.get(runId), outcome: { ...outcome } };
  },
  getRunPlan: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return planResponse(ctx.app.runtime, runId);
  },
  listRunPlanRevisions: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return pageResponse(page(request.query), (q) => ctx.app.runtime.stores.plans.pageRevisions(runId, q), { scope: `plan-revisions:${runId}`, keyOf: (r) => [r.number], shape: ORDINAL });
  },
  listRunInvocations: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    const query = parse(planNodeScopedPageQuerySchema, request.query, "query");
    return pageResponse(query, (q) => ctx.app.runtime.stores.invocations.pageByRun(runId, q, query.planNodeId), { scope: `invocations:${runId}:${query.planNodeId ?? "*"}`, keyOf: (i) => [i.createdAt, i.id], shape: CREATED_ID });
  },
  listRunTasks: (request, ctx): TaskLedgerResponse => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    const query = parse(planNodeScopedPageQuerySchema, request.query, "query");
    return pageResponse(query, (q) => taskViews(ctx.app.runtime, ctx.app.runtime.stores.tasks.pageByRun(runId, q, query.planNodeId)), { scope: `tasks:${runId}:${query.planNodeId ?? "*"}`, keyOf: (v) => [v.task.createdAt, v.task.id], shape: CREATED_ID });
  },
  listRunHandoffs: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return pageResponse(page(request.query), (q) => ctx.app.runtime.stores.handoffs.pageByRun(runId, q), { scope: `handoffs:${runId}`, keyOf: (h) => [h.createdAt, h.id], shape: CREATED_ID });
  },
  listRunDecisions: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    const query = parse(listDecisionsQuerySchema, request.query, "query");
    return pageResponse(query, (q) => ctx.app.runtime.stores.decisions.pageByRun(runId, q, query.status).map(decisionView), { scope: `decisions:${runId}:${query.status ?? "*"}`, keyOf: (d) => [d.decision.createdAt, d.decision.id], shape: CREATED_ID });
  },
  getRunBudget: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return budgetResponse(ctx.app.runtime, runId);
  },
  requestBudgetIncrease: (request, ctx) => {
    admit(ctx);
    const runId = id("run", request.params.runId);
    const body = parse(budgetIncreaseRequestBodySchema, request.body, "body");
    const outcome = ctx.app.runtime.budgetIncreases.request({ runId, partition: body.partition, added: body.added });
    return { decision: outcome.decision, replayed: outcome.replayed };
  },
  resolveBudgetIncrease: (request, ctx): BudgetIncreaseResolveResponse => {
    admit(ctx);
    const runId = id("run", request.params.runId);
    const decisionId = id("decision", request.params.decisionId, "decisionId");
    const body = parse(budgetIncreaseResolveBodySchema, request.body, "body");
    const decision = ctx.app.runtime.stores.decisions.get(decisionId);
    if (decision.runId !== runId || decision.kind !== "budget_increase") throw new ApiError("not_found", `Decision ${decisionId} is not a budget_increase Decision of Run ${runId}`, { decisionId, runId });
    const outcome = ctx.app.runtime.budgetIncreases.resolve({ runId, decisionId, option: body.option });
    notify(ctx, runId);
    const record = outcome as unknown as { kind: "approved" | "denied"; budgetIncreaseId?: string; replayed: boolean };
    return { kind: record.kind, decisionId, budgetIncreaseId: record.budgetIncreaseId ?? null, replayed: record.replayed };
  },
  listRunEvaluations: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    const query = parse(planNodeScopedPageQuerySchema, request.query, "query");
    return pageResponse(query, (q) => ctx.app.runtime.stores.evaluations.pageByRun(runId, q, query.planNodeId), { scope: `evaluations:${runId}:${query.planNodeId ?? "*"}`, keyOf: (e) => [e.createdAt, e.id], shape: CREATED_ID });
  },
  listRunGates: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    const query = parse(planNodeScopedPageQuerySchema, request.query, "query");
    return pageResponse(query, (q) => ctx.app.runtime.stores.gates.pageByRun(runId, q, query.planNodeId), { scope: `gates:${runId}:${query.planNodeId ?? "*"}`, keyOf: (g) => [g.openedAt, g.id], shape: CREATED_ID });
  },
  listRunSnapshots: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return pageResponse(page(request.query), (q) => ctx.app.runtime.stores.snapshots.pageByRun(runId, q), { scope: `snapshots:${runId}`, keyOf: (s) => [s.takenAt, s.id], shape: CREATED_ID });
  },
  listRunChangesets: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return pageResponse(page(request.query), (q) => ctx.app.runtime.stores.changesets.pageByRun(runId, q), { scope: `changesets:${runId}`, keyOf: (c) => [c.createdAt, c.id], shape: CREATED_ID });
  },
  listRunArtifacts: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return pageResponse(page(request.query), (q) => ctx.app.runtime.stores.artifacts.pageByRun(runId, q), { scope: `artifacts:${runId}`, keyOf: (a) => [a.createdAt, a.id], shape: CREATED_ID });
  },
  getRunUsage: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return usageResponse(ctx.app.runtime, runId, page(request.query));
  },
  listRunCompletionRequests: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return pageResponse(page(request.query), (q) => ctx.app.runtime.stores.completionRequests.pageByRun(runId, q), { scope: `completion-requests:${runId}`, keyOf: (r) => [r.createdAt, r.id], shape: CREATED_ID });
  },
  listRunOrchestratorInputs: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return pageResponse(page(request.query), (q) => ctx.app.runtime.stores.orchestratorInputs.pageByRun(runId, q), { scope: `orchestrator-inputs:${runId}`, keyOf: (i) => [i.createdAt, i.id], shape: CREATED_ID });
  },
  getRunSignoff: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return signoffResponse(ctx.app.runtime, runId);
  },
  acceptSignoff: async (request, ctx): Promise<SignoffResolveResponse> => {
    admit(ctx);
    const runId = id("run", request.params.runId);
    const body = parse(signoffAcceptBodySchema, request.body, "body");
    const outcome = await ctx.app.runtime.signoff.accept({ runId, gateId: body.gateId, decisionId: body.decisionId });
    notify(ctx, runId);
    return { kind: outcome.kind, replayed: "replayed" in outcome ? Boolean(outcome.replayed) : false, run: ctx.app.runtime.stores.runs.get(runId) };
  },
  requestSignoffChanges: (request, ctx): SignoffResolveResponse => {
    admit(ctx);
    const runId = id("run", request.params.runId);
    const body = parse(signoffRequestChangesBodySchema, request.body, "body");
    const { runtime } = ctx.app;
    const run = runtime.stores.runs.get(runId);
    // The operator's message is recorded on the Conversation first; the change request names it by id (execution-model §10).
    const message = runtime.stores.conversations.postMessage({ conversationId: run.conversationId, author: "operator", content: body.message, runId, invocationId: null });
    const outcome = runtime.signoff.requestChanges({ runId, gateId: body.gateId, decisionId: body.decisionId, operatorMessageId: message.id });
    notify(ctx, runId);
    return { kind: outcome.kind, replayed: "replayed" in outcome ? Boolean(outcome.replayed) : false, run: runtime.stores.runs.get(runId) };
  },
  getRunPublications: (request, ctx) => {
    const runId = id("run", request.params.runId);
    ctx.app.runtime.stores.runs.get(runId);
    return publicationsResponse(ctx.app.runtime, runId);
  },
  requestPublication: (request, ctx): PublicationRequestResponse => {
    admit(ctx);
    const runId = id("run", request.params.runId);
    const body = parse(publicationRequestBodySchema, request.body, "body");
    const { runtime } = ctx.app;
    const run = runtime.stores.runs.get(runId);
    const workspace = runtime.stores.workspaces.get(run.workspaceId);
    // The capability is stated before any Decision opens: a kind without atomic publication never gets a publish Decision.
    if (!supportsPublication(workspace.kind)) throw new ApiError("unsupported", `a ${workspace.kind} Workspace cannot be published: ${WORKSPACE_CAPABILITIES[workspace.kind].publicationApply}`, { kind: workspace.kind, runId });
    const outcome = runtime.publication.request({ runId, requestedStrategy: body.requestedStrategy ?? { kind: "automatic" } });
    return { decision: outcome.decision, replayed: outcome.replayed };
  },
  resolvePublication: (request, ctx): PublicationResolveResponse => {
    admit(ctx);
    const runId = id("run", request.params.runId);
    const decisionId = id("decision", request.params.decisionId, "decisionId");
    const body = parse(publicationResolveBodySchema, request.body, "body");
    const decision = ctx.app.runtime.stores.decisions.get(decisionId);
    if (decision.runId !== runId || decision.kind !== "publish") throw new ApiError("not_found", `Decision ${decisionId} is not a publish Decision of Run ${runId}`, { decisionId, runId });
    const outcome = ctx.app.runtime.publication.resolve({ runId, decisionId, option: body.option });
    if (outcome.kind === "publishing") void ctx.app.host.notifyPublication(outcome.publicationId);
    return { kind: outcome.kind, decisionId, publicationId: outcome.kind === "publishing" ? outcome.publicationId : null, replayed: outcome.replayed };
  },
};
