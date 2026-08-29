import { ConflictError, InsufficientCapacityError, InvariantViolationError, ValidationError, type PlanNodeId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { extendPlan, joinDefinition, nodeInput, openHarness, patternDefinition, seedRequirements, seedRun } from "../test-support.ts";

describe("execution plan revisions", () => {
  it("appends numbered, immutable source revisions and rejects unknown Patterns", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const second = h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [{ pattern: "single", operation: { agentDefinitionRevisionId: s.definition.id } }] }, null);
      expect(second.number).toBe(2);
      expect(h.stores.plans.listRevisions(s.run.id).map((r) => r.number)).toEqual([1, 2]);
      expect(h.stores.plans.latestRevisionNumber(s.run.id)).toBe(2);
      expect(() => h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [{ pattern: "pipeline", steps: [] }] }, null)).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("UPDATE execution_plan_revisions SET number = 9 WHERE run_id = ?").run(s.run.id)).toThrow(/immutable/);
      h.stores.runs.transition(s.run.id, { to: "cancelled" });
      expect(() => h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, null)).toThrow(ConflictError);
    } finally {
      h.close();
    }
  });

  it("only an Orchestrator Invocation of the Run may propose a revision", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const worker = h.stores.invocations.create({ runId: s.run.id, planNodeId: s.root.id, role: "worker", purpose: "step", agentDefinitionRevisionId: s.definition.id, continuedFromInvocationId: null, taskIds: [], allocation: { costUsd: 1, tokens: 10, attempts: 1 } });
      expect(() => h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, worker.id)).toThrow(/only the Orchestrator/);
      const other = seedRun(h);
      const foreign = h.stores.invocations.create({ runId: other.run.id, planNodeId: other.root.id, role: "orchestrator", purpose: "operator_input", agentDefinitionRevisionId: other.definition.id, continuedFromInvocationId: null, taskIds: [], allocation: { costUsd: 1, tokens: 10, attempts: 1 } });
      expect(() => h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, foreign.id)).toThrow(InvariantViolationError);
    } finally {
      h.close();
    }
  });
});

