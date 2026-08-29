/**
 * Plan-revision service tests: accepted and rejected proposals, transaction
 * behaviour, Event ordering and causation, and every reconciliation rule
 * of execution-model §4.5 (invariants 3, 5, 15, 21, 22).
 */
import { ConflictError, InvariantViolationError, type PlanExpression, type PlanNodeId, type RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/database.ts";
import { createPersistenceContext } from "../persistence/context.ts";
import { MemoryBlobStore } from "../persistence/blob-store.ts";
import { createStores } from "../persistence/stores/index.ts";
import { seedRequirements, INVOCATION_ALLOCATION } from "../persistence/test-support.ts";
import { PlanRevisionService } from "./plan-revision-service.ts";
import { RunCreationService } from "./run-creation-service.ts";
import { accepted, FakeWorkspacePreparation, openRuntimeHarness, propose, rejected, seedRuntime, TEST_NODE_ALLOCATION, TEST_POLICY, type RuntimeHarness, type RuntimeSeed } from "./test-support.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const leaf = (agent: string, title?: string): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: agent as never, ...(title ? { title } : {}) } });
const chain = (...steps: PlanExpression[]): PlanExpression => ({ pattern: "chain", steps });
const parallel = (...items: PlanExpression[]): PlanExpression => ({ pattern: "parallel", items });

function eventTypes(h: RuntimeHarness, runId: string, afterSeq: number): string[] {
  return h.ctx.journal.read({ runId, afterSeq }).map((e) => e.type);
}

function rowCounts(h: RuntimeHarness, runId: string): Record<string, number> {
  const count = (sql: string) => (h.database.sqlite.prepare(sql).get(runId) as { n: number }).n;
  return {
    revisions: count("SELECT count(*) AS n FROM execution_plan_revisions WHERE run_id = ?"),
    nodes: count("SELECT count(*) AS n FROM plan_nodes WHERE run_id = ?"),
    membership: count("SELECT count(*) AS n FROM plan_revision_nodes WHERE run_id = ?"),
    edges: count("SELECT count(*) AS n FROM plan_edges WHERE run_id = ?"),
    scope: count("SELECT count(*) AS n FROM plan_node_requirements WHERE run_id = ?"),
    reservations: count("SELECT count(*) AS n FROM budget_reservations WHERE run_id = ?"),
  };
}

function start(h: RuntimeHarness, id: PlanNodeId): void {
  h.stores.plans.transitionNode(id, { to: "ready" });
  h.stores.plans.transitionNode(id, { to: "running" });
}

describe("accepted revisions", () => {
  it("compiles, materializes, and journals an accepted revision in one transaction with consecutive numbering", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const seq = h.ctx.journal.lastSeq();
      const outcome = accepted(propose(h, s, [chain(leaf(s.worker.id, "a"), parallel(leaf(s.worker.id), chain(leaf(s.worker.id), leaf(s.worker.id))))], { correlationId: "turn-1", causationSeq: seq }));
      expect(outcome.revision).toMatchObject({ number: 2, proposedByInvocationId: s.invocation.id });
      expect(outcome.graph.nodes.map((n) => n.sourcePath)).toEqual(["root", "e0/steps/0", "e0/steps/1/leaves", "e0/steps/1/items/1", "e0/steps/1/join"]);
      expect(outcome.graph.edges.map((e) => e.type)).toEqual(["sequence", "sequence", "fan_in", "fan_in"]);
      expect(outcome.createdNodeIds).toHaveLength(4);
      expect(outcome.reusedNodeIds).toEqual([s.created.root.id]);
      expect(outcome.cancelledNodeIds).toEqual([]);
      expect(h.stores.plans.currentGraph(runId)).toEqual(outcome.graph);
      expect(h.stores.plans.latestRevisionNumber(runId)).toBe(2);
      // Every node is pending with its allocation reserved from ordinary capacity; the join reserves nothing.
      expect(outcome.graph.nodes.slice(1).every((n) => n.status === "pending")).toBe(true);
      const active = h.stores.reservations.listByParent({ type: "run", id: runId }).filter((r) => r.status === "active");
      expect(active).toHaveLength(4);
      expect(h.stores.reservations.runCapacity(runId).ordinary.reserved.costUsd).toBe(10 + 3 * TEST_NODE_ALLOCATION.costUsd);
      // Events: revised first, then compiled, creations, reservations; all correlated and caused by the revised Event.
      const events = h.ctx.journal.read({ runId, afterSeq: seq });
      expect(events.map((e) => e.type)).toEqual([
        "execution_plan.revised",
        "execution_plan.compiled",
        "plan_node.created",
        "plan_node.created",
        "plan_node.created",
        "plan_node.created",
        "budget_reservation.created",
        "budget_reservation.created",
        "budget_reservation.created",
      ]);
      expect(events.every((e) => e.correlationId === "turn-1")).toBe(true);
      expect(events.every((e) => e.actor.kind === "invocation" && e.actor.invocationId === s.invocation.id)).toBe(true);
      expect(events[0]!.causationSeq).toBe(seq);
      expect(events.slice(1).every((e) => e.causationSeq === events[0]!.seq)).toBe(true);
      expect(events[1]!.payload).toMatchObject({ revisionNumber: 2, createdNodeIds: outcome.createdNodeIds, reusedNodeIds: [s.created.root.id], cancelledNodeIds: [] });
    } finally {
      h.close();
    }
  });

  it("the root belongs to every accepted revision and revision numbers count accepted revisions only", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      accepted(propose(h, s, [leaf(s.worker.id)]));
      rejected(propose(h, s, [leaf("agdr_000000000000000000000000")]));
      accepted(propose(h, s, [leaf(s.worker.id), leaf(s.worker.id)]));
      expect(h.stores.plans.listRevisions(runId).map((r) => r.number)).toEqual([1, 2, 3]);
      for (const number of [1, 2, 3]) {
        expect(h.stores.plans.listMembership(runId, number)[0]).toMatchObject({ planNodeId: s.created.root.id, position: 0 });
      }
    } finally {
      h.close();
    }
  });

  it("only an Orchestrator Invocation of the Run may propose; an ended Run cannot be revised", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const seq = h.ctx.journal.lastSeq();
      const worker = h.stores.invocations.create({ runId: s.created.run.id, planNodeId: s.created.root.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.worker.id, continuedFromInvocationId: null, taskIds: [], allocation: { costUsd: 0.1, tokens: 10, attempts: 1 } });
      expect(() => h.planRevisions.propose({ runId: s.created.run.id, proposedByInvocationId: worker.id, source: { version: 1, expressions: [] } })).toThrow(InvariantViolationError);
      const other = seedRuntime(h);
      expect(() => h.planRevisions.propose({ runId: s.created.run.id, proposedByInvocationId: other.invocation.id, source: { version: 1, expressions: [] } })).toThrow(InvariantViolationError);
      // Authorization failures are errors, not rejections: no rejected Event.
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).filter((e) => e.type === "execution_plan.rejected")).toHaveLength(0);
      h.stores.runs.transition(s.created.run.id, { to: "cancelled" });
      expect(() => propose(h, s, [])).toThrow(ConflictError);
    } finally {
      h.close();
    }
  });
});

