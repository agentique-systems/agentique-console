/**
 * Wake-boundary generation retirement: a seat's durable ability to continue
 * work must not require one provider conversation to grow with the seat's
 * lifetime. Bounded DELIVERY already caps what new Console state enters a
 * turn; these tests pin the other bound — when a parked seat's provider
 * session has carried context occupancy at or above the retirement
 * threshold, the next wake retires it behind a deterministic continuation
 * checkpoint and the SAME seat (assignment, tasks, worktree columns, name,
 * role) continues as a fresh generation that never resumes — and never
 * replays — the old transcript.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import type { SdkMessage } from "../sdk/types.ts";
import { collectUntil, makeDelegationHarness, restartHarness } from "../test-helpers.ts";
import { handoffRecords, usageSamples } from "../db/schema.ts";

const PARKED = (event: { type: string; payload: unknown }): boolean =>
  event.type === "agent_session.runtime.noted" && String((event.payload as { detail?: string }).detail ?? "").includes("agent parked");

const ROTATED = (event: { type: string }): boolean => event.type === "agent_session.context.rotated";

const handoff = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

/** An assistant frame whose per-call usage IS the occupancy signal. */
const occupancyFrame = (tokens: number): SdkMessage => ({
  type: "assistant",
  message: { content: [{ type: "text", text: "working" }], usage: { input_tokens: tokens, output_tokens: 10 } },
});

/**
 * Scripted seat: turn 1 runs on provider session "sess-A" and reports the
 * given occupancy; every later invocation runs on "sess-B" — which is only
 * reachable when the console spawns a FRESH query (a resumed one would keep
 * announcing sess-A; the id the console persists tells the test which
 * happened).
 */
function twoSessionProgram(occupancy: number) {
  let call = 0;
  return async function* () {
    call += 1;
    if (call === 1) {
      yield initMessage("sess-A");
      yield occupancyFrame(occupancy);
      yield successMessage(undefined, { session_id: "sess-A", total_cost_usd: 1.0, duration_api_ms: 1_000,
        usage: { input_tokens: 100, cache_read_input_tokens: occupancy - 100, output_tokens: 50 } } as Partial<SdkMessage>);
    } else {
      yield initMessage("sess-B");
      yield successMessage(undefined, { session_id: "sess-B", total_cost_usd: 0.2, duration_api_ms: 500,
        usage: { input_tokens: 80, output_tokens: 20 } } as Partial<SdkMessage>);
    }
  };
}

const POLICY = { agentIdleReapMs: 20, agentContextRetireTokens: 50_000 };

