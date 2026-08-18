/**
 * Rotation is opt-in; when on, the per-model catalog gates it: an unknown
 * agent model lowers the token ceiling to the conservative default (68K),
 * while known models keep the configured 120K limit binding. Off (the
 * default), a seat keeps its provider session however large its context.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

const envelope = (action: string, status: "pending" | "completed", category: string) =>
  JSON.stringify({ handoff: handoff(action, status), category, checkpointReadiness: "stable" });

function makeFlowHarness(harnessOptions: Parameters<typeof makeDelegationHarness>[1] = { config: { policy: { contextRotation: true } } }) {
  let coordinatorTurns = 0;
  return makeDelegationHarness(async function* (options) {
    const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
    const coordinator = append.includes("sole coordinator");
    yield initMessage(coordinator ? `coord-${coordinatorTurns}` : "scout-1");
    if (coordinator) {
      coordinatorTurns += 1;
      yield coordinatorTurns === 1
        ? sendHandoffUse("send-1", "scout", { action: "look around", status: "pending", category: "assignment" })
        : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "done", status: "completed", category: "final" });
      yield successMessage();
    } else {
      yield sendHandoffUse("scout-close", "coordinator", { action: "seen", status: "completed", category: "milestone" });
      yield successMessage();
    }
  }, harnessOptions);
}

describe("catalog-derived rotation limits", () => {
  it("an unknown agent model rotates at the conservative 68K ceiling", async () => {
    const h = makeFlowHarness();
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.context.rotated", 10_000);
    const created = h.host.createSession({ userSessionId, title: "rotate", agents: [{ name: "scout", profileId: "explorer", model: "mystery-model" }], briefing: handoff("go", "pending") });
    h.repo.patchAgent(created.agentSessionId, "scout", { contextTokens: 70_000 });
    const events = await done;
    const rotated = events.filter((event) => event.type === "agent_session.context.rotated");
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.payload).toMatchObject({ agent: "scout", reason: "token_limit" });
    // The successor's prompt carries the checkpoint as prose, not JSON — and
    // only a real checkpoint: the first generation's tail was empty.
    const appends = h.fake.captured.options
      .map((options) => (typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : ""))
      .filter((append) => append.startsWith("Inspect only the assigned scope"));
    expect(appends.length).toBeGreaterThanOrEqual(2);
    expect(appends[0]).not.toContain("## Where you left off");
    expect(appends.at(-1)).toContain("## Where you left off (checkpoint handoff_");
    expect(appends.at(-1)).not.toContain('"schemaVersion"');
  });

  it("a known agent model keeps the configured 120K limit binding at 70K tokens", async () => {
    const h = makeFlowHarness();
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 10_000);
    const created = h.host.createSession({ userSessionId, title: "no-rotate", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("go", "pending") });
    h.repo.patchAgent(created.agentSessionId, "scout", { contextTokens: 70_000 });
    const events = await done;
    expect(events.some((event) => event.type === "agent_session.context.rotated")).toBe(false);
  });

  it("with rotation off (the default) a seat keeps its provider session at any occupancy", async () => {
    const h = makeFlowHarness({});
    expect(h.config.policy.contextRotation).toBe(false);
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 10_000);
    const created = h.host.createSession({ userSessionId, title: "never", agents: [{ name: "scout", profileId: "explorer", model: "mystery-model" }], briefing: handoff("go", "pending") });
    h.repo.patchAgent(created.agentSessionId, "scout", { contextTokens: 500_000, turnCount: 100 });
    const events = await done;
    expect(events.some((event) => event.type === "agent_session.context.rotated")).toBe(false);
    const scout = h.repo.getAgent(created.agentSessionId, "scout");
    expect(scout?.generation).toBe(0);
    expect(scout?.sdkSessionId).toBe("scout-1");
  });
});
