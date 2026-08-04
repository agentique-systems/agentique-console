/**
 * The orchestrator's canUseTool bridge. Console MCP tools auto-allow;
 * AskUserQuestion becomes an operator question card; ExitPlanMode becomes a
 * plan-approval card (approve flips the session phase to executing);
 * anything else runs (no generic approval card — the requirements ban an
 * inbox, and a denial here is indistinguishable from a broken tool).
 */
import type { InteractionQuestion } from "@agentique-console/shared";
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import type { SdkOptions } from "../sdk/types.ts";
import type { InteractionService } from "./interactions.ts";

/**
 * Per-lane callback state. Lives as long as the persistent query; the runner
 * resets it at each turn start, preserving "plan falls back to the turn's
 * last assistant text" semantics across the lane's lifetime.
 */
export interface LaneState {
  lastAssistantText: string;
}

export interface CanUseToolInput {
  userSessionId: string;
  repo: Repo;
  bus: EventBus;
  interactions: InteractionService;
  laneState: LaneState;
}

type CanUseTool = NonNullable<SdkOptions["canUseTool"]>;

export function buildOrchestratorCanUseTool(input: CanUseToolInput): CanUseTool {
  const { userSessionId, repo, bus, interactions, laneState } = input;

  return (async (
    toolName: string,
    toolInput: Record<string, unknown>,
    context?: { signal?: AbortSignal; suggestions?: unknown; agentID?: string },
  ) => {
    if (["Agent", "Task", "SendMessage", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "Bash", "Write", "Edit", "NotebookEdit"].includes(toolName)) {
      return { behavior: "deny" as const, message: "Main is coordination-only. Use profile-bound Console AgentSessions so ownership, execution, messaging, and events remain durable and observable." };
    }
    if (toolName.startsWith("mcp__console__")) {
      return { behavior: "allow" as const, updatedInput: toolInput };
    }

    if (toolName === "AskUserQuestion") {
      const questions = (toolInput.questions ?? []) as InteractionQuestion[];
      if (questions.length === 0) {
        return {
          behavior: "deny" as const,
          message: "AskUserQuestion requires at least one question.",
        };
      }
      const { resolution } = interactions.createQuestion(
        userSessionId,
        questions,
        undefined,
        context?.signal,
      );
      const resolved = await resolution;
      if (resolved.kind === "answers") {
        return {
          behavior: "allow" as const,
          updatedInput: {
            ...toolInput,
            answers: Object.fromEntries(
              Object.entries(resolved.answers).map(([question, labels]) => [
                question,
                labels.join(", "),
              ]),
            ),
          },
        };
      }
      const reason =
        resolved.kind === "dismissed"
          ? resolved.reason
          : "The operator declined.";
      return { behavior: "deny" as const, message: reason };
    }

    if (toolName === "ExitPlanMode") {
      const plan =
        typeof toolInput.plan === "string" && toolInput.plan.length > 0
          ? toolInput.plan
          : laneState.lastAssistantText;
      if (plan === "") {
        return {
          behavior: "deny" as const,
          message:
            "No plan text was captured — write the plan out, then call ExitPlanMode again.",
        };
      }
      const { resolution } = interactions.createPlanApproval(
        userSessionId,
        plan,
        undefined,
        context?.signal,
      );
      const resolved = await resolution;
      if (resolved.kind === "decision" && resolved.approved) {
        repo.patchUserSession(userSessionId, { phase: "executing" });
        bus.append({
          type: "user_session.updated",
          userSessionId,
          payload: {
            sessionId: userSessionId,
            patch: { phase: "executing" },
          },
        });
        return { behavior: "allow" as const, updatedInput: toolInput };
      }
      const note =
        resolved.kind === "decision"
          ? (resolved.note ?? "Revise the plan.")
          : resolved.kind === "dismissed"
            ? resolved.reason
            : "Revise the plan.";
      return { behavior: "deny" as const, message: note };
    }

    // Everything else runs. Delegation is a matter of judgement (the brief),
    // not of capability: the previous blanket denial here meant the
    // Orchestrator could not even fetch a page to answer its own seats, and
    // reported to the operator that "web tools are blocked at my level".
    return { behavior: "allow" as const, updatedInput: toolInput };
  }) as CanUseTool;
}
