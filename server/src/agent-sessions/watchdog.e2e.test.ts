/**
 * Loop/stall watchdog: identical-call and error-streak trips interrupt the
 * turn, settle it as an error with the canonical watchdog message, and post a
 * failure handoff to the coordinator. Operator aborts stay "aborted".
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolResultMessage, toolUseMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

/** A native send: the envelope is the JSON message body the middleware demands. */
const envelope = (action: string, status: "pending" | "completed", category: string) =>
  JSON.stringify({ handoff: handoff(action, status), category, checkpointReadiness: "stable" });

type ScoutTurn = () => AsyncGenerator<ReturnType<typeof initMessage>, void, void>;

function makeWatchdogHarness(scoutTurn: ScoutTurn) {
  let coordinatorTurns = 0;
  return makeDelegationHarness(async function* (options) {
    const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
    const coordinator = append.includes("sole coordinator");
    if (coordinator) {
      coordinatorTurns += 1;
      yield initMessage(`coord-${coordinatorTurns}`);
      yield coordinatorTurns === 1
        ? sendHandoffUse("send-1", "scout", { action: "inspect", status: "pending", category: "assignment" })
        : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "wrapped up after failure", status: "completed", category: "final" });
      yield successMessage();
    } else {
      yield* scoutTurn();
    }
  });
}

async function runFlow(h: ReturnType<typeof makeWatchdogHarness>) {
  const userSessionId = h.addUserSession();
  const done = collectUntil(h.bus, (event) => event.type === "flow.result", 10_000);
  const created = h.host.createSession({ userSessionId, title: "watchdog", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("go", "pending") });
  return { created, events: await done };
}

describe("seat turn watchdog (fake SDK)", () => {
  it("trips on 5 identical consecutive tool calls", async () => {
    const h = makeWatchdogHarness(async function* () {
      yield initMessage("scout-1");
      for (let i = 0; i < 6; i += 1) {
        yield toolUseMessage(`grep-${i}`, "Grep", { pattern: "needle", path: "src" });
        yield toolResultMessage(`grep-${i}`, "no matches");
      }
      yield sendHandoffUse("scout-close", "orchestrator", { action: "never reached", status: "completed", category: "milestone" });
      yield successMessage();
    });
    const { created, events } = await runFlow(h);
    const watchdogEvents = events.filter((event) => event.type === "agent_session.watchdog");
    expect(watchdogEvents).toHaveLength(1);
    expect(watchdogEvents[0]?.payload).toMatchObject({ participant: "scout", kind: "repeat_tool_calls", toolName: "Grep", count: 5 });
    const settled = events.find((event) => event.type === "agent_session.turn.settled" && event.payload.participant === "scout");
    expect(settled?.payload).toMatchObject({ status: "error" });
    expect((settled?.payload as { errorMessage?: string }).errorMessage).toMatch(/^watchdog: 5 identical consecutive calls to Grep/);
    const failures = h.repo.listMessages("agent", created.agentSessionId)
      .filter((row) => row.kind === "message" && row.speakerName === "scout" && (row.payload?.handoff as { action?: string } | undefined)?.action === "Turn failed");
    expect(failures).toHaveLength(1);
    expect(h.repo.listQueuedDeliveries(created.agentSessionId)).toHaveLength(0);
  });

  it("trips on 10 consecutive tool errors", async () => {
    const h = makeWatchdogHarness(async function* () {
      yield initMessage("scout-1");
      for (let i = 0; i < 11; i += 1) {
        yield toolUseMessage(`cmd-${i}`, "Read", { file_path: `src/${i}.ts` });
        yield toolResultMessage(`cmd-${i}`, "boom", true);
      }
      yield sendHandoffUse("scout-close", "orchestrator", { action: "never reached", status: "completed", category: "milestone" });
      yield successMessage();
    });
    const { events } = await runFlow(h);
    const watchdogEvents = events.filter((event) => event.type === "agent_session.watchdog");
    expect(watchdogEvents).toHaveLength(1);
    expect(watchdogEvents[0]?.payload).toMatchObject({ kind: "tool_error_streak", count: 10 });
  });

  it("does not trip when a different call resets the identical streak", async () => {
    const h = makeWatchdogHarness(async function* () {
      yield initMessage("scout-1");
      for (let i = 0; i < 4; i += 1) {
        yield toolUseMessage(`a-${i}`, "Grep", { pattern: "needle" });
        yield toolResultMessage(`a-${i}`, "no matches");
      }
      yield toolUseMessage("other", "Read", { file_path: "README.md" });
      yield toolResultMessage("other", "content");
      for (let i = 0; i < 4; i += 1) {
        yield toolUseMessage(`b-${i}`, "Grep", { pattern: "needle" });
        yield toolResultMessage(`b-${i}`, "no matches");
      }
      yield sendHandoffUse("scout-close", "orchestrator", { action: "all seen", status: "completed", category: "milestone" });
      yield successMessage();
    });
    const { events } = await runFlow(h);
    expect(events.some((event) => event.type === "agent_session.watchdog")).toBe(false);
    const settled = events.find((event) => event.type === "agent_session.turn.settled" && event.payload.participant === "scout");
    expect(settled?.payload).toMatchObject({ status: "completed" });
  });

  it("does not trip on alternating error and success results", async () => {
    const h = makeWatchdogHarness(async function* () {
      yield initMessage("scout-1");
      for (let i = 0; i < 12; i += 1) {
        yield toolUseMessage(`c-${i}`, "Read", { file_path: `src/${i}.ts` });
        yield toolResultMessage(`c-${i}`, i % 2 === 0 ? "boom" : "fine", i % 2 === 0);
      }
      yield sendHandoffUse("scout-close", "orchestrator", { action: "survived", status: "completed", category: "milestone" });
      yield successMessage();
    });
    const { events } = await runFlow(h);
    expect(events.some((event) => event.type === "agent_session.watchdog")).toBe(false);
  });
});