describe("revision membership and edges", () => {
  it("materializes nodes, joins, revision-owned edges, and ordered scope rows, reserving allocations atomically", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s, 2);
      const scope = { requirementRevisionId: revision.id, requirementIds: leafIds };
      const a = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e0/items/0", title: "A", scope }));
      const b = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e0/items/1", title: "B", scope }));
      const j = nodeInput(h, joinDefinition({ fanInPolicy: "require_any", sourcePath: "e0/join" }));
      const agg = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e0/aggregate", title: "Agg" }));
      const graph = extendPlan(h, s, [a, b, j, agg], [
        { type: "fan_in", sourceNodeId: a.id, targetNodeId: j.id, position: 0 },
        { type: "fan_in", sourceNodeId: b.id, targetNodeId: j.id, position: 1 },
        { type: "sequence", sourceNodeId: j.id, targetNodeId: agg.id, position: 0 },
      ]);
      expect(graph.revisionNumber).toBe(2);
      expect(graph.nodes.map((n) => n.id)).toEqual([s.root.id, a.id, b.id, j.id, agg.id]);
      expect(graph.nodes.slice(1).map((n) => n.status)).toEqual(["pending", "pending", "pending", "pending"]);
      expect(graph.nodes.map((n) => n.createdInRevisionNumber)).toEqual([1, 2, 2, 2, 2]);
      const join = h.stores.plans.getNode(j.id);
      expect(join.kind).toBe("join");
      if (join.kind === "join") expect(join.fanInPolicy).toBe("require_any");
      // Edges belong to revision 2 alone and come back in fan-in order per target.
      expect(h.stores.plans.listEdges(s.run.id, 1)).toEqual([]);
      expect(h.stores.plans.listEdges(s.run.id, 2).map((e) => [e.type, e.revisionNumber, e.position])).toEqual([["fan_in", 2, 0], ["fan_in", 2, 1], ["sequence", 2, 0]]);
      // Membership is explicit: revision 1 holds the root only; revision 2 holds root plus the four new nodes in order.
      expect(h.stores.plans.listMembership(s.run.id, 1).map((m) => [m.planNodeId, m.position])).toEqual([[s.root.id, 0]]);
      expect(h.stores.plans.listMembership(s.run.id, 2).map((m) => m.position)).toEqual([0, 1, 2, 3, 4]);
      expect(h.stores.plans.currentGraph(s.run.id)).toEqual(graph);
      expect(h.stores.plans.graph(s.run.id, 1).nodes.map((n) => n.id)).toEqual([s.root.id]);
      // Scope is materialized per pattern node in deterministic order: identical rows under siblings, none for the join.
      expect(h.stores.plans.listScope(a.id).map((r) => [r.requirementId, r.position])).toEqual(leafIds.map((id, i) => [id, i]));
      expect(h.stores.plans.listScope(b.id)).toHaveLength(2);
      expect(h.stores.plans.listScope(j.id)).toHaveLength(0);
      expect(h.stores.plans.getNode(a.id)).toMatchObject({ scope });
      expect(h.stores.plans.isInScope(a.id, leafIds[0]!, revision.id)).toBe(true);
      expect(h.stores.plans.isInScope(j.id, leafIds[0]!, revision.id)).toBe(false);
      // The lookup is served by the primary key, not a scan.
      const plan = h.database.sqlite.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM plan_node_requirements WHERE plan_node_id = ? AND requirement_id = ? AND requirement_revision_id = ?").all(a.id, leafIds[0], revision.id) as { detail: string }[];
      expect(plan.some((row) => /USING (COVERING )?INDEX|PRIMARY KEY/.test(row.detail))).toBe(true);
      // Reservations: one per pattern node (root + a + b + agg), none for the join, all ordinary.
      const reservations = h.stores.reservations.listByParent({ type: "run", id: s.run.id });
      expect(reservations.filter((r) => r.status === "active")).toHaveLength(4);
      expect(reservations.every((r) => r.capacitySource === "ordinary")).toBe(true);
      expect(reservations.some((r) => r.child.id === j.id)).toBe(false);
      // Events: one compiled Event naming the full membership, one created Event per new node.
      const compiled = h.ctx.journal.read({ runId: s.run.id, type: "execution_plan.compiled" });
      expect(compiled).toHaveLength(2);
      expect(compiled[1]!.payload).toMatchObject({ revisionNumber: 2, createdNodeIds: [a.id, b.id, j.id, agg.id], reusedNodeIds: [s.root.id], cancelledNodeIds: [] });
      expect(h.ctx.journal.read({ runId: s.run.id, type: "plan_node.created" })).toHaveLength(5);
    } finally {
      h.close();
    }
  });

  it("rejects malformed materializations and writes nothing", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s);
      const before = h.ctx.journal.lastSeq();
      const attempt = (nodes: ReturnType<typeof nodeInput>[], edges: Parameters<typeof extendPlan>[3] = []) => () => extendPlan(h, s, nodes, edges);
      expect(attempt([nodeInput(h, { ...joinDefinition(), pattern: "single" } as never)])).toThrow(ValidationError);
      expect(attempt([nodeInput(h, { ...patternDefinition(s.definition.id), pattern: undefined } as never)])).toThrow(ValidationError);
      expect(attempt([nodeInput(h, { ...patternDefinition(s.definition.id), pattern: "chain" } as never)])).toThrow(/Pattern and its shape agree/);
      expect(attempt([nodeInput(h, { ...joinDefinition(), scope: { requirementRevisionId: revision.id, requirementIds: leafIds } } as never)])).toThrow(ValidationError);
      const j = nodeInput(h, joinDefinition());
      const p = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1" }));
      const q = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e2" }));
      expect(attempt([p, q], [{ type: "fan_in", sourceNodeId: p.id, targetNodeId: q.id, position: 0 }])).toThrow(/requires a join node/);
      expect(attempt([p, j], [{ type: "sequence", sourceNodeId: p.id, targetNodeId: j.id, position: 0 }])).toThrow(/only fan_in edges/);
      expect(attempt([p, q], [{ type: "sequence", sourceNodeId: p.id, targetNodeId: q.id, position: 0 }, { type: "sequence", sourceNodeId: q.id, targetNodeId: p.id, position: 0 }])).toThrow(/cycle/);
      expect(attempt([p, q], [{ type: "sequence", sourceNodeId: p.id, targetNodeId: q.id, position: 0 }, { type: "sequence", sourceNodeId: p.id, targetNodeId: q.id, position: 1 }])).toThrow(/duplicate PlanEdge/);
      expect(attempt([p, q], [{ type: "sequence", sourceNodeId: p.id, targetNodeId: q.id, position: 1 }])).toThrow(/positioned 0/);
      expect(attempt([p, q], [{ type: "sequence", sourceNodeId: p.id, targetNodeId: s.root.id, position: 0 }])).toThrow(/root node has no predecessors/);
      expect(attempt([p, nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1" }))])).toThrow(/held by two members/);
      const stranger = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e3" }));
      expect(attempt([p], [{ type: "sequence", sourceNodeId: p.id, targetNodeId: stranger.id, position: 0 }])).toThrow(/not a member/);
      // A single Orchestrator node is only ever the root.
      expect(attempt([nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e4", shape: { pattern: "single", role: "orchestrator", operation: { agentDefinitionRevisionId: s.definition.id, title: "x", input: { taskIds: [], decisionIds: [], artifactIds: [] } } } }))])).toThrow(/only the root node/);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.plans.listNodes(s.run.id)).toHaveLength(1);
      expect(h.stores.plans.latestRevisionNumber(s.run.id)).toBe(1);
    } finally {
      h.close();
    }
  });

  it("a revision's membership must begin with the root and cannot be materialized twice", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const p = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1" }));
      expect(() =>
        h.ctx.tx.write(() => {
          const revision = h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, null);
          h.stores.plans.materializeRevision({ runId: s.run.id, revisionNumber: revision.number, membership: [p.id], createdNodes: [p], edges: [], cancelledNodeIds: [] });
        }),
      ).toThrow(/begins with the root/);
      expect(() =>
        h.stores.plans.materializeRevision({ runId: s.run.id, revisionNumber: 1, membership: [s.root.id, p.id], createdNodes: [p], edges: [], cancelledNodeIds: [] }),
      ).toThrow(/already materialized/);
      expect(h.stores.plans.latestRevisionNumber(s.run.id)).toBe(1);
      expect(h.stores.plans.listNodes(s.run.id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("scope rows must name existing leaf Requirements of the Run's Conversation at the pinned revision", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, rootId, leafIds } = seedRequirements(h, s);
      const withScope = (scope: { requirementRevisionId: string; requirementIds: string[] }) => [nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", scope: scope as never }))];
      expect(() => extendPlan(h, s, withScope({ requirementRevisionId: revision.id, requirementIds: [rootId] }))).toThrow(/not a leaf/);
      expect(() => extendPlan(h, s, withScope({ requirementRevisionId: revision.id, requirementIds: ["req_000000000000000000000000"] }))).toThrow(/does not exist/);
      const other = seedRun(h);
      const foreign = seedRequirements(h, other);
      expect(() => extendPlan(h, s, withScope({ requirementRevisionId: foreign.revision.id, requirementIds: [foreign.leafIds[0]!] }))).toThrow(/belongs to Conversation/);
      // A later Requirement revision does not touch existing rows: pin to revision 1, then create revision 2.
      const [p] = withScope({ requirementRevisionId: revision.id, requirementIds: [leafIds[0]!] });
      extendPlan(h, s, [p!]);
      h.stores.requirements.createRevision({ conversationId: s.conversation.id, approvedByDecisionId: null, tree: [{ id: leafIds[0]!, parentId: null, composition: null, statement: "only one now", position: 0, acceptanceCriterionIds: [] }] });
      expect(h.stores.plans.listScope(p!.id)).toEqual([{ planNodeId: p!.id, runId: s.run.id, requirementId: leafIds[0], requirementRevisionId: revision.id, position: 0 }]);
      expect(() => h.database.sqlite.prepare("DELETE FROM plan_node_requirements").run()).toThrow(/never deleted/);
    } finally {
      h.close();
    }
  });

  it("rejects a revision whose allocations exceed ordinary Run capacity after the final reserve, writing nothing", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, {
        budget: { maxCostUsd: 20, maxTokens: 1_000_000, maxAttempts: 50, maxWallClockMs: null, maxConcurrency: null },
        finalReserve: { costUsd: 5, tokens: 0, attempts: 0 },
      });
      // Root holds 10 of the 15 ordinary dollars; the 5 in reserve are not available to compiled nodes.
      const before = h.ctx.journal.lastSeq();
      const tooBig = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", allocation: { costUsd: 6, tokens: 1, attempts: 1 } }));
      expect(() => extendPlan(h, s, [tooBig])).toThrow(InsufficientCapacityError);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.plans.listNodes(s.run.id)).toHaveLength(1);
      expect(h.stores.plans.latestRevisionNumber(s.run.id)).toBe(1);
      const fits = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", allocation: { costUsd: 5, tokens: 1, attempts: 1 } }));
      extendPlan(h, s, [fits]);
      expect(h.stores.reservations.runCapacity(s.run.id).ordinary.available.costUsd).toBe(0);
      expect(h.stores.reservations.runCapacity(s.run.id).final.available.costUsd).toBe(5);
    } finally {
      h.close();
    }
  });

  it("transitions nodes, forbids a join from running, and releases the node reservation on a terminal state", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const j = nodeInput(h, joinDefinition());
      const p = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1" }));
      extendPlan(h, s, [p, j], [{ type: "fan_in", sourceNodeId: p.id, targetNodeId: j.id, position: 0 }]);
      h.stores.plans.transitionNode(j.id, { to: "ready" });
      expect(() => h.stores.plans.transitionNode(j.id, { to: "running" })).toThrow(ValidationError);
      expect(h.stores.plans.transitionNode(j.id, { to: "failed" }).status).toBe("failed");
      h.stores.plans.transitionNode(p.id, { to: "ready" });
      expect(() => h.stores.plans.transitionNode(p.id, { to: "succeeded", outputArtifactIds: [] })).toThrow(ValidationError);
      h.stores.plans.transitionNode(p.id, { to: "running" });
      h.stores.plans.transitionNode(p.id, { to: "waiting", waitReason: "decision" });
      expect(h.stores.plans.getNode(p.id).waitReason).toBe("decision");
      h.stores.plans.transitionNode(p.id, { to: "running" });
      const done = h.stores.plans.transitionNode(p.id, { to: "succeeded", outputArtifactIds: [] });
      expect(done.endedAt).not.toBeNull();
      const reservation = h.stores.reservations.listByChild({ type: "plan_node", id: p.id as PlanNodeId })[0]!;
      expect(reservation.status).toBe("released");
      expect(reservation.releaseReason).toBe("child_terminal");
      expect(() => h.stores.plans.transitionNode(p.id, { to: "running" })).toThrow(/cannot transition from succeeded/);
      expect(h.ctx.journal.read({ runId: s.run.id }).map((e) => e.type)).toEqual(
        expect.arrayContaining(["plan_node.ready", "plan_node.failed", "plan_node.started", "plan_node.waiting", "plan_node.wait_cleared", "plan_node.succeeded", "budget_reservation.released"]),
      );
      // Cancellation records its reason and releases with the matching reservation reason.
      const q = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e2" }));
      extendPlan(h, s, [q]);
      const cancelled = h.stores.plans.transitionNode(q.id, { to: "cancelled", reason: "plan_revision" });
      expect(cancelled.status).toBe("cancelled");
      expect(h.stores.reservations.listByChild({ type: "plan_node", id: q.id })[0]!.releaseReason).toBe("plan_revision_cancelled");
      expect(h.ctx.journal.read({ runId: s.run.id, type: "plan_node.cancelled" })[0]!.payload).toEqual({ from: "pending", to: "cancelled", reason: "plan_revision" });
    } finally {
      h.close();
    }
  });

  it("historical edges never reach the current graph and a node reused across revisions keeps one row", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const a = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e0", title: "A" }));
      const b = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1", title: "B" }));
      extendPlan(h, s, [a, b], [{ type: "sequence", sourceNodeId: a.id, targetNodeId: b.id, position: 0 }]);
      // Revision 3 keeps both nodes but drops the edge (an edge-only change): membership rows and edges are per revision.
      h.ctx.tx.write(() => {
        const revision = h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, null);
        h.stores.plans.materializeRevision({ runId: s.run.id, revisionNumber: revision.number, membership: [s.root.id, a.id, b.id], createdNodes: [], edges: [], cancelledNodeIds: [] });
      });
      expect(h.stores.plans.currentGraph(s.run.id).edges).toEqual([]);
      expect(h.stores.plans.graph(s.run.id, 2).edges).toHaveLength(1);
      expect(h.stores.plans.listNodes(s.run.id)).toHaveLength(3);
      expect(h.stores.plans.listMembership(s.run.id, 3).map((m) => m.planNodeId)).toEqual([s.root.id, a.id, b.id]);
      expect(h.stores.plans.findMember(s.run.id, 3, "e1")?.id).toBe(b.id);
      expect(h.stores.plans.findMember(s.run.id, 3, "e9")).toBeNull();
      // Revision 4 drops b from membership: b's row, state, and reservation are untouched by membership alone.
      h.ctx.tx.write(() => {
        const revision = h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [] }, null);
        h.stores.plans.materializeRevision({ runId: s.run.id, revisionNumber: revision.number, membership: [s.root.id, a.id], createdNodes: [], edges: [], cancelledNodeIds: [] });
      });
      expect(h.stores.plans.currentGraph(s.run.id).nodes.map((n) => n.id)).toEqual([s.root.id, a.id]);
      expect(h.stores.plans.getNode(b.id).status).toBe("pending");
      expect(h.stores.reservations.listByParent({ type: "run", id: s.run.id }).filter((r) => r.status === "active")).toHaveLength(3);
      expect(h.stores.plans.graph(s.run.id, 3).nodes.map((n) => n.id)).toEqual([s.root.id, a.id, b.id]);
    } finally {
      h.close();
    }
  });
});
