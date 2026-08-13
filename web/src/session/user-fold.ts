/**
 * The user-session fold: raw ConsoleEvent envelopes → renderable items.
 * Pinned by the golden suite in user-fold.test.ts — if either side changes
 * shape, those cases must be re-checked against the server's emission.
 *
 * THE load-bearing rule (the one-chat-lane rule): chat rows come ONLY from
 * persisted `user_session.message.appended` events. Stream deltas are overlays owned by
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
  type HandoffSummary,
  type RunSummaryStats,
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
  /** Render identity: callId, suffixed on repeated callIds (retried turns). */
  readonly uid: string;
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
  /** The asking agent; absent = the main lane. */
  readonly askedBy?: string;
  /** The card accepts a typed answer alongside (or instead of) the options. */
  readonly allowFreeText?: boolean;
  readonly answer?: {
    readonly answers?: Record<string, string[]>;
    readonly freeText?: Record<string, string>;
    readonly dismissed?: boolean;
  };
}
export interface PlanItem {
  readonly type: "plan";
  readonly interactionId: string;
  readonly plan: string;
  /** Present when the card proposes a SPEC revision rather than a plan. */
  readonly spec?: { readonly revision: number };
  readonly resolution?: {
    readonly approved: boolean;
    readonly note?: string;
  };
}
/**
 * The Console's end-of-run report, awaiting the operator's verdict.
 *
 * Carries the bounded projection from the event so the collapsed card needs no
 * fetch; the expanded view pulls the full document.
 */
