import { describe, expect, it } from "vitest";
import type { AgentRow, AgentSessionRow } from "../db/repo.ts";
import { InvalidInputError } from "../errors.ts";
import { CHILD_SENDER_PREFIX, CONSOLE_SENDER } from "./names.ts";
import { SessionRouting, type SessionRoutingDeps } from "./routing.ts";

function sessionRow(over: Partial<AgentSessionRow>): AgentSessionRow {
  return {
    id: "as_parent", userSessionId: "us_1", title: "t", lifecycle: "open",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    pattern: "hub_and_spoke", topology: {}, parentAgentSessionId: null,
    parentControllerAgent: null, depth: 0,
    ...over,
  } as AgentSessionRow;
}

function agentRow(name: string, role: string, ord: number): AgentRow {
  return { agentSessionId: "as_parent", name, role, ord } as AgentRow;
}

function routing(over: Partial<{ agents: AgentRow[]; sessions: AgentSessionRow[] }> = {}): SessionRouting {
  const agents = over.agents ?? [agentRow("coordinator", "coordinator", 0), agentRow("worker", "specialist", 1)];
  const sessions = over.sessions ?? [];
  const repo: SessionRoutingDeps["repo"] = {
    getAgent: (agentSessionId, name) => agents.find((row) => row.agentSessionId === agentSessionId && row.name === name),
    listAgents: (agentSessionId) => agents.filter((row) => row.agentSessionId === agentSessionId),
    getAgentSession: (id) => sessions.find((row) => row.id === id),
  } as SessionRoutingDeps["repo"];
  return new SessionRouting({ repo });
}

describe("assertRoute — console sender", () => {
  it("synthesizes an immediate edge toward any agent, without a contract edge", () => {
    const session = sessionRow({});
    // specialist→specialist has no hub edge; the console reaches it anyway.
    expect(routing().assertRoute(session, CONSOLE_SENDER, "worker", "decision"))
      .toEqual({ from: "console", to: "specialist", advance: "immediate" });
    expect(routing().assertRoute(session, CONSOLE_SENDER, "coordinator", "failure"))
      .toEqual({ from: "console", to: "coordinator", advance: "immediate" });
  });

  it("carries the recipient's role even when the recipient is unknown", () => {
    // The console-sender branch never validates the recipient — that stays the
    // delivery path's problem — so an unknown name synthesizes an empty role.
    expect(routing().assertRoute(sessionRow({}), CONSOLE_SENDER, "nobody", "decision"))
      .toEqual({ from: "console", to: "", advance: "immediate" });
  });
});

describe("assertRoute — child: boundary sender", () => {
  const child = sessionRow({ id: "as_child", parentAgentSessionId: "as_parent", parentControllerAgent: "coordinator", depth: 1 });

  it("accepts the child's report toward exactly its own controller", () => {
    const edge = routing({ sessions: [child] }).assertRoute(sessionRow({}), `${CHILD_SENDER_PREFIX}as_child`, "coordinator", "milestone");
    expect(edge).toEqual({ from: "child", to: "controller", advance: "immediate" });
  });

  it("rejects the child's report toward anyone but its controller", () => {
    expect(() => routing({ sessions: [child] }).assertRoute(sessionRow({}), `${CHILD_SENDER_PREFIX}as_child`, "worker", "milestone"))
      .toThrowError(InvalidInputError);
  });

  it("rejects a child sender naming an unknown session", () => {
    expect(() => routing().assertRoute(sessionRow({}), `${CHILD_SENDER_PREFIX}as_ghost`, "coordinator", "milestone"))
      .toThrowError(/reports only to its own controller/);
  });

  it("rejects a child sender whose session belongs to a different parent", () => {
    const foreign = sessionRow({ id: "as_child", parentAgentSessionId: "as_other", parentControllerAgent: "coordinator", depth: 1 });
    expect(() => routing({ sessions: [foreign] }).assertRoute(sessionRow({}), `${CHILD_SENDER_PREFIX}as_child`, "coordinator", "milestone"))
      .toThrowError(InvalidInputError);
  });
});

describe("assertRoute — contract edges", () => {
  it("denies self-address even on a legal role pair", () => {
    const agents = [agentRow("coordinator", "coordinator", 0), agentRow("a", "specialist", 1), agentRow("b", "specialist", 2)];
    expect(() => routing({ agents }).assertRoute(sessionRow({}), "a", "a", "update"))
      .toThrowError(/is not allowed/);
  });

  it("denies a hub edge the contract does not carry", () => {
    const agents = [agentRow("coordinator", "coordinator", 0), agentRow("a", "specialist", 1), agentRow("b", "specialist", 2)];
    expect(() => routing({ agents }).assertRoute(sessionRow({}), "a", "b", "update"))
      .toThrowError(/main ↔ coordinator ↔ specialist/);
  });
});
