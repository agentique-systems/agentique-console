/**
 * The SDK options a seat spawns with, asserted on what the fake SDK captured:
 * CLI parity for settings and skills, effort resolution, and — for a seat
 * WITHOUT a worktree — the profile-bound tool surface. (Isolated seats are
 * covered in seat-worktree.e2e.)
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { GOVERNED_BUILTIN_TOOLS } from "./composer.ts";

const briefing = { core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
  action: "look", state: { summary: "look", evidence: [] }, result: { summary: null, artifacts: [] },
  uncertainty: [], nextAction: "look", requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } };

function program() {
  let coordinatorTurns = 0;
  return async function* (options: { env?: Record<string, string | undefined> }) {
    const role = agentRoleOf(options).role;
    yield initMessage(`${agentRoleOf(options).agent}-1`);
    if (role === "coordinator") {
      coordinatorTurns += 1;
      yield coordinatorTurns === 1
        ? sendHandoffUse("send-1", "scout", { action: "look", status: "pending", category: "assignment" })
        : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "done", status: "completed", category: "final" });
    } else {
      yield sendHandoffUse("scout-1", "coordinator", { action: "looked", status: "completed", category: "milestone" });
    }
    yield successMessage();
  };
}

async function spawnHub(harnessOptions: Parameters<typeof makeDelegationHarness>[1] = {}) {
  const h = makeDelegationHarness(program(), harnessOptions);
  const userSessionId = h.addUserSession();
  const done = collectUntil(h.bus, (event) => event.type === "agent_session.tool.called" && event.payload.agent === "scout", 10_000);
  h.host.createSession({ userSessionId, title: "options", agents: [{ name: "scout", profileId: "explorer" }], briefing });
  await done;
  const byRole = (role: string) => h.fake.captured.options.find((options) => agentRoleOf(options).role === role);
  return { h, coordinator: byRole("coordinator"), scout: byRole("specialist") };
}

describe("seat spawn options", () => {
  it("loads settings, CLAUDE.md and skills like the CLI, and keeps the console skills plugin", async () => {
    const { h, coordinator, scout } = await spawnHub();
    for (const options of [coordinator, scout]) {
      expect(options?.settingSources).toEqual(["user", "project", "local"]);
      expect(options?.skills).toBe("all");
      expect(options?.plugins).toEqual(expect.arrayContaining([{ type: "local", path: h.config.infra.skillsPluginDir }]));
    }
  });

  it("runs at the profile's effort unless CONSOLE_EFFORT overrides it", async () => {
    const { coordinator, scout } = await spawnHub();
    expect(coordinator?.effort).toBe("high");
    expect(scout?.effort).toBe("high");
    const overridden = await spawnHub({ config: { infra: { effort: "low" } } });
    expect(overridden.coordinator?.effort).toBe("low");
    expect(overridden.scout?.effort).toBe("low");
  });

  it("the profile's tool list is binding — worktree or not", async () => {
    // The harness runs with worktrees: null; the isolated counterpart is in
    // seat-worktree.e2e and holds the SAME surface: effectiveNativeTools has
    // no worktree input at all, so containment cannot widen a grant.
    const { coordinator, scout } = await spawnHub();
    for (const options of [coordinator, scout]) {
      expect(options?.allowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "ToolSearch", "Skill"]));
      expect(options?.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "Bash", "NotebookEdit", "Agent", "Task", "SendMessage", "TaskCreate"]));
      expect(options?.allowedTools).not.toEqual(expect.arrayContaining(GOVERNED_BUILTIN_TOOLS.filter((tool) => ["Edit", "Write", "Bash", "NotebookEdit"].includes(tool))));
    }
  });

  it("denies the scheduling, task-state, plan-mode, human-surface and host-surface natives for every seat", async () => {
    const { coordinator, scout } = await spawnHub();
    for (const options of [coordinator, scout]) {
      expect(options?.disallowedTools).toEqual(expect.arrayContaining([
        "ScheduleWakeup", "CronCreate", "RemoteTrigger",
        "TodoWrite", "TaskCreate", "TaskList",
        "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
        "Workflow", "ListAgents",
        "Artifact", "PushNotification", "REPL",
      ]));
    }
  });
});
