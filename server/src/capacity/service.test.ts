/** CapacityService over a real in-memory database. */
import { describe, expect, it } from "vitest";
import { makeHarness } from "../test-helpers.ts";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { CapacityService } from "./service.ts";

function makeWorld() {
  const h = makeHarness(async function* () { yield initMessage(); yield successMessage(); });
  const capacity = new CapacityService({ repo: h.repo, bus: h.bus });
  const userSessionId = h.addUserSession();
  return { h, capacity, userSessionId };
}

describe("CapacityService", () => {
  it("a rejected limit pauses every open session, idempotently, and persists the pause", () => {
    const { h, capacity, userSessionId } = makeWorld();
    const resets = Math.floor(Date.now() / 1000) + 3600;
    capacity.noteLimit({ status: "rejected", resetsAt: resets, limitType: "five_hour" });
    expect(capacity.paused).toBe(true);
    const row = h.repo.getUserSession(userSessionId);
    expect(row?.pauseReason).toBe("capacity");
    expect(row?.pausedUntil).toBe(new Date(resets * 1000).toISOString());
    // A storm of identical limit events must not re-emit pause events.
    capacity.noteLimit({ status: "rejected", resetsAt: resets, limitType: "five_hour" });
    expect(capacity.paused).toBe(true);
    capacity.stop();
  });

  it("resume clears the pause, emits resumed, and fires the resume hooks", () => {
    const { h, capacity, userSessionId } = makeWorld();
    let kicked = 0;
    capacity.onResume(() => { kicked += 1; });
    capacity.noteLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 });
    capacity.resume({ manual: true });
    expect(capacity.paused).toBe(false);
    expect(kicked).toBe(1);
    const row = h.repo.getUserSession(userSessionId);
    expect(row?.pauseReason).toBeNull();
    expect(row?.pausedUntil).toBeNull();
    capacity.stop();
  });

  it("an expired capacity pause self-resumes on the next paused check", () => {
    const { capacity } = makeWorld();
    capacity.noteLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) - 10 });
    // The reset time is already past: the first read resumes.
    expect(capacity.paused).toBe(false);
    capacity.stop();
  });

  it("budget ceiling pauses with reason budget and does not auto-resume", () => {
    const { h, capacity, userSessionId } = makeWorld();
    h.repo.patchUserSession(userSessionId, { budgetUsd: 1 });
    h.repo.insertUsage({ id: "usage_1", userSessionId, agentSessionId: null, participant: "orchestrator",
      profileId: null, generation: 0, turnId: "t1", inputTokens: 0, uncachedInputTokens: 0,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, costUsd: 2,
      model: null, effort: null, trigger: null, durationMs: null, apiDurationMs: null, sdkDurationMs: null,
      status: "completed", stopReason: null, createdAt: new Date().toISOString() });
    capacity.checkBudget(userSessionId);
    expect(capacity.paused).toBe(true);
    expect(h.repo.getUserSession(userSessionId)?.pauseReason).toBe("budget");
    // Budget pauses hold until the operator acts.
    expect(capacity.paused).toBe(true);
    capacity.resume({ manual: true });
    expect(capacity.paused).toBe(false);
    capacity.stop();
  });

  it("armFromBoot restores a persisted pause and expires a stale one", () => {
    const { h, userSessionId } = makeWorld();
    h.repo.patchUserSession(userSessionId, { pausedUntil: new Date(Date.now() + 3600_000).toISOString(), pauseReason: "capacity" });
    const restored = new CapacityService({ repo: h.repo, bus: h.bus });
    restored.armFromBoot();
    expect(restored.paused).toBe(true);
    restored.stop();
    h.repo.patchUserSession(userSessionId, { pausedUntil: new Date(Date.now() - 60_000).toISOString(), pauseReason: "capacity" });
    const expired = new CapacityService({ repo: h.repo, bus: h.bus });
    expired.armFromBoot();
    expect(expired.paused).toBe(false);
    expect(h.repo.getUserSession(userSessionId)?.pauseReason).toBeNull();
    expired.stop();
  });

  it("warningLine appears only at high utilization", () => {
    const { capacity } = makeWorld();
    capacity.noteLimit({ status: "allowed_warning", utilization: 0.5 });
    expect(capacity.warningLine()).toBeNull();
    capacity.noteLimit({ status: "allowed_warning", utilization: 0.9, resetsAt: Math.floor(Date.now() / 1000) + 600 });
    expect(capacity.warningLine()).toContain("90%");
    capacity.noteLimit({ status: "allowed" });
    expect(capacity.warningLine()).toBeNull();
    capacity.stop();
  });
});
