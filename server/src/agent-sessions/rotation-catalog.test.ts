/**
 * The per-model catalog gates rotation: an unknown seat model lowers the
 * token ceiling to the conservative default (68K), while known models keep
 * the configured 120K limit binding.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

function makeFlowHarness() {
  let coordinatorTurns = 0;
  return makeDelegationHarness(async function* (options) {
    const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
    const coordinator = append.includes("sole coordinator");
    yield initMessage(coordinator ? `coord-${coordinatorTurns}` : "scout-1");
    if (coordinator) {
      coordinatorTurns += 1;
      yield successMessage(coordinatorTurns === 1
        ? { handoff: handoff("look around", "pending"), to: "scout", category: "assignment", checkpointReadiness: "stable" }
        : { handoff: handoff("done", "completed"), to: "main", category: "final", checkpointReadiness: "stable" });
    } else {
      yield successMessage({ handoff: handoff("seen", "completed"), to: "orchestrator", category: "milestone", checkpointReadiness: "stable" });
    }
  });
}

describe("catalog-derived rotation limits", () => {
  it("an unknown seat model rotates at the conservative 68K ceiling", async () => {
    const h = makeFlowHarness();
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "flow.result", 10_000);
    const created = h.host.createSession({ userSessionId, title: "rotate", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer", model: "mystery-model" }], briefing: handoff("go", "pending") });
    h.repo.patchParticipant(created.agentSessionId, "scout", { contextTokens: 70_000 });
    const events = await done;
    const rotated = events.filter((event) => event.type === "agent_session.context.rotated");
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.payload).toMatchObject({ participant: "scout", threshold: "hard", reason: "token_limit" });
  });

  it("a known seat model keeps the configured 120K limit binding at 70K tokens", async () => {
    const h = makeFlowHarness();
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "flow.result", 10_000);
    const created = h.host.createSession({ userSessionId, title: "no-rotate", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("go", "pending") });
    h.repo.patchParticipant(created.agentSessionId, "scout", { contextTokens: 70_000 });
    const events = await done;
    expect(events.some((event) => event.type === "agent_session.context.rotated")).toBe(false);
  });
});
