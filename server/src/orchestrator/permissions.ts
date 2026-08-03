/**
 * The orchestrator's canUseTool bridge. Console MCP tools auto-allow;
 * AskUserQuestion becomes an operator question card; ExitPlanMode becomes a
 * plan-approval card (approve flips the session phase to executing);
 * anything else is a delegation-first denial (D4 — no generic approval card,
 * the requirements ban an inbox).
 */
import type { InteractionQuestion } from "@agentique-console/shared";
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import type { SdkOptions } from "../sdk/types.ts";
import type { InteractionService } from "./interactions.ts";

export interface TurnState {
  lastAssistantText: string;
}

export interface CanUseToolInput {
  userSessionId: string;
  repo: Repo;
  bus: EventBus;
  interactions: InteractionService;
  turnState: TurnState;
}

type CanUseTool = NonNullable<SdkOptions["canUseTool"]>;

export function buildOrchestratorCanUseTool(input: CanUseToolInput): CanUseTool {
  const { userSessionId, repo, bus, interactions, turnState } = input;

  return (async (
    toolName: string,
    toolInput: Record<string, unknown>,
    context?: { signal?: AbortSignal; suggestions?: unknown },
  ) => {
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
          : turnState.lastAssistantText;
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

    return {
      behavior: "deny" as const,
      message:
        "Not permitted for the Orchestrator — delegate this to an agent session.",
    };
  }) as CanUseTool;
}
