/**
 * The agent-session fold: raw ConsoleEvent envelopes → renderable items.
 * Pinned by the golden suite in agent-fold.test.ts — if either side changes
 * shape, those cases must be re-checked against the server's emission.
 *
 * THE load-bearing rule (the one-chat-lane rule): chat rows come ONLY from
 * persisted `agent_session.message.appended` events. Stream deltas are overlays owned
 * by the stream kit, retired by that speaker's persisted message; they never
 * fold. The plan arrives as a kind:'plan' message; `status` is a card
 * concern (the strip), not a transcript row.
 *
 * Pure and idempotent: same array in, same items out — duplicate events (a
 * hydration/live race the stream kit normally dedupes) are also deduped here
 * by event id, so double delivery can never double-render.
 */
import {
  eventId,
  type ConsoleEvent,
  type MessageKind,
  type Speaker,
  type HandoffSummary,
} from "@agentique-console/shared";

export interface AgentMessageItem {
  readonly type: "message";
  readonly seq: number;
  readonly speaker: Speaker;
  readonly to?: string;
  readonly kind: MessageKind;
  readonly text: string;
  readonly createdAt: string;
  readonly handoff?: HandoffSummary;
}
export interface AgentToolItem {
  readonly type: "tool";
  /** Render identity: callId, suffixed on repeated callIds (retried turns). */
  readonly uid: string;
  readonly callId: string;
  readonly name: string;
  readonly agent: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly isError?: boolean;
}
export interface AgentTurnItem {
  readonly type: "turn";
  readonly turnId: string;
  readonly agent: string;
}
export interface AgentTurnErrorItem {
  readonly type: "turn_error";
  readonly turnId: string;
  readonly agent: string;
  readonly errorMessage: string;
}
export interface AgentTraceItem {
  readonly type: "trace";
  readonly uid: string;
  readonly agent: string;
  readonly label: string;
  readonly detail: string;
  readonly tone?: "error" | "muted";
}

export type AgentItem =
  | AgentMessageItem
  | AgentToolItem
  | AgentTurnItem
  | AgentTurnErrorItem
  | AgentTraceItem;

/** Stable render identity — every id is unique within its type's namespace. */
export function agentItemKey(item: AgentItem): string {
  switch (item.type) {
    case "message":
      return `message:${item.seq}`;
    case "tool":
      return `tool:${item.uid}`;
    case "turn":
      return `turn:${item.turnId}`;
    case "turn_error":
      return `turn_error:${item.turnId}`;
    case "trace":
      return `trace:${item.uid}`;
  }
}

export function foldAgentItems(events: readonly ConsoleEvent[]): AgentItem[] {
  const items: AgentItem[] = [];
  const seen = new Set<string>();
  const toolIndex = new Map<string, number>();
  const toolCounts = new Map<string, number>();

  for (const event of events) {
    const id = eventId(event);
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    switch (event.type) {
      case "agent_session.message.appended": {
        const { message } = event.payload;
        items.push({
          type: "message",
          seq: message.seq,
          speaker: message.speaker,
          ...(message.to === undefined ? {} : { to: message.to }),
          kind: message.kind,
          text: message.text,
          createdAt: message.createdAt,
          ...(message.handoff === undefined ? {} : { handoff: message.handoff }),
        });
        break;
      }

      case "agent_session.tool.called": {
        const { callId } = event.payload;
        const occurrence = (toolCounts.get(callId) ?? 0) + 1;
        toolCounts.set(callId, occurrence);
        toolIndex.set(callId, items.length);
        items.push({
          type: "tool",
          uid: occurrence === 1 ? callId : `${callId}#${occurrence}`,
          callId: event.payload.callId,
          name: event.payload.name,
          agent: event.payload.agent,
          input: event.payload.input,
        });
        break;
      }

      // Results pair with their call by EXACT callId. An orphan result (its
      // call fell outside the record) has no card to complete — dropped.
      case "agent_session.tool.completed": {
        const index = toolIndex.get(event.payload.callId);
        if (index === undefined) break;
        const call = items[index];
        if (call?.type !== "tool") break;
        items[index] = {
          ...call,
          output: event.payload.output,
          ...(event.payload.isError === true ? { isError: true } : {}),
        };
        break;
      }

      case "agent_session.turn.started":
        items.push({
          type: "turn",
          turnId: event.payload.turnId,
          agent: event.payload.agent,
        });
        break;

      // Success settles are silent (the reply already speaks); failures get a row.
      case "agent_session.turn.settled": {
        if (event.payload.status === "completed") break;
        items.push({
          type: "turn_error",
          turnId: event.payload.turnId,
          agent: event.payload.agent,
          errorMessage:
            event.payload.errorMessage ??
            (event.payload.status === "aborted"
              ? "turn interrupted"
              : "turn failed"),
        });
        break;
      }

      case "agent_session.delivery.updated":
        items.push({ type: "trace", uid: `mailbox:${event.seq ?? event.payload.deliveryId}:${event.payload.status}`,
          agent: event.payload.sender, label: `mailbox ${event.payload.status}`,
          detail: `${event.payload.sender} → ${event.payload.recipient} · ${event.payload.category}` });
        break;

      case "agent_session.runtime.noted":
        items.push({ type: "trace", uid: `runtime:${event.seq ?? event.payload.turnId ?? "unknown"}`,
          agent: event.payload.agent, label: "runtime", detail: event.payload.detail,
          ...(event.payload.detail.includes("failure") ? { tone: "error" as const } : { tone: "muted" as const }) });
        break;

      case "agent_session.context.rotated":
        items.push({ type: "trace", uid: `context:${event.seq ?? event.payload.generation}`, agent: event.payload.agent,
          label: "context rotated", detail: `generation ${event.payload.generation} · ${event.payload.reason}` });
        break;

      case "usage.recorded":
        items.push({ type: "trace", uid: `usage:${event.seq ?? event.payload.turnId}`, agent: event.payload.agent,
          label: "usage", detail: `${event.payload.inputTokens.toLocaleString()} input · ${event.payload.outputTokens.toLocaleString()} output${event.payload.costUsd === undefined ? "" : ` · $${event.payload.costUsd.toFixed(4)}`} · generation ${event.payload.generation}` });
        break;

      // Everything else folds to nothing: created (the strip reads the row
      // from REST), status (a card concern), other topics, transients
      // (overlays own them).
      default:
        break;
    }
  }
  return items;
}