describe("rejected proposals", () => {
  it("writes exactly one execution_plan.rejected Event with stable reasons and correlation, consuming no revision number", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const before = rowCounts(h, runId);
      const seq = h.ctx.journal.lastSeq();
      const cases: [unknown, string][] = [
        [{ version: 1, expressions: [{ pattern: "join" }] }, "explicit_join"],
        [{ version: 1, expressions: [{ pattern: "carousel" }] }, "unsupported_pattern"],
        [{ version: 1, expressions: [{ pattern: "chain", steps: [] }] }, "invalid_structure"],
        [{ version: 1, expressions: [leaf("agdr_000000000000000000000000")] }, "invalid_agent_definition_revision"],
        [{ version: 1, expressions: [{ ...leaf(s.worker.id), scope: { requirementRootIds: ["req_000000000000000000000000"], requirementRevisionId: "reqr_000000000000000000000000" } }] }, "invalid_requirement_scope"],
        [{ version: 1, expressions: [{ pattern: "evaluator_optimizer", producer: chain(leaf(s.worker.id), leaf(s.worker.id)), evaluator: { agentDefinitionRevisionId: s.worker.id }, maxRounds: 7 }] }, "excessive_unrolled_rounds"],
        [{ version: 1, expressions: [chain(chain(chain(chain(chain(leaf(s.worker.id))))))] }, "excessive_source_depth"],
        [{ version: 1, expressions: [{ pattern: "coordinator_worker", coordinator: { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id } }, worker: { agentDefinitionRevisionId: s.worker.id } }] }, "nested_coordinator_worker"],
        [{ version: 1, expressions: [{ ...leaf(s.worker.id), allocation: { costUsd: 1000, tokens: 1, attempts: 1 } }] }, "insufficient_capacity"],
      ];
      const cyclic: Record<string, unknown> = { version: 1, expressions: [] };
      const loop: Record<string, unknown> = { pattern: "chain", steps: [] };
      (loop.steps as unknown[]).push(loop);
      (cyclic.expressions as unknown[]).push(loop);
      cases.push([cyclic, "cyclic_source_object"]);
      let expectedSeq = seq;
      for (const [source, code] of cases) {
        const outcome = rejected(h.planRevisions.propose({ runId, proposedByInvocationId: s.invocation.id, source, correlationId: `turn-${code}`, causationSeq: seq }));
        expect(outcome.reasons[0]!.code, code).toBe(code);
        expect(outcome.reasons[0]!.message.length).toBeGreaterThan(0);
        expect(outcome.currentRevisionNumber).toBe(1);
        expectedSeq += 1;
        expect(outcome.eventSeq).toBe(expectedSeq);
        const event = h.ctx.journal.read({ runId, afterSeq: expectedSeq - 1 })[0]!;
        expect(event.type).toBe("execution_plan.rejected");
        expect(event.payload).toEqual({ runId, proposedByInvocationId: s.invocation.id, currentRevisionNumber: 1, reasons: outcome.reasons });
        expect(event).toMatchObject({ correlationId: `turn-${code}`, causationSeq: seq, actor: { kind: "invocation", invocationId: s.invocation.id }, scope: { runId, invocationId: s.invocation.id } });
      }
      expect(h.ctx.journal.lastSeq()).toBe(expectedSeq);
      expect(rowCounts(h, runId)).toEqual(before);
      expect(h.stores.plans.latestRevisionNumber(runId)).toBe(1);
      // The next accepted revision is number 2: rejections consumed nothing.
      expect(accepted(propose(h, s, [leaf(s.worker.id)])).revision.number).toBe(2);
    } finally {
      h.close();
    }
  });

  it("an unexpected persistence failure throws and writes no false rejection", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const seq = h.ctx.journal.lastSeq();
      const before = rowCounts(h, runId);
      const original = h.stores.plans.materializeRevision.bind(h.stores.plans);
      h.stores.plans.materializeRevision = () => {
        throw new Error("disk full");
      };
      expect(() => propose(h, s, [leaf(s.worker.id)])).toThrow(/disk full/);
      h.stores.plans.materializeRevision = original;
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(rowCounts(h, runId)).toEqual(before);
      expect(h.ctx.journal.read({ runId, type: "execution_plan.rejected" })).toHaveLength(0);
      expect(accepted(propose(h, s, [leaf(s.worker.id)])).revision.number).toBe(2);
    } finally {
      h.close();
    }
  });
});

