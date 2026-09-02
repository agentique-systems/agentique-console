/**
 * Every read of the web application: point reads as plain queries, every
 * collection as a paged query that follows the server's cursors — the first
 * page on mount, further pages on demand, every loaded page refreshed when
 * the live subscription invalidates the scope. Nothing here asks for "all"
 * of anything: the server's page bounds are the client's bounds.
 */
import { useInfiniteQuery, useQuery, type InfiniteData, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { apiPath, type ApiResponses, type Page, type PageOrder } from "@agentique-console/core";
import { api, apiText, type JsonRoute } from "./client";
import { keys } from "./keys";

/** The routes whose response is a page. */
export type PagedRoute = { [K in JsonRoute]: ApiResponses[K] extends Page<unknown> ? K : never }[JsonRoute];
export type ItemOf<N extends PagedRoute> = ApiResponses[N] extends Page<infer T> ? T : never;

export type PagedQuery<T> = UseInfiniteQueryResult<InfiniteData<Page<T>, string | null>, Error>;

export interface PageOptions {
  params?: Record<string, string>;
  /** Route-specific filters and the order; the cursor is the query's own. */
  query?: Record<string, string | number | undefined>;
  order?: PageOrder;
  limit?: number;
  /** The cursor the first page continues from (a `reverseCursor`, for the messages newer than an anchor). */
  initialCursor?: string | null;
  enabled?: boolean;
  /** How long a loaded page stays fresh; immutable history sets it to `Infinity`. */
  staleTime?: number;
}

/**
 * One paged collection: `data.pages` are the pages loaded so far in the collection's order; `fetchNextPage` follows
 * `nextCursor`; an invalidation of the key refetches every loaded page in sequence, so the loaded window stays exact.
 */
export function usePage<N extends PagedRoute>(name: N, queryKey: readonly unknown[], options: PageOptions = {}): PagedQuery<ItemOf<N>> {
  const { params = {}, query = {}, order, limit, initialCursor = null, enabled = true, staleTime } = options;
  return useInfiniteQuery<Page<ItemOf<N>>, Error, InfiniteData<Page<ItemOf<N>>, string | null>, readonly unknown[], string | null>({
    queryKey: [...queryKey, { order: order ?? "asc", limit: limit ?? null, initialCursor, ...query }],
    queryFn: ({ pageParam }) => api(name, { params, query: { ...query, ...(order === undefined ? {} : { order }), ...(limit === undefined ? {} : { limit }), cursor: pageParam ?? initialCursor ?? undefined } }) as Promise<Page<ItemOf<N>>>,
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    ...(staleTime === undefined ? {} : { staleTime }),
  });
}

/** The items of every loaded page, in order, each id once (a refetch that shifted a page boundary never shows a record twice). */
export function itemsOf<T>(data: InfiniteData<Page<T>, string | null> | undefined, idOf: (item: T) => string): T[] {
  if (data === undefined) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of data.pages) {
    for (const item of page.items) {
      const id = idOf(item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
  }
  return out;
}

export const useHealth = () => useQuery({ queryKey: keys.health, queryFn: () => api("health"), refetchInterval: false });
export const useConfig = () => useQuery({ queryKey: keys.config, queryFn: () => api("config"), staleTime: Infinity });
export const useCapacity = () => useQuery({ queryKey: keys.capacity, queryFn: () => api("capacity") });
/** Workspaces, newest first. */
export const useWorkspaces = () => usePage("listWorkspaces", keys.workspaces, { order: "desc" });
export const useWorkspace = (workspaceId: string | null) => useQuery({ queryKey: keys.workspace(workspaceId ?? ""), queryFn: () => api("getWorkspace", { params: { workspaceId: workspaceId! } }), enabled: workspaceId !== null, retry: false });
/** A Workspace's Conversations, newest first. */
export const useWorkspaceConversations = (workspaceId: string) => usePage("listWorkspaceConversations", keys.workspaceConversations(workspaceId), { params: { workspaceId }, order: "desc" });
export const useWorkspaceRuns = (workspaceId: string) => usePage("listWorkspaceRuns", keys.workspaceRuns(workspaceId), { params: { workspaceId }, order: "desc" });
export const useWorkspaceAgents = (workspaceId: string) => useQuery({ queryKey: keys.workspaceAgents(workspaceId), queryFn: () => api("listWorkspaceAgentDefinitions", { params: { workspaceId } }) });
export const useAgentDefinition = (agentDefinitionId: string) => useQuery({ queryKey: keys.agentDefinition(agentDefinitionId), queryFn: () => api("getAgentDefinition", { params: { agentDefinitionId } }) });
export const useAgentDefinitionRevisions = (agentDefinitionId: string) => usePage("listAgentDefinitionRevisions", [...keys.agentDefinition(agentDefinitionId), "revisions"], { params: { agentDefinitionId }, order: "desc" });
export const useConversation = (conversationId: string) => useQuery({ queryKey: keys.conversation(conversationId), queryFn: () => api("getConversation", { params: { conversationId } }) });
export const useConversationRequirements = (conversationId: string) => useQuery({ queryKey: keys.conversationRequirements(conversationId), queryFn: () => api("listConversationRequirements", { params: { conversationId } }) });
/** A Conversation's Runs, newest first. */
export const useConversationRuns = (conversationId: string) => usePage("listConversationRuns", keys.conversationRuns(conversationId), { params: { conversationId }, order: "desc" });
export const useRun = (runId: string) => useQuery({ queryKey: keys.run(runId), queryFn: () => api("getRun", { params: { runId } }) });
export const useRunPlan = (runId: string) => useQuery({ queryKey: keys.runPart(runId, "plan"), queryFn: () => api("getRunPlan", { params: { runId } }) });
export const useRunTasks = (runId: string) => usePage("listRunTasks", keys.runPart(runId, "tasks"), { params: { runId } });
/** The Run's Decisions of one status (the open ones are always the first page), or every Decision newest first. */
export const useRunDecisions = (runId: string, status?: "open" | "resolved" | "superseded") => usePage("listRunDecisions", keys.runPart(runId, "decisions"), { params: { runId }, query: status === undefined ? {} : { status }, order: status === "open" ? "asc" : "desc" });
export const useRunProposals = (runId: string) => usePage("listRunRequirementProposals", keys.runPart(runId, "proposals"), { params: { runId }, order: "desc" });
export const useRunBudget = (runId: string) => useQuery({ queryKey: keys.runPart(runId, "budget"), queryFn: () => api("getRunBudget", { params: { runId } }) });
export const useRunUsage = (runId: string) => useQuery({ queryKey: keys.runPart(runId, "usage"), queryFn: () => api("getRunUsage", { params: { runId } }) });
export const useRunGates = (runId: string) => usePage("listRunGates", keys.runPart(runId, "gates"), { params: { runId }, order: "desc" });
export const useRunEvaluations = (runId: string) => usePage("listRunEvaluations", keys.runPart(runId, "evaluations"), { params: { runId }, order: "desc" });
export const useRunChangesets = (runId: string) => usePage("listRunChangesets", keys.runPart(runId, "changesets"), { params: { runId }, order: "desc" });
export const useRunArtifacts = (runId: string) => usePage("listRunArtifacts", keys.runPart(runId, "artifacts"), { params: { runId }, order: "desc" });
export const useRunInvocations = (runId: string, planNodeId?: string) => usePage("listRunInvocations", keys.runPart(runId, "invocations"), { params: { runId }, query: planNodeId === undefined ? {} : { planNodeId }, order: "desc" });
export const useRunSignoff = (runId: string) => useQuery({ queryKey: keys.runPart(runId, "signoff"), queryFn: () => api("getRunSignoff", { params: { runId } }) });
export const useRunPublications = (runId: string) => useQuery({ queryKey: keys.runPart(runId, "publications"), queryFn: () => api("getRunPublications", { params: { runId } }) });
export const usePlanNode = (planNodeId: string) => useQuery({ queryKey: keys.planNode(planNodeId), queryFn: () => api("getPlanNode", { params: { planNodeId } }) });
export const useInvocation = (invocationId: string | null) => useQuery({ queryKey: keys.invocation(invocationId ?? ""), queryFn: () => api("getInvocation", { params: { invocationId: invocationId! } }), enabled: invocationId !== null });
export const useAttempt = (attemptId: string | null) => useQuery({ queryKey: keys.attempt(attemptId ?? ""), queryFn: () => api("getAttempt", { params: { attemptId: attemptId! } }), enabled: attemptId !== null });
export const useArtifact = (artifactId: string | null) => useQuery({ queryKey: keys.artifact(artifactId ?? ""), queryFn: () => api("getArtifact", { params: { artifactId: artifactId! } }), enabled: artifactId !== null });
export const useArtifactText = (artifactId: string | null, maxBytes = 262_144) =>
  useQuery({ queryKey: keys.artifactText(artifactId ?? ""), queryFn: () => apiText(apiPath("getArtifactContent", { artifactId: artifactId! }), { maxBytes }), enabled: artifactId !== null });
export const useTranscript = (attemptId: string | null, maxBytes = 262_144) =>
  useQuery({ queryKey: keys.transcript(attemptId ?? ""), queryFn: () => apiText(apiPath("getAttemptTranscript", { attemptId: attemptId! }), { maxBytes }), enabled: attemptId !== null });
export const useFsRoots = () => useQuery({ queryKey: keys.fsRoots, queryFn: () => api("fsRoots"), staleTime: Infinity });
export const useFsDirs = (path: string | null, showHidden: boolean) => useQuery({ queryKey: keys.fsDirs(path ?? "", showHidden), queryFn: () => api("fsDirs", { query: { path: path!, showHidden: showHidden ? "1" : "0" } }), enabled: path !== null });
