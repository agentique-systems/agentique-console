import { describe, expect, it } from "vitest";

import type { ConsoleEvent } from "@agentique-console/shared";

import { foldAgentItems } from "./agent-fold";

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
    agentSessionId: "as_1",
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
    agentSessionId: "as_1",
    payload,
  } as ConsoleEvent;
}

const SCOUT = { kind: "agent", name: "scout" } as const;
const ORCHESTRATOR = { kind: "orchestrator", name: "orchestrator" } as const;
const SYSTEM = { kind: "system", name: "system" } as const;

function message(
  text: string,
  speaker: { kind: string; name: string } = SCOUT,
  kind: "message" | "notice" | "plan" = "message",
  to?: string,
): ConsoleEvent {
  return ev("agent_session.message", {
    agentSessionId: "as_1",
    message: {
      seq: seq + 1,
      speaker,
      ...(to === undefined ? {} : { to }),
      kind,
      text,
      createdAt: "2026-08-03T12:00:00.000Z",
    },
  });
}

/**
 * Golden suite for the agent-session fold. The wire contract is the server's
 * agent-session host emission (frozen in shared/src/events.ts) — if either
 * side changes shape, these cases must be re-checked against it.
 */
describe("foldAgentItems", () => {
  it("carries a structured handoff on the existing message row", () => {
    const handoff = { id: "handoff_1", trigger: "milestone" as const, status: "in_progress" as const, risk: "medium" as const,
      action: "Report state", stateSummary: "Parser is updated", resultSummary: null, nextAction: "Run tests",
      evidenceCount: 1, artifactCount: 0, extensionKind: "implementation" as const, overflow: false, referenceWarnings: [] };
    const items = foldAgentItems([ev("agent_session.message", { agentSessionId: "as_1", message: { seq: 1, speaker: SCOUT,
      to: "orchestrator", kind: "message", text: "compact projection", handoff, createdAt: "2026-08-03T12:00:00.000Z" } })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "message", handoff });
  });

  it("agent_session.message is THE chat lane, speaker + to intact", () => {
    const items = foldAgentItems([
      message("found it in repo.ts", SCOUT, "message", "coder"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "message",
      speaker: SCOUT,
      to: "coder",
      text: "found it in repo.ts",
      kind: "message",
    });
  });

  it("orchestrator messages keep their speaker; no `to` stays absent", () => {
    const items = foldAgentItems([message("kick off", ORCHESTRATOR)]);
    expect(items[0]).toMatchObject({
      type: "message",
      speaker: ORCHESTRATOR,
      text: "kick off",
    });
    expect(items[0]).not.toHaveProperty("to");
  });

  it("notice- and plan-kind messages keep their kind", () => {
    const items = foldAgentItems([
      message("scout joined", SYSTEM, "notice"),
      message("# Plan\n1. read", SCOUT, "plan"),
    ]);
    expect(items[0]).toMatchObject({ type: "message", kind: "notice" });
    expect(items[1]).toMatchObject({
      type: "message",
      kind: "plan",
      text: "# Plan\n1. read",
    });
  });

  it("tool call and result pair by EXACT callId, participant carried", () => {
    const items = foldAgentItems([
      ev("agent_session.tool.call", {
        sessionId: "as_1",
        turnId: "turn_1",
        callId: "call_1",
        name: "Read",
        participant: "scout",
        input: { file_path: "/tmp/a" },
      }),
      ev("agent_session.tool.result", {
        sessionId: "as_1",
        callId: "call_1",
        participant: "scout",
        output: { ok: true },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool",
      callId: "call_1",
      name: "Read",
      participant: "scout",
      input: { file_path: "/tmp/a" },
      output: { ok: true },
    });
  });

  it("error results carry isError onto the paired card", () => {
    const items = foldAgentItems([
      ev("agent_session.tool.call", {
        sessionId: "as_1",
        turnId: "turn_1",
        callId: "call_2",
        name: "Bash",
        participant: "coder",
        input: { command: "false" },
      }),
      ev("agent_session.tool.result", {
        sessionId: "as_1",
        callId: "call_2",
        participant: "coder",
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
    const items = foldAgentItems([
      ev("agent_session.tool.result", {
        sessionId: "as_1",
        callId: "call_gone",
        participant: "scout",
        output: null,
      }),
    ]);
    expect(items).toHaveLength(0);
  });

  it("routed folds to a micro-row with decisions + hopCount", () => {
    const items = foldAgentItems([
      ev("agent_session.routed", {
        agentSessionId: "as_1",
        messageSeq: 7,
        decisions: [
          { recipient: "scout", reason: "mention" },
          { recipient: "coder", reason: "mention" },
        ],
        hopCount: 2,
      }),
    ]);
    expect(items[0]).toMatchObject({
      type: "routed",
      messageSeq: 7,
      decisions: [
        { recipient: "scout", reason: "mention" },
        { recipient: "coder", reason: "mention" },
      ],
      hopCount: 2,
    });
  });

  it("turn.started folds to a marker with its participant", () => {
    const items = foldAgentItems([
      ev("agent_session.turn.started", {
        agentSessionId: "as_1",
        participant: "scout",
        turnId: "turn_9",
      }),
    ]);
    expect(items[0]).toMatchObject({
      type: "turn",
      turnId: "turn_9",
      participant: "scout",
    });
  });

  it("turn.settled: success is silent, error and abort get a row", () => {
    expect(
      foldAgentItems([
        ev("agent_session.turn.settled", {
          agentSessionId: "as_1",
          participant: "scout",
          turnId: "turn_9",
          status: "completed",
        }),
      ]),
    ).toHaveLength(0);

    const failed = foldAgentItems([
      ev("agent_session.turn.settled", {
        agentSessionId: "as_1",
        participant: "scout",
        turnId: "turn_9",
        status: "error",
        errorMessage: "model blew up",
      }),
    ]);
    expect(failed[0]).toMatchObject({
      type: "turn_error",
      participant: "scout",
      errorMessage: "model blew up",
    });

    const aborted = foldAgentItems([
      ev("agent_session.turn.settled", {
        agentSessionId: "as_1",
        participant: "coder",
        turnId: "turn_10",
        status: "aborted",
      }),
    ]);
    expect(aborted[0]).toMatchObject({
      type: "turn_error",
      errorMessage: "turn interrupted",
    });
  });

  it("MUST-IGNORE set: lifecycle, status, other topics, transients", () => {
    for (const event of [
      ev("agent_session.created", {
        session: { id: "as_1" },
        participants: ["scout"],
      }),
      // Status is a strip-card concern, never a transcript row.
      ev("agent_session.status", {
        agentSessionId: "as_1",
        status: "idle",
        owedToOrchestrator: false,
      }),
      ev("user_session.message", {
        sessionId: "us_1",
        message: {
          seq: 1,
          speaker: { kind: "operator", name: "operator" },
          kind: "message",
          text: "wrong lane",
          createdAt: "2026-08-03T12:00:00.000Z",
        },
      }),
      ev("task.created", { task: {} }),
      ev("task.updated", { task: {}, changed: [] }),
      ev("flow.delegation", {
        userSessionId: "us_1",
        agentSessionId: "as_1",
        kind: "created",
        preview: "x",
      }),
      ev("flow.result", {
        userSessionId: "us_1",
        agentSessionId: "as_1",
        digestPreview: "y",
      }),
      transient("stream.delta", {
        scope: { kind: "agent", sessionId: "as_1" },
        speaker: "scout",
        turnId: "turn_1",
        text: "streaming…",
      }),
      transient("stream.reasoning", {
        scope: { kind: "agent", sessionId: "as_1" },
        speaker: "scout",
        turnId: "turn_1",
        text: "hmm",
      }),
      transient("agent.state", {
        scope: { kind: "agent", sessionId: "as_1" },
        participant: "scout",
        state: "thinking",
      }),
    ]) {
      expect(
        foldAgentItems([event]),
        `expected ${event.type} to fold to nothing`,
      ).toHaveLength(0);
    }
  });

  it("no double render: a duplicated event folds once; the fold is pure", () => {
    const row = message("hello");
    // The same envelope delivered twice (hydration + live race) renders once —
    // dedupe by event id inside the fold, belt to the stream kit's braces.
    expect(foldAgentItems([row, row])).toHaveLength(1);

    // Pure: same array in, same items out, input untouched.
    const events = [
      row,
      ev("agent_session.tool.call", {
        sessionId: "as_1",
        turnId: "turn_1",
        callId: "call_9",
        name: "Read",
        participant: "scout",
        input: {},
      }),
      ev("agent_session.tool.result", {
        sessionId: "as_1",
        callId: "call_9",
        participant: "scout",
        output: null,
      }),
    ];
    const first = foldAgentItems(events);
    const second = foldAgentItems(events);
    expect(second).toEqual(first);
    expect(events).toHaveLength(3);
  });
});
