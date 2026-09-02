/**
 * Query keys, by scope: the live subscription invalidates by Workspace,
 * Conversation, and Run prefix, so every key of a scoped projection starts
 * with that scope's id.
 */
export const keys = {
  health: ["health"] as const,
  config: ["config"] as const,
  capacity: ["capacity"] as const,
  workspaces: ["workspaces"] as const,
  workspace: (workspaceId: string) => ["workspace", workspaceId] as const,
  workspaceConversations: (workspaceId: string) => ["workspace", workspaceId, "conversations"] as const,
  workspaceRuns: (workspaceId: string) => ["workspace", workspaceId, "runs"] as const,
  workspaceAgents: (workspaceId: string) => ["workspace", workspaceId, "agent-definitions"] as const,
  agentDefinition: (id: string) => ["agent-definition", id] as const,
  conversation: (conversationId: string) => ["conversation", conversationId] as const,
  conversationMessages: (conversationId: string) => ["conversation", conversationId, "messages"] as const,
  conversationRequirements: (conversationId: string) => ["conversation", conversationId, "requirements"] as const,
  conversationRuns: (conversationId: string) => ["conversation", conversationId, "runs"] as const,
  conversationDecisions: (conversationId: string) => ["conversation", conversationId, "decisions"] as const,
  run: (runId: string) => ["run", runId] as const,
  runPart: (runId: string, part: string) => ["run", runId, part] as const,
  planNode: (planNodeId: string) => ["plan-node", planNodeId] as const,
  invocation: (invocationId: string) => ["invocation", invocationId] as const,
  attempt: (attemptId: string) => ["attempt", attemptId] as const,
  artifact: (artifactId: string) => ["artifact", artifactId] as const,
  artifactText: (artifactId: string) => ["artifact", artifactId, "text"] as const,
  transcript: (attemptId: string) => ["attempt", attemptId, "transcript"] as const,
  fsRoots: ["fs", "roots"] as const,
  fsDirs: (path: string, hidden: boolean) => ["fs", "dirs", path, hidden] as const,
};
