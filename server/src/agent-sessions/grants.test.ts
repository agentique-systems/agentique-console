/**
 * Registration and allow-list must agree BY CONSTRUCTION: buildSeatTools
 * registers exactly the tools grants.ts grants, and the spawn allow-list is
 * the same set with the MCP prefix. Before grants.ts these were two
 * hand-maintained lists that had drifted.
 */
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { AgentSessionRow, ParticipantRow, UserSessionRow } from "../db/repo.ts";
import type { ConsoleSdk } from "../sdk/types.ts";
import { grantedTools, runtimeToolNames, type SeatGrantDeps } from "./grants.ts";
import { buildSeatTools, type SeatToolsContext } from "./seat-tools.ts";
import { hubContract } from "./topology.ts";

const stubSdk = { tool: (name: string) => name, createSdkMcpServer: () => ({}) } as unknown as ConsoleSdk;

function makeProfile(runtime: Partial<AgentProfile["runtime"]> = {}): AgentProfile {
  return { id: "p", title: "p", purpose: "p", instructions: "x", tools: ["Read"], permissionMode: "default",
    maxTurns: 30, sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false, network: [], ...runtime } };
}

function makeSeat(over: Partial<ParticipantRow>): ParticipantRow {
  return { agentSessionId: "as1", name: "seat", role: "agent", instructions: "", model: null,
    profileId: "p", profileSnapshot: {}, ownership: [], sdkSessionId: null, lastActiveAt: null,
    generation: 0, turnCount: 0, contextTokens: 0, latestHandoffId: null, checkpointReady: true,
    cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, lastDecisionAt: null,
    worktreePath: null, worktreeBaseCommit: null, worktreeBranch: null,
    patternRole: null, ord: 1, createdAt: "2026-01-01", ...over };
}

function registeredNames(seat: ParticipantRow, profile: AgentProfile, roleName: string): Set<string> {
  const hub = hubContract();
  const deps: SeatGrantDeps = { tasks: true, handoffs: true, processes: true, browsers: true, worktrees: true, user: true, childSessions: true };
  const granted = grantedTools(hub.roles[roleName], profile, deps);
  const ctx = {
    sdk: stubSdk,
    deps: { repo: {}, bus: {}, tasks: {}, handoffs: {}, processes: {}, browsers: {}, worktrees: {} },
    session: { id: "as1", userSessionId: "us1" } as AgentSessionRow,
    seat, profile,
    user: { workspaceId: "ws" } as UserSessionRow,
    workspaceRoot: "/tmp/ws",
    granted,
    legalRecipient: (candidate: string) => candidate,
    post: () => { throw new Error("not exercised"); },
    askOperator: () => Promise.reject(new Error("not exercised")),
    currentTurnId: () => undefined,
    markSawSend: () => undefined,
    seatWorkState: () => "",
    simpleHandoff: () => { throw new Error("not exercised"); },
  } as unknown as SeatToolsContext;
  const names = new Set(buildSeatTools(ctx) as string[]);
  expect(runtimeToolNames(granted).sort()).toEqual([...granted].map((n) => `mcp__console_agent__${n}`).sort());
  return names;
}

function grantedNames(profile: AgentProfile, roleName: string): Set<string> {
  const deps: SeatGrantDeps = { tasks: true, handoffs: true, processes: true, browsers: true, worktrees: true, user: true, childSessions: true };
  return new Set(grantedTools(hubContract().roles[roleName], profile, deps));
}

describe("grants parity", () => {
  it("hub coordinator: registration equals the granted set", () => {
    const seat = makeSeat({ name: "orchestrator", role: "orchestrator", patternRole: "coordinator", ord: 0 });
    const profile = makeProfile();
    expect(registeredNames(seat, profile, "coordinator")).toEqual(grantedNames(profile, "coordinator"));
  });

  it("hub specialist with shell+browser: registration equals the granted set", () => {
    const seat = makeSeat({ patternRole: "specialist" });
    const profile = makeProfile({ shell: true, browser: true, screenshots: true });
    expect(registeredNames(seat, profile, "specialist")).toEqual(grantedNames(profile, "specialist"));
  });

});
