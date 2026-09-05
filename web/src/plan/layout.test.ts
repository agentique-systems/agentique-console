import { describe, expect, it } from "vitest";
import type { PlanEdge, PlanNode } from "@agentique-console/core";
import { layout, NODE_H, NODE_W, PAD, place } from "./layout";

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

  it("centres a single-row layer against the tallest layer and sizes the canvas to fit", () => {
    const positions = layout([node("pn_a"), node("pn_b"), node("pn_c")], [edge("pe_1", "pn_a", "pn_b"), edge("pe_2", "pn_a", "pn_c")]);
    const { placed, width, height } = place(positions);
    expect(placed.get("pn_a")!.x).toBe(PAD);
    expect(placed.get("pn_b")!.y).toBe(PAD);
    // The lone source sits midway between its two dependants.
    expect(placed.get("pn_a")!.y).toBeGreaterThan(placed.get("pn_b")!.y);
    expect(placed.get("pn_a")!.y).toBeLessThan(placed.get("pn_c")!.y);
    expect(width).toBeGreaterThanOrEqual(2 * NODE_W + PAD * 2);
    expect(height).toBeGreaterThanOrEqual(2 * NODE_H + PAD * 2);
  });
});