describe("wake-boundary generation retirement", () => {
  it("retires an overburdened provider session behind a checkpoint and continues the same seat as a fresh generation", async () => {
    const h = makeDelegationHarness(twoSessionProgram(60_000), { config: { policy: POLICY } });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "rotation", agents: [{ name: "scout", profileId: "explorer" }],
      briefing: handoff("observe"),
      tasks: [{ taskId: "t1", subject: "unit one", owner: "scout" }],
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    const unitBefore = h.tasks.listForAgentSession(created.agentSessionId)[0]!;

    // Turn 1 persisted the occupancy peak and the provider session id.
    const before = h.repo.getAgent(created.agentSessionId, "coordinator")!;
    expect(before.contextTokens).toBe(60_000);
    expect(before.sdkSessionId).toBe("sess-A");
    expect(before.generation).toBe(0);
    // The seat's worktree binding must survive retirement untouched.
    h.repo.patchAgent(created.agentSessionId, "coordinator", {
      worktreePath: "/tmp/rotation-wt", worktreeBranch: "seat-coordinator", worktreeBaseCommit: "abc123" });

    await collectUntil(h.bus, PARKED, 10_000);
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "main" },
      to: "coordinator", handoff: handoff("second unit"), category: "assignment",
    });
    const events = await collectUntil(h.bus, ROTATED, 10_000);
    await collectUntil(h.bus, (event) => event.type === "usage.recorded"
      && (event.payload as { generation?: number }).generation === 1, 10_000);

    // The rotated event carries provenance: which provider session preceded
    // generation 1, at what burden, seeded by which checkpoint.
    const rotated = events.find(ROTATED)!.payload as {
      agent: string; generation: number; reason: string; handoffId?: string;
      checkpointBytes?: number; contextTokens?: number; retiredSdkSessionId?: string };
    expect(rotated.agent).toBe("coordinator");
    expect(rotated.generation).toBe(1);
    expect(rotated.reason).toBe("token_limit");
    expect(rotated.contextTokens).toBe(60_000);
    expect(rotated.retiredSdkSessionId).toBe("sess-A");

    // Same logical seat, new generation: the successor announced sess-B and
    // the seat row now points at it — the retired session is never resumed.
    const after = h.repo.getAgent(created.agentSessionId, "coordinator")!;
    expect(after.generation).toBe(1);
    expect(after.sdkSessionId).toBe("sess-B");
    expect(after.contextTokens).toBeLessThan(60_000);
    expect(after.worktreePath).toBe("/tmp/rotation-wt");
    expect(after.worktreeBranch).toBe("seat-coordinator");
    expect(after.worktreeBaseCommit).toBe("abc123");
    // No new logical seat was minted.
    expect(h.repo.listAgents(created.agentSessionId).map((seat) => seat.name).sort()).toEqual(["coordinator", "scout"]);

    // The fresh generation's spawn carries NO resume — the old transcript
    // stays journaled but out of every future prompt.
    const spawns = h.fake.captured.options;
    expect(spawns.length).toBe(2);
    expect(spawns[0]!.resume).toBeUndefined();
    expect(spawns[1]!.resume).toBeUndefined();

    // The checkpoint: journaled, checkpoint-flagged, self-addressed, stamped
    // with the RETIRED generation, planned (not a failure), bounded, and
    // console-authored (synthetic).
    const checkpoints = h.db.select().from(handoffRecords)
      .where(and(eq(handoffRecords.trigger, "rotation"), eq(handoffRecords.checkpoint, true))).all();
    expect(checkpoints.length).toBe(1);
    const checkpoint = checkpoints[0]!;
    expect(checkpoint.id).toBe(rotated.handoffId);
    expect(checkpoint.sender).toBe("coordinator");
    expect(checkpoint.recipient).toBe("coordinator");
    expect(checkpoint.generation).toBe(0);
    expect(checkpoint.synthetic).toBe(true);
    expect(checkpoint.bytes).toBeLessThan(16_384);
    const core = checkpoint.core as { status: string; risk: string; action: string; uncertainty: string[]; state: { summary: string } };
    expect(core.action.startsWith("Rotation checkpoint: ")).toBe(true);
    expect(core.status).toBe("in_progress");
    expect(core.risk).toBe("medium");
    expect(core.state.summary).toContain("planned context boundary");
    expect(core.uncertainty.join(" ")).toContain("Planned context rotation");
    // The ledger unit rides the checkpoint facts under its prompt-canonical
    // taskId — task truth is not reset.
    expect(core.state.summary).toContain("- t1 [pending] unit one (scout)");

    // The successor's system prompt carries the checkpoint tail, not the
    // transcript; the delivery carries the queued assignment — nothing posted
    // around the boundary is lost.
    const append = (spawns[1]!.systemPrompt as { append?: string }).append ?? "";
    expect(append).toContain(`## Where you left off (checkpoint ${checkpoint.id})`);
    expect(append).toContain("same seat continuing the same work");
    const secondPrompt = await h.fake.waitForPrompt(1);
    expect(secondPrompt).toContain("second unit");

    // Ledger identity survives: same canonical unit, same status — not
    // re-minted, not abandoned, not reset by the generation boundary.
    const units = h.tasks.listForAgentSession(created.agentSessionId);
    expect(units.map((unit) => unit.id)).toEqual([unitBefore.id]);
    expect(units[0]!.status).toBe(unitBefore.status);

    // Usage stays attributable per generation and summable across them, and
    // the fresh provider session's cumulative counters restart cleanly: the
    // $0.20 turn is charged $0.20, not $0.20 minus the retired session's $1.
    const rows = h.db.select().from(usageSamples).all().filter((row) => row.participant === "coordinator");
    expect(rows.some((row) => row.generation === 0)).toBe(true);
    expect(rows.some((row) => row.generation === 1)).toBe(true);
    expect(rows.some((row) => row.costUsd !== null && Math.abs(row.costUsd - 0.2) < 0.001)).toBe(true);
    const totals = h.repo.aggregateUsageByParticipant(created.agentSessionId).get("coordinator")!;
    expect(totals.turns).toBeGreaterThanOrEqual(2);
    // No failure machinery fired: a planned rotation is not a dead turn.
    expect(h.db.select().from(handoffRecords).where(eq(handoffRecords.trigger, "failure")).all()).toEqual([]);
  });

  it("resumes the same provider session unchanged below the threshold", async () => {
    const h = makeDelegationHarness(twoSessionProgram(60_000),
      { config: { policy: { ...POLICY, agentContextRetireTokens: 1_000_000 } } });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "no rotation", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    await collectUntil(h.bus, PARKED, 10_000);
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "main" },
      to: "coordinator", handoff: handoff("second unit"), category: "assignment",
    });
    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled"
      && h.fake.captured.options.length >= 2, 10_000);

    expect(events.some(ROTATED)).toBe(false);
    // The respawn RESUMED the retained provider session.
    expect(h.fake.captured.options[1]!.resume).toBe("sess-A");
    const seat = h.repo.getAgent(created.agentSessionId, "coordinator")!;
    expect(seat.generation).toBe(0);
    expect(h.db.select().from(handoffRecords).where(eq(handoffRecords.checkpoint, true)).all()).toEqual([]);
  });

  it("0 disables retirement entirely", async () => {
    const h = makeDelegationHarness(twoSessionProgram(60_000),
      { config: { policy: { ...POLICY, agentContextRetireTokens: 0 } } });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "disabled", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    await collectUntil(h.bus, PARKED, 10_000);
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "main" },
      to: "coordinator", handoff: handoff("second unit"), category: "assignment",
    });
    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled"
      && h.fake.captured.options.length >= 2, 10_000);
    expect(events.some(ROTATED)).toBe(false);
    expect(h.fake.captured.options[1]!.resume).toBe("sess-A");
  });

  it("concurrent wakes retire exactly once — one active generation, one checkpoint", async () => {
    const h = makeDelegationHarness(twoSessionProgram(60_000), { config: { policy: POLICY } });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "concurrent", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    await collectUntil(h.bus, PARKED, 10_000);

    await Promise.all([
      h.host.ensureSeatLive(created.agentSessionId, "coordinator"),
      h.host.ensureSeatLive(created.agentSessionId, "coordinator"),
    ]);

    const seat = h.repo.getAgent(created.agentSessionId, "coordinator")!;
    expect(seat.generation).toBe(1);
    expect(h.db.select().from(handoffRecords).where(eq(handoffRecords.checkpoint, true)).all().length).toBe(1);
  });

  it("survives a restart between the burden accruing and the wake — exactly one authoritative generation", async () => {
    const h = makeDelegationHarness(twoSessionProgram(60_000), { config: { policy: POLICY } });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "restart", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    await collectUntil(h.bus, PARKED, 10_000);

    // The process dies while the seat is parked and overburdened. The durable
    // row (sdkSessionId + generation + contextTokens) is the only transition
    // state there is, so the fresh process converges on the same decision.
    const h2 = await restartHarness(h);
    h2.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "main" },
      to: "coordinator", handoff: handoff("post-restart unit"), category: "assignment",
    });
    await collectUntil(h2.bus, ROTATED, 10_000);
    await collectUntil(h2.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    const seat = h2.repo.getAgent(created.agentSessionId, "coordinator")!;
    expect(seat.generation).toBe(1);
    expect(seat.sdkSessionId).toBe("sess-B");
    expect(h2.db.select().from(handoffRecords)
      .where(and(eq(handoffRecords.trigger, "rotation"), eq(handoffRecords.checkpoint, true))).all().length).toBe(1);

    // A further wake finds nothing left to retire: retirement is one-way and
    // idempotent, not a cadence.
    await h2.host.ensureSeatLive(created.agentSessionId, "coordinator");
    expect(h2.repo.getAgent(created.agentSessionId, "coordinator")!.generation).toBe(1);
  });
});
