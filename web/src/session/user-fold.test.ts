import { describe, expect, it } from "vitest";

import type { ConsoleEvent } from "@agentique-console/shared";

import { foldBusy, foldUserItems } from "./user-fold";

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
