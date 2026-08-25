/**
 * The bounded delivery-view selection layer, tested as data: within budget
 * every selector is the identity (byte-stability law), over budget selection
 * is semantic — owned work, blockers, pins, flags — never mere recency, and
 * every omission is counted.
 */
import { describe, expect, it } from "vitest";
import type { ChangeImpactWire } from "@agentique-console/shared";
import {
  DECISION_DELTA_MAX_ENTRIES,
  ROSTER_MAX_SEATS,
  TASK_VIEW_MAX_ENTRIES,
  selectDecisionDelta,
  selectDelegatedView,
  selectRosterSeats,
  selectSessionImpacts,
  selectTaskView,
  type DelegatedViewNode,
  type TaskViewTask,
} from "./delivery-view.ts";

function makeTask(id: string, overrides: Partial<TaskViewTask> = {}): TaskViewTask {
  return {
    id, status: "pending", owner: null, dependencyIds: [], ready: true,
    line: `- [${overrides.status ?? "pending"}] task ${id}`,
    ...overrides,
  };
}

describe("selectTaskView", () => {
  it("is the identity for a ledger within budget", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => makeTask(`t${i}`));
    const view = selectTaskView(tasks, "worker");
    expect(view.lines).toEqual(tasks.map((task) => task.line));
    expect(view.omittedLine).toBeNull();
  });

  it("a ledger with hundreds of unrelated tasks keeps the seat's active unit and its direct blocker visible", () => {
    const unrelated = Array.from({ length: 300 }, (_, i) => makeTask(`u${i}`, { owner: "someone-else", status: i % 2 === 0 ? "completed" : "pending" }));
    const blocker = makeTask("blocker", { owner: "peer", status: "in_progress", line: "- [in_progress] the blocker (peer)" });
    const mine = makeTask("mine", { owner: "worker", status: "pending", dependencyIds: ["blocker"], ready: false, line: "- [pending] my unit (worker)" });
    // The seat's work is buried at the END of the ledger — recency or ledger
    // order alone would drop it.
    const view = selectTaskView([...unrelated, blocker, mine], "worker");
    expect(view.lines.length).toBeLessThanOrEqual(TASK_VIEW_MAX_ENTRIES);
    expect(view.lines).toContain("- [pending] my unit (worker)");
    expect(view.lines).toContain("- [in_progress] the blocker (peer)");
    expect(view.omittedLine).toMatch(/\d+ more task\(s\) not shown/);
    expect(view.omittedLine).toContain("task_list returns the full ledger");
  });

  it("selected lines keep ledger order and the omission line counts by status", () => {
    const tasks = [
      makeTask("a", { owner: "worker", status: "in_progress", line: "- [in_progress] a (worker)" }),
      ...Array.from({ length: 40 }, (_, i) => makeTask(`p${i}`, { status: "pending" })),
      ...Array.from({ length: 40 }, (_, i) => makeTask(`c${i}`, { status: "completed", line: `- [completed] task c${i}` })),
      makeTask("z", { owner: "worker", status: "pending", line: "- [pending] z (worker)" }),
    ];
    const view = selectTaskView(tasks, "worker");
    // Ledger order: "a" renders before "z" even though both are class 0.
    expect(view.lines.indexOf("- [in_progress] a (worker)")).toBeLessThan(view.lines.indexOf("- [pending] z (worker)"));
    expect(view.omittedLine).toMatch(/pending/);
    expect(view.omittedLine).toMatch(/completed/);
  });
});

describe("selectDecisionDelta", () => {
  it("is the identity within caps", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ line: `- decision ${i}`, pinned: false }));
    const view = selectDecisionDelta(entries);
    expect(view.lines).toEqual(entries.map((entry) => entry.line));
    expect(view.omitted).toBe(0);
  });

  it("pins scope-relevant decisions ahead of recency and counts the rest", () => {
    // The OLDEST decision is the pinned one; a recency-only cap would drop it.
    const entries = [
      { line: "- pinned: use sqlite for the ledger [r3]", pinned: true },
      ...Array.from({ length: 80 }, (_, i) => ({ line: `- unrelated decision ${i}`, pinned: false })),
    ];
    const view = selectDecisionDelta(entries);
    expect(view.lines[0]).toBe("- pinned: use sqlite for the ledger [r3]");
    expect(view.lines.length).toBeLessThanOrEqual(DECISION_DELTA_MAX_ENTRIES);
    expect(view.omitted).toBe(entries.length - view.lines.length);
    // Recency fills the remaining budget: the newest unpinned entry survives.
    expect(view.lines).toContain("- unrelated decision 79");
  });

  it("renders selected lines in chronological order whatever the selection order", () => {
    const entries = [
      ...Array.from({ length: 50 }, (_, i) => ({ line: `- old ${i}`, pinned: false })),
      { line: "- pinned late [r1]", pinned: true },
    ];
    const view = selectDecisionDelta(entries);
    // The pinned entry is chronologically LAST and must render last.
    expect(view.lines[view.lines.length - 1]).toBe("- pinned late [r1]");
  });
});

