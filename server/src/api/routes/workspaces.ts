import { pageOf, workspaceCreateBodySchema, workspaceUpdateBodySchema, type AgentDefinitionLoadResponse, type AgentDefinitionResponse, type AgentDefinitionSummary, type ConversationResponse, type Page, type Run, type WorkspaceAgentDefinitionsResponse, type AgentDefinitionRevision } from "@agentique-console/core";
import type { ConsoleRuntime } from "../../composition/console-runtime.ts";
import { ApiError } from "../errors.ts";
import { admit, created, id, page, parse, type RouteHandlers } from "./support.ts";

export function conversationResponse(runtime: ConsoleRuntime, conversationId: ConversationResponse["conversation"]["id"]): ConversationResponse {
  const conversation = runtime.stores.conversations.get(conversationId);
  const runs = runtime.stores.runs.listByConversation(conversationId);
  return { conversation, activeRun: conversation.activeRunId === null ? null : runtime.stores.runs.get(conversation.activeRunId), runs: runs.length };
}

function summaries(runtime: ConsoleRuntime, filter: (revision: AgentDefinitionRevision) => boolean): AgentDefinitionSummary[] {
  const out: AgentDefinitionSummary[] = [];
  for (const definition of runtime.stores.agents.listDefinitions()) {
    const revisions = runtime.stores.agents.listRevisions(definition.id).filter(filter);
    const latest = revisions.at(-1);
    if (latest !== undefined) out.push({ definition, latestRevision: latest, revisionCount: revisions.length });
  }
  return out;
}

export const workspaceRoutes: Pick<RouteHandlers, "listWorkspaces" | "createWorkspace" | "getWorkspace" | "updateWorkspace" | "listWorkspaceConversations" | "listWorkspaceRuns" | "listWorkspaceAgentDefinitions" | "loadWorkspaceAgentDefinitions" | "getAgentDefinition" | "listAgentDefinitionRevisions" | "getAgentDefinitionRevision"> = {
  listWorkspaces: (request, ctx) => pageOf(ctx.app.workspaces.list(), (w) => w.workspace.id, page(request.query)),
  createWorkspace: async (request, ctx) => {
    admit(ctx);
    return created(request.reply, await ctx.app.workspaces.create(parse(workspaceCreateBodySchema, request.body, "body")));
  },
  getWorkspace: (request, ctx) => ctx.app.workspaces.get(id("workspace", request.params.workspaceId)),
  updateWorkspace: (request, ctx) => {
    admit(ctx);
    return ctx.app.workspaces.update(id("workspace", request.params.workspaceId), parse(workspaceUpdateBodySchema, request.body, "body"));
  },
  listWorkspaceConversations: (request, ctx): Page<ConversationResponse> => {
    const workspaceId = id("workspace", request.params.workspaceId);
    ctx.app.runtime.stores.workspaces.get(workspaceId);
    return pageOf(
      ctx.app.runtime.stores.conversations.listByWorkspace(workspaceId).map((c) => conversationResponse(ctx.app.runtime, c.id)),
      (c) => c.conversation.id,
      page(request.query),
    );
  },
  listWorkspaceRuns: (request, ctx): Page<Run> => {
    const workspaceId = id("workspace", request.params.workspaceId);
    ctx.app.runtime.stores.workspaces.get(workspaceId);
    return pageOf(ctx.app.runtime.stores.runs.listByWorkspace(workspaceId), (r) => r.id, page(request.query));
  },
  listWorkspaceAgentDefinitions: (request, ctx): WorkspaceAgentDefinitionsResponse => {
    const workspaceId = id("workspace", request.params.workspaceId);
    const { runtime } = ctx.app;
    runtime.stores.workspaces.get(workspaceId);
    const ofWorkspace = (snapshotId: AgentDefinitionRevision["id"] | string): boolean => {
      try {
        return runtime.stores.snapshots.get(snapshotId as never).workspaceId === workspaceId;
      } catch {
        return false;
      }
    };
    return {
      builtins: summaries(runtime, (r) => r.provenance.kind === "builtin"),
      workspaceFiles: summaries(runtime, (r) => r.provenance.kind === "workspace_file" && ofWorkspace(r.provenance.snapshotId)),
    };
  },
  loadWorkspaceAgentDefinitions: (request, ctx): AgentDefinitionLoadResponse => {
    admit(ctx);
    const workspaceId = id("workspace", request.params.workspaceId);
    const view = ctx.app.workspaces.get(workspaceId);
    if (view.defaultTarget === null) throw new ApiError("conflict", "the Workspace has no branch that holds Agent Definitions", { workspaceId });
    const report = ctx.app.runtime.agents.loader.loadCurrent(workspaceId, view.defaultTarget);
    return { snapshotId: report.snapshotId, files: report.files };
  },
  getAgentDefinition: (request, ctx): AgentDefinitionResponse => {
    const definitionId = id("agentDefinition", request.params.agentDefinitionId);
    const { stores } = ctx.app.runtime;
    return { definition: stores.agents.getDefinition(definitionId), revisions: stores.agents.listRevisions(definitionId) };
  },
  listAgentDefinitionRevisions: (request, ctx) => {
    const definitionId = id("agentDefinition", request.params.agentDefinitionId);
    ctx.app.runtime.stores.agents.getDefinition(definitionId);
    return pageOf(ctx.app.runtime.stores.agents.listRevisions(definitionId), (r) => r.id, page(request.query));
  },
  getAgentDefinitionRevision: (request, ctx) => {
    const definitionId = id("agentDefinition", request.params.agentDefinitionId);
    const revision = ctx.app.runtime.stores.agents.getRevision(id("agentDefinitionRevision", request.params.revisionId, "revisionId"));
    if (revision.definitionId !== definitionId) throw new ApiError("not_found", `revision ${revision.id} does not belong to Agent Definition ${definitionId}`, { revisionId: revision.id });
    return revision;
  },
};
