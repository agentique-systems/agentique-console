/**
 * The tree module's invariants: runtime, inspection, timeline and portfolio
 * all consume these walks, so parent/child/root/depth agreeing HERE is what
 * keeps them agreeing everywhere. The fixture is the depth the default
 * config actually permits (maxSessionDepth 2 — root, child, grandchild).
 */
import { describe, expect, it } from "vitest";
import type { AgentSessionRow } from "../db/repo.ts";
import { orderedSessionForest, sessionAncestors, sessionSubtree, sessionTree, type SessionTreeSource } from "./session-tree.ts";

const row = (id: string, parent: string | null, depth: number, createdAt: string): AgentSessionRow => ({
  id, userSessionId: "us_1", title: id, lifecycle: "open",
  pattern: "hub_and_spoke", topology: {}, parentAgentSessionId: parent,
  parentControllerAgent: parent === null ? null : "coordinator",
  depth, allowChildSessions: false, budgetUsd: null,
  createdAt, updatedAt: createdAt,
});

/**
 * main ── A ── A1 ── A1a   (A1a at depth 2, the default cap)
 *        │     └ A2
 *        └ B ── B1
 */
const FIXTURE: AgentSessionRow[] = [
  row("as_A", null, 0, "2026-08-01T10:00:00.000Z"),
  row("as_A1", "as_A", 1, "2026-08-01T10:01:00.000Z"),
  row("as_A1a", "as_A1", 2, "2026-08-01T10:02:00.000Z"),
  row("as_A2", "as_A", 1, "2026-08-01T10:03:00.000Z"),
  row("as_B", null, 0, "2026-08-01T10:04:00.000Z"),
  row("as_B1", "as_B", 1, "2026-08-01T10:05:00.000Z"),
];

const source = (rows: AgentSessionRow[]): SessionTreeSource => ({
  getAgentSession: (id) => rows.find((r) => r.id === id),
  listChildSessions: (parentId) => rows.filter((r) => r.parentAgentSessionId === parentId),
});

const shuffled = <T,>(input: readonly T[], seed: number): T[] => {
  const out = [...input];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

describe("orderedSessionForest", () => {
  it("is depth-first pre-order — every session directly after its parent, at every depth", () => {
    const ids = orderedSessionForest(FIXTURE).map((r) => r.id);
    expect(ids).toEqual(["as_A", "as_A1", "as_A1a", "as_A2", "as_B", "as_B1"]);
  });

  it("never depends on input (DB return) order", () => {
    const expected = orderedSessionForest(FIXTURE).map((r) => r.id);
    for (const seed of [1, 7, 42, 1337]) {
      expect(orderedSessionForest(shuffled(FIXTURE, seed)).map((r) => r.id)).toEqual(expected);
    }
  });

  it("breaks same-millisecond sibling ties by id, deterministically", () => {
    const at = "2026-08-01T10:00:00.000Z";
    const rows = [row("as_z", null, 0, at), row("as_a", null, 0, at), row("as_m", null, 0, at)];
    expect(orderedSessionForest(rows).map((r) => r.id)).toEqual(["as_a", "as_m", "as_z"]);
    expect(orderedSessionForest(rows.reverse()).map((r) => r.id)).toEqual(["as_a", "as_m", "as_z"]);
  });

  it("renders a row whose parent is missing as a root — a session must never disappear", () => {
    const orphaned = FIXTURE.filter((r) => r.id !== "as_A1"); // A1a's parent gone
    const ids = orderedSessionForest(orphaned).map((r) => r.id);
    expect(ids).toContain("as_A1a");
    // Still deterministic, still every remaining row exactly once.
    expect(ids).toHaveLength(orphaned.length);
    expect(new Set(ids).size).toBe(orphaned.length);
  });

  it("includes archived rows — history stays inspectable; callers filter", () => {
    const withArchived = FIXTURE.map((r) => r.id === "as_A2" ? { ...r, lifecycle: "archived" as const } : r);
    expect(orderedSessionForest(withArchived).map((r) => r.id)).toContain("as_A2");
  });
});

describe("sessionAncestors", () => {
  it("walks nearest-first to the root", () => {
    expect(sessionAncestors(source(FIXTURE), "as_A1a").map((r) => r.id)).toEqual(["as_A1", "as_A"]);
    expect(sessionAncestors(source(FIXTURE), "as_A").map((r) => r.id)).toEqual([]);
  });

  it("agrees with the stored depth column at every node", () => {
    for (const node of FIXTURE) {
      expect(sessionAncestors(source(FIXTURE), node.id)).toHaveLength(node.depth);
    }
  });

  it("terminates on a corrupt parent cycle instead of hanging", () => {
    const a = row("as_x", "as_y", 1, "2026-08-01T10:00:00.000Z");
    const b = row("as_y", "as_x", 1, "2026-08-01T10:00:01.000Z");
    expect(sessionAncestors(source([a, b]), "as_x").map((r) => r.id)).toEqual(["as_y"]);
  });
});

describe("sessionSubtree / sessionTree agreement", () => {
  it("subtree covers every descendant at every depth, and tree finds the true root from a leaf", () => {
    expect(new Set(sessionSubtree(source(FIXTURE), "as_A").map((r) => r.id)))
      .toEqual(new Set(["as_A", "as_A1", "as_A1a", "as_A2"]));
    const fromLeaf = sessionTree(source(FIXTURE), "as_A1a").map((r) => r.id);
    expect(fromLeaf[0]).toBe("as_A");
    expect(new Set(fromLeaf)).toEqual(new Set(["as_A", "as_A1", "as_A1a", "as_A2"]));
  });

  it("forest order, subtree membership and ancestry are one consistent model", () => {
    const order = orderedSessionForest(FIXTURE).map((r) => r.id);
    for (const node of FIXTURE) {
      for (const ancestor of sessionAncestors(source(FIXTURE), node.id)) {
        // Every ancestor precedes its descendant in the display order…
        expect(order.indexOf(ancestor.id)).toBeLessThan(order.indexOf(node.id));
        // …and every descendant is in each ancestor's subtree.
        expect(sessionSubtree(source(FIXTURE), ancestor.id).map((r) => r.id)).toContain(node.id);
      }
    }
  });
});