describe("selectRosterSeats", () => {
  const facts = (name: string, overrides: Partial<{ live: boolean; lastActiveAt: string | null }> = {}) =>
    ({ name, live: false, lastActiveAt: null, ...overrides });

  it("renders everything at or under the cap", () => {
    expect(selectRosterSeats(Array.from({ length: ROSTER_MAX_SEATS }, (_, i) => facts(`s${i}`)), "s0")).toBeNull();
  });

  it("over the cap keeps self and live seats and counts the rest", () => {
    const seats = [
      ...Array.from({ length: 30 }, (_, i) => facts(`mapper${i}`, { lastActiveAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` })),
      facts("me"),
      facts("busy", { live: true }),
    ];
    const selection = selectRosterSeats(seats, "me")!;
    expect(selection.names.has("me")).toBe(true);
    expect(selection.names.has("busy")).toBe(true);
    expect(selection.names.size).toBe(ROSTER_MAX_SEATS);
    expect(selection.omitted).toBe(seats.length - ROSTER_MAX_SEATS);
    // Recency fills the rest: the most recently active mapper survives.
    expect(selection.names.has("mapper29")).toBe(true);
  });
});

describe("selectDelegatedView", () => {
  const node = (id: string, parentId: string | null, overrides: Partial<DelegatedViewNode> = {}): DelegatedViewNode => ({
    id, parentId, derivedStatus: "open", flagged: false,
    line: `- ${id} [open]: statement of ${id} with enough words to carry realistic weight in the byte budget`,
    ...overrides,
  });

  it("is the identity within budget", () => {
    const nodes = [node("r1", null), node("r1.1", "r1"), node("r1.2", "r1")];
    const view = selectDelegatedView(nodes);
    expect(view.lines).toEqual(nodes.map((n) => n.line));
    expect(view.omittedLine).toBeNull();
  });

  it("collapses a fully satisfied unflagged subtree to its top line with a count", () => {
    const nodes = [
      node("r1", null),
      node("r1.done", "r1", { derivedStatus: "satisfied" }),
      ...Array.from({ length: 200 }, (_, i) => node(`r1.done.${i}`, "r1.done", { derivedStatus: "satisfied" })),
      node("r1.open", "r1"),
    ];
    const view = selectDelegatedView(nodes, 2048);
    expect(view.lines.some((line) => line.includes("r1.done ") && line.includes("(subtree: 200/200 satisfied, collapsed)"))).toBe(true);
    expect(view.lines.some((line) => line.includes("r1.open"))).toBe(true);
    expect(view.lines.every((line) => !line.includes("r1.done.0 "))).toBe(true);
  });

  it("a flagged claim survives even a tight budget while satisfied siblings are counted", () => {
    const nodes = [
      node("r1", null),
      ...Array.from({ length: 120 }, (_, i) => node(`r1.s${i}`, "r1", { derivedStatus: "satisfied" })),
      node("r1.suspect", "r1", { derivedStatus: "satisfied", flagged: true, line: "- r1.suspect [satisfied ⚠ depends_changed]: the claim whose dependency moved" }),
    ];
    const view = selectDelegatedView(nodes, 512);
    expect(view.lines).toContain("- r1.suspect [satisfied ⚠ depends_changed]: the claim whose dependency moved");
    expect(view.omittedLine).toMatch(/\d+ requirement\(s\) not shown/);
    expect(view.omittedLine).toContain("read_requirements");
    // The governing boundary (the delegated root) stays visible beside the flag.
    expect(view.lines.some((line) => line.startsWith("- r1 "))).toBe(true);
  });

  it("keeps the open frontier and its ancestor chain when satisfied bulk collapses", () => {
    const nodes = [
      node("r1", null, { derivedStatus: "open" }),
      node("r1.a", "r1", { derivedStatus: "satisfied" }),
      ...Array.from({ length: 150 }, (_, i) => node(`r1.a.${i}`, "r1.a", { derivedStatus: "satisfied" })),
      node("r1.b", "r1", { derivedStatus: "satisfied" }),
      node("r1.b.deep", "r1.b", { derivedStatus: "open", line: "- r1.b.deep [open]: the one still-open leaf under a satisfied-looking parent" }),
    ];
    const view = selectDelegatedView(nodes, 1024);
    expect(view.lines).toContain("- r1.b.deep [open]: the one still-open leaf under a satisfied-looking parent");
    // Its parent renders too — the boundary that makes the leaf legible.
    expect(view.lines.some((line) => line.startsWith("- r1.b "))).toBe(true);
  });
});

describe("selectSessionImpacts", () => {
  const impact = (id: string, sessions: string[], overrides: Partial<ChangeImpactWire> = {}): ChangeImpactWire => ({
    id, sourceKind: "amendment", sourceRef: "rev:2", atRevision: 2, computedAtOrd: 1, note: null,
    affected: { seedIds: ["r1"], requirements: [], suspectClaims: [], sessions: [], tasks: [], scheduledAssignments: [] },
    dispositions: [], outstanding: { claims: [], sessions }, status: "open", createdAt: `2026-01-0${id.length}T00:00:00Z`,
    ...overrides,
  });

  it("selects only open impacts naming the session, oldest first, capped with a count", () => {
    const impacts = [
      impact("a", ["other"]),
      impact("b", ["mine"], { createdAt: "2026-01-04T00:00:00Z" }),
      impact("c", ["mine"], { createdAt: "2026-01-01T00:00:00Z" }),
      impact("d", ["mine"], { status: "reconciled" }),
      impact("e", ["mine"], { createdAt: "2026-01-02T00:00:00Z" }),
      impact("f", ["mine"], { createdAt: "2026-01-03T00:00:00Z" }),
    ];
    const view = selectSessionImpacts(impacts, "mine");
    expect(view.shown.map((row) => row.id)).toEqual(["c", "e", "f"]);
    expect(view.omitted).toBe(1);
  });
});
