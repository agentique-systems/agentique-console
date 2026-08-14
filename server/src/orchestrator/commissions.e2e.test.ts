/**
 * The commission read-model joins by STABLE ids: the commission is the
 * creation briefing (steering never overwrites its why/expecting), the
 * outcome is the terminal report, and the status is the derived live status
 * — the exact joins the old recency-based /orchestration endpoint got wrong.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeHarness, type Harness } from "../test-helpers.ts";
import { buildCommissions } from "./commissions.ts";

describe("commission read-model", () => {
  it("keeps the briefing's rationale through steering and joins the terminal outcome", async () => {
    let mainTurns = 0;
    let hRef: Harness | null = null;
    const h = makeHarness(async function* (options) {
      const identity = agentRoleOf(options);
      yield initMessage();
      if (identity.agent === undefined) {
        mainTurns += 1;
        if (mainTurns === 1) {
          yield toolUseMessage("create-1", "mcp__console__create_agent_session", {
            title: "survey", pattern: "hub_and_spoke",
            agents: [{ name: "scout", profileId: "explorer", owns: [] }],
            briefing: {
              core: { schemaVersion: 1, taskId: null, status: "pending", risk: "low", action: "Survey the repo",
                state: { summary: "greenfield", evidence: [] }, result: { summary: null, artifacts: [] },
                uncertainty: [], nextAction: "survey", requestExpandedContext: false },
              extension: { kind: "coordination", data: {} },
            },
            why: "the shape of the repo blocks planning",
            expecting: "a per-module inventory",
          });
          yield toolUseMessage("create-2", "mcp__console__create_agent_session", {
            title: "sidecar", pattern: "hub_and_spoke",
            agents: [{ name: "watcher", profileId: "explorer", owns: [] }],
            briefing: {
              core: { schemaVersion: 1, taskId: null, status: "pending", risk: "low", action: "Watch the logs",
                state: { summary: "bg", evidence: [] }, result: { summary: null, artifacts: [] },
                uncertainty: [], nextAction: "watch", requestExpandedContext: false },
              extension: { kind: "coordination", data: {} },
            },
          });
        } else if (mainTurns === 2) {
          const surveyId = (hRef!.sqlite.prepare("SELECT id FROM agent_sessions WHERE title = 'survey'").get() as { id: string }).id;
          for (const [index, action] of ["Also check the docs", "And the CI config"].entries()) {
            yield toolUseMessage(`steer-${index}`, "mcp__console__send_to_coordinator", {
              agentSessionId: surveyId, category: "update", status: "in_progress", risk: "low",
              action, stateSummary: action, evidence: [], resultSummary: null,
              artifacts: [], uncertainty: [], nextAction: null, taskId: null, requestExpandedContext: false,
            });
          }
        }
        yield successMessage();
      } else if (identity.agent === "coordinator") {
        const sessionTitle = (hRef!.sqlite.prepare("SELECT title FROM agent_sessions WHERE id = ?").get(identity.agentSessionId) as { title: string }).title;
        if (sessionTitle === "survey") {
          yield sendHandoffUse("c-final", "main", { action: "surveyed: 12 modules", status: "completed", category: "final" });
        }
        yield successMessage();
      } else {
        yield successMessage();
      }
    });
    hRef = h;
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) =>
      event.type === "handoff.created" &&
      String((event.payload as { handoff?: { action?: string } }).handoff?.action ?? "").includes("And the CI config"), 10_000);
    h.runner.postOperatorMessage(userSessionId, "survey");
    await done;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const commissions = buildCommissions({ repo: h.repo, statusOf: (row) => h.host.statusOf(row) }, userSessionId);
    expect(commissions).toHaveLength(2);
    const survey = commissions.find((row) => row.title === "survey")!;
    const sidecar = commissions.find((row) => row.title === "sidecar")!;

    // The commission is the FIRST briefing — two later steers didn't touch it.
    expect(survey.commission).toMatchObject({
      action: "Survey the repo",
      why: "the shape of the repo blocks planning",
      expecting: "a per-module inventory",
    });
    expect(survey.steering.count).toBe(2);
    // The outcome is the terminal report, by stable id.
    expect(survey.outcome).toMatchObject({ trigger: "final", status: "completed" });
    expect(survey.outcome!.action).toContain("surveyed");
    const outcomeRow = h.repo.listHandoffs({ userSessionId, agentSessionId: survey.agentSessionId, recipient: "main", excludeCheckpoints: true, excludeSynthetic: true })
      .filter((row) => row.trigger === "final").at(-1);
    expect(survey.outcome!.handoffId).toBe(outcomeRow!.id);
    // The briefing id is the first non-synthetic main assignment's id.
    const briefingRow = h.repo.listHandoffs({ userSessionId, agentSessionId: survey.agentSessionId, sender: "main", excludeCheckpoints: true, excludeSynthetic: true })[0]!;
    expect(survey.commission!.handoffId).toBe(briefingRow.id);

    // A commission without rationale reports nulls, not boilerplate; no
    // outcome yet reports null; derived status is live, not a lifecycle bit.
    expect(sidecar.commission).toMatchObject({ why: null, expecting: null });
    expect(sidecar.outcome).toBeNull();
    expect(["working", "idle"]).toContain(sidecar.status);
    expect(["reported"]).toContain(survey.status);
    expect(survey.parentAgentSessionId).toBeNull();
  });
});
