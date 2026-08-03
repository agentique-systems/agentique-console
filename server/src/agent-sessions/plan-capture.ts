/**
 * Per-seat canUseTool for specialist turns. Only consulted in planning-phase
 * turns (executing-phase turns run bypassPermissions, which skips it): the
 * seat's ExitPlanMode becomes a kind:'plan' message routed to the orchestrator
 * plus an agent_session.plan.captured event, then a deny that ends the turn —
 * the normal wake path carries the plan to the Orchestrator, who judges it (or
 * relays it to the operator) and calls approve_agent_plan.
 */
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import type { SdkOptions } from "../sdk/types.ts";
import type { AgentSessionHost } from "./host.ts";
import { ORCHESTRATOR_SEAT } from "./routing.ts";

export function buildSeatPlanCapture(deps: {
  host: () => AgentSessionHost;
  repo: Repo;
  bus: EventBus;
}) {
  return (seat: {
    agentSessionId: string;
    participant: string;
    lastText: () => string;
  }): SdkOptions["canUseTool"] =>
    (async (toolName: string, toolInput: Record<string, unknown>) => {
      if (toolName === "ExitPlanMode") {
        const session = deps.repo.getAgentSession(seat.agentSessionId);
        const plan =
          typeof toolInput.plan === "string" && toolInput.plan.length > 0
            ? toolInput.plan
            : seat.lastText();
        if (session && plan !== "") {
          deps.host().post({
            agentSessionId: seat.agentSessionId,
            speaker: { kind: "agent", name: seat.participant },
            to: ORCHESTRATOR_SEAT,
            text: plan,
            kind: "plan",
          });
          deps.bus.append({
            type: "agent_session.plan.captured",
            userSessionId: session.userSessionId,
            agentSessionId: seat.agentSessionId,
            payload: {
              agentSessionId: seat.agentSessionId,
              participant: seat.participant,
              plan,
            },
          });
          return {
            behavior: "deny" as const,
            message:
              "Plan recorded and forwarded for approval — end your turn; you will be woken with the decision.",
          };
        }
        return {
          behavior: "deny" as const,
          message:
            "No plan text was captured — write the plan out, then call ExitPlanMode again.",
        };
      }
      return {
        behavior: "deny" as const,
        message:
          "This session is in its planning phase — present a plan with ExitPlanMode first.",
      };
    }) as SdkOptions["canUseTool"];
}
