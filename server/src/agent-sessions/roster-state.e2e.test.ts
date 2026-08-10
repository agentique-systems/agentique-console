/**
 * Every delivery prompt carries what the other seats are doing.
 *
 * `#composePrompt` rendered per-seat work state only when `p.worktreeBranch`
 * was set. db-live-2's workspace was not a git repo, so no seat had a worktree
 * and every roster line degraded to name/profile/owns. The cost of that
 * blindness, from that run:
 *
 *   - `renderer` wrote `.renderer-dev/serve.mjs` + `harness.html` and ran a
 *     second dev server on :8199 for ~16 minutes — duplicating infrastructure
 *     `page` had already written and was serving.
 *   - `renderer` then re-ran `check`'s entire verification (browser_open,
 *     snapshots, key presses) 23:43:28–23:44:53, which `check` redid in full
 *     23:46:39–23:53:35.
 *   - `renderer` and `page` independently diagnosed the same CDN outage,
 *     ~3m20s of duplicated network probing, neither telling the other.
 *
 * The comment above the roster line already said this data exists to prevent
 * exactly that. It just wasn't rendered.
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
  it("tells each seat what the others are doing, with no git repo in sight", async () => {
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

    // Give `page` a reported milestone, then deliver to `renderer` — the exact
    // moment db-live-2's renderer decided to build its own server.
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "agent", name: "page" }, to: "orchestrator",
      handoff: handoff("serve.mjs and index.html are written and serving", "completed"),
      category: "milestone",
    });
    h.host.post({
      agentSessionId: created.agentSessionId,
      speaker: { kind: "orchestrator", name: "orchestrator" }, to: "renderer",
      handoff: handoff("implement src/game.js"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.mailbox"
        && (event.payload as { recipient?: string }).recipient === "renderer"
        && (event.payload as { status?: string }).status === "delivered",
      10_000,
    );

    const rendererPrompt = h.fake.captured.prompts.find((text) => text.includes("You are renderer."));
    expect(rendererPrompt).toBeDefined();

    // No worktree anywhere — this is the non-git case that produced the blind
    // roster.
    expect(h.repo.getParticipant(created.agentSessionId, "page")?.worktreePath).toBeNull();

    // renderer can see that page exists, what it owns, and that it has already
    // reported. Before this change the line stopped at `owns:`.
    expect(rendererPrompt).toContain("page (implementer");
    expect(rendererPrompt).toContain("index.html");
    expect(rendererPrompt).toMatch(/page \(implementer[^)]*last reported completed: serve\.mjs and index\.html are written and serving/);
  });

  it("says 'not started' for a seat that has never run", async () => {
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
      speaker: { kind: "orchestrator", name: "orchestrator" }, to: "dev",
      handoff: handoff("implement src/app.ts"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.mailbox"
        && (event.payload as { recipient?: string }).recipient === "dev"
        && (event.payload as { status?: string }).status === "delivered",
      10_000,
    );

    const devPrompt = h.fake.captured.prompts.find((text) => text.includes("You are dev."));
    // A seat waiting on a dependency reads as idle, not as absent — which is
    // what `ls`-ing the workspace told db-live-1's coordinator instead.
    expect(devPrompt).toMatch(/check \(visual-reviewer[^)]*not started/);
  });
});
