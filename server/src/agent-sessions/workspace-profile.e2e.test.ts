/**
 * The native-definition round trip: a genuine `.claude/agents/*.md` file is
 * discovered as a candidate profile, trust-gated, and instantiated as an
 * AgentSession seat whose options carry exactly the granted surface — while
 * the native `Agent` tool that would run the same file natively stays denied
 * for every lane. The definition means the same thing everywhere; only the
 * execution engine differs, by policy.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const NATIVE = `---
name: fixture-auditor
description: Audits the fixture workspace
tools: Read, Grep, Bash, Skill
mcpServers:
  - github
  - probe:
      command: /bin/true
agentique:
  role: reviewer
  exemptFromOwnership: true
  assignmentTurnBudget: 12
  recommendedSkills: [handoff-discipline]
---
Audit the assigned scope and report concrete findings.
`;

const briefing = { core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
  action: "audit", state: { summary: "audit", evidence: [] }, result: { summary: null, artifacts: [] },
  uncertainty: [], nextAction: "audit", requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } };

function program() {
  let coordinatorTurns = 0;
  return async function* (options: { systemPrompt?: unknown }) {
    const append = typeof options.systemPrompt === "object" && options.systemPrompt !== null && !Array.isArray(options.systemPrompt)
      ? ((options.systemPrompt as { append?: string }).append ?? "") : "";
    const coordinator = append.includes("sole coordinator");
    yield initMessage(coordinator ? `coord-${(coordinatorTurns += 1)}` : "auditor-1");
    if (coordinator) {
      yield coordinatorTurns === 1
        ? sendHandoffUse("send-1", "auditor", { action: "audit", status: "pending", category: "assignment" })
        : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "done", status: "completed", category: "final" });
    } else {
      yield sendHandoffUse("auditor-close", "coordinator", { action: "audited", status: "completed", category: "milestone" });
    }
    yield successMessage();
  };
}

describe("native workspace profiles end to end", () => {
  it("discover → trust → instantiate; the seat holds the declared surface and the Agent tool stays denied", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-native-ws-")); dirs.push(workspaceRoot);
    fs.mkdirSync(path.join(workspaceRoot, ".claude", "agents"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, ".claude", "agents", "fixture-auditor.md"), NATIVE);
    // The ref target: the workspace's own native MCP config launches it.
    fs.writeFileSync(path.join(workspaceRoot, ".mcp.json"), JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));
    const h = makeDelegationHarness(program(), { workspaceRoot });
    const userSessionId = h.addUserSession();

    // Discoverable as workspace configuration; untrusted = not instantiable.
    const summary = h.app.profiles.summaries(h.workspaceId).find((entry) => entry.id === "fixture-auditor");
    expect(summary).toMatchObject({ claudeValid: true, agentiqueCompatible: true, trusted: false });
    expect(() => h.host.createSession({ userSessionId, title: "audit", agents: [{ name: "auditor", profileId: "fixture-auditor" }], briefing }))
      .toThrow(/not trusted/);

    h.app.profiles.trust(h.workspaceId, "fixture-auditor", summary!.revision);
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 10_000);
    h.host.createSession({ userSessionId, title: "audit", agents: [{ name: "auditor", profileId: "fixture-auditor" }], briefing });
    await done;

    const options = h.fake.captured.options.find((opts) => agentRoleOf(opts).agent === "auditor");
    expect(options).toBeDefined();
    // The declared native surface, exactly — plus the declared MCP servers,
    // auto-approved whole. One launcher per declaration: the stdio form is
    // console-launched; the `github` ref is GRANTED but launched by the
    // workspace's own .mcp.json (SDK-owned), so the console's launch map
    // must not carry it.
    expect(options?.allowedTools).toEqual(expect.arrayContaining(["Read", "Grep", "Bash", "Skill", "mcp__probe", "mcp__github"]));
    expect(options?.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "ToolSearch", "WebSearch", "Agent", "Task", "AskUserQuestion"]));
    expect((options?.mcpServers as Record<string, { command?: string }>)?.probe).toMatchObject({ command: "/bin/true" });
    expect((options?.mcpServers as Record<string, unknown>)?.github).toBeUndefined();
    // A single-file native profile brings no plugin of its own — only the
    // console skills plugin loads.
    expect((options?.plugins as { path: string }[]).map((plugin) => plugin.path)).toEqual([h.config.infra.skillsPluginDir]);
    // The body is the system prompt; the overlay drove role and budget.
    const append = (options?.systemPrompt as { append?: string })?.append ?? "";
    expect(append).toContain("Audit the assigned scope");
  });
});
