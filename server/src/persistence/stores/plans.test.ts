import { ConflictError, InsufficientCapacityError, ValidationError, type PlanNodeId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { joinNode, openHarness, patternNode, seedRequirements, seedRun } from "../test-support.ts";

describe("execution plan revisions", () => {
  it("appends numbered, immutable source revisions and rejects unknown Patterns", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const second = h.stores.plans.appendRevision(s.run.id, { version: 1, expressions: [{ pattern: "single", operation: { agentDefinitionRevisionId: s.definition.id } }] }, null);
      expect(second.number).toBe(2);
      expect(h.stores.plans.listRevisions(s.run.id).map((r) => r.number)).toEqual([1, 2]);
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
    } finally {
      h.close();
    }
  });
});

describe("compiled graph", () => {
  it("persists pattern nodes, join nodes, typed edges, and scope rows, reserving allocations atomically", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s, 2);
      const a = patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id, sourcePath: "0.items.0", title: "A" });
      const b = patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id, sourcePath: "0.items.1", title: "B" });
      const j = joinNode(h, s.run, { fanInPolicy: "require_any" });
      const agg = patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id, sourcePath: "0.aggregate", title: "Agg" });
      const inserted = h.stores.plans.insertCompiledGraph({
        runId: s.run.id,
        revisionNumber: 1,
        nodes: [a, b, j, agg],
        edges: [
          { type: "fan_in", sourceNodeId: a.id, targetNodeId: j.id, position: 0 },
          { type: "fan_in", sourceNodeId: b.id, targetNodeId: j.id, position: 1 },
          { type: "sequence", sourceNodeId: j.id, targetNodeId: agg.id, position: 0 },
        ],
        requirements: [
          ...leafIds.map((requirementId) => ({ planNodeId: a.id, requirementId, requirementRevisionId: revision.id })),
          ...leafIds.map((requirementId) => ({ planNodeId: b.id, requirementId, requirementRevisionId: revision.id })),
        ],
      });
      expect(inserted.nodes.map((n) => n.status)).toEqual(["pending", "pending", "pending", "pending"]);
      const join = h.stores.plans.getNode(j.id);
      expect(join.kind).toBe("join");
      if (join.kind === "join") expect(join.fanInPolicy).toBe("require_any");
      expect(h.stores.plans.listEdges(s.run.id).map((e) => e.type).sort()).toEqual(["fan_in", "fan_in", "sequence"]);
      // Inherited scope materialized per pattern node: identical rows under siblings, none for the join.
      expect(h.stores.plans.listScope(a.id)).toHaveLength(2);
      expect(h.stores.plans.listScope(b.id)).toHaveLength(2);
      expect(h.stores.plans.listScope(j.id)).toHaveLength(0);
      expect(h.stores.plans.isInScope(a.id, leafIds[0]!, revision.id)).toBe(true);
      expect(h.stores.plans.isInScope(j.id, leafIds[0]!, revision.id)).toBe(false);
      // The lookup is served by the primary key, not a scan.
      const plan = h.database.sqlite.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM plan_node_requirements WHERE plan_node_id = ? AND requirement_id = ? AND requirement_revision_id = ?").all(a.id, leafIds[0], revision.id) as { detail: string }[];
      expect(plan.some((row) => /USING (COVERING )?INDEX|PRIMARY KEY/.test(row.detail))).toBe(true);
      // Reservations: one per pattern node (root + a + b + agg), none for the join.
      const reservations = h.stores.reservations.listByParent({ type: "run", id: s.run.id });
      expect(reservations.filter((r) => r.status === "active")).toHaveLength(4);
      expect(reservations.some((r) => r.child.id === j.id)).toBe(false);
    } finally {
      h.close();
    }
  });

  it("rejects a join with a Pattern, a pattern node without one, scope on a join, and a fan-in into a pattern node", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { revision, leafIds } = seedRequirements(h, s);
      const base = { runId: s.run.id, revisionNumber: 1, edges: [], requirements: [] };
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, nodes: [{ ...joinNode(h, s.run), pattern: "single" } as never] })).toThrow(ValidationError);
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, nodes: [{ ...patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id }), pattern: undefined } as never] })).toThrow(ValidationError);
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, nodes: [{ ...patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id }), pattern: "join" } as never] })).toThrow(ValidationError);
      const j = joinNode(h, s.run);
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, nodes: [j], requirements: [{ planNodeId: j.id, requirementId: leafIds[0]!, requirementRevisionId: revision.id }] })).toThrow(/no Requirement scope/);
      const p = patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id });
      const q = patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id, sourcePath: "1" });
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, nodes: [p, q], edges: [{ type: "fan_in", sourceNodeId: p.id, targetNodeId: q.id, position: 0 }] })).toThrow(/requires a join node/);
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, nodes: [p, j], edges: [{ type: "sequence", sourceNodeId: p.id, targetNodeId: j.id, position: 0 }] })).toThrow(/only fan_in edges/);
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, nodes: [p, q], edges: [{ type: "sequence", sourceNodeId: p.id, targetNodeId: q.id, position: 0 }, { type: "sequence", sourceNodeId: q.id, targetNodeId: p.id, position: 0 }] })).toThrow(/cycle/);
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, nodes: [p, q], edges: [{ type: "sequence", sourceNodeId: p.id, targetNodeId: q.id, position: 0 }, { type: "sequence", sourceNodeId: p.id, targetNodeId: q.id, position: 1 }] })).toThrow(/duplicate PlanEdge/);
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
      const p = patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id });
      const base = { runId: s.run.id, revisionNumber: 1, nodes: [p], edges: [] };
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, requirements: [{ planNodeId: p.id, requirementId: rootId, requirementRevisionId: revision.id }] })).toThrow(/not a leaf/);
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, requirements: [{ planNodeId: p.id, requirementId: "req_000000000000000000000000", requirementRevisionId: revision.id }] })).toThrow(/does not exist/);
      const other = seedRun(h);
      const foreign = seedRequirements(h, other);
      expect(() => h.stores.plans.insertCompiledGraph({ ...base, requirements: [{ planNodeId: p.id, requirementId: foreign.leafIds[0]!, requirementRevisionId: foreign.revision.id }] })).toThrow(/belongs to Conversation/);
      // A later revision does not touch existing rows: pin to revision 1, then create revision 2.
      h.stores.plans.insertCompiledGraph({ ...base, requirements: [{ planNodeId: p.id, requirementId: leafIds[0]!, requirementRevisionId: revision.id }] });
      h.stores.requirements.createRevision({ conversationId: s.conversation.id, approvedByDecisionId: null, tree: [{ id: leafIds[0]!, parentId: null, composition: null, statement: "only one now", position: 0, acceptanceCriterionIds: [] }] });
      expect(h.stores.plans.listScope(p.id)).toEqual([{ planNodeId: p.id, runId: s.run.id, requirementId: leafIds[0], requirementRevisionId: revision.id }]);
      expect(() => h.database.sqlite.prepare("DELETE FROM plan_node_requirements").run()).toThrow(/never deleted/);
    } finally {
      h.close();
    }
  });

  it("rejects a graph whose allocations exceed unreserved Run capacity, writing nothing", () => {
    const h = openHarness();
    try {
      const s = seedRun(h, { budget: { maxCostUsd: 15, maxTokens: 1_000_000, maxAttempts: 50, maxWallClockMs: null, maxConcurrency: null } });
      const before = h.ctx.journal.lastSeq();
      const a = patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id, sourcePath: "1" });
      expect(() => h.stores.plans.insertCompiledGraph({ runId: s.run.id, revisionNumber: 1, nodes: [a], edges: [], requirements: [] })).toThrow(InsufficientCapacityError);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.plans.listNodes(s.run.id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("transitions nodes, forbids a join from running, and releases the node reservation on a terminal state", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const j = joinNode(h, s.run);
      const p = patternNode(h, s.run, { agentDefinitionRevisionId: s.definition.id, sourcePath: "1" });
      h.stores.plans.insertCompiledGraph({ runId: s.run.id, revisionNumber: 1, nodes: [p, j], edges: [{ type: "fan_in", sourceNodeId: p.id, targetNodeId: j.id, position: 0 }], requirements: [] });
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
    } finally {
      h.close();
    }
  });
});
