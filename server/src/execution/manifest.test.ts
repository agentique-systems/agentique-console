/**
 * Context Manifest assembly and deterministic rendering (execution-model
 * §6.2, §6.4; invariants 6 transcripts are never canonical, 9 canonical
 * objects by id, 20 one immutable manifest per Invocation).
 */
import { canonicalJson, InvariantViolationError, MANIFEST_RENDERER_VERSION, ValidationError, type ContextManifest, type Invocation } from "@agentique-console/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openHarness } from "../persistence/test-support.ts";
import { ContextManifestAssembler } from "./manifest/assembler.ts";
import { renderManifest } from "./manifest/renderer.ts";
import { accepted, COMPLETED_RESULT, openRuntimeHarness, propose, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

/** Runs the pending Orchestrator Invocation of a started Run to completion so a successor can be prepared. */
async function completeOrchestratorTurn(h: RuntimeHarness, invocation: Invocation) {
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "finalized" || outcome.settlement.invocation.status !== "succeeded") throw new Error(`turn did not succeed: ${JSON.stringify(outcome.kind)}`);
  return outcome;
}

function scopedWorkerNode(h: RuntimeHarness, s: ReturnType<typeof seedPlanningRuntime>) {
  const rootId = h.ctx.ids("requirement");
  const leafIds = [h.ctx.ids("requirement"), h.ctx.ids("requirement")];
  const revision = h.stores.requirements.createRevision({
    conversationId: s.created.run.conversationId,
    approvedByDecisionId: null,
    tree: [
      { id: rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] },
      { id: leafIds[0]!, parentId: rootId, composition: null, statement: "`--version` prints the package version", position: 0, acceptanceCriterionIds: [] },
      { id: leafIds[1]!, parentId: rootId, composition: null, statement: "the flag is documented", position: 1, acceptanceCriterionIds: [] },
    ],
  });
  const criterion = h.stores.requirements.createAcceptanceCriterion({ conversationId: s.created.run.conversationId, requirementId: leafIds[0]!, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } });
  const outcome = accepted(propose(h, s, [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "implement" }, scope: { requirementRootIds: [rootId], requirementRevisionId: revision.id }, allocation: { costUsd: 8, tokens: 80_000, attempts: 8 } }]));
  const node = outcome.graph.nodes[1]!;
  h.stores.plans.transitionNode(node.id, { to: "ready" });
  h.stores.plans.transitionNode(node.id, { to: "running" });
  return { node, revision, rootId, leafIds, criterion };
}

