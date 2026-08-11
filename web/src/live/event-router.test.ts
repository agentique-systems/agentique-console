/**
 * The attention flag is the operator's only signal that a run is waiting on
 * them — a 1.5px dot in the sidebar, and (once the attention layer lands) the
 * title/favicon/toast that hang off the same state.
 *
 * It was cleared by ANY `user_session.message`. The server rule it mirrors
 * (`interactions.dismissPendingForChat`) fires only from
 * `runner.postOperatorMessage`, i.e. only for operator speech — so an
 * orchestrator reply, a system notice, or the post-restart recovery notice all
 * silently switched off "needs you" while the question was still pending.
 *
 * In db-live-2 the run ended on an unanswered question with the orchestrator
 * talking either side of it. That is exactly this shape.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConsoleEvent } from "@agentique-console/shared";

import { routeEvent, type RouterDeps } from "./event-router";

function deps(): RouterDeps & { setAwaitingInput: ReturnType<typeof vi.fn> } {
  return {
    invalidate: vi.fn(),
    appendUserStreamEvent: vi.fn(),
    appendAgentStreamEvent: vi.fn(),
    ingestAgentState: vi.fn(),
    setAwaitingInput: vi.fn(),
    pulseFlow: vi.fn(),
    isWatched: () => true,
  } as unknown as RouterDeps & { setAwaitingInput: ReturnType<typeof vi.fn> };
}

const messageEvent = (speakerKind: "operator" | "orchestrator" | "agent" | "system"): ConsoleEvent =>
  ({
    type: "user_session.message",
    seq: 10,
    ts: "2026-08-09T10:00:00.000Z",
    userSessionId: "us_1",
    payload: {
      userSessionId: "us_1",
      message: {
        id: "msg_1", seq: 1, kind: "message", text: "…",
        speaker: { kind: speakerKind, name: speakerKind },
        createdAt: "2026-08-09T10:00:00.000Z",
      },
    },
  }) as unknown as ConsoleEvent;

const questionAsked = (): ConsoleEvent =>
  ({
    type: "user_session.question.asked",
    seq: 9,
    ts: "2026-08-09T09:59:00.000Z",
    userSessionId: "us_1",
    payload: { userSessionId: "us_1", interactionId: "int_1", questions: [] },
  }) as unknown as ConsoleEvent;

describe("routeEvent — attention", () => {
  it("raises attention when a question is asked", () => {
    const d = deps();
    routeEvent(questionAsked(), d);
    expect(d.setAwaitingInput).toHaveBeenCalledWith("us_1", true);
  });

  it("clears attention when the OPERATOR speaks", () => {
    const d = deps();
    routeEvent(messageEvent("operator"), d);
    expect(d.setAwaitingInput).toHaveBeenCalledWith("us_1", false);
  });

  for (const speaker of ["orchestrator", "agent", "system"] as const) {
    it(`leaves attention alone when the ${speaker} speaks`, () => {
      const d = deps();
      routeEvent(messageEvent(speaker), d);
      // Not "called with false" — not called at all. The question is still
      // pending and nothing about the run talking changes that.
      expect(d.setAwaitingInput).not.toHaveBeenCalled();
      // The message must still reach the transcript.
      expect(d.appendUserStreamEvent).toHaveBeenCalled();
    });
  }

  it("clears attention when the question is actually answered", () => {
    const d = deps();
    routeEvent({
      type: "user_session.question.answered", seq: 11, ts: "2026-08-09T10:01:00.000Z",
      userSessionId: "us_1", payload: { userSessionId: "us_1", interactionId: "int_1", answers: {} },
    } as unknown as ConsoleEvent, d);
    expect(d.setAwaitingInput).toHaveBeenCalledWith("us_1", false);
  });

  it("raises attention for a question asked inside a CHILD session", () => {
    // Regression guard: children share the root userSessionId, and the router
    // must keep setting awaitingInput unconditionally — "fixing" it to filter
    // by session level would silence nested asks.
    const d = deps();
    routeEvent({
      type: "user_session.question.asked", seq: 12, ts: "2026-08-09T10:02:00.000Z",
      userSessionId: "us_1",
      payload: { userSessionId: "us_1", interactionId: "int_2", agentSessionId: "as_child", participant: "scout", questions: [] },
    } as unknown as ConsoleEvent, d);
    expect(d.setAwaitingInput).toHaveBeenCalledWith("us_1", true);
  });

  it("routes replayed pre-rename history by its legacy sessionId", () => {
    // Rows persisted before the payload id rule carry a bare `sessionId`, and
    // the auxiliary agentSessionId (the asking seat) must not capture the
    // stream. This pin dies with A8's data migration, together with idOf.
    const d = deps();
    routeEvent({
      type: "user_session.question.asked", seq: 13, ts: "2026-08-09T10:05:00.000Z",
      userSessionId: "us_1",
      payload: { sessionId: "us_1", interactionId: "int_3", agentSessionId: "as_child", participant: "scout", questions: [] },
    } as unknown as ConsoleEvent, d);
    expect(d.setAwaitingInput).toHaveBeenCalledWith("us_1", true);
    expect(d.appendUserStreamEvent).toHaveBeenCalledWith("us_1", expect.anything());
  });
});

describe("routeEvent — boundary flow pulses", () => {
  it("pulses the parent card for child spawn and child report", () => {
    const d = deps();
    routeEvent({
      type: "agent_session.child.spawned", seq: 20, ts: "2026-08-09T10:03:00.000Z", userSessionId: "us_1",
      payload: { agentSessionId: "as_parent", childAgentSessionId: "as_child", pattern: "pipeline", byParticipant: "orchestrator", title: "sub" },
    } as unknown as ConsoleEvent, d);
    expect(d.pulseFlow).toHaveBeenCalledWith("as_parent", "delegation", "2026-08-09T10:03:00.000Z");
    routeEvent({
      type: "agent_session.child.reported", seq: 21, ts: "2026-08-09T10:04:00.000Z", userSessionId: "us_1",
      payload: { agentSessionId: "as_parent", childAgentSessionId: "as_child", status: "completed", handoffId: "h1" },
    } as unknown as ConsoleEvent, d);
    expect(d.pulseFlow).toHaveBeenCalledWith("as_parent", "result", "2026-08-09T10:04:00.000Z");
  });
});
