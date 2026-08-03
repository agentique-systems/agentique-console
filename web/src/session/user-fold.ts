/**
 * The user-session fold: raw ConsoleEvent envelopes → renderable items.
 * Pinned by the golden suite in user-fold.test.ts — if either side changes
 * shape, those cases must be re-checked against the server's emission.
 *
 * THE load-bearing rule (the one-chat-lane rule): chat rows come ONLY from
 * persisted `user_session.message` events. Stream deltas are overlays owned by
 * the stream kit, retired by that speaker's persisted message; they never fold.
 *
 * Pure and idempotent: same array in, same items out — duplicate events (a
 * hydration/live race the stream kit normally dedupes) are also deduped here
 * by event id, so double delivery can never double-render.
 */
import {
  eventId,
  type ConsoleEvent,
  type InteractionQuestion,
  type MessageKind,
  type Speaker,
  type TurnTrigger,
} from "@agentique-console/shared";

export interface MessageItem {
  readonly type: "message";
  readonly seq: number;
  readonly speaker: Speaker;
  readonly text: string;
  readonly kind: MessageKind;
  readonly createdAt: string;
}
export interface ToolItem {
  readonly type: "tool";
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly isError?: boolean;
}
export interface QuestionItem {
  readonly type: "question";
  readonly interactionId: string;
  readonly questions: readonly InteractionQuestion[];
  readonly answer?: {
    readonly answers?: Record<string, string[]>;
    readonly dismissed?: boolean;
  };
}
export interface PlanItem {
  readonly type: "plan";
  readonly interactionId: string;
  readonly plan: string;
  readonly resolution?: {
    readonly approved: boolean;
    readonly note?: string;
  };
}
export interface TurnItem {
  readonly type: "turn";
  readonly turnId: string;
  readonly trigger: TurnTrigger;
}
export interface TurnErrorItem {
  readonly type: "turn_error";
  readonly turnId: string;
  readonly errorMessage: string;
}

export type UserItem =
  | MessageItem
  | ToolItem
  | QuestionItem
  | PlanItem
  | TurnItem
  | TurnErrorItem;

/** Stable render identity — every id is unique within its type's namespace. */
export function itemKey(item: UserItem): string {
  switch (item.type) {
    case "message":
      return `message:${item.seq}`;
    case "tool":
      return `tool:${item.callId}`;
    case "question":
      return `question:${item.interactionId}`;
    case "plan":
      return `plan:${item.interactionId}`;
    case "turn":
      return `turn:${item.turnId}`;
    case "turn_error":
      return `turn_error:${item.turnId}`;
  }
}

export function foldUserItems(events: readonly ConsoleEvent[]): UserItem[] {
  const items: UserItem[] = [];
  const seen = new Set<string>();
  const toolIndex = new Map<string, number>();
  const questionIndex = new Map<string, number>();
  const planIndex = new Map<string, number>();

  for (const event of events) {
    const id = eventId(event);
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    switch (event.type) {
      case "user_session.message": {
        const { message } = event.payload;
        items.push({
          type: "message",
          seq: message.seq,
          speaker: message.speaker,
          text: message.text,
          kind: message.kind,
          createdAt: message.createdAt,
        });
        break;
      }

      case "user_session.tool.call": {
        toolIndex.set(event.payload.callId, items.length);
        items.push({
          type: "tool",
          callId: event.payload.callId,
          name: event.payload.name,
          input: event.payload.input,
        });
        break;
      }

      // Results pair with their call by EXACT callId. An orphan result (its
      // call fell outside the record) has no card to complete — dropped.
      case "user_session.tool.result": {
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

      case "user_session.question.asked": {
        questionIndex.set(event.payload.interactionId, items.length);
        items.push({
          type: "question",
          interactionId: event.payload.interactionId,
          questions: event.payload.questions,
        });
        break;
      }

      case "user_session.question.answered": {
        const index = questionIndex.get(event.payload.interactionId);
        if (index === undefined) break;
        const question = items[index];
        if (question?.type !== "question") break;
        items[index] = {
          ...question,
          answer: {
            ...(event.payload.answers === undefined
              ? {}
              : { answers: event.payload.answers }),
            ...(event.payload.dismissed === true ? { dismissed: true } : {}),
          },
        };
        break;
      }

      case "user_session.plan.proposed": {
        planIndex.set(event.payload.interactionId, items.length);
        items.push({
          type: "plan",
          interactionId: event.payload.interactionId,
          plan: event.payload.plan,
        });
        break;
      }

      case "user_session.plan.resolved": {
        const index = planIndex.get(event.payload.interactionId);
        if (index === undefined) break;
        const plan = items[index];
        if (plan?.type !== "plan") break;
        items[index] = {
          ...plan,
          resolution: {
            approved: event.payload.approved,
            ...(event.payload.note === undefined
              ? {}
              : { note: event.payload.note }),
          },
        };
        break;
      }

      case "user_session.turn.started":
        items.push({
          type: "turn",
          turnId: event.payload.turnId,
          trigger: event.payload.trigger,
        });
        break;

      // Success settles are silent (the reply already speaks); failures get a row.
      case "user_session.turn.settled": {
        if (event.payload.status === "completed") break;
        items.push({
          type: "turn_error",
          turnId: event.payload.turnId,
          errorMessage:
            event.payload.errorMessage ??
            (event.payload.status === "aborted"
              ? "turn interrupted"
              : "turn failed"),
        });
        break;
      }

      // Everything else — session lifecycle (created/updated: the header reads
      // those from REST), transients (overlays own them), other topics — folds
      // to nothing.
      default:
        break;
    }
  }
  return items;
}

/**
 * Busy = an unsettled turn is in flight, or the last settle left jobs queued.
 * Drives the header spinner + interrupt affordance.
 */
export function foldBusy(events: readonly ConsoleEvent[]): boolean {
  const seen = new Set<string>();
  const open = new Set<string>();
  let queuedJobs = 0;
  for (const event of events) {
    const id = eventId(event);
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    if (event.type === "user_session.turn.started") {
      open.add(event.payload.turnId);
    } else if (event.type === "user_session.turn.settled") {
      open.delete(event.payload.turnId);
      queuedJobs = event.payload.queuedJobs;
    }
  }
  return open.size > 0 || queuedJobs > 0;
}
