/**
 * The agent-session fold: raw ConsoleEvent envelopes → renderable items.
 * Pinned by the golden suite in agent-fold.test.ts — if either side changes
 * shape, those cases must be re-checked against the server's emission.
 *
 * THE load-bearing rule (the one-chat-lane rule): chat rows come ONLY from
 * persisted `agent_session.message` events. Stream deltas are overlays owned
 * by the stream kit, retired by that speaker's persisted message; they never
 * fold. The plan arrives as a kind:'plan' message, so `plan.captured` folds
 * to nothing; `status` is a card concern (the strip), not a transcript row.
 *
 * Pure and idempotent: same array in, same items out — duplicate events (a
 * hydration/live race the stream kit normally dedupes) are also deduped here
 * by event id, so double delivery can never double-render.
 */
import {
  eventId,
  type ConsoleEvent,
  type MessageKind,
  type SessionPhase,
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
  readonly participant: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly isError?: boolean;
}
export interface RoutedItem {
  readonly type: "routed";
  readonly messageSeq: number;
  readonly decisions: readonly { recipient: string; reason: string }[];
  readonly hopCount: number;
}
export interface AgentTurnItem {
  readonly type: "turn";
  readonly turnId: string;
  readonly participant: string;
}
export interface AgentTurnErrorItem {
  readonly type: "turn_error";
  readonly turnId: string;
  readonly participant: string;
  readonly errorMessage: string;
}
export interface PhaseItem {
  readonly type: "phase";
  readonly seq: number;
  readonly phase: SessionPhase;
}
export interface AgentTraceItem {
  readonly type: "trace";
  readonly uid: string;
  readonly participant: string;
  readonly label: string;
  readonly detail: string;
  readonly tone?: "error" | "muted";
}

export type AgentItem =
  | AgentMessageItem
  | AgentToolItem
  | RoutedItem
  | AgentTurnItem
  | AgentTurnErrorItem
  | PhaseItem
  | AgentTraceItem;

/** Stable render identity — every id is unique within its type's namespace. */
export function agentItemKey(item: AgentItem): string {
  switch (item.type) {
    case "message":
      return `message:${item.seq}`;
    case "tool":
      return `tool:${item.uid}`;
    case "routed":
      return `routed:${item.messageSeq}`;
    case "turn":
      return `turn:${item.turnId}`;
    case "turn_error":
      return `turn_error:${item.turnId}`;
    case "phase":
      return `phase:${item.seq}`;
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
      case "agent_session.message": {
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

      case "agent_session.tool.call": {
        const { callId } = event.payload;
        const occurrence = (toolCounts.get(callId) ?? 0) + 1;
        toolCounts.set(callId, occurrence);
        toolIndex.set(callId, items.length);
        items.push({
          type: "tool",
          uid: occurrence === 1 ? callId : `${callId}#${occurrence}`,
          callId: event.payload.callId,
          name: event.payload.name,
          participant: event.payload.participant,
          input: event.payload.input,
        });
        break;
      }

      // Results pair with their call by EXACT callId. An orphan result (its
      // call fell outside the record) has no card to complete — dropped.
      case "agent_session.tool.result": {
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

      case "agent_session.routed":
        items.push({
          type: "routed",
          messageSeq: event.payload.messageSeq,
          decisions: event.payload.decisions,
          hopCount: event.payload.hopCount,
        });
        break;

      case "agent_session.turn.started":
        items.push({
          type: "turn",
          turnId: event.payload.turnId,
          participant: event.payload.participant,
        });
        break;

      // Success settles are silent (the reply already speaks); failures get a row.
      case "agent_session.turn.settled": {
        if (event.payload.status === "completed") break;
        items.push({
          type: "turn_error",
          turnId: event.payload.turnId,
          participant: event.payload.participant,
          errorMessage:
            event.payload.errorMessage ??
            (event.payload.status === "aborted"
              ? "turn interrupted"
              : "turn failed"),
        });
        break;
      }

      case "agent_session.phase":
        items.push({
          type: "phase",
          seq: event.seq ?? 0,
          phase: event.payload.phase,
        });
        break;

      case "agent_session.mailbox":
        items.push({ type: "trace", uid: `mailbox:${event.seq ?? event.payload.deliveryId}:${event.payload.status}`,
          participant: event.payload.sender, label: `mailbox ${event.payload.status}`,
          detail: `${event.payload.sender} → ${event.payload.recipient} · ${event.payload.category}` });
        break;

      case "agent_session.runtime":
        items.push({ type: "trace", uid: `runtime:${event.seq ?? event.payload.turnId ?? "unknown"}`,
          participant: event.payload.participant, label: "runtime", detail: event.payload.detail,
          ...(event.payload.detail.includes("failure") ? { tone: "error" as const } : { tone: "muted" as const }) });
        break;

      case "agent_session.context.rotated":
        items.push({ type: "trace", uid: `context:${event.seq ?? event.payload.generation}`, participant: event.payload.participant,
          label: "context rotated", detail: `generation ${event.payload.generation} · ${event.payload.reason} · ${event.payload.memoryChars} memory chars` });
        break;

      case "agent_session.process.started":
        items.push({ type: "trace", uid: `process-start:${event.payload.processId}`, participant: event.payload.participant,
          label: "process started", detail: `${event.payload.command} ${event.payload.args.join(" ")} · pid ${event.payload.pid ?? "?"}` });
        break;

      case "agent_session.process.output":
        items.push({ type: "trace", uid: `process-output:${event.payload.processId}:${event.payload.seq}`, participant: event.payload.participant,
          label: `${event.payload.stream} · ${event.payload.processId}`, detail: event.payload.text,
          ...(event.payload.stream === "stderr" ? { tone: "error" as const } : { tone: "muted" as const }) });
        break;

      case "agent_session.process.exited":
        items.push({ type: "trace", uid: `process-exit:${event.payload.processId}`, participant: event.payload.participant,
          label: "process exited", detail: `code ${event.payload.code ?? "null"}${event.payload.signal ? ` · ${event.payload.signal}` : ""}`,
          ...(event.payload.code && event.payload.code !== 0 ? { tone: "error" as const } : {}) });
        break;

      case "usage.recorded":
        items.push({ type: "trace", uid: `usage:${event.seq ?? event.payload.turnId}`, participant: event.payload.participant,
          label: "usage", detail: `${event.payload.inputTokens.toLocaleString()} input · ${event.payload.outputTokens.toLocaleString()} output${event.payload.costUsd === undefined ? "" : ` · $${event.payload.costUsd.toFixed(4)}`} · generation ${event.payload.generation}` });
        break;

      // Everything else folds to nothing: created (the strip reads the row
      // from REST), status (a card concern), plan.captured (the plan arrives
      // as the kind:'plan' message), other topics, transients (overlays own
      // them).
      default:
        break;
    }
  }
  return items;
}
