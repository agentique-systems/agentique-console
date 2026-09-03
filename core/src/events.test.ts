import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.ts";
import { EVENT_CATALOGUE, EVENT_TYPES, eventScopeSchema, isEventType, planNodeTransitionEventType, runTransitionEventType, validateEventPayload } from "./events.ts";
import { newId } from "./ids.ts";

describe("event catalogue", () => {
  it("names every type as <object>.<past_tense_verb> in snake_case", () => {
    for (const type of EVENT_TYPES) {
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
    expect(EVENT_TYPES.length).toBe(Object.keys(EVENT_CATALOGUE).length);
  });

  it("never carries a provider continuation or legacy namespace", () => {
    for (const type of EVENT_TYPES) {
      expect(type.startsWith("provider_continuation")).toBe(false);
      expect(type.startsWith("user_session")).toBe(false);
      expect(type.startsWith("agent_session")).toBe(false);
    }
    expect(isEventType("user_session.created")).toBe(false);
    expect(isEventType("run.started")).toBe(true);
  });

  it("validates payloads against the declared schema", () => {
    expect(validateEventPayload("run.waiting", { from: "running", to: "waiting", waitReason: "budget" })).toEqual({ from: "running", to: "waiting", waitReason: "budget" });
    expect(() => validateEventPayload("run.waiting", { from: "running", to: "waiting", waitReason: "sleepy" })).toThrow(ValidationError);
    expect(() => validateEventPayload("handoff.delivered", { handoffId: "nope" })).toThrow(ValidationError);
    expect(() => validateEventPayload("handoff.delivered", { handoffId: newId("handoff"), extra: 1 })).toThrow(ValidationError);
  });

  it("requires a Workspace, Conversation, or Run scope", () => {
    const empty = { workspaceId: null, conversationId: null, runId: null, planNodeId: null, invocationId: null, attemptId: null };
    expect(eventScopeSchema.safeParse(empty).success).toBe(false);
    expect(eventScopeSchema.safeParse({ ...empty, runId: newId("run") }).success).toBe(true);
  });

  it("maps every Run and Plan Node transition to one Event type", () => {
    expect(runTransitionEventType("created", "running")).toBe("run.started");
    expect(runTransitionEventType("waiting", "running")).toBe("run.wait_cleared");
    expect(runTransitionEventType("verifying", "running")).toBe("run.verification_failed");
    expect(runTransitionEventType("awaiting_signoff", "running")).toBe("run.changes_requested");
    expect(runTransitionEventType("awaiting_signoff", "completed")).toBe("run.completed");
    expect(() => runTransitionEventType("running", "created")).toThrow();
    expect(planNodeTransitionEventType("waiting", "running")).toBe("plan_node.wait_cleared");
    expect(planNodeTransitionEventType("ready", "running")).toBe("plan_node.started");
    expect(planNodeTransitionEventType("pending", "skipped")).toBe("plan_node.skipped");
  });
});
