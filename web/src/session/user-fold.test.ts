import { describe, expect, it } from "vitest";

import type { ConsoleEvent } from "@agentique-console/shared";

import { foldBusy, foldPosture, foldUserItems } from "./user-fold";

let seq = 0;
function ev(
  type: string,
  payload: unknown,
  extra: Partial<ConsoleEvent> = {},
): ConsoleEvent {
  seq += 1;
  return {
    seq,
    ts: "2026-08-03T12:00:00.000Z",
    type,
    userSessionId: "us_1",
    payload,
    ...extra,
  } as ConsoleEvent;
}

/** Transient frames have no seq and carry the transient flag, like the wire. */
function transient(type: string, payload: unknown): ConsoleEvent {
  return {
    ts: "2026-08-03T12:00:00.000Z",
    type,
    transient: true,
    userSessionId: "us_1",
    payload,
  } as ConsoleEvent;
}

const OPERATOR = { kind: "operator", name: "operator" } as const;
const ORCHESTRATOR = { kind: "orchestrator", name: "orchestrator" } as const;

function message(
  text: string,
  speaker: typeof OPERATOR | typeof ORCHESTRATOR = OPERATOR,
  kind: "message" | "notice" | "plan" = "message",
): ConsoleEvent {
  return ev("user_session.message", {
    sessionId: "us_1",
    message: {
      seq: seq + 1,
      speaker,
      kind,
      text,
      createdAt: "2026-08-03T12:00:00.000Z",
    },
  });
}

/**
 * Golden suite for the user-session fold. The wire contract is the server's
 * OrchestratorRunner/InteractionService emission (frozen in shared/src/events.ts)
 * — if either side changes shape, these cases must be re-checked against it.
 */
