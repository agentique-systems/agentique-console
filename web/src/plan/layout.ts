import type { PlanEdge, PlanNode } from "@agentique-console/core";

/** A layered layout from the edges: sources first; nodes on one layer share a column. */
export function layout(nodes: PlanNode[], edges: PlanEdge[]): Map<string, { layer: number; row: number }> {
  const layer = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const edge of edges) incoming.get(edge.targetNodeId)?.push(edge.sourceNodeId);
  const visit = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map((p) => visit(p, seen))) + 1;
    layer.set(id, value);
    return value;
  };
  for (const node of nodes) visit(node.id, new Set());
  const rows = new Map<number, number>();
  const out = new Map<string, { layer: number; row: number }>();
  for (const node of nodes) {
    const l = layer.get(node.id) ?? 0;
    const row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    out.set(node.id, { layer: l, row });
  }
  return out;
}

export const NODE_W = 220;
export const NODE_H = 68;
export const GAP_X = 64;
export const GAP_Y = 16;
export const PAD = 16;

export interface Placed {
  x: number;
  y: number;
}

/** Pixel positions from the layered layout; rows of a layer are centred against the tallest layer. */
export function place(positions: Map<string, { layer: number; row: number }>): { placed: Map<string, Placed>; width: number; height: number } {
  const rowsPerLayer = new Map<number, number>();
  for (const p of positions.values()) rowsPerLayer.set(p.layer, Math.max(rowsPerLayer.get(p.layer) ?? 0, p.row + 1));
  const maxRows = Math.max(0, ...rowsPerLayer.values());
  const layers = Math.max(0, ...[...rowsPerLayer.keys()].map((l) => l + 1));
  const height = maxRows * NODE_H + Math.max(0, maxRows - 1) * GAP_Y + PAD * 2;
  const width = layers * NODE_W + Math.max(0, layers - 1) * GAP_X + PAD * 2;
  const placed = new Map<string, Placed>();
  for (const [id, p] of positions) {
    const rows = rowsPerLayer.get(p.layer) ?? 1;
    const columnHeight = rows * NODE_H + (rows - 1) * GAP_Y;
    const offset = (height - PAD * 2 - columnHeight) / 2;
    placed.set(id, { x: PAD + p.layer * (NODE_W + GAP_X), y: PAD + offset + p.row * (NODE_H + GAP_Y) });
  }
  return { placed, width, height };
}