describe("context manifest assembly", () => {
  it("assembles exactly one immutable manifest per Invocation with the Invocation's authorized context only, deterministically", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const started = startRun(h, s);
      const { invocation, manifest } = started.prepared;
      expect(h.stores.invocations.getManifest(invocation.id)).toEqual(manifest);
      expect(manifest.rendererVersion).toBe(MANIFEST_RENDERER_VERSION);
      expect(() => h.stores.invocations.putManifest(invocation.id, manifest.content)).toThrow(/already has its Context Manifest/);
      const c = manifest.content;
      expect(c).toMatchObject({
        agentDefinitionRevisionId: s.orchestrator.id,
        agentDefinitionContentHash: s.orchestrator.contentHash,
        instructions: s.orchestrator.instructions,
        modelPolicy: s.orchestrator.modelPolicy,
        role: "orchestrator",
        purpose: "operator_input",
        patternPosition: null,
        continuedFromInvocationId: null,
        runId: s.created.run.id,
        planNodeId: s.created.root.id,
        tasks: [],
        requirementRevisionId: null,
        requirements: [],
        decisions: [],
        inputs: [{ kind: "operator_message", conversationMessageId: s.message.id, content: s.message.content }],
        handoffs: [],
        artifacts: [],
        allocation: invocation.allocation,
        allocationSource: "plan_node",
        finalReserveUse: null,
        maxWallClockMs: 600_000,
        capabilities: { tools: ["read", "shell", "write"], mcpServers: [] },
        toolPolicy: { read: "allowed", shell: "approval_required", write: "allowed" },
      });
      expect(c.runtimeTools).toContain("revise_execution_plan");
      // A writing Invocation starts from its own before-Invocation Snapshot in an isolated worktree.
      expect(c.startingSnapshotId).not.toBeNull();
      expect(h.stores.snapshots.get(c.startingSnapshotId!)).toMatchObject({ reason: "before_invocation", runId: s.created.run.id });
      expect(c.worktreePath).toBe(`${s.created.run.integrationWorkspacePath}/worktrees/${invocation.id}`);
      // Nothing about provider state, transcripts, or history is present.
      const text = canonicalJson(c);
      for (const forbidden of ["transcript", "storageKey", "continuation", "payload", "messages", "history"]) expect(text).not.toContain(forbidden);
      // Assembly is deterministic: the same request assembles byte-identical content.
      const assembler = new ContextManifestAssembler(h.stores);
      const request = {
        run: h.stores.runs.get(s.created.run.id),
        node: h.stores.plans.getNode(s.created.root.id) as never,
        invocation,
        revision: s.orchestrator,
        policy: started.prepared.policy,
        patternPosition: null,
        inputs: c.inputs,
        handoffIds: [],
        artifactIds: [],
        startingSnapshotId: c.startingSnapshotId,
        worktreePath: c.worktreePath,
        maxWallClockMs: c.maxWallClockMs,
      };
      expect(canonicalJson(assembler.assemble(request))).toBe(text);
      expect(canonicalJson(assembler.assemble(request))).toBe(text);
    } finally {
      h.close();
    }
  });

  it("gives a scoped node exactly its pinned leaf Requirements and the root the current revision, with role-specific tools and capabilities", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { node, revision, rootId, leafIds, criterion } = scopedWorkerNode(h, s);
      const worker = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, taskIds: [], patternPosition: "single" });
      const c = worker.manifest.content;
      expect(c.requirementRevisionId).toBe(revision.id);
      expect(c.requirements.map((r) => r.requirementId)).toEqual(leafIds);
      expect(c.requirements[0]).toEqual({ requirementId: leafIds[0], statement: "`--version` prints the package version", status: "open", acceptanceCriterionIds: [] });
      expect(c.acceptanceCriteria).toEqual([{ acceptanceCriterionId: criterion.id, requirementId: leafIds[0], taskId: null, check: { kind: "deterministic", command: "npm test", expectedExitCode: 0 } }]);
      expect(c.runtimeTools).not.toContain("revise_execution_plan");
      expect(c.runtimeTools).toContain("return_result");
      expect(c.patternPosition).toBe("single");
      // An Evaluator on the node is read-only whatever its definition declares, and runs against the Integration Workspace.
      const evaluator = h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "evaluator", purpose: "evaluate", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, taskIds: [], patternPosition: null });
      expect(evaluator.manifest.content.capabilities).toEqual({ tools: ["read"], mcpServers: [] });
      expect(evaluator.manifest.content.toolPolicy).toEqual({ read: "allowed", shell: "denied", write: "denied" });
      expect(evaluator.manifest.content.worktreePath).toBe(s.created.run.integrationWorkspacePath);
      expect(evaluator.manifest.content.startingSnapshotId).toBe(s.created.run.baseSnapshotId);
      expect(evaluator.manifest.content.runtimeTools).not.toContain("update_task");
      expect(evaluator.manifest.content.requirements.map((r) => r.requirementId)).toEqual(leafIds);
      // A later Requirement revision leaves the node's existing manifests untouched; the root sees the current tree, and a
      // node whose pinned Requirement was retired can no longer prepare an Invocation (the Orchestrator revises the plan).
      const later = h.stores.requirements.createRevision({
        conversationId: s.created.run.conversationId,
        approvedByDecisionId: null,
        tree: [{ id: rootId, parentId: null, composition: "all", statement: "The CLI reports its version", position: 0, acceptanceCriterionIds: [] }, { id: leafIds[0]!, parentId: rootId, composition: null, statement: "`--version` prints the package version", position: 0, acceptanceCriterionIds: [] }],
      });
      expect(h.stores.invocations.getManifest(worker.invocation.id)).toEqual(worker.manifest);
      await completeOrchestratorTurn(h, s.invocation);
      const orchestrator = h.preparation.prepare({ runId: s.created.run.id, planNodeId: s.created.root.id, role: "orchestrator", purpose: "node_result", agentDefinitionRevisionId: s.orchestrator.id, continuedFromInvocationId: s.invocation.id, taskIds: [], patternPosition: null, inputs: [{ kind: "node_result", planNodeId: node.id, status: "running", outputArtifactIds: [] }] });
      expect(orchestrator.manifest.content.requirementRevisionId).toBe(later.id);
      expect(orchestrator.manifest.content.requirements.map((r) => r.requirementId)).toEqual([rootId, leafIds[0]]);
      expect(orchestrator.manifest.content.requirements.map((r) => r.status)).toEqual(["open", "open"]);
      expect(h.stores.requirements.get(leafIds[1]!).status).toBe("retired");
      expect(() => h.preparation.prepare({ runId: s.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, taskIds: [], patternPosition: null })).toThrow(/retired/);
    } finally {
      h.close();
    }
  });

  it("includes only relevant Decisions and explicitly delivered Handoffs, and rejects foreign, missing, cancelled, or unauthorized objects", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const { node, leafIds } = scopedWorkerNode(h, s);
      const conversationId = s.created.run.conversationId;
      const request = (affects: { requirementIds?: string[]; taskIds?: string[]; planNodeIds?: string[] }, question = "q") =>
        h.stores.decisions.request({
          conversationId,
          runId: s.created.run.id,
          kind: "operator_choice",
          resolutionPolicy: "operator_required",
          requestedBy: { kind: "operator" },
          question,
          options: [{ id: "a", label: "A", description: null }],
          recommendedOptionId: null,
          rationale: null,
          affects: { requirementIds: (affects.requirementIds ?? []) as never, taskIds: (affects.taskIds ?? []) as never, planNodeIds: (affects.planNodeIds ?? []) as never },
          deadlineAt: null,
          activationCondition: null,
          supersedesDecisionId: null,
        });
      const relevant = request({ requirementIds: [leafIds[1]!] });
      const nodeDecision = request({ planNodeIds: [node.id] });
      const unrelated = request({});
      h.stores.decisions.resolve(relevant.id, { resolvedBy: "operator", chosenOptionId: "a", rationale: null, artifactIds: [] });
      const artifact = h.stores.artifacts.create({ runId: s.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "notes" }, new TextEncoder().encode("hello"));
      const handoff = h.stores.handoffs.create({ runId: s.created.run.id, source: { kind: "plan_node", planNodeId: s.created.root.id }, target: { kind: "plan_node", planNodeId: node.id }, taskIds: [], artifactIds: [artifact.id], summary: "read the notes" });
      const elsewhere = h.stores.handoffs.create({ runId: s.created.run.id, source: { kind: "plan_node", planNodeId: s.created.root.id }, target: { kind: "plan_node", planNodeId: s.created.root.id }, taskIds: [], artifactIds: [], summary: "not for the worker" });
      const other = seedRuntime(h);
      const foreignArtifact = h.stores.artifacts.create({ runId: other.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: null }, new TextEncoder().encode("foreign"));
      const base = { runId: s.created.run.id, planNodeId: node.id, role: "worker" as const, purpose: "step" as const, agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, taskIds: [], patternPosition: null };
      const before = h.stores.invocations.listByRun(s.created.run.id).length;
      // Every foreign or unauthorized reference fails preparation transactionally: nothing is created.
      expect(() => h.preparation.prepare({ ...base, handoffIds: [elsewhere.id] })).toThrow(ValidationError);
      expect(() => h.preparation.prepare({ ...base, artifactIds: [foreignArtifact.id] })).toThrow(InvariantViolationError);
      expect(() => h.preparation.prepare({ ...base, artifactIds: ["art_000000000000000000000000"] })).toThrow(/not found/);
      expect(() => h.preparation.prepare({ ...base, inputs: [{ kind: "operator_message", conversationMessageId: other.message.id, content: other.message.content }] })).toThrow(InvariantViolationError);
      expect(() => h.preparation.prepare({ ...base, inputs: [{ kind: "decision_resolution", decisionId: "dec_000000000000000000000000" }] })).toThrow(/not found/);
      expect(() => h.preparation.prepare({ ...base, taskIds: ["task_000000000000000000000000"] })).toThrow(/not found/);
      h.stores.handoffs.transition(elsewhere.id, "cancelled");
      expect(h.stores.invocations.listByRun(s.created.run.id)).toHaveLength(before);
      expect(h.stores.handoffs.get(handoff.id).status).toBe("pending");
      // Every preparation that reached the port after the Run start was rolled back and compensated.
      expect(h.executionWorkspace.discarded.length).toBe(h.executionWorkspace.prepared.length - 1);

      const prepared = h.preparation.prepare({ ...base, handoffIds: [handoff.id] });
      const c = prepared.manifest.content;
      expect(c.decisions.map((d) => d.decisionId).sort()).toEqual([relevant.id, nodeDecision.id].sort());
      expect(c.decisions.find((d) => d.decisionId === relevant.id)).toEqual({ decisionId: relevant.id, kind: "operator_choice", chosenOptionId: "a", resolvedSincePrevious: false });
      expect(c.decisions.some((d) => d.decisionId === unrelated.id)).toBe(false);
      expect(c.handoffs).toEqual([{ handoffId: handoff.id, source: { kind: "plan_node", planNodeId: s.created.root.id }, taskIds: [], artifactIds: [artifact.id], summary: "read the notes" }]);
      expect(c.artifacts).toEqual([{ artifactId: artifact.id, mediaType: "text/plain", byteSize: 5, title: "notes" }]);
      expect(h.stores.handoffs.get(handoff.id).status).toBe("delivered");
      // A Decision resolved after the previous Invocation's manifest is delivered to the successor as resolved-since-previous.
      await completeOrchestratorTurn(h, s.invocation);
      const resolvedLater = request({}, "later");
      h.stores.decisions.resolve(resolvedLater.id, { resolvedBy: "operator", chosenOptionId: "a", rationale: null, artifactIds: [] });
      const successor = h.preparation.prepare({ runId: s.created.run.id, planNodeId: s.created.root.id, role: "orchestrator", purpose: "decision_resolution", agentDefinitionRevisionId: s.orchestrator.id, continuedFromInvocationId: s.invocation.id, taskIds: [], patternPosition: null, inputs: [{ kind: "decision_resolution", decisionId: resolvedLater.id }] });
      expect(successor.manifest.content.decisions.find((d) => d.decisionId === resolvedLater.id)).toEqual({ decisionId: resolvedLater.id, kind: "operator_choice", chosenOptionId: "a", resolvedSincePrevious: true });
      expect(successor.manifest.content.decisions.some((d) => d.decisionId === nodeDecision.id)).toBe(false);
    } finally {
      h.close();
    }
  });
});

