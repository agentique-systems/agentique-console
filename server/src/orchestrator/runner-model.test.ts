/**
 * Which model the orchestrator lane actually spawns on.
 *
 * The resolution is `session.model ?? config.infra.model`, and the failure mode it
 * guards against is silent: a per-session choice that never reaches the SDK
 * options looks exactly like one that did, right up until the bill or the
 * output quality says otherwise. So these assert on the options the fake SDK
 * captured, not on the row.
 */
import { describe, expect, it, vi } from "vitest";
import { initMessage, successMessage, textMessage } from "../sdk/fake.ts";
import { collectUntil, makeHarness } from "../test-helpers.ts";

const settled = (e: { type: string }): boolean =>
  e.type === "user_session.turn.settled";

/**
 * collectUntil replays from seq 1, so "wait for the Nth turn to settle" is a
 * fresh counter each call rather than a cursor.
 */
function nthSettled(n: number): (e: { type: string }) => boolean {
  let seen = 0;
  return (e) => settled(e) && ++seen === n;
}

function makeModelHarness() {
  return makeHarness(async function* () {
    yield initMessage("sdk-sess-1");
    yield textMessage("ok");
    yield successMessage(undefined, { session_id: "sdk-sess-1" });
  });
}

describe("orchestrator lane model", () => {
  it("a session with no model of its own spawns on the configured default", async () => {
    const h = makeModelHarness();
    const sessionId = h.addUserSession();

    const collected = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "hi");
    await collected;

    expect(h.config.infra.model).toBe("claude-opus-5");
    expect(h.fake.captured.options[0]?.model).toBe("claude-opus-5");
  });

  it("a session's own model wins over the configured default", async () => {
    const h = makeModelHarness();
    const sessionId = h.addUserSession();
    h.repo.patchUserSession(sessionId, { model: "claude-fable-5" });

    const collected = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "hi");
    await collected;

    expect(h.fake.captured.options[0]?.model).toBe("claude-fable-5");
  });

  it("the usage row records the model the turn actually ran on", async () => {
    const h = makeModelHarness();
    const sessionId = h.addUserSession();
    h.repo.patchUserSession(sessionId, { model: "claude-sonnet-5" });

    const collected = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "hi");
    await collected;

    const usage = h.repo.listUsage(sessionId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.model).toBe("claude-sonnet-5");
  });

  /**
   * The lane's options are frozen at spawn, so a mid-session change only lands
   * once the lane recycles — which is exactly what the service does on a model
   * patch. Recycling here stands in for that patch.
   */
  it("a recycled lane respawns on the session's new model", async () => {
    const h = makeModelHarness();
    const sessionId = h.addUserSession();

    h.runner.postOperatorMessage(sessionId, "first");
    await collectUntil(h.bus, nthSettled(1));
    expect(h.fake.captured.options[0]?.model).toBe("claude-opus-5");

    h.repo.patchUserSession(sessionId, { model: "claude-fable-5" });
    h.runner.recycleSession(sessionId);
    // recycleSession fires the close and returns; the respawn only happens on
    // the next message, so wait for the closed query to actually be gone.
    await vi.waitFor(() => expect(h.fake.captured.closed).toBe(true));

    h.runner.postOperatorMessage(sessionId, "second");
    await collectUntil(h.bus, nthSettled(2));
    expect(h.fake.captured.options).toHaveLength(2);
    expect(h.fake.captured.options.at(-1)?.model).toBe("claude-fable-5");
  });
});
