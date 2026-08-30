/**
 * Deterministic Acceptance Criterion execution (execution-model §5.6, §10;
 * invariant 11): expected and unexpected exit codes, canonical criterion
 * order, fail-fast, infrastructure failures recording nothing, commands
 * outside every transaction in an isolated view that never touches the
 * Integration Workspace or the Target, bounded output living only in its
 * Artifact with truncation recorded canonically, and convergence after a
 * restart between a command and its record without a duplicate row.
 */
import { InvariantViolationError, type AcceptanceCriterion, type PlanNode } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness } from "../persistence/test-support.ts";
import { AcceptanceCheckService, COMMAND_OUTPUT_MEDIA_TYPE } from "./acceptance-checks.ts";
import { optimizerNodes, seedCriteria, type SeededCriteria } from "./optimizer-test-support.ts";
import { FakeAcceptanceCriterionExecution, openRuntimeHarness, seedPlanningRuntime, type RuntimeHarness } from "./test-support.ts";

/** An inline optimizer node moved to running with an integration Snapshot on the Run, and its deterministic criteria. */
function checkable(h: RuntimeHarness, counts: { deterministic: number; evaluated?: number } = { deterministic: 2 }) {
  const s = seedPlanningRuntime(h);
  const criteria = seedCriteria(h, s, counts);
  const { byPath } = optimizerNodes(h, s, criteria, { maxRounds: 2 });
  const node = byPath["e0"]!;
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  h.stores.plans.transitionNode(node.id, { to: "running" });
  const run = h.stores.runs.get(s.created.run.id);
  const snapshotId = run.baseSnapshotId!;
  const artifact = h.stores.artifacts.create({ runId: run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "candidate" }, new TextEncoder().encode("candidate"));
  const request = { runId: run.id, planNodeId: node.id, scope: { kind: "optimizer_round" as const, round: 1, maxRounds: 2 }, snapshotId, artifactIds: [artifact.id], criteria: h.checks.deterministicCriteria(run.id, node.kind === "pattern" ? node.gateAcceptanceCriterionIds : []) };
  return { s, criteria, node, run, snapshotId, artifact, request };
}

const ids = (criteria: AcceptanceCriterion[]) => criteria.map((c) => c.id);