describe("deterministic rendering", () => {
  it("renders byte-for-byte identical text for the same manifest, with the documented field order and no artifact content", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { manifest } = startRun(h, s).prepared;
      const a = renderManifest(manifest);
      const b = renderManifest(h.stores.invocations.getManifest(manifest.invocationId));
      expect(a).toEqual(b);
      expect(a.rendererVersion).toBe(1);
      const lines = a.text.split("\n");
      expect(lines[0]).toBe("# Context Manifest v1");
      expect(lines[1]).toBe(`manifest: ${manifest.id} digest ${manifest.digest}`);
      const headings = lines.filter((l) => l.startsWith("## "));
      expect(headings).toEqual(["## Instructions", "## Inputs", "## Tasks", "## Requirements (revision none)", "## Acceptance Criteria", "## Decisions", "## Handoffs", "## Artifacts", "## Capabilities", "## Tool Policy", "## Runtime Tools"]);
      expect(a.text).toContain(`- operator_message ${s.message.id}\n\`\`\`\n${s.message.content}\n\`\`\``);
      expect(a.text).toContain("- shell: approval_required");
      expect(a.text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(a.text.endsWith("\n")).toBe(true);
      expect(() => renderManifest({ ...manifest, rendererVersion: 2 })).toThrow(/renderer version 2/);
    } finally {
      h.close();
    }
  });

  it("renders a retry as the unchanged manifest plus a bounded appendix, identically before and after a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-manifest-"));
    const file = path.join(dir, "console.db");
    const first = openRuntimeHarness({ base: openHarness(file) });
    let manifest!: ContextManifest;
    let expected!: string;
    let invocationId!: Invocation["id"];
    try {
      const s = seedRuntime(first);
      const started = startRun(first, s);
      invocationId = started.prepared.invocation.id;
      manifest = started.prepared.manifest;
      first.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: ["art_000000000000000000000000"] } });
      const outcome = await first.executor.advanceInvocation(invocationId);
      expect(outcome.kind).toBe("finalized");
      const attempt = first.stores.invocations.listAttempts(invocationId)[0]!;
      expect(attempt.failureClass).toBe("result_invalid");
      const retry = renderManifest(manifest, { priorAttemptId: attempt.id, attemptNumber: 2, maxAttempts: manifest.content.allocation.attempts, failureClass: "result_invalid", detail: attempt.failureDetail! });
      const fresh = renderManifest(manifest);
      expect(retry.text.startsWith(fresh.text)).toBe(true);
      expect(retry.text.slice(fresh.text.length)).toBe(
        [
          "",
          "## Retry",
          `attempt: 2 of ${manifest.content.allocation.attempts} (0 remaining after this one)`,
          `prior_attempt: ${attempt.id}`,
          "failure_class: result_invalid",
          "detail: result invalid: unknown_artifact",
          "tool: none",
          "violations:",
          "- unknown_artifact at artifactIds.0: Artifact art_000000000000000000000000 does not exist",
          "",
        ].join("\n"),
      );
      expect(retry.text).not.toContain("transcript of");
      // The retry Attempt received exactly these bytes.
      const second = await first.executor.advanceInvocation(invocationId);
      expect(second.kind).toBe("finalized");
      expect(first.provider.requests[1]!.request.input.text).toBe(retry.text);
      expected = retry.text;
    } finally {
      first.close();
    }
    const reopened = openRuntimeHarness({ base: openHarness(file) });
    try {
      const persisted = reopened.stores.invocations.getManifest(invocationId);
      expect(persisted).toEqual(manifest);
      const attempt = reopened.stores.invocations.listAttempts(invocationId)[0]!;
      expect(renderManifest(persisted, { priorAttemptId: attempt.id, attemptNumber: 2, maxAttempts: persisted.content.allocation.attempts, failureClass: attempt.failureClass!, detail: attempt.failureDetail! }).text).toBe(expected);
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
