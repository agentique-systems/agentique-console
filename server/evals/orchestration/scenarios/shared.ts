/** Shared builders for scenario programs: handoff drafts and main-lane tool calls. */
import { toolUseMessage } from "../../../src/sdk/fake.ts";

export type DraftStatus = "pending" | "in_progress" | "blocked" | "needs_verification" | "completed" | "failed";

/** A minimal valid HandoffDraft (the shape briefings and send_to_coordinator carry). */
export function draft(action: string, status: DraftStatus = "pending") {
  return {
    core: {
      schemaVersion: 1 as const,
      taskId: null,
      status,
      risk: "low" as const,
      action,
      state: { summary: action, evidence: [] },
      result: { summary: status === "completed" ? action : null, artifacts: [] },
      uncertainty: [],
      nextAction: status === "completed" ? null : action,
      requestExpandedContext: false,
    },
    extension: { kind: "generic" as const, data: {} },
  };
}

/** Main calls mcp__console__create_agent_session (the fake runs the real handler). */
export function createSessionUse(
  callId: string,
  input: {
    title: string;
    pattern?: string;
    agents: { name: string; profileId: string; instructions?: string; owns?: string[] }[];
    briefingAction: string;
  },
) {
  return toolUseMessage(callId, "mcp__console__create_agent_session", {
    title: input.title,
    pattern: input.pattern ?? "hub_and_spoke",
    agents: input.agents.map((agent) => ({ owns: [], ...agent })),
    briefing: draft(input.briefingAction),
  });
}

/** Main steers a session via mcp__console__send_to_coordinator. */
export function steerUse(
  callId: string,
  input: { agentSessionId: string; category?: "assignment" | "update"; action: string },
) {
  return toolUseMessage(callId, "mcp__console__send_to_coordinator", {
    agentSessionId: input.agentSessionId,
    category: input.category ?? "update",
    status: "in_progress",
    risk: "medium",
    action: input.action,
    stateSummary: input.action,
    evidence: [],
    resultSummary: null,
    artifacts: [],
    uncertainty: [],
    nextAction: null,
    taskId: null,
    requestExpandedContext: false,
  });
}
