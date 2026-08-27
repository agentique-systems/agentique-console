/**
 * The attention policy's decision matrix, pinned as a table: the whole wake
 * semantics of the mailroom hangs off these three pure functions, so the
 * matrix is asserted explicitly rather than left to be inferred from e2e runs.
 */
import { describe, expect, it } from "vitest";
import { attentionOf, routineProgress, wakesMain } from "./attention.ts";
import type { EdgeSpec } from "./topology-contract.ts";

const material: EdgeSpec = { from: "specialist", to: "coordinator", advance: "immediate", attention: "material" };
const plain: EdgeSpec = { from: "coordinator", to: "specialist", advance: "immediate" };
const join: EdgeSpec = { from: "mapper", to: "reducer", advance: "join" };

describe("attentionOf", () => {
  it("defers routine progress only on material-marked edges", () => {
    expect(attentionOf(material, "update", "in_progress", "low")).toBe("defer");
    expect(attentionOf(material, "update", "pending", "medium")).toBe("defer");
    expect(attentionOf(material, "decision", "in_progress", "low")).toBe("defer");
    // An unmarked edge keeps the historical semantics: every delivery wakes.
    expect(attentionOf(plain, "update", "in_progress", "low")).toBe("wake");
    expect(attentionOf(plain, "decision", "pending", "low")).toBe("wake");
  });

  it("wakes for terminal, verification-needing, and material categories on any edge", () => {
    expect(attentionOf(material, "update", "completed", "low")).toBe("wake");
    expect(attentionOf(material, "update", "failed", "low")).toBe("wake");
    expect(attentionOf(material, "update", "needs_verification", "low")).toBe("wake");
    expect(attentionOf(material, "milestone", "in_progress", "low")).toBe("wake");
    expect(attentionOf(material, "assignment", "pending", "low")).toBe("wake");
    expect(attentionOf(material, "final", "completed", "low")).toBe("wake");
  });

  it("interrupts for failures, blocked statuses, and declared-urgent sends", () => {
    expect(attentionOf(material, "failure", "failed", "low")).toBe("interrupt");
    expect(attentionOf(material, "update", "blocked", "low")).toBe("interrupt");
    expect(attentionOf(plain, "decision", "blocked", "medium")).toBe("interrupt");
    expect(attentionOf(material, "update", "in_progress", "high")).toBe("interrupt");
  });

  it("holds every join-edge delivery for the engine, whatever it carries", () => {
    expect(attentionOf(join, "update", "completed", "low")).toBe("hold");
    expect(attentionOf(join, "failure", "failed", "high")).toBe("hold");
    expect(attentionOf(join, "milestone", "in_progress", "low")).toBe("hold");
  });
});

describe("wakesMain", () => {
  it("keeps the material categories, minus routine decision records", () => {
    expect(wakesMain("milestone", "in_progress")).toBe(true);
    expect(wakesMain("failure", "failed")).toBe(true);
    expect(wakesMain("final", "completed")).toBe(true);
    expect(wakesMain("decision", "blocked")).toBe(true);
    expect(wakesMain("decision", "needs_verification")).toBe(true);
    // A decision already taken, work continuing: recorded, not woken.
    expect(wakesMain("decision", "in_progress")).toBe(false);
    expect(wakesMain("decision", "pending")).toBe(false);
    // Updates and assignments never woke main; unchanged.
    expect(wakesMain("update", "completed")).toBe(false);
    expect(wakesMain("assignment", "pending")).toBe(false);
  });
});

describe("routineProgress", () => {
  it("covers exactly still-working updates and decision records", () => {
    expect(routineProgress("update", "in_progress")).toBe(true);
    expect(routineProgress("decision", "pending")).toBe(true);
    expect(routineProgress("update", "blocked")).toBe(false);
    expect(routineProgress("milestone", "in_progress")).toBe(false);
  });
});
