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
import type { RequirementService } from "./requirements.ts";
import type { SpecService } from "./spec.ts";

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
  /** Legacy fallback: a plan that is not a requirement outline records here. */
  specs: SpecService;
  /** The approved plan records as the run's first REQUIREMENT revision when it parses. */
  requirements: RequirementService;
}

type CanUseTool = NonNullable<SdkOptions["canUseTool"]>;

export function buildOrchestratorCanUseTool(input: CanUseToolInput): CanUseTool {
  const { userSessionId, repo, bus, interactions, laneState, specs, requirements } = input;

  const deny = (
    toolName: string,
    kind: "coordination_only" | "empty_question" | "question_declined" | "plan_missing" | "plan_rejected",
    message: string,
  ): { behavior: "deny"; message: string } => {
    bus.append({ type: "tool.denied", userSessionId,
      payload: { userSessionId, toolName, kind, reason: message.slice(0, 500) } });
    return { behavior: "deny", message };
  };

  return (async (
    toolName: string,
    toolInput: Record<string, unknown>,
    context?: { signal?: AbortSignal; suggestions?: unknown; agentID?: string },
  ) => {
    if (["Agent", "Task"].includes(toolName)) {
      return deny(toolName, "coordination_only", "Main never forks in-process subagents — they run ungoverned context. Delegate execution to profile-bound Console AgentSessions.");
    }
    // Native SendMessage never reaches this callback — its PreToolUse
    // middleware decides allow/deny; task and cron tools run and are
    // mirrored by PostToolUse hooks.
    if (toolName.startsWith("mcp__console__")) {
      return { behavior: "allow" as const, updatedInput: toolInput };
    }

    if (toolName === "AskUserQuestion") {
      const questions = (toolInput.questions ?? []) as InteractionQuestion[];
      if (questions.length === 0) {
        return deny(toolName, "empty_question", "AskUserQuestion requires at least one question.");
      }
      const { resolution } = interactions.createQuestion(
        userSessionId,
        questions,
        undefined,
        context?.signal,
      );
      const resolved = await resolution;
      if (resolved.kind === "answers") {
        // Merge picked labels with per-question FREE TEXT — a typed answer is
        // the operator's own words and outranks the offered options. The old
        // mapping read only `answers`, so a freeText-only reply came back as
        // an empty result.
        const merged = Object.fromEntries(
          questions
            .map((question) => {
              const labels = resolved.answers[question.question] ?? [];
              const typed = resolved.freeText?.[question.question]?.trim() ?? "";
              return [question.question, [...labels, ...(typed === "" ? [] : [typed])].join(", ")] as const;
            })
            .filter(([, value]) => value !== ""),
        );
        const note = resolved.note?.trim() ?? "";
        return {
          behavior: "allow" as const,
          updatedInput: {
            ...toolInput,
            answers: note === "" ? merged : { ...merged, "operator note": note },
          },
        };
      }
      const reason =
        resolved.kind === "dismissed"
          ? resolved.reason
          : "The operator declined.";
      return deny(toolName, "question_declined", reason);
    }

    if (toolName === "ExitPlanMode") {
      const plan =
        typeof toolInput.plan === "string" && toolInput.plan.length > 0
          ? toolInput.plan
          : laneState.lastAssistantText;
      if (plan === "") {
        return deny(toolName, "plan_missing",
          "No plan text was captured — write the plan out, then call ExitPlanMode again.");
      }
      const { id: approvalId, resolution } = interactions.createPlanApproval(
        userSessionId,
        plan,
        undefined,
        context?.signal,
      );
      const resolved = await resolution;
      if (resolved.kind === "decision" && resolved.approved) {
        // The planning phase's deliverable IS the specification: when the
        // approved (possibly operator-edited) plan parses as a requirement
        // outline it becomes the run's first requirement revision; otherwise
        // it records as a legacy spec (compat soft-fail) — plan approval must
        // never fail on the recording.
        try {
          const finalText = resolved.editedDocument?.trim() || plan;
          const edited = resolved.editedDocument !== undefined && resolved.editedDocument.trim() !== plan.trim();
          if (requirements.validateDocument(userSessionId, finalText).ok) {
            const draft = requirements.propose(userSessionId, finalText, "approved via ExitPlanMode");
            requirements.approve(draft.id, { document: finalText, interactionId: approvalId, edited });
          } else {
            const draft = specs.propose(userSessionId, finalText, "approved via ExitPlanMode");
            specs.approve(draft.id, { document: finalText, interactionId: approvalId, edited });
          }
        } catch { /* best effort — plan approval itself must not fail on spec recording */ }
        repo.patchUserSession(userSessionId, { phase: "executing" });
        bus.append({
          type: "user_session.updated",
          userSessionId,
          payload: {
            userSessionId,
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
      return deny(toolName, "plan_rejected", note);
    }

    // Everything else runs. Delegation is a matter of judgement (the brief),
    // not of capability — a blanket denial would leave the Orchestrator unable
    // even to fetch a page to answer its own agents.
    return { behavior: "allow" as const, updatedInput: toolInput };
  }) as CanUseTool;
}