describe("AcceptanceCheckService", () => {
  it("passes on the expected exit code and fails on any other, recording each check once with its Evidence and bounded output Artifact", async () => {
    const h = openRuntimeHarness();
    try {
      const { criteria, node, run, snapshotId, artifact, request } = checkable(h, { deterministic: 2, evaluated: 1 });
      expect(ids(request.criteria)).toEqual(criteria.deterministic);
      h.criterionExecution.script(criteria.deterministic[1]!, { kind: "exit", exitCode: 2, output: "boom\n" });
      const seq = h.ctx.journal.lastSeq();
      const outcome = await h.checks.run(request);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") throw new Error(outcome.kind);
      expect(outcome.checks.map((c) => [c.acceptanceCriterionId, c.exitCode, c.evaluation.verdict, c.executed])).toEqual([[criteria.deterministic[0], 0, "pass", true], [criteria.deterministic[1], 2, "fail", true]]);
      expect(outcome.failed.acceptanceCriterionId).toBe(criteria.deterministic[1]);
      for (const check of outcome.checks) {
        expect(check.evaluation).toMatchObject({ runId: run.id, planNodeId: node.id, gateId: null, subject: { kind: "acceptance_criterion", acceptanceCriterionId: check.acceptanceCriterionId }, context: { kind: "optimizer_criterion", round: 1, maxRounds: 2 }, producedBy: { kind: "runtime" }, artifactIds: [artifact.id], snapshotId });
        expect(check.evaluation.evidence).toEqual([{ kind: "command", command: expect.stringMatching(/^npm run check-/), exitCode: check.exitCode, outputArtifactId: check.outputArtifactId, outputTruncated: false }, { kind: "snapshot", snapshotId }]);
        const output = h.stores.artifacts.get(check.outputArtifactId);
        expect(output).toMatchObject({ mediaType: COMMAND_OUTPUT_MEDIA_TYPE, producer: { kind: "runtime", component: "command" } });
      }
      expect(new TextDecoder().decode(h.stores.artifacts.read(outcome.failed.outputArtifactId).bytes)).toBe("boom\n");
      // Events carry ids and metadata, never the output.
      const events = h.ctx.journal.read({ runId: run.id, afterSeq: seq });
      expect(events.map((e) => e.type)).toEqual(["artifact.created", "evaluation.recorded", "artifact.created", "evaluation.recorded"]);
      expect(JSON.stringify(events)).not.toContain("boom");
      expect(JSON.stringify(outcome)).not.toContain("boom");
      // Every request carried exactly the facts the port needs: no store, no Artifact lookup, the exact Snapshot, the bound.
      expect(h.criterionExecution.requests.map((r) => Object.keys(r).sort())).toEqual([["acceptanceCriterionId", "command", "deadlineAt", "expectedExitCode", "gateId", "maxOutputBytes", "planNodeId", "round", "runId", "signal", "workspace"], ["acceptanceCriterionId", "command", "deadlineAt", "expectedExitCode", "gateId", "maxOutputBytes", "planNodeId", "round", "runId", "signal", "workspace"]]);
      expect(h.criterionExecution.requests[0]!.workspace).toEqual({ integrationWorkspacePath: run.integrationWorkspacePath, snapshot: h.stores.snapshots.get(snapshotId).identity, isolationKey: `${run.id}/${node.id}/1/${criteria.deterministic[0]}` });
    } finally {
      h.close();
    }
  });

  it("executes criteria in canonical id order whatever order they are given, stops at the first failure, and never runs a later command", async () => {
    const h = openRuntimeHarness();
    try {
      const { criteria, request } = checkable(h, { deterministic: 3 });
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 0 }).script(criteria.deterministic[1]!, { kind: "exit", exitCode: 1 });
      const shuffled = [...request.criteria].reverse();
      const outcome = await h.checks.run({ ...request, criteria: shuffled });
      expect(outcome.kind).toBe("failed");
      expect(h.criterionExecution.observed.map((o) => o.acceptanceCriterionId)).toEqual([criteria.deterministic[0], criteria.deterministic[1]]);
      expect(h.stores.evaluations.optimizerCriterionEvaluationsOf(request.planNodeId, 1).map((e) => e.verdict)).toEqual(["pass", "fail"]);
      // A repeated run executes nothing: the recorded rows answer for the first two, and the third is still never reached.
      const again = await h.checks.run({ ...request, criteria: shuffled });
      expect(again).toMatchObject({ kind: "failed", checks: [{ executed: false }, { executed: false }] });
      expect(h.criterionExecution.observed).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("reports a timeout, an abort, a failed start, a lost view, or lost output as an infrastructure failure that records nothing and retries on the next run", async () => {
    const h = openRuntimeHarness();
    try {
      const { criteria, request } = checkable(h, { deterministic: 2 });
      for (const step of [{ kind: "fail" as const, failure: "timed_out" as const }, { kind: "fail" as const, failure: "workspace_unavailable" as const }, { kind: "fail" as const, failure: "output_unavailable" as const }, { kind: "fail" as const, failure: "start_failed" as const }, { kind: "throw" as const, error: new Error("spawn EACCES") }]) {
        h.criterionExecution.script(criteria.deterministic[0]!, step);
        const before = h.ctx.journal.lastSeq();
        const outcome = await h.checks.run(request);
        expect(outcome).toMatchObject({ kind: "infrastructure_failure", acceptanceCriterionId: criteria.deterministic[0], checks: [], failure: step.kind === "throw" ? "start_failed" : step.failure });
        expect(h.ctx.journal.lastSeq()).toBe(before);
        expect(h.stores.evaluations.optimizerCriterionEvaluationsOf(request.planNodeId, 1)).toEqual([]);
        expect(h.stores.artifacts.listByRun(request.runId).filter((a) => a.title?.startsWith("check ") === true)).toEqual([]);
      }
      // An abort through the request signal is an infrastructure failure too; every view was disposed.
      const controller = new AbortController();
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "hang" });
      const pending = h.checks.run({ ...request, signal: controller.signal });
      controller.abort("cancelled");
      expect(await pending).toMatchObject({ kind: "infrastructure_failure", failure: "aborted" });
      expect(h.criterionExecution.liveViews.size).toBe(0);
      // The next run carries the checks out and records them exactly once.
      const outcome = await h.checks.run(request);
      expect(outcome).toMatchObject({ kind: "passed", checks: [{ executed: true }, { executed: true }] });
      expect(h.stores.evaluations.optimizerCriterionEvaluationsOf(request.planNodeId, 1)).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("runs every command outside any transaction, in an isolated view of the exact Snapshot, and never writes to the Integration Workspace", async () => {
    const h = openRuntimeHarness();
    try {
      const { run, snapshotId, request } = checkable(h, { deterministic: 2 });
      await expect(h.ctx.tx.write(() => h.checks.run(request))).rejects.toThrow(/outside any transaction/);
      await h.checks.run(request);
      for (const observed of h.criterionExecution.observed) {
        expect(observed.inTransaction).toBe(false);
        expect(observed.snapshot).toEqual(h.stores.snapshots.get(snapshotId).identity);
        expect(observed.viewPath).not.toBe(run.integrationWorkspacePath);
        expect(observed.viewPath.startsWith(`${run.integrationWorkspacePath}/.verification/`)).toBe(true);
      }
      expect(h.criterionExecution.writes.every((w) => w.path.startsWith(`${run.integrationWorkspacePath}/.verification/`) && !w.path.startsWith(`${run.integrationWorkspacePath}/worktrees`))).toBe(true);
      expect(h.criterionExecution.disposed).toHaveLength(2);
      expect(h.criterionExecution.liveViews.size).toBe(0);
      // Nothing touched the Run's integration state or its Snapshot chain.
      expect(h.integrationWorkspace.requests).toEqual([]);
      expect(h.stores.runs.get(run.id).integrationSnapshotId).toBeNull();
      expect(h.stores.snapshots.listByRun(run.id).filter((x) => x.reason === "integration")).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("bounds the stored output and records truncation canonically on the command Evidence, never silently", async () => {
    const h = openRuntimeHarness({ checks: { maxOutputBytes: 16, commandTimeoutMs: null } });
    try {
      const { criteria, request } = checkable(h, { deterministic: 2 });
      h.criterionExecution.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 0, output: "x".repeat(100) }).script(criteria.deterministic[1]!, { kind: "exit", exitCode: 0, output: "short", truncated: true });
      const outcome = await h.checks.run(request);
      expect(outcome).toMatchObject({ kind: "passed", checks: [{ truncated: true }, { truncated: true }] });
      if (outcome.kind !== "passed") throw new Error(outcome.kind);
      expect(h.criterionExecution.requests.map((r) => [r.maxOutputBytes, r.deadlineAt])).toEqual([[16, null], [16, null]]);
      const [first, second] = outcome.checks;
      expect(h.stores.artifacts.get(first!.outputArtifactId).byteSize).toBe(16);
      expect(new TextDecoder().decode(h.stores.artifacts.read(first!.outputArtifactId).bytes)).toBe("x".repeat(16));
      expect(first!.evaluation.evidence[0]).toMatchObject({ kind: "command", outputTruncated: true });
      expect(second!.evaluation.evidence[0]).toMatchObject({ kind: "command", outputTruncated: true });
      expect(h.stores.artifacts.get(second!.outputArtifactId).byteSize).toBe(5);
    } finally {
      h.close();
    }
  });

  it("converges after a restart between a command and its record without a duplicate Artifact or Evaluation, discarding the stale view", async () => {
    const port = new FakeAcceptanceCriterionExecution();
    const base = openHarness();
    const h = openRuntimeHarness({ base, criterionExecution: port });
    try {
      const { criteria, request } = checkable(h, { deterministic: 2 });
      // Process 1: the first command completes but the process dies before its record; its view is never disposed.
      port.script(criteria.deterministic[0]!, { kind: "exit", exitCode: 0 });
      port.crashBeforeDispose = true;
      const write = h.ctx.tx.write.bind(h.ctx.tx);
      let crashed = false;
      h.ctx.tx.write = ((fn: () => unknown) => {
        if (!crashed) {
          crashed = true;
          throw new Error("process died before recording the check");
        }
        return write(fn);
      }) as typeof h.ctx.tx.write;
      await expect(h.checks.run(request)).rejects.toThrow(/process died/);
      h.ctx.tx.write = write;
      port.crashBeforeDispose = false;
      expect(port.liveViews.size).toBe(1);
      expect(h.stores.evaluations.optimizerCriterionEvaluationsOf(request.planNodeId, 1)).toEqual([]);
      // Process 2 (the same port, as the Workspace survives): the command reruns in a fresh view, the stale view is discarded, one row per check exists.
      const outcome = await h.checks.run(request);
      expect(outcome).toMatchObject({ kind: "passed", checks: [{ executed: true }, { executed: true }] });
      expect(port.observed.map((o) => [o.acceptanceCriterionId, o.discardedStale])).toEqual([[criteria.deterministic[0], false], [criteria.deterministic[0], true], [criteria.deterministic[1], false]]);
      expect(port.liveViews.size).toBe(0);
      expect(h.stores.evaluations.optimizerCriterionEvaluationsOf(request.planNodeId, 1)).toHaveLength(2);
      expect(h.stores.artifacts.listByRun(request.runId).filter((a) => a.title?.startsWith("check ") === true)).toHaveLength(2);
      // A third run repeats nothing.
      expect(await h.checks.run(request)).toMatchObject({ kind: "passed", checks: [{ executed: false }, { executed: false }] });
      expect(port.observed).toHaveLength(3);
    } finally {
      h.close();
    }
  });

  it("refuses a Snapshot of another Workspace, a non-deterministic criterion, and a foreign criterion", async () => {
    const h = openRuntimeHarness();
    try {
      const { s, request } = checkable(h, { deterministic: 1, evaluated: 1 });
      const other = seedPlanningRuntime(h);
      await expect(h.checks.run({ ...request, snapshotId: other.created.run.baseSnapshotId! })).rejects.toThrow(InvariantViolationError);
      const evaluated = h.stores.requirements.getAcceptanceCriterion(seedCriteria(h, s, { evaluated: 1 }).evaluated[0]!);
      await expect(h.checks.run({ ...request, criteria: [evaluated] })).rejects.toThrow(/not deterministic/);
      const foreign = seedCriteria(h, other, { deterministic: 1 });
      expect(() => h.checks.deterministicCriteria(request.runId, foreign.deterministic)).toThrow(/another Conversation/);
      const service = new AcceptanceCheckService(h.ctx, h.stores, h.criterionExecution);
      expect(service.deterministicCriteria(request.runId, [])).toEqual([]);
      expect(h.criterionExecution.requests).toEqual([]);
    } finally {
      h.close();
    }
  });
});

/** Keeps the type import in use for the criteria helper's signature. */
export type _Criteria = SeededCriteria & { node?: PlanNode };