describe("reconciliation", () => {
  function twoNodes(h: RuntimeHarness, s: RuntimeSeed) {
    const outcome = accepted(propose(h, s, [leaf(s.worker.id, "A"), leaf(s.worker.id, "B")]));
    const [a, b] = outcome.graph.nodes.slice(1);
    return { outcome, a: a!, b: b! };
  }

  it("an identical revision reuses every node with no new reservation", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { a, b } = twoNodes(h, s);
      const again = accepted(propose(h, s, [leaf(s.worker.id, "A"), leaf(s.worker.id, "B")]));
      expect(again.revision.number).toBe(3);
      expect(again.createdNodeIds).toEqual([]);
      expect(again.reusedNodeIds).toEqual([s.created.root.id, a.id, b.id]);
      expect(again.cancelledNodeIds).toEqual([]);
      expect(h.stores.plans.listNodes(s.created.run.id)).toHaveLength(3);
      expect(h.stores.reservations.listByParent({ type: "run", id: s.created.run.id })).toHaveLength(3);
      expect(h.stores.plans.listMembership(s.created.run.id, 3).map((m) => m.planNodeId)).toEqual([s.created.root.id, a.id, b.id]);
    } finally {
      h.close();
    }
  });

  it("appending a sibling keeps existing nodes, ids, status, timestamps, and reservations", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { a, b } = twoNodes(h, s);
      start(h, a.id);
      const started = h.stores.plans.getNode(a.id);
      const extended = accepted(propose(h, s, [leaf(s.worker.id, "A"), leaf(s.worker.id, "B"), leaf(s.worker.id, "C")]));
      expect(extended.reusedNodeIds).toEqual([s.created.root.id, a.id, b.id]);
      expect(extended.createdNodeIds).toHaveLength(1);
      expect(h.stores.plans.getNode(a.id)).toEqual(started);
      expect(h.stores.plans.getNode(a.id).createdInRevisionNumber).toBe(2);
      expect(h.stores.reservations.listByChild({ type: "plan_node", id: a.id })).toHaveLength(1);
      expect(extended.graph.nodes.map((n) => n.sourcePath)).toEqual(["root", "e0", "e1", "e2"]);
    } finally {
      h.close();
    }
  });

  it("removing an unstarted node cancels it and releases its reservation; removing a running node leaves it untouched but out of membership", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const { a, b } = twoNodes(h, s);
      start(h, a.id);
      const seq = h.ctx.journal.lastSeq();
      const shrunk = accepted(propose(h, s, []));
      expect(shrunk.cancelledNodeIds).toEqual([b.id]);
      expect(shrunk.graph.nodes.map((n) => n.id)).toEqual([s.created.root.id]);
      expect(h.stores.plans.getNode(b.id)).toMatchObject({ status: "cancelled" });
      expect(h.stores.reservations.listByChild({ type: "plan_node", id: b.id })[0]).toMatchObject({ status: "released", releaseReason: "plan_revision_cancelled", consumed: { costUsd: 0, tokens: 0, attempts: 0 } });
      // The running node keeps its state and reservation; it is simply no longer a member.
      expect(h.stores.plans.getNode(a.id)).toMatchObject({ status: "running" });
      expect(h.stores.reservations.listByChild({ type: "plan_node", id: a.id })[0]).toMatchObject({ status: "active" });
      expect(h.stores.plans.listMembership(runId, 3).map((m) => m.planNodeId)).toEqual([s.created.root.id]);
      expect(h.stores.plans.listMembership(runId, 2).map((m) => m.planNodeId)).toEqual([s.created.root.id, a.id, b.id]);
      expect(eventTypes(h, runId, seq)).toEqual(["execution_plan.revised", "plan_node.cancelled", "budget_reservation.released", "execution_plan.compiled"]);
      // Its running execution may still finish; only the current graph controls scheduling.
      h.stores.plans.transitionNode(a.id, { to: "succeeded", outputArtifactIds: [] });
      expect(h.stores.plans.currentGraph(runId).nodes.map((n) => n.id)).toEqual([s.created.root.id]);
    } finally {
      h.close();
    }
  });

  it("a changed definition replaces an unstarted node with a new id and rejects for a started or terminal node", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const { a, b } = twoNodes(h, s);
      const changedB = accepted(propose(h, s, [leaf(s.worker.id, "A"), leaf(s.worker.id, "B changed")]));
      expect(changedB.reusedNodeIds).toEqual([s.created.root.id, a.id]);
      expect(changedB.cancelledNodeIds).toEqual([b.id]);
      expect(changedB.createdNodeIds).toHaveLength(1);
      const newB = changedB.graph.nodes[2]!;
      expect(newB.id).not.toBe(b.id);
      expect(newB.sourcePath).toBe("e1");
      expect(newB.title).toBe("B changed");
      expect(h.stores.plans.getNode(b.id)).toMatchObject({ status: "cancelled", title: "B" });
      // Definition-level changes all replace: allocation, scope, limits, policies, bindings.
      const { revision, leafIds } = seedRequirements(h, { conversation: h.stores.conversations.get(s.created.run.conversationId) } as never, 2);
      const scoped = accepted(propose(h, s, [leaf(s.worker.id, "A"), { ...leaf(s.worker.id, "B changed"), scope: { requirementRootIds: [leafIds[0]!], requirementRevisionId: revision.id } }]));
      expect(scoped.cancelledNodeIds).toEqual([newB.id]);
      expect(h.stores.plans.listScope(scoped.graph.nodes[2]!.id).map((r) => r.requirementId)).toEqual([leafIds[0]]);
      const reallocated = accepted(propose(h, s, [leaf(s.worker.id, "A"), { ...leaf(s.worker.id, "B changed"), scope: { requirementRootIds: [leafIds[0]!], requirementRevisionId: revision.id }, allocation: { costUsd: 1, tokens: 1, attempts: 1 } }]));
      expect(reallocated.cancelledNodeIds).toEqual([scoped.graph.nodes[2]!.id]);
      expect(reallocated.reusedNodeIds).toEqual([s.created.root.id, a.id]);
      // A started node cannot change: the whole proposal is rejected and nothing is written.
      start(h, a.id);
      const before = h.stores.plans.currentGraph(runId);
      const seq = h.ctx.journal.lastSeq();
      const conflict = rejected(propose(h, s, [leaf(s.worker.id, "A renamed")]));
      expect(conflict.reasons).toEqual([{ code: "started_node_changed", message: expect.stringContaining(a.id), path: "e0" }]);
      expect(h.stores.plans.currentGraph(runId)).toEqual(before);
      expect(eventTypes(h, runId, seq)).toEqual(["execution_plan.rejected"]);
      h.stores.plans.transitionNode(a.id, { to: "succeeded", outputArtifactIds: [] });
      expect(rejected(propose(h, s, [leaf(s.worker.id, "A renamed")])).reasons[0]!.code).toBe("started_node_changed");
      // A removed terminal node is not rewritten; it just leaves the membership.
      const removed = accepted(propose(h, s, []));
      expect(removed.cancelledNodeIds).toEqual([reallocated.graph.nodes[2]!.id]);
      expect(h.stores.plans.getNode(a.id).status).toBe("succeeded");
    } finally {
      h.close();
    }
  });

  it("an edge-only change reuses both nodes and writes revision-specific edges; historical edges never reach the current graph", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      // Two independent top-level leaves, then the same two leaves as a chain of composite steps: the nodes keep their
      // definitions only if their source paths match, so build them at chain-step paths from the start.
      const first = accepted(propose(h, s, [chain(leaf(s.worker.id, "A"), parallel(leaf(s.worker.id), chain(leaf(s.worker.id), leaf(s.worker.id))), leaf(s.worker.id, "Z"))]));
      const keep = first.graph.nodes.slice(1).map((n) => n.id);
      expect(first.graph.edges).toHaveLength(5);
      // Same nodes, different wiring: swap the parallel's aggregation policy only affects the join... instead drop Z's predecessor by moving Z to its own expression.
      const second = accepted(propose(h, s, [chain(leaf(s.worker.id, "A"), parallel(leaf(s.worker.id), chain(leaf(s.worker.id), leaf(s.worker.id)))), leaf(s.worker.id, "Z")]));
      // The parallel's nodes are reused (same paths, same definitions); Z moved path so it is replaced.
      expect(second.reusedNodeIds).toEqual([s.created.root.id, ...keep.slice(0, 4)]);
      expect(second.cancelledNodeIds).toEqual([keep[4]]);
      expect(second.graph.edges.every((e) => e.revisionNumber === 3)).toBe(true);
      expect(second.graph.edges).toHaveLength(4);
      expect(h.stores.plans.graph(runId, 2).edges.every((e) => e.revisionNumber === 2)).toBe(true);
      expect(h.stores.plans.graph(runId, 2).edges).toHaveLength(5);
      const secondEdgeIds = new Set(second.graph.edges.map((e) => e.id));
      expect(h.stores.plans.graph(runId, 2).edges.some((e) => secondEdgeIds.has(e.id))).toBe(false);
      // The old join -> Z edge exists only in revision 2 and is not an input to the current graph.
      expect(h.stores.plans.currentGraph(runId).edges.some((e) => e.targetNodeId === keep[4])).toBe(false);
    } finally {
      h.close();
    }
  });

  it("an allocation failure rolls back the entire candidate revision (invariant 22)", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const runId = s.created.run.id;
      const { a } = twoNodes(h, s);
      const before = rowCounts(h, runId);
      const seq = h.ctx.journal.lastSeq();
      // Ordinary capacity after root (10) + two nodes (8) is 77 of 95; ask for more than that.
      const outcome = rejected(propose(h, s, [leaf(s.worker.id, "A"), leaf(s.worker.id, "B"), { ...leaf(s.worker.id, "C"), allocation: { costUsd: 80, tokens: 1, attempts: 1 } }]));
      expect(outcome.reasons[0]).toMatchObject({ code: "insufficient_capacity" });
      expect(rowCounts(h, runId)).toEqual(before);
      expect(eventTypes(h, runId, seq)).toEqual(["execution_plan.rejected"]);
      expect(h.stores.plans.getNode(a.id).status).toBe("pending");
      // Capacity released by cancelling a removed node counts towards the candidate; the reserve never does.
      const capacity = h.stores.reservations.runCapacity(runId);
      const swap = accepted(propose(h, s, [{ ...leaf(s.worker.id, "C"), allocation: { costUsd: capacity.ordinary.available.costUsd + 2 * TEST_NODE_ALLOCATION.costUsd, tokens: 1, attempts: 1 } }]));
      expect(swap.cancelledNodeIds).toHaveLength(2);
      expect(h.stores.reservations.runCapacity(runId).ordinary.available.costUsd).toBeCloseTo(0);
      expect(h.stores.reservations.runCapacity(runId).final.available).toEqual(s.created.run.finalReserve);
      expect(rejected(propose(h, s, [{ ...leaf(s.worker.id, "C"), allocation: { costUsd: capacity.ordinary.available.costUsd + 2 * TEST_NODE_ALLOCATION.costUsd + 0.5, tokens: 1, attempts: 1 } }])).reasons[0]!.code).toBe("insufficient_capacity");
    } finally {
      h.close();
    }
  });

  it("the current graph survives closing and reopening the database identically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-execution-"));
    const file = path.join(dir, "console.db");
    const first = openDatabase(file);
    let expected: unknown;
    let runId!: RunId;
    try {
      const ctx = createPersistenceContext(first, new MemoryBlobStore());
      const stores = createStores(ctx);
      const workspace = stores.workspaces.create({ name: "w", rootPath: dir, kind: "git" });
      const conversation = stores.conversations.create({ workspaceId: workspace.id, title: null });
      const definition = stores.agents.ensureDefinition("orchestrator");
      const orchestrator = stores.agents.appendRevision(definition.id, {
        provenance: { kind: "builtin" },
        modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
        instructions: "orchestrate",
        capabilities: { tools: ["read", "write", "shell"], mcpServers: [] },
        toolPolicy: {},
        defaultLimits: { allocation: INVOCATION_ALLOCATION, maxWallClockMs: null },
      });
      const runCreation = new RunCreationService(ctx, stores, new FakeWorkspacePreparation(), TEST_POLICY);
      const created = runCreation.create({ conversationId: conversation.id, kind: "code", target: { kind: "branch", branch: "main" }, budget: { maxCostUsd: 100, maxTokens: 1_000_000, maxAttempts: 50, maxWallClockMs: null, maxConcurrency: null }, orchestratorAgentDefinitionRevisionId: orchestrator.id });
      runId = created.run.id;
      const invocation = stores.invocations.create({ runId: created.run.id, planNodeId: created.root.id, role: "orchestrator", purpose: "operator_input", agentDefinitionRevisionId: orchestrator.id, continuedFromInvocationId: null, taskIds: [], allocation: INVOCATION_ALLOCATION });
      const service = new PlanRevisionService(ctx, stores, { defaults: { nodeAllocation: TEST_NODE_ALLOCATION, coordinatorWorkerBounds: { maxTasks: 8, maxConcurrentWorkers: 2, maxCoordinatorInvocations: 4 } }, limits: { maxPlanDepth: 4, maxUnrolledRounds: 6, maxPlanNodes: 200 } });
      const outcome = service.propose({ runId, proposedByInvocationId: invocation.id, source: { version: 1, expressions: [chain(leaf(orchestrator.id, "a"), parallel(leaf(orchestrator.id), chain(leaf(orchestrator.id), leaf(orchestrator.id))))] } });
      if (!outcome.accepted) throw new Error("expected acceptance");
      expected = stores.plans.currentGraph(runId);
    } finally {
      first.close();
    }
    const second = openDatabase(file);
    try {
      const stores = createStores(createPersistenceContext(second, new MemoryBlobStore()));
      expect(stores.plans.currentGraph(runId)).toEqual(expected);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
