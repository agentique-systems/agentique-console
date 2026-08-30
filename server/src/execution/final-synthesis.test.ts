/**
 * The read-only final synthesis and the operator-signoff boundary
 * (execution-model §10 `run_completion`, `operator_signoff`; invariants 12
 * and 25): one `final_synthesis` turn per passed verification, narrowed to
 * read-only capabilities with no Execution Workspace and no Changeset,
 * returning one typed report that becomes one canonical report Artifact;
 * and a Run that reached `awaiting_signoff` performs nothing further —
 * no ordinary work, no new request, no resolution, no publication — until
 * the operator decides, which this phase does not implement.
 */
import { canonicalFinalReport, FINAL_REPORT_MEDIA_TYPE, READ_ONLY_CAPABILITY_TOOLS, type SnapshotId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { CompletionFacts } from "./completion-requests.ts";
import { advanceUntil, completionGatesOf, FINAL_REPORT, prepareOperatorTurn, reportsOf, requestingStep, requestsOf, signoffGatesOf, synthesesOf, synthesisStep } from "./completion-test-support.ts";
import { scriptByRole } from "./gate-test-support.ts";
import { InvocationResultValidator, type ResultValidationContext } from "./result-validator.ts";
import { COMPLETED_RESULT, fakeSnapshot, openRuntimeHarness, seedPlanningRuntime } from "./test-support.ts";

describe("final synthesis", () => {
  it("is prepared read-only from the final reserve after every criterion passed: no write or shell tool, no MCP, no Execution Workspace, no Changeset, and a Changeset is rejected by the validator", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      scriptByRole(h, { orchestrator: [requestingStep()] });
      const kinds = await advanceUntil(h, runId, () => synthesesOf(h, runId).length > 0, { maxActions: 1 });
      expect(kinds.at(-1)).toBe("prepare_final_synthesis");
      expect(kinds).toContain("derive_requirement_statuses");
      const [synthesis] = synthesesOf(h, runId);
      const manifest = h.stores.invocations.getManifest(synthesis!.id);
      expect(synthesis).toMatchObject({ status: "pending", role: "orchestrator", purpose: "final_synthesis", patternPosition: { kind: "orchestrator" }, taskIds: [], allocationSource: "run_final_reserve", finalReserveUse: "final_synthesis", gateId: completionGatesOf(h, runId)[0]!.id });
      // Capabilities narrowed by purpose: read-only tools only, every other declared tool denied, no MCP server; no runtime tool that changes state.
      const readOnly = new Set<string>(READ_ONLY_CAPABILITY_TOOLS);
      expect(manifest.content.capabilities.tools.every((t) => readOnly.has(t))).toBe(true);
      expect(manifest.content.capabilities.mcpServers).toEqual([]);
      expect(Object.entries(manifest.content.toolPolicy).filter(([, d]) => d !== "denied").every(([tool]) => readOnly.has(tool))).toBe(true);
      expect(s.orchestrator.capabilities.tools.some((t) => !readOnly.has(t))).toBe(true);
      for (const tool of ["request_completion", "propose_tasks", "update_task", "request_decision", "record_decision", "propose_requirements", "revise_execution_plan"]) expect(manifest.content.runtimeTools).not.toContain(tool);
      // No Execution Workspace: the port was asked for a non-writing view (the Integration Workspace at the pinned Snapshot), never a worktree.
      expect(h.executionWorkspace.prepared.at(-1)!.request).toMatchObject({ invocationId: synthesis!.id, writes: false });
      expect(manifest.content.worktreePath).toBe(h.stores.runs.get(runId).integrationWorkspacePath);
      expect(manifest.content.worktreePath).not.toContain("/worktrees/");
      expect(manifest.content.startingSnapshotId).toBe(completionGatesOf(h, runId)[0]!.snapshotId);
      // The validator refuses a Changeset, Task reports, a Run outcome, and a missing report from a synthesis; and a report from any other turn.
      const validator = new InvocationResultValidator(h.stores);
      const run = h.stores.runs.get(runId);
      const context: ResultValidationContext = { run, invocation: synthesis!, manifest, writes: false, changeset: null };
      const codes = (candidate: unknown, ctx: typeof context) => {
        const outcome = validator.validate(candidate, ctx);
        return outcome.ok ? [] : outcome.violations.map((v) => v.code);
      };
      const report = { ...COMPLETED_RESULT, finalReport: FINAL_REPORT };
      expect(codes(report, context)).toEqual([]);
      expect(codes(report, { ...context, changeset: { afterSnapshot: fakeSnapshot("x"), diff: new TextEncoder().encode("+x"), empty: false } })).toEqual(["status_incompatible"]);
      expect(codes({ ...COMPLETED_RESULT }, context)).toEqual(["final_report_missing"]);
      expect(codes({ ...report, runOutcome: { kind: "infeasible", summary: "no", evidence: [{ kind: "snapshot", snapshotId: run.integrationSnapshotId }] } }, context)[0]).toMatch(/^malformed|run_outcome_not_permitted/);
      expect(codes({ ...report, finalReport: { ...FINAL_REPORT, summary: "" } }, context)[0]).toMatch(/^malformed/);
      const ordinary = h.stores.invocations.get(s.invocation.id);
      expect(codes(report, { run, invocation: ordinary, manifest: h.stores.invocations.getManifest(ordinary.id), writes: true, changeset: { afterSnapshot: fakeSnapshot("y"), diff: new Uint8Array(), empty: true } })).toEqual(["final_report_not_permitted"]);
      // Executing it collects no Changeset even when the port would offer one.
      h.executionWorkspace.nextChangeset = { afterSnapshot: fakeSnapshot("never"), diff: new TextEncoder().encode("+never"), empty: false };
      scriptByRole(h, { orchestrator: [synthesisStep(h)] });
      await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
      expect(h.executionWorkspace.collected.some((r) => r.invocationId === synthesis!.id)).toBe(false);
      expect(h.stores.changesets.listByRun(runId).some((c) => c.invocationId === synthesis!.id)).toBe(false);
      expect(h.executionWorkspace.nextChangeset).not.toBeUndefined();
    } finally {
      h.close();
    }
  });

  it("serializes the typed report to one canonical versioned Artifact whose bytes live only in the Artifact Store; Events carry its id", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const seq = h.ctx.journal.lastSeq();
      // The synthesis answers from its typed input: the report names the pinned facts it was given.
      scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h, (input) => ({ ...FINAL_REPORT, summary: `Verified ${input.requirements.length} requirement(s) at ${input.snapshotId}`, verification: input.evaluations.map((e) => `${e.acceptanceCriterionId}: ${e.verdict}`) }))] });
      await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
      const [gate] = completionGatesOf(h, runId);
      const [request] = requestsOf(h, runId);
      const [artifact] = reportsOf(h, runId);
      expect(artifact).toMatchObject({ runId, mediaType: FINAL_REPORT_MEDIA_TYPE, producer: { kind: "runtime", component: "final_report" }, taskId: null });
      const evaluation = h.stores.evaluations.gateCriterionEvaluationsOf(gate!.id)[0]!;
      const expected = { version: 1 as const, runId, completionRequestId: request!.id, gateId: gate!.id, snapshotId: gate!.snapshotId!, requirementRevisionId: gate!.requirementRevisionId!, report: { ...FINAL_REPORT, summary: `Verified 1 requirement(s) at ${gate!.snapshotId}`, verification: [`${s.completion.criterionId}: ${evaluation.verdict}`] } };
      const bytes = h.blobs.get(artifact!.digest);
      expect(new TextDecoder().decode(bytes)).toBe(canonicalFinalReport(expected));
      // Canonical JSON: key order does not depend on the producer's; the same report yields the same bytes.
      expect(canonicalFinalReport({ ...expected, report: { followUps: [], risks: [], verification: expected.report.verification, completed: expected.report.completed, summary: expected.report.summary } })).toBe(canonicalFinalReport(expected));
      expect(JSON.parse(new TextDecoder().decode(bytes)).report).toEqual(expected.report);
      // The Events reference the Artifact; none carries the report's text.
      const events = h.ctx.journal.read({ runId, afterSeq: seq });
      expect(events.find((e) => e.type === "gate.passed")!.payload).toEqual({ gateId: gate!.id, reportArtifactId: artifact!.id });
      expect(events.find((e) => e.type === "completion_request.passed")!.payload).toMatchObject({ id: request!.id, reportArtifactId: artifact!.id });
      // The typed result of the synthesis Invocation is canonical and journaled like every result; no Artifact, Gate, or request Event carries the text.
      expect(events.filter((e) => e.type.startsWith("artifact.") || e.type.startsWith("gate.") || e.type.startsWith("completion_request.")).some((e) => JSON.stringify(e.payload).includes("Verified 1 requirement"))).toBe(false);
      expect(gate!.reportArtifactId).toBe(artifact!.id);
      expect(request!.reportArtifactId).toBe(artifact!.id);
    } finally {
      h.close();
    }
  });
});

