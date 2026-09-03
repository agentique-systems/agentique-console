/**
 * Bounded retrieval and canonical order of the runtime read tools
 * (execution-model §6.4 "Runtime read tools"): every page is one keyset
 * store query whose ownership and visibility predicates run in the
 * database, retrieving at most `limit + 1` rows of the collection and
 * resolving page-local references in batched lookups — proven here by
 * observing the statements and rows the store actually executed, never
 * inferred from a small response. Plan edges page in the plan's canonical
 * order (target membership position, then fan-in position), not by
 * generated id; a cursor is valid exactly while the record it names is in
 * the caller's visible set of the current revision and view.
 */
import { newId, RUNTIME_READ_BOUNDS, type IdKind, type PlanEdgeId, type TaskId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness } from "../persistence/test-support.ts";
import { decomposePort, proposal, propose, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import {
  approveRevision,
  cancelRun,
  laterRunInConversation,
  observeQueries,
  operatorDecision,
  orchestratorTask,
  readAgents,
  readDecisions,
  readPlan,
  readRequirements,
  readResult,
  readTasks,
  rejectionCodes,
  rootTurn,
} from "./data-access-test-support.ts";
import { rootPort, workerPort } from "./decision-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, planNodes, seedPlanningRuntime } from "./test-support.ts";

describe("bounded reads", () => {
  it("read_decisions: a page of a long Conversation history retrieves at most limit + 1 Decision rows for every role, an exact read one, and a cursor check one", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      // An earlier Run of the Conversation left 80 Decisions behind; the current Run records 120 more.
      const earlier = seedPlanningRuntime(h);
      const conversationId = earlier.created.run.conversationId;
      for (let i = 0; i < 80; i += 1) operatorDecision(h, conversationId, earlier.created.run.id, {}, `Earlier ${i}`);
      cancelRun(h, earlier);
      const s = laterRunInConversation(h, earlier);
      const d = await decomposePort(h, s);
      const nodeDecisions = Array.from({ length: 120 }, (_, i) => operatorDecision(h, conversationId, s.created.run.id, { planNodeIds: [d.node.id] }, `Current ${i}`));
      expect(h.stores.decisions.listByConversation(conversationId).length).toBeGreaterThanOrEqual(200);
      const q = observeQueries(h);
      try {
        // The Coordinator: default page (25) — one page query of 26 rows at most, nothing of the 200-row history materialized.
        const page = readResult(await d.port.call(readDecisions()), "read_decisions");
        expect(page.items).toHaveLength(RUNTIME_READ_BOUNDS.defaultLimit);
        expect(page.next).toBe(page.items.at(-1)!.decisionId);
        expect(q.rowsFrom("decisions")).toBeLessThanOrEqual(RUNTIME_READ_BOUNDS.defaultLimit + 1);
        expect(q.selectsFrom("decisions")).toHaveLength(1);
        // A continued page: one cursor check (one row) plus one page query.
        q.reset();
        const second = readResult(await d.port.call(readDecisions({ after: page.next!, limit: 10 })), "read_decisions");
        expect(second.items).toHaveLength(10);
        expect(second.items[0]!.decisionId > page.next!).toBe(true);
        expect(q.rowsFrom("decisions")).toBeLessThanOrEqual(1 + 11);
        // An exact read: the visibility check and the one row.
        q.reset();
        const exact = readResult(await d.port.call(readDecisions({ decisionId: nodeDecisions[7]!.id })), "read_decisions");
        expect(exact.items.map((x) => x.decisionId)).toEqual([nodeDecisions[7]!.id]);
        expect(q.rowsFrom("decisions")).toBeLessThanOrEqual(2);
        // A refused foreign cursor costs one lookup and retrieves no Decision row.
        q.reset();
        expect(rejectionCodes(await d.port.call(readDecisions({ after: h.ctx.ids("decision") })))).toEqual(["cursor_invalid"]);
        expect(q.rowsFrom("decisions")).toBe(0);
        // The Orchestrator of the current Run: the same bound over its wider set (the Run's 120 plus what its manifest names).
        h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
        await h.executor.executePreparedAttempt(d.attempt.id);
        const root = await rootTurn(h, s);
        q.reset();
        const rootPage = readResult(await root.port.call(readDecisions({ limit: RUNTIME_READ_BOUNDS.maxLimit })), "read_decisions");
        expect(rootPage.items).toHaveLength(RUNTIME_READ_BOUNDS.maxLimit);
        expect(q.rowsFrom("decisions")).toBeLessThanOrEqual(RUNTIME_READ_BOUNDS.maxLimit + 1);
        // Everything visible is enumerable exactly once through the cursor chain, in id order, and nothing of the earlier Run appears.
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const p = readResult(await root.port.call(readDecisions({ limit: 50, ...(cursor === undefined ? {} : { after: cursor as never }) })), "read_decisions");
          seen.push(...p.items.map((x) => x.decisionId));
          if (p.next === null) break;
          cursor = p.next;
        }
        expect(seen).toEqual([...seen].sort());
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toEqual(expect.arrayContaining(nodeDecisions.map((x) => x.id)));
        expect(seen.filter((id) => h.stores.decisions.get(id as never).runId === earlier.created.run.id)).toEqual([]);
      } finally {
        q.restore();
      }
    } finally {
      h.close();
    }
  });

  it("read_tasks: a page of a large ledger retrieves at most limit + 1 Task rows plus batched page-local dependency and replacement lookups; a superseded Task invalidates the Orchestrator's cursor", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const created = Array.from({ length: 150 }, (_, i) => orchestratorTask(h, runId, `task ${i}`));
      const root = await rootPort(h, s);
      const q = observeQueries(h);
      try {
        const page = readResult(await root.port.call(readTasks()), "read_tasks");
        expect(page.items).toHaveLength(RUNTIME_READ_BOUNDS.defaultLimit);
        expect(q.rowsFrom("tasks")).toBeLessThanOrEqual(RUNTIME_READ_BOUNDS.defaultLimit + 1);
        expect(q.selectsFrom("task_dependencies")).toHaveLength(1);
        q.reset();
        const exact = readResult(await root.port.call(readTasks({ taskId: created[99]!.id })), "read_tasks");
        expect(exact.items.map((t) => t.taskId)).toEqual([created[99]!.id]);
        expect(q.rowsFrom("tasks")).toBeLessThanOrEqual(2);
        // A cursor names a visible Task; once that Task is superseded it leaves the Orchestrator's current set and the cursor is refused.
        const anchor = page.next!;
        q.reset();
        expect(readResult(await root.port.call(readTasks({ after: anchor, limit: 3 })), "read_tasks").items).toHaveLength(3);
        expect(q.rowsFrom("tasks")).toBeLessThanOrEqual(1 + 4);
        h.stores.tasks.transition(anchor as TaskId, { to: "blocked", blockReason: { kind: "decision", decisionId: operatorDecision(h, s.created.run.conversationId, runId).id } });
        const replacement = h.stores.tasks.create({ runId, planNodeId: null, origin: "orchestrator", subject: "replacement", requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: anchor as TaskId });
        expect(rejectionCodes(await root.port.call(readTasks({ after: anchor })))).toEqual(["cursor_invalid"]);
        expect(rejectionCodes(await root.port.call(readTasks({ taskId: anchor })))).toEqual(["record_out_of_scope"]);
        expect(readResult(await root.port.call(readTasks({ taskId: replacement.id })), "read_tasks").items[0]).toMatchObject({ replacesTaskId: anchor, supersededByTaskId: null });
      } finally {
        q.restore();
      }
    } finally {
      h.close();
    }
  });

  it("read_tasks: a Coordinator's ledger page projects dependency and replacement references from batched lookups — a Task others depend on lists no dependency of its own", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const d = await decomposePort(h, s);
      const accepted = await d.port.call(propose([proposal({ key: "a", requirementIds: [d.leafIds[0]!] }), proposal({ key: "b", requirementIds: [d.leafIds[1]!], dependsOnKeys: ["a"] }), proposal({ key: "c", requirementIds: [d.leafIds[1]!], dependsOnKeys: ["a", "b"] })]));
      if (accepted.kind !== "accepted" || accepted.result.tool !== "propose_tasks") throw new Error("proposal not accepted");
      const ids = accepted.result.taskIdsByKey as Record<string, TaskId>;
      const q = observeQueries(h);
      try {
        const ledger = readResult(await d.port.call(readTasks()), "read_tasks");
        const by = new Map(ledger.items.map((t) => [t.taskId, t]));
        expect(by.get(ids.a!)!.dependsOnTaskIds).toEqual([]);
        expect(by.get(ids.b!)!.dependsOnTaskIds).toEqual([ids.a]);
        expect(by.get(ids.c!)!.dependsOnTaskIds).toEqual([ids.a, ids.b].sort());
        expect(q.selectsFrom("task_dependencies")).toHaveLength(1);
        expect(q.rowsFrom("tasks")).toBeLessThanOrEqual(3 + 1 + 3);
      } finally {
        q.restore();
      }
    } finally {
      h.close();
    }
  });

  it("read_agent_definitions: the page is one predicate query over revisions — never an enumeration of every definition and revision — and agrees with the execution boundary's resolver", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      // 40 definitions with 3 builtin revisions each (only the latest is relevant), one Workspace-file definition of another Workspace
      // (never relevant), and one whose latest revision is foreign while an older builtin revision is the latest executable one.
      const revision = (extra: string) => ({
        provenance: { kind: "builtin" as const },
        modelPolicy: { model: "claude-fable-5", effort: "medium" as const, maxContextOccupancy: 0.8 },
        instructions: `You are ${extra}.`,
        capabilities: { tools: ["read"], mcpServers: [] },
        toolPolicy: { read: "allowed" as const },
        defaultLimits: { allocation: { costUsd: 1, tokens: 10_000, attempts: 1 }, maxWallClockMs: null },
      });
      const latestIds: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        const definition = h.stores.agents.ensureDefinition(`agent-${String(i).padStart(2, "0")}`);
        let last = "";
        for (let r = 0; r < 3; r += 1) last = h.stores.agents.appendRevision(definition.id, revision(`agent ${i} r${r}`)).id;
        latestIds.push(last);
      }
      const foreignWorkspace = h.stores.workspaces.create({ name: "other", rootPath: `/tmp/other-${h.ctx.ids("workspace")}`, kind: "git" });
      const foreignSnapshot = h.stores.snapshots.record({ workspaceId: foreignWorkspace.id, runId: null, identity: { kind: "git", commitId: "a".repeat(40), treeId: "b".repeat(40) }, reason: "run_start" });
      const foreignOnly = h.stores.agents.ensureDefinition("foreign-only");
      h.stores.agents.appendRevision(foreignOnly.id, { ...revision("foreign"), provenance: { kind: "workspace_file", path: ".claude/agents/foreign-only.md", snapshotId: foreignSnapshot.id } });
      const mixed = h.stores.agents.ensureDefinition("mixed");
      const olderBuiltin = h.stores.agents.appendRevision(mixed.id, revision("mixed builtin"));
      h.stores.agents.appendRevision(mixed.id, { ...revision("mixed foreign"), provenance: { kind: "workspace_file", path: ".claude/agents/mixed.md", snapshotId: foreignSnapshot.id } });
      const { port } = await rootPort(h, s);
      const q = observeQueries(h);
      try {
        const page = readResult(await port.call(readAgents({ limit: 10 })), "read_agent_definitions");
        expect(page.items).toHaveLength(10);
        expect(page.items.map((i) => i.revisionId)).toEqual([...page.items.map((i) => i.revisionId)].sort());
        // At most limit + 1 revision rows from the page query, plus one re-resolution per returned row (a revision and a definition
        // point read each); one batched definition lookup for the projection. Nothing enumerates the 120-odd revisions.
        expect(q.rowsFrom("agent_definition_revisions")).toBeLessThanOrEqual(11 + 10);
        expect(q.selectsFrom("agent_definition_revisions").length).toBeLessThanOrEqual(1 + 10);
        expect(q.selectsFrom("agent_definitions").length).toBeLessThanOrEqual(1 + 10);
        // The whole relevant set, enumerated through the cursor chain, is exactly what the resolver admits as latest-or-referenced.
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard += 1) {
          const p = readResult(await port.call(readAgents({ limit: 20, ...(cursor === undefined ? {} : { after: cursor as never }) })), "read_agent_definitions");
          seen.push(...p.items.map((i) => i.revisionId));
          if (p.next === null) break;
          cursor = p.next;
        }
        expect(seen).toEqual(expect.arrayContaining(latestIds));
        expect(seen).toContain(olderBuiltin.id);
        expect(seen.filter((id) => h.stores.agents.getRevision(id as never).provenance.kind === "workspace_file")).toEqual([]);
        const names = seen.map((id) => h.stores.agents.getDefinition(h.stores.agents.getRevision(id as never).definitionId).name);
        expect(names).not.toContain("foreign-only");
        expect(names.filter((n) => n === "mixed")).toHaveLength(1);
        for (let i = 0; i < 40; i += 1) expect(names.filter((n) => n === `agent-${String(i).padStart(2, "0")}`)).toHaveLength(1);
        expect(rejectionCodes(await port.call(readAgents({ agentDefinitionId: foreignOnly.id })))).toEqual(["record_out_of_scope"]);
        expect(readResult(await port.call(readAgents({ agentDefinitionId: mixed.id })), "read_agent_definitions").items.map((i) => i.revisionId)).toEqual([olderBuiltin.id]);
      } finally {
        q.restore();
      }
    } finally {
      h.close();
    }
  });

  it("read_requirements: the one whole-value read is the revision's bounded tree; a page's statuses and criteria are batched over the page alone", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      approveRevision(h, s, 200);
      const { port } = await rootPort(h, s);
      const q = observeQueries(h);
      try {
        const page = readResult(await port.call(readRequirements({ includeAcceptanceCriteria: true, limit: 30 })), "read_requirements");
        expect(page.items).toHaveLength(30);
        expect(q.rowsFrom("requirement_revisions")).toBe(1);
        expect(q.rowsFrom("requirements")).toBeLessThanOrEqual(30);
        expect(q.selectsFrom("requirements")).toHaveLength(1);
        expect(q.selectsFrom("acceptance_criteria").length).toBeLessThanOrEqual(1);
      } finally {
        q.restore();
      }
    } finally {
      h.close();
    }
  });

  it("read_execution_plan: edges page in the canonical order even when generated ids sort otherwise, pages cross target-node boundaries, and a previous revision's, a removed node's, or the other view's cursor is refused", async () => {
    // Plan Edge ids are minted in descending order, so id order is the reverse of the canonical order.
    let edgeCounter = 0xffffff;
    const ids = <K extends IdKind>(kind: K) => {
      if (kind !== "planEdge") return newId(kind);
      edgeCounter -= 1;
      return `pe_${edgeCounter.toString(16).padStart(24, "0")}` as ReturnType<typeof newId<K>>;
    };
    const h = openRuntimeHarness({ base: openHarness(":memory:", { ids }), governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      // A chain whose middle step is a parallel of composite items: each item is a two-step chain (a subgraph), so the compiler emits
      // sequence edges inside every item, one fan-in edge per item into the parallel's join (positions 0..2), and a sequence edge on.
      const single = (title: string) => ({ pattern: "single" as const, operation: { agentDefinitionRevisionId: s.worker.id, title } });
      const chain = (titles: string[]) => ({
        pattern: "chain" as const,
        steps: [
          single(titles[0]!),
          { pattern: "parallel" as const, items: [1, 2, 3].map((i) => ({ pattern: "chain" as const, steps: [single(`${titles[1]}${i}a`), single(`${titles[1]}${i}b`)] })), requireAll: true },
          single(titles[2]!),
        ],
      });
      const first = planNodes(h, s, [chain(["a", "i", "z"])]);
      const { port } = await rootPort(h, s);
      const graph = h.stores.plans.currentGraph(runId);
      const canonical = graph.edges.map((e) => e.id);
      expect(graph.edges.filter((e) => e.type === "fan_in").map((e) => e.position)).toEqual([0, 1, 2]);
      expect(canonical.length).toBeGreaterThanOrEqual(7);
      expect([...canonical].sort()).not.toEqual(canonical);
      // Whole view: canonical order (target membership position, then fan-in position), never id order.
      const all = readResult(await port.call(readPlan({ view: "edges" })), "read_execution_plan");
      if (all.view !== "edges") throw new Error("edges view expected");
      expect(all.items.map((e) => e.planEdgeId)).toEqual(canonical);
      const positionOf = new Map(graph.nodes.map((n, i) => [n.id, i]));
      for (let i = 1; i < all.items.length; i += 1) {
        const before = all.items[i - 1]!;
        const after = all.items[i]!;
        const key = (e: typeof before) => [positionOf.get(e.targetNodeId)!, e.position];
        expect(key(before) < key(after) || (key(before)[0] === key(after)[0] && key(before)[1]! < key(after)[1]!)).toBe(true);
      }
      // Pages of two cross the fan-in target's boundary and chain by cursor in the same order; retrieval is bounded per page.
      const q = observeQueries(h);
      const paged: PlanEdgeId[] = [];
      let cursor: PlanEdgeId | undefined;
      try {
        for (let guard = 0; guard < 20; guard += 1) {
          q.reset();
          const page = readResult(await port.call(readPlan({ view: "edges", limit: 2, ...(cursor === undefined ? {} : { after: cursor }) })), "read_execution_plan");
          if (page.view !== "edges") throw new Error("edges view expected");
          expect(q.rowsFrom("plan_edges")).toBeLessThanOrEqual(1 + 3);
          paged.push(...page.items.map((e) => e.planEdgeId));
          if (page.next === null) break;
          cursor = page.next;
        }
      } finally {
        q.restore();
      }
      expect(paged).toEqual(canonical);
      // Nodes page in membership order with bounded retrieval too.
      const nodes = readResult(await port.call(readPlan({ view: "nodes", limit: 3 })), "read_execution_plan");
      if (nodes.view !== "nodes") throw new Error("nodes view expected");
      expect(nodes.items.map((n) => n.planNodeId)).toEqual(graph.nodes.slice(0, 3).map((n) => n.id));
      // The other view's cursor is a schema rejection; an unknown edge is a foreign cursor.
      expect(rejectionCodes(await port.call({ tool: "read_execution_plan", input: { view: "nodes", after: canonical[0] } } as never))).toEqual(["invalid_input"]);
      expect(rejectionCodes(await port.call(readPlan({ view: "edges", after: h.ctx.ids("planEdge") })))).toEqual(["cursor_invalid"]);
      // A new accepted revision owns new edge rows: the previous revision's edge ids are no longer cursors, and a node the
      // revision dropped is no longer a node cursor.
      const dropped = first.nodes.find((n) => n.kind === "pattern" && n.title === "z")!;
      const second = planNodes(h, s, [chain(["a", "i", "y"])]);
      expect(second.revisionNumber).toBe(first.revisionNumber + 1);
      expect(rejectionCodes(await port.call(readPlan({ view: "edges", after: canonical[3]! })))).toEqual(["cursor_invalid"]);
      expect(h.stores.plans.currentGraph(runId).nodes.map((n) => n.id)).not.toContain(dropped.id);
      expect(rejectionCodes(await port.call(readPlan({ view: "nodes", after: dropped.id })))).toEqual(["cursor_invalid"]);
      const current = readResult(await port.call(readPlan({ view: "edges" })), "read_execution_plan");
      if (current.view !== "edges") throw new Error("edges view expected");
      expect(current.revisionNumber).toBe(second.revisionNumber);
      expect(current.items.map((e) => e.planEdgeId)).toEqual(h.stores.plans.currentGraph(runId).edges.map((e) => e.id));
    } finally {
      h.close();
    }
  });

  it("read_tasks: a record beyond the response budget is a typed reference in the keyset page too, and the next page continues after it without skipping a record silently", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const small1 = orchestratorTask(h, runId, "small one");
      const huge = h.stores.tasks.create({ runId, planNodeId: null, origin: "orchestrator", subject: "x".repeat(70_000), requirementIds: [], requirementRevisionId: null, inputArtifactIds: [], requiredOutputs: [], replacesTaskId: null });
      const small2 = orchestratorTask(h, runId, "small two");
      const order = [small1.id, huge.id, small2.id].sort();
      const { port } = await rootPort(h, s);
      const seen: { items: string[]; oversized: string | null }[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 6; guard += 1) {
        const page = readResult(await port.call(readTasks({ limit: 2, ...(cursor === undefined ? {} : { after: cursor as never }) })), "read_tasks");
        seen.push({ items: page.items.map((t) => t.taskId), oversized: page.oversizedRecord?.id ?? null });
        if (page.next === null) break;
        cursor = page.next;
      }
      const flat = seen.flatMap((p) => [...p.items, ...(p.oversized === null ? [] : [p.oversized])]);
      expect(flat).toEqual(order);
      expect(seen.find((p) => p.oversized === huge.id)?.items).toEqual([]);
      const exact = readResult(await port.call(readTasks({ taskId: huge.id })), "read_tasks");
      expect(exact.items).toEqual([]);
      expect(exact.oversizedRecord).toMatchObject({ id: huge.id, byteSize: expect.any(Number) });
    } finally {
      h.close();
    }
  });

  it("a Worker's page retrieves only its own Tasks and direct dependencies by id, never the node's ledger", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const w = await workerPort(h, s);
      // The Worker owns no Task on a single node: its Task scope is empty and costs no ledger scan.
      const q = observeQueries(h);
      try {
        expect(readResult(await w.port.call(readTasks()), "read_tasks").items).toEqual([]);
        expect(q.rowsFrom("tasks")).toBe(0);
      } finally {
        q.restore();
      }
    } finally {
      h.close();
    }
  });
});
