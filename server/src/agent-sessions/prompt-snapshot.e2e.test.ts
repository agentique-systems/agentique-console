/**
 * Pins the hub agents' system-prompt append byte-for-byte, and its size.
 * Prompt caching and operator familiarity both require these strings stable —
 * a diff in this snapshot is a regression, not an update to accept — and the
 * byte budget keeps the append a brief rather than a manual: everything here
 * competes with the native system prompt for the model's attention.
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
        yield sendHandoffUse("send-2", "digger", { action: "read the spec", status: "pending", category: "assignment" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    // A web-capable seat is pinned alongside the read-only one: the capability
    // brief once told a researcher holding WebSearch that it could "read files
    // only", and a snapshot over read-only profiles alone could not see it.
    const settled = new Set<string>();
    const done = collectUntil(h.bus, (event) => {
      if (event.type !== "agent_session.turn.settled") return false;
      const payload = JSON.stringify(event.payload);
      for (const name of ["scout", "digger"]) if (payload.includes(`"${name}"`)) settled.add(name);
      return settled.size === 2;
    }, 10_000);
    h.host.createSession({ userSessionId, title: "snapshot", agents: [{ name: "scout", profileId: "explorer" }, { name: "digger", profileId: "researcher" }],
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
    const specialist = appends.find((append) => append.startsWith("Inspect only the assigned scope"));
    const researcher = appends.find((append) => append.startsWith("Research only the assigned question"));
    expect(coordinator).toBeDefined();
    expect(specialist).toBeDefined();
    expect(researcher).toBeDefined();
    expect(coordinator).toMatchSnapshot("hub coordinator append");
    expect(specialist).toMatchSnapshot("hub specialist append");
    expect(researcher).toMatchSnapshot("hub researcher append");

    // The two failures that cost a live run its sources, asserted directly:
    // a web-capable seat must not be told it is read-only, and it must be told
    // the tools are deferred rather than absent.
    expect(researcher).toContain("search the web with WebSearch and read pages with WebFetch");
    expect(researcher).toContain('select:WebSearch,WebFetch');
    expect(researcher).not.toContain("read files only");
    // The roster line every seat reads: a coordinator assigns off this tag.
    expect(coordinator).toContain("digger (researcher; can: read-only, reads the web");
    // The grant reaches every evidence-gathering profile, not just researcher.
    expect(specialist).toContain("search the web with WebSearch");
    // The byte budget: down from 5.1/4.4/4.3 KB. A regression guard, not a
    // target — the roster line grows with the crew.
    for (const append of [coordinator!, specialist!, researcher!]) {
      const head = append.split("\n\n## Where you left off")[0]!;
      expect(Buffer.byteLength(head, "utf8")).toBeLessThanOrEqual(3_000);
    }
  });
});
