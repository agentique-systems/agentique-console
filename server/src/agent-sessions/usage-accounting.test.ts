/**
 * Per-turn cost is a DELTA against a baseline that belongs to the provider
 * session, not to the process reading it: a resumed session continues the
 * SDK's running `total_cost_usd`, so a zeroed baseline would record the whole
 * session-to-date total as one turn's delta.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { loadConfig } from "../config.ts";
import { usageSamples } from "../db/schema.ts";

/**
 * The bug only exists across a PROCESS boundary, so the test has to cross one.
 * The fake re-invokes its program once per pushed message inside a single
 * `query()`, which is a new turn but the SAME lane — `#spawnSeat` never runs
 * and `lane.lastCumulative` survives in memory. Parking the agent first (a 20ms
 * idle window) is what forces the respawn-over-`resume` this is about.
 */
const PARKED = (event: { type: string; payload: unknown }): boolean =>
  event.type === "agent_session.runtime.noted" && String((event.payload as { detail?: string }).detail ?? "").includes("agent parked");

const handoff = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

const usageFrame = (cumulativeCost: number, cumulativeApiMs: number, tokens = 1_000) =>
  successMessage(undefined, {
    session_id: "sess-resumed",
    total_cost_usd: cumulativeCost,
    duration_api_ms: cumulativeApiMs,
    usage: { input_tokens: 10, cache_read_input_tokens: tokens, output_tokens: 50 },
  } as Record<string, unknown>);

describe("cumulative usage baseline", () => {
  it("charges the delta, not the session-to-date total, when an agent respawns over resume", async () => {
    // Two turns in one provider session, the second after a respawn. The
    // second result restates the running total ($4.78), of which only $0.30 is
    // actually this turn's.
    let invocation = 0;
    const h = makeDelegationHarness(
      async function* () {
        invocation += 1;
        yield initMessage("sess-resumed");
        yield invocation === 1 ? usageFrame(4.48, 1_080_818) : usageFrame(4.78, 1_138_239);
      },
      { config: { policy: { agentIdleReapMs: 20 } } },
    );
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "usage", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    // The agent's baseline must have been persisted with the provider session.
    const afterFirst = h.repo.getAgent(created.agentSessionId, "coordinator");
    expect(afterFirst?.cumulativeCostUsd).toBeCloseTo(4.48, 6);
    expect(afterFirst?.cumulativeApiDurationMs).toBe(1_080_818);
    expect(afterFirst?.sdkSessionId).toBe("sess-resumed");

    // The process boundary: wait for the lane to actually park, so the next
    // delivery respawns it over `resume` rather than reusing the live lane.
    await collectUntil(h.bus, PARKED, 10_000);

    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "main" },
      to: "coordinator", handoff: handoff("second unit"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "usage.recorded" && (event.payload as { turnId?: string }).turnId !== undefined
        && (event.payload as { costUsd?: number }).costUsd !== undefined
        && h.db.select().from(usageSamples).all().filter((row) => row.participant === "coordinator").length >= 2,
      10_000,
    );

    const rows = h.db.select().from(usageSamples).all()
      .filter((row) => row.participant === "coordinator");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(invocation).toBeGreaterThanOrEqual(2);

    // Asserted as properties of the set rather than by position: a 20ms idle
    // window can park the agent mid-turn and trigger a redelivery, which
    // legitimately records a third row whose delta is 0 (same cumulative
    // restated). Row ORDER is therefore not deterministic; the two facts below
    // are.
    const near = (value: number | null, target: number) => value !== null && Math.abs(value - target) < 0.005;
    // The second turn is charged its own $0.30 …
    expect(rows.some((row) => near(row.costUsd, 0.3) && row.apiDurationMs === 57_421)).toBe(true);
    // … and NO row is ever charged the session-to-date total.
    expect(rows.some((row) => near(row.costUsd, 4.78))).toBe(false);
  });

  it("takes the raw value when the counter restarts below the baseline", async () => {
    // Defensive clamp: if the SDK ever does start a resumed session fresh, a
    // total below the watermark must not clamp a real turn to zero.
    let invocation = 0;
    const h = makeDelegationHarness(
      async function* () {
        invocation += 1;
        yield initMessage("sess-restarted");
        yield invocation === 1 ? usageFrame(4.48, 1_080_818) : usageFrame(0.31, 42_000);
      },
      { config: { policy: { agentIdleReapMs: 20 } } },
    );
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "usage", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    await collectUntil(h.bus, PARKED, 10_000);
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "main" },
      to: "coordinator", handoff: handoff("second unit"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "usage.recorded" && Math.abs(((event.payload as { costUsd?: number }).costUsd ?? -1) - 0.31) < 0.001,
      10_000,
    );

    const rows = h.db.select().from(usageSamples).all()
      .filter((row) => row.participant === "coordinator");
    // The raw value, not max(0, 0.31 - 4.48) = 0. Asserted over the set for the
    // same redelivery reason as above.
    expect(rows.some((row) => row.costUsd !== null && Math.abs(row.costUsd - 0.31) < 0.001)).toBe(true);
  });

  it("records a row for a zero-token errored turn instead of dropping it", async () => {
    // A turn that spends wall clock and buys nothing is the most interesting
    // row in the ledger; it must not be the invisible one.
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield { type: "result", subtype: "success", is_error: true,
        usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0 } as never;
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "usage", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    const rows = h.db.select().from(usageSamples).all()
      .filter((row) => row.agentSessionId === created.agentSessionId);
    // One row per attempt: the original plus MAX_REDELIVERY_ATTEMPTS retries.
    // Every one of them burned wall clock, so every one is in the ledger —
    // before this change the count was zero.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.status).toBe("error");
      expect(row.inputTokens).toBe(0);
      expect(row.outputTokens).toBe(0);
    }
  });
});
