/**
 * The attention flag is the operator's only signal that a run is waiting on
 * them. It clears only on OPERATOR speech, mirroring the server rule
 * (`interactions.dismissPendingForChat` fires only from
 * `runner.postOperatorMessage`) — an orchestrator reply or a system notice
 * must not switch off "needs you" while the question is still pending.
 */
import { describe, expect, it, vi } from "vitest";
import type { ConsoleEvent } from "@agentique-console/shared";

import { routeEvent, type RouterDeps } from "./event-router";

function deps(): RouterDeps & { setAwaitingInput: ReturnType<typeof vi.fn> } {
  return {
    invalidate: vi.fn(),
    appendUserStreamEvent: vi.fn(),
    appendAgentStreamEvent: vi.fn(),
    ingestAgentActivity: vi.fn(),
    setAwaitingInput: vi.fn(),
    pulseFlow: vi.fn(),
    isWatched: () => true,
  } as unknown as RouterDeps & { setAwaitingInput: ReturnType<typeof vi.fn> };
}

const messageEvent = (speakerKind: "operator" | "orchestrator" | "agent" | "system"): ConsoleEvent =>
  ({
    type: "user_session.message.appended",
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
      payload: { userSessionId: "us_1", interactionId: "int_2", agentSessionId: "as_child", agent: "scout", questions: [] },
    } as unknown as ConsoleEvent, d);
    expect(d.setAwaitingInput).toHaveBeenCalledWith("us_1", true);
  });
});

describe("routeEvent — boundary flow pulses", () => {
  it("pulses the parent card for child spawn and child report", () => {
    const d = deps();
    routeEvent({
      type: "agent_session.child.spawned", seq: 20, ts: "2026-08-09T10:03:00.000Z", userSessionId: "us_1",
      payload: { agentSessionId: "as_parent", childAgentSessionId: "as_child", pattern: "pipeline", byAgent: "coordinator", title: "sub" },
    } as unknown as ConsoleEvent, d);
    expect(d.pulseFlow).toHaveBeenCalledWith("as_parent", "delegation", "2026-08-09T10:03:00.000Z");
    routeEvent({
      type: "agent_session.child.reported", seq: 21, ts: "2026-08-09T10:04:00.000Z", userSessionId: "us_1",
      payload: { agentSessionId: "as_parent", childAgentSessionId: "as_child", status: "completed", handoffId: "h1" },
    } as unknown as ConsoleEvent, d);
    expect(d.pulseFlow).toHaveBeenCalledWith("as_parent", "result", "2026-08-09T10:04:00.000Z");
  });
});

describe("routeEvent — orchestration surfaces", () => {
  it("spec and state revisions invalidate the user-sessions prefix and the spec marker reaches the stream", () => {
    const d = deps();
    routeEvent({
      type: "user_session.spec.updated", seq: 30, ts: "2026-08-09T10:05:00.000Z", userSessionId: "us_1",
      payload: { userSessionId: "us_1", revision: 2, changeNote: "drop three.js", edited: false },
    } as unknown as ConsoleEvent, d);
    expect(d.invalidate).toHaveBeenCalledWith(["user-sessions"]);
    expect(d.appendUserStreamEvent).toHaveBeenCalledWith("us_1", expect.objectContaining({ type: "user_session.spec.updated" }));

    routeEvent({
      type: "user_session.state.updated", seq: 31, ts: "2026-08-09T10:06:00.000Z", userSessionId: "us_1",
      payload: { userSessionId: "us_1", revision: 1, trigger: "commission", sections: ["strategy"], counts: { uncertainties: 0, assumptions: 0, risks: 0 } },
    } as unknown as ConsoleEvent, d);
    expect(d.invalidate).toHaveBeenCalledWith(["user-sessions"]);
  });
});
