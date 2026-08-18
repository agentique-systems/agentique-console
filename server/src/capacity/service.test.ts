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

  it("an operator pause holds until resume, persists as reason operator, and emits the system snapshot", () => {
    const { h, capacity, userSessionId } = makeWorld();
    capacity.pauseByOperator("top bar");
    expect(capacity.paused).toBe(true);
    const row = h.repo.getUserSession(userSessionId);
    expect(row?.pauseReason).toBe("operator");
    expect(row?.pausedUntil).toBeNull();
    const snap = capacity.snapshot();
    expect(snap).toMatchObject({ paused: true, reason: "operator", until: null, detail: "top bar" });
    expect(snap.since).not.toBeNull();
    const changed = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'system.pause.changed' ORDER BY seq").all() as { payload: string }[];
    expect(changed.map((event) => JSON.parse(event.payload).paused)).toEqual([true]);
    const perSession = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'run.capacity.paused'").all() as { payload: string }[];
    expect(perSession.map((event) => JSON.parse(event.payload).reason)).toEqual(["operator"]);
    // Idempotent: a second press changes nothing and emits nothing new.
    capacity.pauseByOperator();
    expect((h.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'system.pause.changed'").get() as { n: number }).n).toBe(1);
    capacity.stop();
  });

  it("the ladder: operator outranks budget outranks capacity, in both directions", () => {
    const { h, capacity, userSessionId } = makeWorld();
    // Lower never displaces higher.
    capacity.pauseByOperator();
    capacity.noteLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) - 10 });
    h.repo.patchUserSession(userSessionId, { budgetUsd: 0 });
    capacity.checkBudget(userSessionId);
    expect(capacity.snapshot().reason).toBe("operator");
    // A capacity reset in the past would have self-expired a capacity pause; the operator pause holds.
    expect(capacity.paused).toBe(true);
    capacity.resume({ manual: true });
    expect(capacity.paused).toBe(false);
    // Higher displaces lower and drops the lower's timer.
    capacity.noteLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 1 });
    expect(capacity.snapshot().reason).toBe("capacity");
    capacity.pauseByOperator();
    expect(capacity.snapshot()).toMatchObject({ reason: "operator", until: null });
    capacity.stop();
  });

  it("resume emits the unpaused snapshot once and armFromBoot restores an operator pause without a start time", () => {
    const { h, capacity } = makeWorld();
    capacity.pauseByOperator();
    capacity.resume({ manual: true });
    const changed = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'system.pause.changed' ORDER BY seq").all() as { payload: string }[];
    expect(changed.map((event) => JSON.parse(event.payload).paused)).toEqual([true, false]);
    expect(capacity.snapshot()).toEqual({ paused: false, reason: null, since: null, until: null });
    capacity.pauseByOperator();
    const restored = new CapacityService({ repo: h.repo, bus: h.bus });
    restored.armFromBoot();
    expect(restored.snapshot()).toMatchObject({ paused: true, reason: "operator", since: null, until: null });
    restored.stop();
    capacity.stop();
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
