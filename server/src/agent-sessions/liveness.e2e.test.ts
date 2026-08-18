/**
 * Liveness alarms: a turn wedged INSIDE one tool call — the dimension every
 * completed-action guard is blind to — trips a typed event and wakes main
 * with a console-authored failure handoff, exactly once per cause; and
 * interrupt_agent (the wired-up dead code) actually kills the wedged turn.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness, type Harness } from "../test-helpers.ts";

const briefing = {
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action: "survey", state: { summary: "survey", evidence: [] },
    result: { summary: null, artifacts: [] }, uncertainty: [], nextAction: "survey",
    requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
};

/** Coordinator assigns scout; scout makes one tool call and hangs forever. */
function makeWedgedHarness(policy: Record<string, number>): { h: Harness; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = makeDelegationHarness(async function* (options) {
    const identity = agentRoleOf(options);
    yield initMessage();
    if (identity.agent === "coordinator") {
      yield sendHandoffUse("send-1", "scout", { action: "survey the repo", status: "pending", category: "assignment" });
      yield successMessage();
      return;
    }
    if (identity.agent === "scout") {
      yield toolUseMessage("hang-1", "Read", { file_path: "src/never-returns.ts" });
      await gate;
      yield successMessage();
      return;
    }
    yield successMessage();
  }, { config: { policy: policy as never } });
  return { h, release };
}

describe("liveness alarms (fake SDK)", () => {
  it("a hung tool call trips ONE alarm that wakes main with the facts", async () => {
    const { h, release } = makeWedgedHarness({ toolCallAlarmMs: 30, turnQuietAlarmMs: 0 });
    const userSessionId = h.addUserSession();
    const tripped = collectUntil(h.bus, (event) => event.type === "agent_session.liveness.tripped", 10_000);
    const created = h.host.createSession({ userSessionId, title: "wedge", agents: [{ name: "scout", profileId: "explorer" }], briefing });
    h.host.startGovernanceSweep(10);
    try {
      const events = await tripped;
      const alarm = events.at(-1)!;
      expect(alarm.payload).toMatchObject({
        agentSessionId: created.agentSessionId, agent: "scout", kind: "tool_hang", toolName: "Read",
      });
      expect(String((alarm.payload as { inputPreview?: string }).inputPreview)).toContain("never-returns");

      // The wake reaches MAIN as a journaled console-authored failure handoff.
      await collectUntil(h.bus, (event) =>
        event.type === "handoff.created" &&
        String((event.payload as { recipient?: string }).recipient) === "main" &&
        String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").startsWith("Liveness alarm"), 10_000);

      // The latch holds across further sweeps: still exactly one alarm event.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const alarms = h.sqlite.prepare(
        "SELECT count(*) AS n FROM events WHERE type = 'agent_session.liveness.tripped'").get() as { n: number };
      expect(alarms.n).toBe(1);
    } finally {
      h.host.stopGovernanceSweep();
      release();
    }
  });

  it("an ask_operator park never alarms; interrupt_agent kills a wedged turn", async () => {
    const { h, release } = makeWedgedHarness({ toolCallAlarmMs: 30, turnQuietAlarmMs: 0 });
    const userSessionId = h.addUserSession();
    const tripped = collectUntil(h.bus, (event) => event.type === "agent_session.liveness.tripped", 10_000);
    const created = h.host.createSession({ userSessionId, title: "wedge", agents: [{ name: "scout", profileId: "explorer" }], briefing });
    h.host.startGovernanceSweep(10);
    try {
      await tripped;
      // The orchestrator's lever: stop exactly this agent's turn. The lane
      // survives; the turn settles as an error and escalates a failure.
      const settled = collectUntil(h.bus, (event) =>
        event.type === "agent_session.turn.settled" &&
        (event.payload as { agent?: string }).agent === "scout" &&
        (event.payload as { status?: string }).status === "error", 10_000);
      h.host.interruptAgent(created.agentSessionId, "scout", "main: wedged in Read for 14 minutes");
      const events = await settled;
      const stopNote = events.find((event) => event.type === "agent_session.runtime.noted" &&
        String((event.payload as { detail?: string }).detail ?? "").startsWith("stopped: main: wedged"));
      expect(stopNote).toBeDefined();
    } finally {
      h.host.stopGovernanceSweep();
      release();
    }
  });

  it("interrupting an idle agent is a truthful conflict", async () => {
    const { h, release } = makeWedgedHarness({ toolCallAlarmMs: 0, turnQuietAlarmMs: 0 });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "idle", agents: [{ name: "scout", profileId: "explorer" }], briefing });
    // "other" (never-spawned) has no lane at all.
    expect(() => h.host.interruptAgent(created.agentSessionId, "other", "poke")).toThrow(/no turn in flight/);
    release();
  });
});
