/**
 * Pins the hub seats' system-prompt append byte-for-byte. The topology
 * refactor moves these strings from host literals into the hub contract's
 * prompt pack; prompt caching and operator familiarity both require that the
 * move changes NOTHING. Recorded against the pre-contract code — a diff in
 * this snapshot is a regression, not an update to accept.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

describe("hub prompt byte-identity", () => {
  it("coordinator and specialist appends are unchanged by the contract refactor", async () => {
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      const coordinator = append.includes("sole coordinator");
      yield initMessage();
      if (coordinator) {
        yield sendHandoffUse("send-1", "scout", { action: "look around", status: "pending", category: "assignment" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) =>
      event.type === "agent_session.turn.settled" && JSON.stringify(event.payload).includes("scout"), 10_000);
    h.host.createSession({ userSessionId, title: "snapshot", agents: [{ name: "scout", profileId: "explorer" }],
      briefing: { core: { schemaVersion: 1, taskId: null, status: "pending", risk: "low",
        action: "look around", state: { summary: "look around", evidence: [] }, result: { summary: null, artifacts: [] },
        uncertainty: [], nextAction: "look around", requestExpandedContext: false }, extension: { kind: "generic", data: {} } } });
    await done;

    const appends = h.fake.captured.options
      .map((options) => (typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : ""))
      .filter((append) => append !== "")
      // Handoff ids are minted per run; everything else must be byte-stable.
      .map((append) => append.replace(/handoff_[a-z0-9]+/g, "handoff_<id>"));
    const coordinator = appends.find((append) => append.includes("sole coordinator"));
    const specialist = appends.find((append) => !append.includes("sole coordinator"));
    expect(coordinator).toBeDefined();
    expect(specialist).toBeDefined();
    expect(coordinator).toMatchSnapshot("hub coordinator append");
    expect(specialist).toMatchSnapshot("hub specialist append");
  });
});
