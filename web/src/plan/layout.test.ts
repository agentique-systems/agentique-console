import { describe, expect, it } from "vitest";
import type { PlanEdge, PlanNode } from "@agentique-console/core";
import { layout } from "./panel";

const node = (id: string) => ({ id, kind: "pattern", status: "pending" }) as unknown as PlanNode;
const edge = (id: string, sourceNodeId: string, targetNodeId: string) => ({ id, sourceNodeId, targetNodeId, type: "sequence" }) as unknown as PlanEdge;

describe("plan layout", () => {
  it("places sources first and dependants one layer later; siblings share a layer", () => {
    const positions = layout([node("pn_a"), node("pn_b"), node("pn_c"), node("pn_d")], [edge("pe_1", "pn_a", "pn_b"), edge("pe_2", "pn_a", "pn_c"), edge("pe_3", "pn_b", "pn_d"), edge("pe_4", "pn_c", "pn_d")]);
    expect(positions.get("pn_a")).toEqual({ layer: 0, row: 0 });
    expect(positions.get("pn_b")).toEqual({ layer: 1, row: 0 });
    expect(positions.get("pn_c")).toEqual({ layer: 1, row: 1 });
    expect(positions.get("pn_d")).toEqual({ layer: 2, row: 0 });
  });
});
