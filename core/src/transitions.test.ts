import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "./errors.ts";
import { HANDOFF_MACHINE } from "./handoffs.ts";
import { ATTEMPT_MACHINE, INVOCATION_MACHINE } from "./invocations.ts";
import { PLAN_NODE_MACHINE, assertPlanNodeTransition } from "./plans.ts";
import { REQUIREMENT_MACHINE } from "./requirements.ts";
import { RUN_MACHINE } from "./runs.ts";
import { TASK_MACHINE } from "./tasks.ts";
import { defineStateMachine, type StateMachine } from "./transitions.ts";
import { GATE_MACHINE } from "./verification.ts";
import { CHANGESET_MACHINE } from "./workspace-state.ts";
import { LEASE_MACHINE } from "./capacity.ts";

/** Every legal pair passes; every other pair throws and is reported as illegal. */
function exhaustively<S extends string>(machine: StateMachine<S>, legal: ReadonlyArray<readonly [S, S]>): void {
  for (const from of machine.states) {
    for (const to of machine.states) {
      const isLegal = legal.some(([f, t]) => f === from && t === to);
      expect(machine.canTransition(from, to), `${machine.subject} ${from} -> ${to}`).toBe(isLegal);
      if (isLegal) expect(() => machine.assertTransition(from, to)).not.toThrow();
      else expect(() => machine.assertTransition(from, to)).toThrow(IllegalTransitionError);
    }
  }
}

describe("defineStateMachine", () => {
  it("rejects a table naming an unknown state", () => {
    expect(() => defineStateMachine("X", ["a", "b"] as const, { a: ["c" as "b"], b: [] })).toThrow(/unknown state/);
  });

  it("derives terminal states from empty target sets", () => {
    const m = defineStateMachine("X", ["a", "b"] as const, { a: ["b"], b: [] });
    expect(m.isTerminal("a")).toBe(false);
    expect(m.isTerminal("b")).toBe(true);
    expect([...m.terminal]).toEqual(["b"]);
  });
});

describe("Run transitions", () => {
  it("match execution-model §3 exactly", () => {
    exhaustively(RUN_MACHINE, [
      ["created", "running"],
      ["created", "cancelled"],
      ["running", "verifying"],
      ["running", "waiting"],
      ["running", "failed"],
      ["running", "cancelled"],
      ["waiting", "running"],
      ["waiting", "cancelled"],
      ["verifying", "awaiting_signoff"],
      ["verifying", "running"],
      ["verifying", "cancelled"],
      ["awaiting_signoff", "completed"],
      ["awaiting_signoff", "running"],
      ["awaiting_signoff", "cancelled"],
    ]);
  });

  it("treats completed, failed, and cancelled as final", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(RUN_MACHINE.isTerminal(state)).toBe(true);
      for (const to of RUN_MACHINE.states) expect(RUN_MACHINE.canTransition(state, to)).toBe(false);
    }
  });
});

describe("PlanNode transitions", () => {
  it("match execution-model §4.2", () => {
    exhaustively(PLAN_NODE_MACHINE, [
      ["pending", "ready"],
      ["pending", "cancelled"],
      ["pending", "skipped"],
      ["ready", "running"],
      ["ready", "succeeded"],
      ["ready", "failed"],
      ["ready", "cancelled"],
      ["ready", "skipped"],
      ["running", "waiting"],
      ["running", "succeeded"],
      ["running", "failed"],
      ["running", "cancelled"],
      ["waiting", "running"],
      ["waiting", "cancelled"],
    ]);
  });

  it("a join executes from ready and never runs or waits; a pattern node runs first", () => {
    expect(() => assertPlanNodeTransition({ kind: "join", status: "ready" }, "succeeded")).not.toThrow();
    expect(() => assertPlanNodeTransition({ kind: "join", status: "ready" }, "failed")).not.toThrow();
    expect(() => assertPlanNodeTransition({ kind: "join", status: "ready" }, "running")).toThrow(/join node cannot be running/);
    expect(() => assertPlanNodeTransition({ kind: "pattern", status: "ready" }, "succeeded")).toThrow(/must be running/);
    expect(() => assertPlanNodeTransition({ kind: "pattern", status: "ready" }, "running")).not.toThrow();
    expect(() => assertPlanNodeTransition({ kind: "pattern", status: "succeeded" }, "running")).toThrow(IllegalTransitionError);
  });
});

describe("Task transitions", () => {
  it("match execution-model §7.9", () => {
    exhaustively(TASK_MACHINE, [
      ["pending", "ready"],
      ["pending", "blocked"],
      ["pending", "cancelled"],
      ["ready", "running"],
      ["ready", "cancelled"],
      ["running", "completed"],
      ["running", "blocked"],
      ["running", "failed"],
      ["blocked", "ready"],
      ["blocked", "cancelled"],
    ]);
  });

  it("never reclassifies a failed Task as cancelled", () => {
    expect(TASK_MACHINE.canTransition("failed", "cancelled")).toBe(false);
    expect(TASK_MACHINE.canTransition("completed", "cancelled")).toBe(false);
  });
});

describe("Invocation and Attempt transitions", () => {
  it("Invocation distinguishes not started, active, waiting, blocked (terminal, on an approval), success, failure, cancellation", () => {
    exhaustively(INVOCATION_MACHINE, [
      ["pending", "running"],
      ["pending", "cancelled"],
      ["running", "waiting"],
      ["running", "blocked"],
      ["running", "succeeded"],
      ["running", "failed"],
      ["running", "cancelled"],
      ["waiting", "running"],
      ["waiting", "succeeded"],
      ["waiting", "failed"],
      ["waiting", "cancelled"],
    ]);
  });

  it("Attempt statuses are terminal after running, including interrupted; a pending Attempt is interrupted by recovery without ever running", () => {
    exhaustively(ATTEMPT_MACHINE, [
      ["pending", "running"],
      ["pending", "interrupted"],
      ["pending", "cancelled"],
      ["running", "succeeded"],
      ["running", "failed"],
      ["running", "timed_out"],
      ["running", "interrupted"],
      ["running", "cancelled"],
    ]);
    expect(ATTEMPT_MACHINE.isTerminal("interrupted")).toBe(true);
  });
});

describe("Requirement transitions", () => {
  it("retired is final; every live status can be retired", () => {
    for (const from of REQUIREMENT_MACHINE.states) {
      if (from === "retired") expect(REQUIREMENT_MACHINE.isTerminal(from)).toBe(true);
      else expect(REQUIREMENT_MACHINE.canTransition(from, "retired")).toBe(true);
    }
    expect(REQUIREMENT_MACHINE.canTransition("open", "waived")).toBe(true);
    expect(REQUIREMENT_MACHINE.canTransition("satisfied", "waived")).toBe(false);
  });
});

describe("small lifecycles", () => {
  it("Gate, Handoff, Changeset, and Lease machines are closed", () => {
    exhaustively(GATE_MACHINE, [
      ["open", "passed"],
      ["open", "failed"],
    ]);
    exhaustively(HANDOFF_MACHINE, [
      ["pending", "delivered"],
      ["pending", "cancelled"],
    ]);
    exhaustively(CHANGESET_MACHINE, [
      ["pending", "integrated"],
      ["pending", "conflict"],
      ["conflict", "integrated"],
    ]);
    exhaustively(LEASE_MACHINE, [["active", "released"]]);
  });
});
