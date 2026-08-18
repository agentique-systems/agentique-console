/**
 * The operator's whole-system Pause, end to end over the fake SDK: a HARD
 * pause cuts a seat mid-turn without a verdict on its work (delivery back to
 * `queued`, no failure escalation, no attempt spent), holds every new turn,
 * and on Resume redelivers the same handoff with a "continue, don't restart"
 * note. A restart while paused stays paused.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness, restartHarness, type Harness } from "../test-helpers.ts";

const briefing = {
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action: "survey", state: { summary: "survey", evidence: [] },
    result: { summary: null, artifacts: [] }, uncertainty: [], nextAction: "survey",
    requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
};

/**
 * Coordinator assigns scout. Scout's FIRST turn hangs in a tool call until
 * released (or interrupted); every later scout turn completes at once.
 */
function makePausableHarness(policy: Record<string, number> = {}): { h: Harness; release: () => void; scoutTurns: () => number } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let scoutTurns = 0;
  const h = makeDelegationHarness(async function* (options) {
    const identity = agentRoleOf(options);
    yield initMessage();
    if (identity.agent === "coordinator") {
      yield sendHandoffUse("send-1", "scout", { action: "survey the repo", status: "pending", category: "assignment" });
      yield successMessage();
      return;
    }
    if (identity.agent === "scout") {
      scoutTurns += 1;
      if (scoutTurns === 1) {
        yield toolUseMessage("hang-1", "Read", { file_path: "src/never-returns.ts" });
        await gate;
      }
      yield successMessage();
      return;
    }
    yield successMessage();
  }, { config: { policy: policy as never } });
  return { h, release, scoutTurns: () => scoutTurns };
}

const count = (h: Harness, sql: string): number => (h.sqlite.prepare(sql).get() as { n: number }).n;

describe("operator pause (fake SDK)", () => {
  it("hard pause cuts a mid-turn seat without a verdict; resume redelivers with the continue note", async () => {
    const { h, release, scoutTurns } = makePausableHarness({ maxRedeliveryAttempts: 1 });
    const userSessionId = h.addUserSession();
    const hung = collectUntil(h.bus, (event) => event.type === "agent_session.tool.called" &&
      (event.payload as { agent?: string }).agent === "scout", 10_000);
    const created = h.host.createSession({ userSessionId, title: "pausable", agents: [{ name: "scout", profileId: "explorer" }], briefing });
    try {
      await hung;
      expect(scoutTurns()).toBe(1);

      const settled = collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled" &&
        (event.payload as { agent?: string }).agent === "scout", 10_000);
      const response = h.app.system.pause({ mode: "hard" });
      expect(response).toMatchObject({ paused: true, reason: "operator", interrupted: { main: 0, seats: 1 } });
      expect(h.app.capacity.paused).toBe(true);
      expect(h.repo.getUserSession(userSessionId)?.pauseReason).toBe("operator");

      const events = await settled;
      const settle = events.at(-1)!.payload as { status: string; errorMessage?: string };
      expect(settle).toMatchObject({ status: "aborted", errorMessage: "paused by operator" });
      // The assignment is back in the queue — not cancelled, not acknowledged.
      const rows = h.repo.listUnackedDeliveries(created.agentSessionId, "scout");
      expect(rows.map((row) => row.status)).toEqual(["queued"]);
      // No verdict was passed on the work: nothing escalated to the coordinator.
      expect(count(h, "SELECT count(*) AS n FROM handoff_records WHERE trigger = 'failure'")).toBe(0);
      // And the pause held the redelivery: no second scout turn while paused.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(scoutTurns()).toBe(1);

      // Resume: the same delivery redelivers, prefixed with the console note.
      const resumed = collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled" &&
        (event.payload as { agent?: string }).agent === "scout" &&
        (event.payload as { status?: string }).status === "completed", 10_000);
      h.app.system.resume();
      expect(h.app.capacity.paused).toBe(false);
      await resumed;
      expect(scoutTurns()).toBe(2);
      const resumePrompt = h.fake.captured.prompts.find((prompt) => prompt.startsWith("[Console: the operator paused the whole system"));
      expect(resumePrompt).toBeDefined();
      expect(resumePrompt).toContain("CONTINUE the work in progress");
      expect(resumePrompt).toContain("survey the repo");
      expect(h.repo.listUnackedDeliveries(created.agentSessionId, "scout")).toEqual([]);
      const changed = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'system.pause.changed' ORDER BY seq").all() as { payload: string }[];
      expect(changed.map((event) => JSON.parse(event.payload).paused)).toEqual([true, false]);
    } finally {
      release();
    }
  });

  it("while paused no new session gets a turn; resume starts it; a restart keeps the pause", async () => {
    const { h, release } = makePausableHarness();
    const userSessionId = h.addUserSession();
    h.app.system.pause({ mode: "soft" });
    const created = h.host.createSession({ userSessionId, title: "held", agents: [{ name: "scout", profileId: "explorer" }], briefing });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(count(h, "SELECT count(*) AS n FROM events WHERE type = 'agent_session.turn.started'")).toBe(0);
    expect(h.repo.listUnackedDeliveries(created.agentSessionId, "coordinator").map((row) => row.status)).toEqual(["queued"]);

    // The pause survives a process restart (persisted on the open session).
    const restarted = await restartHarness(h);
    expect(restarted.app.capacity.paused).toBe(true);
    expect(restarted.app.system.state()).toMatchObject({ paused: true, reason: "operator", since: null });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(count(restarted, "SELECT count(*) AS n FROM events WHERE type = 'agent_session.turn.started'")).toBe(0);

    const started = collectUntil(restarted.bus, (event) => event.type === "agent_session.turn.started", 10_000);
    restarted.app.system.resume();
    await started;
    release();
  });
});
