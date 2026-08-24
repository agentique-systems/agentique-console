/**
 * Registration and allow-list must agree BY CONSTRUCTION: buildAgentTools
 * registers exactly the tools grants.ts grants, and the spawn allow-list is
 * the same set with the MCP prefix. Before grants.ts these were two
 * hand-maintained lists that had drifted.
 */
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { AgentSessionRow, AgentRow, UserSessionRow } from "../db/repo.ts";
import type { ConsoleSdk } from "../sdk/types.ts";
import { grantedTools, runtimeToolNames, type AgentGrantDeps } from "./grants.ts";
import { buildAgentTools, type AgentToolsContext } from "./agent-tools.ts";
import { hubContract } from "./topology.ts";

const stubSdk = { tool: (name: string) => name, createSdkMcpServer: () => ({}) } as unknown as ConsoleSdk;

function makeProfile(over: Partial<AgentProfile> = {}): AgentProfile {
  return { id: "p", title: "p", purpose: "p", instructions: "x", tools: ["Read"], permissionMode: "default",
    exemptFromOwnership: false, maxTurns: 30, mcpServers: {}, ...over };
}

function makeAgent(over: Partial<AgentRow>): AgentRow {
  return { agentSessionId: "as1", name: "agent", role: "specialist", instructions: "", model: null,
    profileId: "p", profileSnapshot: {}, ownership: [], sharedOwnership: [], sdkSessionId: null, lastActiveAt: null,
    generation: 0, turnCount: 0, contextTokens: 0, latestHandoffId: null,
    cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, lastDecisionAt: null,
    worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null,
    salvageBranch: null, salvageArtifactId: null,
    ord: 1, createdAt: "2026-01-01", ...over };
}

function registeredNames(agent: AgentRow, profile: AgentProfile, roleName: string): Set<string> {
  const hub = hubContract();
  const deps: AgentGrantDeps = { tasks: true, handoffs: true, worktrees: true, user: true, specs: true, childSessions: true };
  const granted = grantedTools(hub.roles[roleName], profile, deps);
  const ctx = {
    sdk: stubSdk,
    deps: { repo: {}, bus: {}, tasks: {}, handoffs: {}, worktrees: {}, requirements: {} },
    session: { id: "as1", userSessionId: "us1" } as AgentSessionRow,
    agent, profile,
    user: { workspaceId: "ws" } as UserSessionRow,
    workspaceRoot: "/tmp/ws",
    granted,
    legalRecipient: (candidate: string) => candidate,
    post: () => { throw new Error("not exercised"); },
    askOperator: () => Promise.reject(new Error("not exercised")),
    currentTurnId: () => undefined,
    markSawSend: () => undefined,
    agentWorkState: () => "",
    simpleHandoff: () => { throw new Error("not exercised"); },
  } as unknown as AgentToolsContext;
  const names = new Set(buildAgentTools(ctx) as string[]);
  expect(runtimeToolNames(granted).sort()).toEqual([...granted].map((n) => `mcp__console_agent__${n}`).sort());
  return names;
}

function grantedNames(profile: AgentProfile, roleName: string): Set<string> {
  const deps: AgentGrantDeps = { tasks: true, handoffs: true, worktrees: true, user: true, specs: true, childSessions: true };
  return new Set(grantedTools(hubContract().roles[roleName], profile, deps));
}

describe("grants parity", () => {
  it("hub coordinator: registration equals the granted set", () => {
    const agent = makeAgent({ name: "coordinator", role: "coordinator", ord: 0 });
    const profile = makeProfile();
    expect(registeredNames(agent, profile, "coordinator")).toEqual(grantedNames(profile, "coordinator"));
  });

  it("hub specialist: registration equals the granted set", () => {
    const agent = makeAgent({ role: "specialist" });
    const profile = makeProfile();
    expect(registeredNames(agent, profile, "specialist")).toEqual(grantedNames(profile, "specialist"));
  });

  // Review regression: report/decompose registration follows the ENTRY SEAT,
  // not the delegation existing at spawn — a delegation can arrive mid-run
  // (send_to_coordinator requirements) after the tool list froze, and
  // authorization is checked live per call (assertWithinDelegation).
  it("the entry seat holds report/decompose without a spawn-time delegation; other seats do not", () => {
    const profile = makeProfile();
    const deps: AgentGrantDeps = { tasks: true, handoffs: true, worktrees: true, user: true, specs: true, childSessions: true };
    const entry = grantedTools({ grants: [] }, profile, { ...deps, requirementsEntrySeat: true });
    expect(entry.has("report_requirement")).toBe(true);
    expect(entry.has("decompose_requirement")).toBe(true);
    const nonEntry = grantedTools({ grants: [] }, profile, { ...deps, requirementsEntrySeat: false });
    expect(nonEntry.has("report_requirement")).toBe(false);
    expect(nonEntry.has("read_requirements")).toBe(true);
  });

  // The independent tier derives only from a write-isolated reviewer's own
  // claim, so a reviewer-archetype seat holds report_requirement wherever it
  // sits in the topology — without inheriting decompose (scoping stays with
  // the entry seat and role grants).
  it("a reviewer-archetype seat holds report_requirement without an entry grant", () => {
    const deps: AgentGrantDeps = { tasks: true, handoffs: true, worktrees: true, user: true, specs: true, childSessions: true };
    const reviewer = grantedTools({ grants: [] }, makeProfile({ role: "reviewer" }), { ...deps, requirementsEntrySeat: false });
    expect(reviewer.has("report_requirement")).toBe(true);
    expect(reviewer.has("decompose_requirement")).toBe(false);
  });

  // The Console grants COORDINATION and nothing else. Capability is native
  // Bash plus whatever MCP servers a profile declares, so no console tool name
  // may ever describe a browser, a process, or an HTTP request again.
  it("grants no capability tools, whatever the profile asks for", () => {
    const profile = makeProfile();
    for (const role of ["coordinator", "specialist"]) {
      for (const name of grantedNames(profile, role)) {
        expect(name).not.toMatch(/^(browser_|process_|http_probe)/);
      }
    }
  });

});
