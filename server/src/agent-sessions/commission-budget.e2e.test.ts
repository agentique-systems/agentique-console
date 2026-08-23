/**
 * The per-commission budget: an optional USD ceiling on a session and its
 * children. Crossing it fires exactly two one-shot notices — an honest
 * wrap-up instruction to the entry agent and an escalation milestone to main
 * naming the delegated open frontier — whose durable mailbox dedupe survives
 * re-checks and restarts. Stop-and-escalate, never acceptance: nothing is
 * cancelled, the run does not pause, and the read surfaces carry
 * budget + spend.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness, restartHarness } from "../test-helpers.ts";
import { nowIso, newId } from "../ids.ts";

const briefing = (action: string) => ({
  core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false },
  extension: { kind: "generic" as const, data: {} },
});

const DOC = `## Requirements
- Auth works end to end
- \`npm run verify\` passes
`;

function spend(h: ReturnType<typeof makeDelegationHarness>, userSessionId: string, agentSessionId: string, costUsd: number): void {
  h.repo.insertUsage({ id: newId("usage"), userSessionId, agentSessionId, participant: "coordinator",
    profileId: "coordinator", generation: 0, turnId: newId("turn"), inputTokens: 10, uncachedInputTokens: 10,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 10, costUsd, model: null, effort: null,
    trigger: "delivery", durationMs: null, apiDurationMs: null, sdkDurationMs: null, status: "completed",
    stopReason: null, createdAt: nowIso() });
}

function budgetNotices(h: ReturnType<typeof makeDelegationHarness>): { toMain: number; toSession: number } {
  const rows = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.message.appended'").all()
    .map((row) => String((row as { payload: string }).payload))
    .filter((payload) => payload.includes("Commission budget exhausted"));
  return {
    toMain: rows.filter((payload) => payload.includes("Commission budget exhausted:")).length,
    toSession: rows.filter((payload) => !payload.includes("Commission budget exhausted:")).length,
  };
}

describe("commission budgets (fake SDK)", () => {
  it("fires two one-shot notices on crossing, durable across re-checks and restart, without pausing", { timeout: 25_000 }, async () => {
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "coordinator") {
        coordinatorTurns += 1;
        yield coordinatorTurns === 1
          ? sendHandoffUse("a-1", "scout", { action: "look", status: "pending", category: "assignment" })
          : sendHandoffUse("f-1", "main", { action: "done", status: "completed", category: "final" });
      } else {
        yield sendHandoffUse("s-1", "coordinator", { action: "seen", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const draft = h.app.requirements.propose(userSessionId, DOC, "initial");
    h.app.requirements.approve(draft.id, { document: DOC, edited: false });
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({
      userSessionId, title: "budgeted work", agents: [{ name: "scout", profileId: "explorer" }],
      briefing: briefing("go"), requirements: ["r1"], budgetUsd: 1,
    });
    await done;

    // Under budget: a check is a no-op.
    spend(h, userSessionId, created.agentSessionId, 0.4);
    h.host.checkCommissionBudget(created.agentSessionId);
    expect(budgetNotices(h)).toEqual({ toMain: 0, toSession: 0 });

    // Crossing fires both notices; the escalation names the delegated frontier.
    spend(h, userSessionId, created.agentSessionId, 0.8);
    h.host.checkCommissionBudget(created.agentSessionId);
    expect(budgetNotices(h)).toEqual({ toMain: 1, toSession: 1 });
    const escalation = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.message.appended'").all()
      .map((row) => String((row as { payload: string }).payload))
      .find((payload) => payload.includes("Commission budget exhausted:"));
    expect(escalation).toContain("$1.20 of its $1.00");
    expect(escalation).toContain("r1 (Auth works end to end)");
    expect(escalation).not.toContain("r2");

    // Nothing paused, nothing cancelled.
    expect(h.repo.getUserSession(userSessionId)?.pauseReason ?? null).toBeNull();
    expect(h.repo.getAgentSession(created.agentSessionId)?.lifecycle).toBe("open");

    // Re-check and restart are dedupe no-ops (durable delivery rows).
    h.host.checkCommissionBudget(created.agentSessionId);
    expect(budgetNotices(h)).toEqual({ toMain: 1, toSession: 1 });
    const restarted = await restartHarness(h);
    restarted.host.checkCommissionBudget(created.agentSessionId);
    expect(budgetNotices(restarted)).toEqual({ toMain: 1, toSession: 1 });

    // The read surfaces carry budget + spend (float sums, so closeTo).
    const listed = restarted.host.listForUserSession(userSessionId).find((row) => row.id === created.agentSessionId);
    expect(listed?.budget?.budgetUsd).toBe(1);
    expect(listed?.budget?.spendUsd).toBeCloseTo(1.2);
    expect(restarted.host.activity(created.agentSessionId).budget?.spendUsd).toBeCloseTo(1.2);
    expect(restarted.host.wireSession(restarted.repo.getAgentSession(created.agentSessionId)!).budget?.spendUsd)
      .toBeCloseTo(1.2);
  });

  it("a child session's spend bills its budgeted ancestor", { timeout: 25_000 }, async () => {
    let coordinatorSeen = 0;
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "coordinator") {
        coordinatorSeen += 1;
        if (coordinatorSeen === 1) {
          yield sendHandoffUse("a-1", "scout", { action: "look", status: "pending", category: "assignment" });
        }
      } else {
        yield sendHandoffUse("s-1", "coordinator", { action: "seen", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const parent = h.host.createSession({
      userSessionId, title: "parent", agents: [{ name: "scout", profileId: "explorer" }],
      briefing: briefing("parent work"), budgetUsd: 1,
    });
    await done;
    const child = h.host.createSession({
      userSessionId, title: "child", agents: [{ name: "kid", profileId: "explorer" }],
      parent: { agentSessionId: parent.agentSessionId, controllerAgent: "coordinator" },
    });

    spend(h, userSessionId, child.agentSessionId, 1.5);
    // The check starts from the CHILD (the recording session) and walks up.
    h.host.checkCommissionBudget(child.agentSessionId);
    expect(budgetNotices(h)).toEqual({ toMain: 1, toSession: 1 });
    expect(h.host.commissionBudget(h.repo.getAgentSession(parent.agentSessionId)!))
      .toMatchObject({ budgetUsd: 1, spendUsd: 1.5 });
  });
});
