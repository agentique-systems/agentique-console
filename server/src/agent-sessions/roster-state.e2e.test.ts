/**
 * Every delivery prompt carries what the other agents are doing — for every
 * agent, worktree or not, so nobody infers a teammate's absence from `ls`.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string, status: "pending" | "completed" = "pending") => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
    action, state: { summary: action, evidence: [] },
    result: { summary: status === "completed" ? action : null, artifacts: [] },
    uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

describe("roster work state (no worktrees)", () => {
  it("tells each agent what the others are doing, with no git repo in sight", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "lane runner", agents: [
        { name: "renderer", profileId: "implementer", owns: ["src/game.js"] },
        { name: "page", profileId: "implementer", owns: ["index.html", "serve.mjs"] },
      ],
      briefing: handoff("build the game"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    // Give `page` a reported milestone, then deliver to `renderer` — the
    // moment a blind renderer would decide to build its own server.
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "agent", name: "page" }, to: "coordinator",
      handoff: handoff("serve.mjs and index.html are written and serving", "completed"),
      category: "milestone",
    });
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" }, to: "renderer",
      handoff: handoff("implement src/game.js"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.delivery.updated"
        && (event.payload as { recipient?: string }).recipient === "renderer"
        && (event.payload as { status?: string }).status === "delivered",
      10_000,
    );

    const rendererPrompt = h.fake.captured.prompts.find((text) => text.includes("You are renderer."));
    expect(rendererPrompt).toBeDefined();

    // No worktree anywhere — this is the non-git case that produced the blind
    // roster.
    expect(h.repo.getAgent(created.agentSessionId, "page")?.worktreePath).toBeNull();

    // renderer can see that page exists, what it owns, and that it has already
    // reported.
    expect(rendererPrompt).toContain("page (implementer");
    expect(rendererPrompt).toContain("index.html");
    expect(rendererPrompt).toMatch(/page \(implementer[^)]*last reported completed: serve\.mjs and index\.html are written and serving/);
  });

  it("says 'not started' for an agent that has never run", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "gated", agents: [
        { name: "dev", profileId: "implementer", owns: ["src/app.ts"] },
        { name: "check", profileId: "visual-reviewer", owns: [] },
      ],
      briefing: handoff("build it"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "coordinator" }, to: "dev",
      handoff: handoff("implement src/app.ts"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.delivery.updated"
        && (event.payload as { recipient?: string }).recipient === "dev"
        && (event.payload as { status?: string }).status === "delivered",
      10_000,
    );

    const devPrompt = h.fake.captured.prompts.find((text) => text.includes("You are dev."));
    // An agent waiting on a dependency reads as idle, not as absent.
    expect(devPrompt).toMatch(/check \(visual-reviewer[^)]*not started/);
  });
});