describe("foldUserItems", () => {
  it("shows one compact card for an AgentSession handoff addressed to main", () => {
    const handoff = { id: "handoff_1", trigger: "final" as const, status: "completed" as const, risk: "low" as const,
      action: "Deliver result", stateSummary: "Work is complete", resultSummary: "Tests pass", nextAction: null,
      evidenceCount: 1, artifactCount: 0, extensionKind: "coordination" as const, overflow: false, referenceWarnings: [] };
    const items = foldUserItems([ev("handoff.created", { handoff, sender: "orchestrator", recipient: "main", checkpoint: false, bytes: 400, softTargetBytes: 4096 }, { agentSessionId: "as_1" })]);
    expect(items).toEqual([{ type: "handoff", handoff, sender: "orchestrator", recipient: "main" }]);
  });

  it("user_session.message is THE chat lane", () => {
    const items = foldUserItems([message("please check")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "message",
      speaker: OPERATOR,
      text: "please check",
      kind: "message",
    });
  });

  it("orchestrator messages keep their speaker", () => {
    const items = foldUserItems([message("done", ORCHESTRATOR)]);
    expect(items[0]).toMatchObject({
      type: "message",
      speaker: ORCHESTRATOR,
      text: "done",
    });
  });

  it("notice-kind messages keep the notice kind (muted row)", () => {
    const items = foldUserItems([
      message("mode changed to plan_execute", ORCHESTRATOR, "notice"),
    ]);
    expect(items[0]).toMatchObject({ type: "message", kind: "notice" });
  });

  it("tool call and result pair by EXACT callId into one card", () => {
    const items = foldUserItems([
      ev("user_session.tool.call", {
        sessionId: "us_1",
        turnId: "turn_1",
        callId: "call_1",
        name: "Read",
        input: { file_path: "/tmp/a" },
      }),
      ev("user_session.tool.result", {
        sessionId: "us_1",
        callId: "call_1",
        output: { ok: true },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool",
      callId: "call_1",
      name: "Read",
      input: { file_path: "/tmp/a" },
      output: { ok: true },
    });
  });

  it("error results carry isError onto the paired card", () => {
    const items = foldUserItems([
      ev("user_session.tool.call", {
        sessionId: "us_1",
        turnId: "turn_1",
        callId: "call_2",
        name: "Bash",
        input: { command: "false" },
      }),
      ev("user_session.tool.result", {
        sessionId: "us_1",
        callId: "call_2",
        output: "exit 1",
        isError: true,
      }),
    ]);
    expect(items[0]).toMatchObject({
      type: "tool",
      isError: true,
      output: "exit 1",
    });
  });

  it("an orphan tool.result (its call outside the record) folds to nothing", () => {
    const items = foldUserItems([
      ev("user_session.tool.result", {
        sessionId: "us_1",
        callId: "call_gone",
        output: null,
      }),
    ]);
    expect(items).toHaveLength(0);
  });

  it("question.asked folds to a card; answered attaches the answers", () => {
    const asked = ev("user_session.question.asked", {
      sessionId: "us_1",
      interactionId: "int_1",
      questions: [
        {
          question: "Deploy?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    });
    expect(foldUserItems([asked])[0]).toMatchObject({
      type: "question",
      interactionId: "int_1",
    });
    expect(foldUserItems([asked])[0]).not.toHaveProperty("answer");

    const items = foldUserItems([
      asked,
      ev("user_session.question.answered", {
        sessionId: "us_1",
        interactionId: "int_1",
        answers: { "Deploy?": ["Yes"] },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "question",
      answer: { answers: { "Deploy?": ["Yes"] } },
    });
  });

  it("a chat-dismissed question carries the dismissed flag", () => {
    const items = foldUserItems([
      ev("user_session.question.asked", {
        sessionId: "us_1",
        interactionId: "int_2",
        questions: [{ question: "Which?", options: [{ label: "A" }] }],
      }),
      ev("user_session.question.answered", {
        sessionId: "us_1",
        interactionId: "int_2",
        dismissed: true,
      }),
    ]);
    expect(items[0]).toMatchObject({
      type: "question",
      answer: { dismissed: true },
    });
  });

  it("plan.proposed folds to a card; resolved attaches the decision", () => {
    const proposed = ev("user_session.plan.proposed", {
      sessionId: "us_1",
      interactionId: "int_3",
      plan: "# Plan\n1. do it",
    });
    expect(foldUserItems([proposed])[0]).toMatchObject({
      type: "plan",
      plan: "# Plan\n1. do it",
    });

    const approved = foldUserItems([
      proposed,
      ev("user_session.plan.resolved", {
        sessionId: "us_1",
        interactionId: "int_3",
        approved: true,
      }),
    ]);
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      type: "plan",
      resolution: { approved: true },
    });

    const rejected = foldUserItems([
      proposed,
      ev("user_session.plan.resolved", {
        sessionId: "us_1",
        interactionId: "int_3",
        approved: false,
        note: "smaller scope please",
      }),
    ]);
    expect(rejected[0]).toMatchObject({
      type: "plan",
      resolution: { approved: false, note: "smaller scope please" },
    });
  });

  it("turn.started folds to a hairline with its trigger", () => {
    const items = foldUserItems([
      ev("user_session.turn.started", {
        sessionId: "us_1",
        turnId: "turn_9",
        trigger: "operator",
      }),
    ]);
    expect(items[0]).toMatchObject({
      type: "turn",
      turnId: "turn_9",
      trigger: "operator",
    });
  });

  it("turn.settled: success is silent, error and abort get a row", () => {
    expect(
      foldUserItems([
        ev("user_session.turn.settled", {
          sessionId: "us_1",
          turnId: "turn_9",
          status: "completed",
          queuedJobs: 0,
        }),
      ]),
    ).toHaveLength(0);

    const failed = foldUserItems([
      ev("user_session.turn.settled", {
        sessionId: "us_1",
        turnId: "turn_9",
        status: "error",
        errorMessage: "model blew up",
        queuedJobs: 0,
      }),
    ]);
    expect(failed[0]).toMatchObject({
      type: "turn_error",
      errorMessage: "model blew up",
    });

    const aborted = foldUserItems([
      ev("user_session.turn.settled", {
        sessionId: "us_1",
        turnId: "turn_10",
        status: "aborted",
        queuedJobs: 0,
      }),
    ]);
    expect(aborted[0]).toMatchObject({
      type: "turn_error",
      errorMessage: "turn interrupted",
    });
  });

  it("MUST-IGNORE set: lifecycle, other topics, transients", () => {
    for (const event of [
      ev("user_session.created", {
        session: { id: "us_1" },
      }),
      ev("user_session.updated", {
        sessionId: "us_1",
        patch: { mode: "plan_execute" },
      }),
      ev("workspace.created", { workspace: { id: "ws_1" } }),
      ev("workspace.updated", { workspaceId: "ws_1", patch: {} }),
      ev("agent_session.message", { agentSessionId: "as_1", message: {} }),
      ev("task.created", { task: {} }),
      ev("task.updated", { task: {}, changed: [] }),
      ev("flow.delegation", {
        userSessionId: "us_1",
        agentSessionId: "as_1",
        kind: "created",
        preview: "x",
      }),
      transient("stream.delta", {
        scope: { kind: "user", sessionId: "us_1" },
        speaker: "orchestrator",
        turnId: "turn_1",
        text: "streaming…",
      }),
      transient("stream.reasoning", {
        scope: { kind: "user", sessionId: "us_1" },
        speaker: "orchestrator",
        turnId: "turn_1",
        text: "hmm",
      }),
      transient("agent.state", {
        scope: { kind: "user", sessionId: "us_1" },
        participant: "orchestrator",
        state: "thinking",
      }),
    ]) {
      expect(
        foldUserItems([event]),
        `expected ${event.type} to fold to nothing`,
      ).toHaveLength(0);
    }
  });

  it("no double render: a duplicated event folds once; the fold is pure", () => {
    const row = message("hello");
    // The same envelope delivered twice (hydration + live race) renders once —
    // dedupe by event id inside the fold, belt to the stream kit's braces.
    expect(foldUserItems([row, row])).toHaveLength(1);

    // Pure: same array in, same items out, input untouched.
    const events = [
      row,
      ev("user_session.tool.call", {
        sessionId: "us_1",
        turnId: "turn_1",
        callId: "call_9",
        name: "Read",
        input: {},
      }),
      ev("user_session.tool.result", {
        sessionId: "us_1",
        callId: "call_9",
        output: null,
      }),
    ];
    const first = foldUserItems(events);
    const second = foldUserItems(events);
    expect(second).toEqual(first);
    expect(events).toHaveLength(3);
  });
});

describe("foldBusy", () => {
  it("an unsettled turn is busy; a clean settle is not", () => {
    const started = ev("user_session.turn.started", {
      sessionId: "us_1",
      turnId: "turn_1",
      trigger: "operator",
    });
    expect(foldBusy([started])).toBe(true);
    expect(
      foldBusy([
        started,
        ev("user_session.turn.settled", {
          sessionId: "us_1",
          turnId: "turn_1",
          status: "completed",
          queuedJobs: 0,
        }),
      ]),
    ).toBe(false);
  });

  it("a settle that leaves queued jobs keeps the busy state up", () => {
    expect(
      foldBusy([
        ev("user_session.turn.started", {
          sessionId: "us_1",
          turnId: "turn_1",
          trigger: "operator",
        }),
        ev("user_session.turn.settled", {
          sessionId: "us_1",
          turnId: "turn_1",
          status: "completed",
          queuedJobs: 2,
        }),
      ]),
    ).toBe(true);
  });
});

/**
 * The run's own ending, as the transcript sees it. db-live-2 had no card here
 * at all — the run stopped and the operator was left reading a spinner that had
 * quietly gone still.
 */
describe("run summary fold", () => {
  // Distinct seqs: the fold dedupes by event id, so two proposals sharing one
  // seq would collapse into a single card.
  const proposed = (runId: string, seq = 90): ConsoleEvent =>
    ({
      type: "run.completion.proposed", seq, ts: "2026-08-09T10:00:00.000Z",
      userSessionId: "us_1",
      payload: {
        sessionId: "us_1", runId, summaryId: runId,
        headline: "Lane Runner is done and verified.",
        verdict: "completed_with_caveats",
        filesChanged: 4, tasks: { completed: 4, total: 4 },
        durationMs: 1_974_000, deadAirMs: 949_000,
        costUsd: 10.38, costCoverage: 0.79, openUncertainty: 2,
        reaped: { processes: 1, browsers: 1, leakedBefore: 1 },
      },
    }) as unknown as ConsoleEvent;

  it("pushes one card and rewrites it in place on sign-off", () => {
    const items = foldUserItems([
      proposed("run_1"),
      {
        type: "run.signoff.resolved", seq: 91, ts: "2026-08-09T10:01:00.000Z",
        userSessionId: "us_1",
        payload: { sessionId: "us_1", runId: "run_1", decision: "accept" },
      } as unknown as ConsoleEvent,
    ]);
    const cards = items.filter((item) => item.type === "run_summary");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      stats: {
        headline: "Lane Runner is done and verified.",
        verdict: "completed_with_caveats",
      },
      resolution: { decision: "accept" },
    });
  });

  it("keeps a resolved card and appends a second one after a reopen", () => {
    // The resolved card stays as a record of what was proposed and what the
    // operator said; the next proposal is a NEW card below it.
    const items = foldUserItems([
      proposed("run_1"),
      {
        type: "run.signoff.resolved", seq: 91, ts: "t",
        userSessionId: "us_1",
        payload: { sessionId: "us_1", runId: "run_1", decision: "changes", note: "HUD is off" },
      } as unknown as ConsoleEvent,
      { type: "run.reopened", seq: 92, ts: "t", userSessionId: "us_1",
        payload: { sessionId: "us_1", runId: "run_1", reason: "changes_requested" } } as unknown as ConsoleEvent,
      proposed("run_2", 93),
    ]);
    const cards = items.filter((item) => item.type === "run_summary");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ resolution: { decision: "changes", note: "HUD is off" } });
    expect(cards[1]?.resolution).toBeUndefined();
  });
});

describe("foldPosture", () => {
  const started = { type: "user_session.turn.started", seq: 1, ts: "t", userSessionId: "us_1",
    payload: { sessionId: "us_1", turnId: "t1", trigger: "operator" } } as unknown as ConsoleEvent;
  const asked = { type: "user_session.question.asked", seq: 2, ts: "t", userSessionId: "us_1",
    payload: { sessionId: "us_1", interactionId: "int_1", questions: [], urgency: "blocking", source: "agent", allowFreeText: true } } as unknown as ConsoleEvent;
  const answered = { type: "user_session.question.answered", seq: 3, ts: "t", userSessionId: "us_1",
    payload: { sessionId: "us_1", interactionId: "int_1", answers: {} } } as unknown as ConsoleEvent;

  it("reports a running turn as busy", () => {
    expect(foldPosture([started])).toEqual({ busy: true, blocked: false });
  });

  it("reports a turn parked on a card as BLOCKED, not busy", () => {
    // The db-live-2 state exactly: the turn never settles because the tool
    // awaits the operator. Calling that "busy" is what made "done" and
    // "waiting on you" render identically.
    expect(foldPosture([started, asked])).toEqual({ busy: false, blocked: true });
  });

  it("returns to busy once the card is answered", () => {
    expect(foldPosture([started, asked, answered])).toEqual({ busy: true, blocked: false });
  });

  it("ignores a SEAT's card — it parks the seat's turn, not the main lane", () => {
    // A seat-raised ask_operator (participant set, even blocking) must not
    // stop the main lane's spinner or swap the interrupt affordance: main is
    // genuinely running. Deferred seat cards doubly so.
    const seatAsked = { type: "user_session.question.asked", seq: 4, ts: "t", userSessionId: "us_1",
      payload: { sessionId: "us_1", interactionId: "int_2", questions: [], agentSessionId: "agsess_1",
        participant: "renderer", urgency: "blocking", source: "agent", allowFreeText: true } } as unknown as ConsoleEvent;
    expect(foldPosture([started, seatAsked])).toEqual({ busy: true, blocked: false });
  });
});