export interface RunSummaryItem {
  readonly type: "run_summary";
  readonly runId: string;
  readonly summaryId: string;
  /** The SHARED projection — the same type the event payload extends. */
  readonly stats: RunSummaryStats;
  readonly resolution?: {
    readonly decision: "accept" | "changes";
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
export interface RuntimeItem { readonly type: "runtime"; readonly uid: string; readonly label: string; readonly detail: string; }
export interface HandoffItem { readonly type: "handoff"; readonly handoff: HandoffSummary; readonly sender: string; readonly recipient: string; }

export type UserItem =
  | MessageItem
  | ToolItem
  | QuestionItem
  | PlanItem
  | RunSummaryItem
  | TurnItem
  | TurnErrorItem
  | RuntimeItem
  | HandoffItem;

/** Stable render identity — every id is unique within its type's namespace. */
export function itemKey(item: UserItem): string {
  switch (item.type) {
    case "message":
      return `message:${item.seq}`;
    case "tool":
      return `tool:${item.uid}`;
    case "question":
      return `question:${item.interactionId}`;
    case "plan":
      return `plan:${item.interactionId}`;
    case "run_summary":
      return `run_summary:${item.runId}`;
    case "turn":
      return `turn:${item.turnId}`;
    case "turn_error":
      return `turn_error:${item.turnId}`;
    case "runtime":
      return `runtime:${item.uid}`;
    case "handoff":
      return `handoff:${item.handoff.id}`;
  }
}

export function foldUserItems(events: readonly ConsoleEvent[]): UserItem[] {
  const items: UserItem[] = [];
  const seen = new Set<string>();
  const toolIndex = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const questionIndex = new Map<string, number>();
  const planIndex = new Map<string, number>();
  const runSummaryIndex = new Map<string, number>();

  for (const event of events) {
    const id = eventId(event);
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    switch (event.type) {
      case "user_session.message.appended": {
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

      case "user_session.tool.called": {
        const { callId } = event.payload;
        const occurrence = (toolCounts.get(callId) ?? 0) + 1;
        toolCounts.set(callId, occurrence);
        toolIndex.set(callId, items.length);
        items.push({
          type: "tool",
          uid: occurrence === 1 ? callId : `${callId}#${occurrence}`,
          callId: event.payload.callId,
          name: event.payload.name,
          input: event.payload.input,
        });
        break;
      }

      // Results pair with their call by EXACT callId. An orphan result (its
      // call fell outside the record) has no card to complete — dropped.
      case "user_session.tool.completed": {
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
          ...(event.payload.agent === undefined ? {} : { askedBy: event.payload.agent }),
          ...(event.payload.allowFreeText === true ? { allowFreeText: true } : {}),
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
            ...(event.payload.freeText === undefined
              ? {}
              : { freeText: event.payload.freeText }),
            ...(event.payload.dismissed === true ? { dismissed: true } : {}),
          },
        };
        break;
      }

      case "run.completion.proposed": {
        runSummaryIndex.set(event.payload.runId, items.length);
        // The payload IS `{ sessionId, runId, summaryId } & RunSummaryStats`,
        // so the rest-spread is exactly the shared projection.
        const { userSessionId: _userSessionId, runId, summaryId, ...stats } = event.payload;
        items.push({ type: "run_summary", runId, summaryId, stats });
        break;
      }

      case "run.signoff.resolved": {
        const index = runSummaryIndex.get(event.payload.runId);
        if (index === undefined) break;
        const summary = items[index];
        if (summary?.type !== "run_summary") break;
        items[index] = {
          ...summary,
          resolution: {
            decision: event.payload.decision,
            ...(event.payload.note === undefined ? {} : { note: event.payload.note }),
          },
        };
        break;
      }

      // `run.reopened` deliberately does NOT clear the resolved card. It stays
      // in the transcript as a record of what was proposed and what the
      // operator said; the next proposal pushes a NEW card below it.

      case "user_session.plan.proposed": {
        planIndex.set(event.payload.interactionId, items.length);
        items.push({
          type: "plan",
          interactionId: event.payload.interactionId,
          plan: event.payload.plan,
          ...(event.payload.spec === undefined ? {} : { spec: event.payload.spec }),
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

      case "user_session.runtime.noted":
        items.push({ type: "runtime", uid: `runtime:${event.seq ?? items.length}`, label: "runtime", detail: event.payload.detail });
        break;

      case "user_session.context.rotated":
        items.push({ type: "runtime", uid: `context:${event.seq ?? event.payload.generation}`, label: "context rotated", detail: `generation ${event.payload.generation} · ${event.payload.reason}` });
        break;

      case "usage.recorded":
        if (event.agentSessionId !== undefined) break;
        items.push({ type: "runtime", uid: `usage:${event.seq ?? event.payload.turnId}`, label: "usage",
          detail: `${event.payload.inputTokens.toLocaleString()} input · ${event.payload.outputTokens.toLocaleString()} output${event.payload.costUsd === undefined ? "" : ` · $${event.payload.costUsd.toFixed(4)}`} · generation ${event.payload.generation}` });
        break;

      case "handoff.created":
        if (event.agentSessionId === undefined || event.payload.recipient !== "main") break;
        items.push({ type: "handoff", handoff: event.payload.handoff, sender: event.payload.sender, recipient: event.payload.recipient });
        break;

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
 * What the session is actually doing. `busy` alone is not enough:
 * `AskUserQuestion` parks its turn, and "waiting on you" must not render as
 * the same pixels as "working". `blocked` separates the case the operator can
 * act on.
 */
export interface SessionPosture {
  /** A turn is genuinely running. */
  readonly busy: boolean;
  /** A turn is parked on a card only the operator can resolve. */
  readonly blocked: boolean;
  /** The most recent settled turn errored — feeds the `blocked` session state. */
  readonly lastTurnErrored: boolean;
}

export function foldPosture(events: readonly ConsoleEvent[]): SessionPosture {
  const seen = new Set<string>();
  const open = new Set<string>();
  const pending = new Set<string>();
  let queuedJobs = 0;
  let lastTurnErrored = false;
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
      lastTurnErrored = (event.payload as { status?: string }).status === "error";
    } else if (event.type === "user_session.question.asked") {
      // Only MAIN-LANE cards park the lane this posture describes. An agent's
      // card (agent set) parks that agent's turn — main keeps running,
      // and stopping the spinner for it would misreport a live lane as idle.
      if (event.payload.agent === undefined) pending.add(event.payload.interactionId);
    } else if (event.type === "user_session.plan.proposed") {
      pending.add(event.payload.interactionId);
    } else if (event.type === "user_session.question.answered" || event.type === "user_session.plan.resolved") {
      pending.delete(event.payload.interactionId);
    }
  }
  const blocked = pending.size > 0;
  // A turn parked on a card is NOT busy.
  return { busy: !blocked && (open.size > 0 || queuedJobs > 0), blocked, lastTurnErrored };
}

export function foldBusy(events: readonly ConsoleEvent[]): boolean {
  return foldPosture(events).busy;
}
