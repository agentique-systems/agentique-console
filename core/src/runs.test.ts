/**
 * Operator Run control in the domain model (execution-model §3, §14): the
 * closed pause modes, the persisted pause's invariants on a Run, the one
 * admission rule and its execution and draining companions, the closed
 * refusal codes, and the strict control request schemas.
 */
import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import {
  OPERATOR_PAUSABLE_STATUSES,
  OPERATOR_PAUSE_HELD_STATUSES,
  OPERATOR_PAUSE_MODES,
  RUN_CONTROL_REFUSAL_CODES,
  RUN_STATUSES,
  RunControlRefusedError,
  runAdmitsExecution,
  runAdmitsNewWork,
  runCancelRequestSchema,
  runExecutionInterruptionOf,
  runIsRunningOrDraining,
  runPauseRequestSchema,
  runResumeRequestSchema,
  runSchema,
  type Run,
  type RunStatus,
} from "./runs.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const run = (overrides: Partial<Run> = {}): Run => ({
  id: newId("run"),
  conversationId: newId("conversation"),
  workspaceId: newId("workspace"),
  kind: "code",
  status: "running",
  waitReason: null,
  operatorPause: null,
  target: { kind: "branch", branch: "main" },
  budget: { maxCostUsd: 10, maxTokens: 1000, maxAttempts: 10, maxWallClockMs: null, maxConcurrency: null },
  finalReserve: { costUsd: 1, tokens: 100, attempts: 1 },
  verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 3, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] },
  baseSnapshotId: null,
  integrationSnapshotId: null,
  finalSnapshotId: null,
  finalChangesetId: null,
  integrationWorkspacePath: null,
  failure: null,
  createdAt: NOW,
  updatedAt: NOW,
  endedAt: null,
  ...overrides,
});

const terminal = (status: "cancelled" | "failed"): Partial<Run> => ({ status, endedAt: NOW, failure: status === "failed" ? { kind: "root_node_failed", summary: "root failed", evidenceArtifactIds: [] } : null });

describe("operator pause", () => {
  it("has two closed modes, two closed refusal codes, and closed status sets", () => {
    expect(OPERATOR_PAUSE_MODES).toEqual(["soft", "hard"]);
    expect(RUN_CONTROL_REFUSAL_CODES).toEqual(["run_terminal", "not_started"]);
    expect(OPERATOR_PAUSABLE_STATUSES).toEqual(["running", "waiting", "verifying", "awaiting_signoff"]);
    expect(OPERATOR_PAUSE_HELD_STATUSES).toEqual(["waiting", "verifying", "awaiting_signoff"]);
    const error = new RunControlRefusedError("not_started", "not started", { runId: "run_x" });
    expect(error).toMatchObject({ code: "conflict", refusal: "not_started", details: { refusal: "not_started", runId: "run_x" } });
  });

  it("is held only by a waiting, verifying, or awaiting_signoff Run, and a Run waits on operator exactly when it is paused", () => {
    expect(runSchema.safeParse(run({ status: "waiting", waitReason: "operator", operatorPause: "soft" })).success).toBe(true);
    expect(runSchema.safeParse(run({ status: "waiting", waitReason: "operator", operatorPause: "hard" })).success).toBe(true);
    expect(runSchema.safeParse(run({ status: "verifying", operatorPause: "hard" })).success).toBe(true);
    expect(runSchema.safeParse(run({ status: "awaiting_signoff", operatorPause: "soft" })).success).toBe(true);
    // A paused running Run is a contradiction: it is waiting on operator.
    expect(runSchema.safeParse(run({ status: "running", operatorPause: "soft" })).success).toBe(false);
    expect(runSchema.safeParse(run({ status: "created", operatorPause: "soft" })).success).toBe(false);
    for (const status of ["cancelled", "failed"] as const) expect(runSchema.safeParse(run({ ...terminal(status), operatorPause: "hard" })).success).toBe(false);
    // The operator wait reason without a pause, and a pause with another wait reason, are both contradictions.
    expect(runSchema.safeParse(run({ status: "waiting", waitReason: "operator", operatorPause: null })).success).toBe(false);
    expect(runSchema.safeParse(run({ status: "waiting", waitReason: "budget", operatorPause: "soft" })).success).toBe(false);
    expect(runSchema.safeParse(run({ status: "waiting", waitReason: "budget", operatorPause: null })).success).toBe(true);
    expect(runSchema.safeParse(run({ operatorPause: "medium" as never })).success).toBe(false);
  });

  it("admits new work only on a live, unpaused Run; lets admitted work execute unless the Run is cancelled or hard-paused; drains a soft pause", () => {
    const facts = (status: RunStatus, operatorPause: Run["operatorPause"]) => ({ status, operatorPause });
    expect(RUN_STATUSES.map((status) => runAdmitsNewWork(facts(status, null)))).toEqual([true, true, true, true, true, false, false, false]);
    expect(runAdmitsNewWork(facts("waiting", "soft"))).toBe(false);
    expect(runAdmitsNewWork(facts("verifying", "hard"))).toBe(false);
    expect(runAdmitsNewWork(facts("awaiting_signoff", "soft"))).toBe(false);
    expect(runAdmitsExecution(facts("running", null))).toBe(true);
    expect(runAdmitsExecution(facts("waiting", "soft"))).toBe(true);
    expect(runAdmitsExecution(facts("waiting", "hard"))).toBe(false);
    expect(runAdmitsExecution(facts("verifying", "hard"))).toBe(false);
    expect(runAdmitsExecution(facts("cancelled", null))).toBe(false);
    expect(runExecutionInterruptionOf(facts("cancelled", null))).toBe("cancelled");
    expect(runExecutionInterruptionOf(facts("waiting", "hard"))).toBe("operator_pause");
    expect(runExecutionInterruptionOf(facts("waiting", "soft"))).toBeNull();
    expect(runExecutionInterruptionOf(facts("running", null))).toBeNull();
    expect(runIsRunningOrDraining(facts("running", null))).toBe(true);
    expect(runIsRunningOrDraining(facts("waiting", "soft"))).toBe(true);
    expect(runIsRunningOrDraining(facts("waiting", "hard"))).toBe(false);
    expect(runIsRunningOrDraining(facts("waiting", null))).toBe(false);
    expect(runIsRunningOrDraining(facts("verifying", null))).toBe(false);
    expect(runIsRunningOrDraining(facts("awaiting_signoff", "soft"))).toBe(false);
  });

  it("control requests are strict: a Run id, a closed mode, nothing else", () => {
    const runId = newId("run");
    expect(runCancelRequestSchema.safeParse({ runId }).success).toBe(true);
    expect(runCancelRequestSchema.safeParse({ runId, force: true }).success).toBe(false);
    expect(runCancelRequestSchema.safeParse({ runId: "run" }).success).toBe(false);
    expect(runPauseRequestSchema.safeParse({ runId, mode: "soft" }).success).toBe(true);
    expect(runPauseRequestSchema.safeParse({ runId, mode: "hard" }).success).toBe(true);
    expect(runPauseRequestSchema.safeParse({ runId, mode: "medium" }).success).toBe(false);
    expect(runPauseRequestSchema.safeParse({ runId }).success).toBe(false);
    expect(runResumeRequestSchema.safeParse({ runId }).success).toBe(true);
    expect(runResumeRequestSchema.safeParse({ runId, mode: "soft" }).success).toBe(false);
  });
});