describe("awaiting_signoff boundary", () => {
  it("performs nothing further: no ordinary work, no new request, no second signoff Gate or Decision, no resolution, no publication, no Target mutation", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      scriptByRole(h, { orchestrator: [requestingStep(), synthesisStep(h)] });
      await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
      const run = h.stores.runs.get(runId);
      const [gate] = completionGatesOf(h, runId);
      const [signoff] = signoffGatesOf(h, runId);
      const decision = h.stores.decisions.signoffOf(signoff!.id)!;
      // The scheduler projects and performs nothing.
      const projection = h.scheduler.reconcileRun(runId);
      expect(projection).toMatchObject({ stop: "quiescent", actions: [], completion: { kind: "none" } });
      expect(await h.scheduler.advanceRun(runId)).toMatchObject({ stop: "quiescent", actions: [] });
      expect(h.runners.completion.phaseOf(runId)).toEqual({ kind: "idle" });
      // No new turn or request: the Run is not running.
      expect(() => prepareOperatorTurn(h, runId)).toThrow(/awaiting signoff/);
      const seq = h.ctx.journal.lastSeq();
      expect(new CompletionFacts(h.stores).preflight(run, null)).toContain("run_not_running");
      expect(() => h.stores.completionRequests.create({ runId, invocationId: s.invocation.id, runtimeToolCallId: h.stores.runtimeToolCalls.listByInvocation(s.invocation.id)[0]!.id })).toThrow();
      // One open signoff Gate per Run, one Decision per signoff Gate, one signoff Gate per successful request.
      expect(() => h.stores.gates.open({ runId, planNodeId: null, kind: "operator_signoff", acceptanceCriterionIds: [], snapshotId: gate!.snapshotId, candidateArtifactIds: [], completionRequestId: gate!.completionRequestId, requirementRevisionId: gate!.requirementRevisionId, requirementIds: gate!.requirementIds, completionGateId: gate!.id, reportArtifactId: gate!.reportArtifactId })).toThrow();
      expect(() => h.stores.decisions.request({ ...decision, id: undefined as never, status: undefined as never, resolution: undefined as never, createdAt: undefined as never, resolvedAt: undefined as never } as never)).toThrow();
      expect(signoffGatesOf(h, runId)).toHaveLength(1);
      expect(h.stores.decisions.listOpen(run.conversationId).filter((d) => d.kind === "signoff")).toHaveLength(1);
      // Nothing resolved, completed, published, or written to the Target; the Snapshot the operator is asked to accept is the verified one.
      expect(h.stores.decisions.get(decision.id).status).toBe("open");
      expect(h.stores.runs.get(runId).status).toBe("awaiting_signoff");
      expect(h.stores.publications.listByRun(runId)).toEqual([]);
      expect(h.stores.runs.get(runId).integrationSnapshotId).toBe(gate!.snapshotId as SnapshotId);
      expect(h.integrationWorkspace.requests.every((r) => JSON.stringify(r).includes("main") === false || r.runId !== runId)).toBe(true);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
    } finally {
      h.close();
    }
  });
});
