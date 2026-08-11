import { describe, expect, it } from "vitest";
import type { TopologyContract } from "./topology-contract.ts";
import { compileContract, contractOfSession, hubContract, roleOfAgent } from "./topology.ts";

describe("topology contracts", () => {
  it("hub contract encodes exactly the legacy route table", () => {
    const hub = compileContract(hubContract());
    expect(hub.edge("main", "coordinator")?.advance).toBe("immediate");
    expect(hub.edge("coordinator", "main")?.advance).toBe("immediate");
    expect(hub.edge("coordinator", "specialist")?.advance).toBe("immediate");
    expect(hub.edge("specialist", "coordinator")?.advance).toBe("immediate");
    // The three hops the star has always denied.
    expect(hub.edge("specialist", "specialist")).toBeUndefined();
    expect(hub.edge("specialist", "main")).toBeUndefined();
    expect(hub.edge("main", "specialist")).toBeUndefined();
  });

  it("resolves an agent's contract role from its role binding", () => {
    expect(roleOfAgent({ role: "coordinator" })).toBe("coordinator");
    expect(roleOfAgent({ role: "specialist" })).toBe("specialist");
    expect(roleOfAgent({ role: "mapper" })).toBe("mapper");
  });

  it("reads an empty topology snapshot as the hub default", () => {
    expect(contractOfSession({ topology: {} }).pattern).toBe("hub_and_spoke");
    expect(contractOfSession({ topology: {} }).routeSummary).toBe("main ↔ coordinator ↔ specialist");
    const custom = { ...hubContract(), pattern: "pipeline" } as TopologyContract;
    expect(contractOfSession({ topology: custom as unknown as Record<string, unknown> }).pattern).toBe("pipeline");
  });

  it("hub roles carry the coordinator-only grants and escalation targets", () => {
    const hub = compileContract(hubContract());
    expect(hub.role("coordinator")?.grants).toContain("tasks_write");
    expect(hub.role("coordinator")?.grants).toContain("forward_message");
    expect(hub.role("specialist")?.grants).toEqual([]);
    expect(hub.role("coordinator")?.escalateTo).toBe("main");
    expect(hub.role("specialist")?.escalateTo).toBe("coordinator");
  });
});
