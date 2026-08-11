/**
 * The precedence IS the feature: an orchestrator can be mid-turn AND blocked
 * on the operator — `needs_you` must beat `working`, because the thing the
 * operator can act on outranks the thing they cannot.
 */
import { describe, expect, it } from "vitest";
import { deriveSessionState } from "./session-state";

const base = {
  runState: "active" as const,
  archived: false,
  needsYou: false,
  posture: { busy: false, blocked: false },
  lastTurnErrored: false,
  spineOpen: true,
};

describe("deriveSessionState", () => {
  it("is ready when nothing is happening", () => {
    expect(deriveSessionState(base)).toBe("ready");
  });

  it("works while a turn runs", () => {
    expect(deriveSessionState({ ...base, posture: { busy: true, blocked: false } })).toBe("working");
  });

  it("needs_you beats working — mid-turn AND blocked on the operator", () => {
    expect(deriveSessionState({
      ...base, needsYou: true, posture: { busy: true, blocked: true },
    })).toBe("needs_you");
  });

  it("awaiting_signoff is needs_you, not done", () => {
    expect(deriveSessionState({ ...base, runState: "awaiting_signoff" })).toBe("needs_you");
  });

  it("done wins over everything once the operator accepted", () => {
    expect(deriveSessionState({
      ...base, runState: "completed", needsYou: true, posture: { busy: true, blocked: true },
    })).toBe("done");
  });

  it("an errored last turn reads blocked, unless the operator is needed", () => {
    expect(deriveSessionState({ ...base, lastTurnErrored: true })).toBe("blocked");
    expect(deriveSessionState({ ...base, lastTurnErrored: true, needsYou: true })).toBe("needs_you");
  });
});
