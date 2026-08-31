/**
 * The runtime read tools' common contract (execution-model §6.4 "Runtime
 * read tools"; invariants 5 runtime-owned facts, 6 no transcript decides
 * anything): a successful read is a typed bounded projection and never a
 * durable mutation — no `runtime_tool_calls` row, no Event, no Usage row,
 * no cursor state; lists are deterministically ordered and paged by a
 * stateless keyset cursor; responses are size-bounded with a typed
 * oversized-record reference; reads run outside every transaction, are
 * refused inside one, are refused once the caller stops running or its
 * logical turn ended, and repeat identically across a database reopen.
 */
import { RUNTIME_READ_BOUNDS, type RequirementId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness } from "../persistence/test-support.ts";
import { portFor, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import {
  approveRevision,
  readAgents,
  readArtifact,
  readDecisions,
  readPlan,
  readRequirements,
  readResult,
  readTasks,
  rejectionCodes,
  writeArtifact,
  writtenArtifact,
} from "./data-access-test-support.ts";
import { choice, rootPort, workerPort } from "./decision-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, planNodes, seedPlanningRuntime } from "./test-support.ts";

describe("runtime read tools", () => {
  it("returns typed projections without writing anything: no runtime_tool_calls row, no Event, no Usage row, and identical results on repetition", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      planNodes(h, s, [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "work" } }]);
      const { invocation, attempt, port } = await rootPort(h, s);
      const seq = h.ctx.journal.lastSeq();
      const first = [await port.call(readRequirements()), await port.call(readDecisions()), await port.call(readTasks()), await port.call(readPlan()), await port.call(readPlan({ view: "edges" })), await port.call(readAgents())];
      for (const outcome of first) expect(outcome.kind).toBe("read");
      // Nothing durable happened: no Event, no runtime-tool-call row, no Usage, no digest or call id presented as a record.
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.runtimeToolCalls.listByInvocation(invocation.id)).toEqual([]);
      expect(h.stores.usage.listByAttempt(attempt.id)).toEqual([]);
      expect(JSON.stringify(first)).not.toContain("callId");
      expect(h.ctx.tx.inTransaction).toBe(false);
      // Repeated reads are harmless and canonical: the same database state yields byte-identical results.
      const again = [await port.call(readRequirements()), await port.call(readDecisions()), await port.call(readTasks()), await port.call(readPlan()), await port.call(readPlan({ view: "edges" })), await port.call(readAgents())];
      expect(JSON.stringify(again)).toBe(JSON.stringify(first));
      expect(h.ctx.journal.lastSeq()).toBe(seq);
    } finally {
      h.close();
    }
  });

  it("pages deterministically: default 25, bounded limit, keyset continuation in canonical order, and a rejected malformed or foreign cursor", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const { leafIds, rootId } = approveRevision(h, s, 30);
      const { port } = await rootPort(h, s);
      const treeOrder = [rootId, ...leafIds];
      // Default page: 25 records in tree order, the cursor naming the last.
      const first = readResult(await port.call(readRequirements()), "read_requirements");
      expect(first.items.map((r) => r.requirementId)).toEqual(treeOrder.slice(0, RUNTIME_READ_BOUNDS.defaultLimit));
      expect(first.oversizedRecord).toBeNull();
      expect(first.next).toBe(treeOrder[24]);
      // Continuation is stateless: `after` re-derives the position from rows; the last page ends with next null.
      const second = readResult(await port.call(readRequirements({ after: first.next! })), "read_requirements");
      expect(second.items.map((r) => r.requirementId)).toEqual(treeOrder.slice(25));
      expect(second.next).toBeNull();
      // An explicit limit within 1..100 is honored.
      const two = readResult(await port.call(readRequirements({ limit: 2 })), "read_requirements");
      expect(two.items.map((r) => r.requirementId)).toEqual(treeOrder.slice(0, 2));
      expect(two.next).toBe(treeOrder[1]);
      const capped = readResult(await port.call(readRequirements({ limit: RUNTIME_READ_BOUNDS.maxLimit })), "read_requirements");
      expect(capped.items).toHaveLength(31);
      // A limit above the maximum, a malformed id, an unknown key: strict schema rejections that write nothing.
      expect(rejectionCodes(await port.call(readRequirements({ limit: RUNTIME_READ_BOUNDS.maxLimit + 1 })))).toEqual(["invalid_input"]);
      expect(rejectionCodes(await port.call({ tool: "read_requirements", input: { after: "not-an-id" } } as never))).toEqual(["invalid_input"]);
      expect(rejectionCodes(await port.call({ tool: "read_requirements", input: { everything: true } } as never))).toEqual(["invalid_input"]);
      // A well-formed cursor outside the caller's visible order is foreign: refused, never treated as an empty page.
      expect(rejectionCodes(await port.call(readRequirements({ after: h.ctx.ids("requirement") })))).toEqual(["cursor_invalid"]);
    } finally {
      h.close();
    }
  });

  it("bounds every response: a page stops at the largest complete prefix that fits, and a single oversized record returns a typed reference — never truncated JSON, never a dropped record", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      // Three ~40 KiB statements cannot share one 64 KiB response; each fits alone.
      const wide = approveRevision(h, s, 3, 40_000);
      const { port } = await rootPort(h, s);
      const first = readResult(await port.call(readRequirements()), "read_requirements");
      expect(first.items.map((r) => r.requirementId)).toEqual([wide.rootId, wide.leafIds[0]]);
      expect(first.next).toBe(wide.leafIds[0]);
      const second = readResult(await port.call(readRequirements({ after: first.next! })), "read_requirements");
      expect(second.items.map((r) => r.requirementId)).toEqual([wide.leafIds[1]]);
      const third = readResult(await port.call(readRequirements({ after: second.next! })), "read_requirements");
      expect(third.items.map((r) => r.requirementId)).toEqual([wide.leafIds[2]]);
      expect(third.next).toBeNull();
      for (const page of [first, second, third]) expect(JSON.stringify(page).length).toBeLessThanOrEqual(RUNTIME_READ_BOUNDS.maxResponseBytes);
      // One record beyond the bound: a typed reference with its id and size, and a cursor that skips exactly it.
      const huge = approveRevision(h, s, 2, 80_000);
      const oversized = readResult(await port.call(readRequirements({ after: huge.rootId })), "read_requirements");
      expect(oversized.items).toEqual([]);
      expect(oversized.oversizedRecord).toMatchObject({ id: huge.leafIds[0], byteSize: expect.any(Number) });
      expect(oversized.next).toBe(huge.leafIds[0]);
      const after = readResult(await port.call(readRequirements({ after: oversized.next! })), "read_requirements");
      expect(after.oversizedRecord).toMatchObject({ id: huge.leafIds[1] });
      expect(after.next).toBeNull();
      // The exact-record form reports the same reference instead of truncating.
      const exact = readResult(await port.call(readRequirements({ requirementId: huge.leafIds[0] })), "read_requirements");
      expect(exact.items).toEqual([]);
      expect(exact.oversizedRecord).toMatchObject({ id: huge.leafIds[0] });
    } finally {
      h.close();
    }
  });

  it("is refused inside a persistence transaction, after the caller stopped running, and after the logical turn ended on an accepted request_decision", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const root = await rootPort(h, s);
      await expect(h.ctx.tx.write(() => root.port.call(readRequirements()))).rejects.toThrow(/outside any persistence transaction/);
      // A worker whose accepted request_decision ended its logical turn reads nothing further.
      const w = await workerPort(h, s);
      expect((await w.port.call(readTasks())).kind).toBe("read");
      expect((await w.port.call(choice())).kind).toBe("accepted");
      expect(rejectionCodes(await w.port.call(readTasks()))).toEqual(["turn_ended"]);
      // A completed Attempt no longer reads: the caller must be a running Attempt of a running Invocation.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(root.attempt.id);
      expect(rejectionCodes(await root.port.call(readRequirements()))).toEqual(["caller_not_running"]);
    } finally {
      h.close();
    }
  });

  it("projects the current accepted graph as separately paged nodes and edges: revision number, membership order, bounded shape summaries, scope ids, allocation metadata, and typed edges", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const scoped = approveRevision(h, s, 2);
      const { nodes, revisionNumber } = planNodes(h, s, [
        {
          pattern: "chain",
          steps: [
            { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "first" } },
            { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "second" } },
          ],
          scope: { requirementRootIds: [scoped.rootId], requirementRevisionId: scoped.revision.id },
        },
        {
          pattern: "chain",
          steps: [
            { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "alpha" }, allocation: { costUsd: 1, tokens: 10_000, attempts: 1 } },
            { pattern: "parallel", items: Array.from({ length: 2 }, (_, i) => ({ pattern: "single" as const, operation: { agentDefinitionRevisionId: s.worker.id, title: `item ${i}` } })), requireAll: false },
            { pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "omega" }, allocation: { costUsd: 1, tokens: 10_000, attempts: 1 } },
          ],
        },
      ]);
      const { port } = await rootPort(h, s);
      const paged = readResult(await port.call(readPlan({ view: "nodes", limit: 2 })), "read_execution_plan");
      expect(paged.view).toBe("nodes");
      expect(paged.revisionNumber).toBe(revisionNumber);
      if (paged.view !== "nodes") throw new Error("nodes view expected");
      // Membership order: the root first, then the compiled draft order.
      const graph = h.stores.plans.currentGraph(s.created.run.id);
      expect(paged.items.map((n) => n.planNodeId)).toEqual(graph.nodes.slice(0, 2).map((n) => n.id));
      const rest = readResult(await port.call(readPlan({ view: "nodes", after: paged.next! })), "read_execution_plan");
      if (rest.view !== "nodes") throw new Error("nodes view expected");
      expect([...paged.items, ...rest.items].map((n) => n.planNodeId)).toEqual(graph.nodes.map((n) => n.id));
      const all = [...paged.items, ...rest.items];
      const root = all[0]!;
      expect(root).toMatchObject({ kind: "pattern", pattern: "single", sourcePath: "root", shape: { pattern: "single", operationTitle: "Orchestrator" }, fanInPolicy: null, requirementIds: [], onAllocationExhausted: "extend" });
      const chain = all.find((n) => n.pattern === "chain")!;
      expect(chain).toMatchObject({ kind: "pattern", shape: { pattern: "chain", stepCount: 2 }, requirementRevisionId: scoped.revision.id, requirementIds: scoped.leafIds, status: "pending" });
      expect(chain.allocation).toEqual(nodes.find((n) => n.id === chain.planNodeId)!.allocation);
      const parallel = all.find((n) => n.pattern === "parallel")!;
      expect(parallel.shape).toEqual({ pattern: "parallel", itemCount: 2, hasAggregation: false, requireAll: false });
      // No full nested plan JSON: a node record never embeds operations, inputs, or instructions.
      expect(JSON.stringify(all)).not.toMatch(/agentDefinitionRevisionId|instructions|"input"/);
      // Edges: typed records in edge-id order, separately paged.
      const edges = readResult(await port.call(readPlan({ view: "edges" })), "read_execution_plan");
      if (edges.view !== "edges") throw new Error("edges view expected");
      expect(edges.revisionNumber).toBe(revisionNumber);
      expect(edges.items.map((e) => e.planEdgeId)).toEqual([...graph.edges.map((e) => e.id)].sort());
      for (const edge of edges.items) {
        const canonical = graph.edges.find((e) => e.id === edge.planEdgeId)!;
        expect(edge).toMatchObject({ type: canonical.type, sourceNodeId: canonical.sourceNodeId, targetNodeId: canonical.targetNodeId, position: canonical.position });
      }
      const one = readResult(await port.call(readPlan({ view: "edges", limit: 1 })), "read_execution_plan");
      expect(one.items).toHaveLength(1);
      expect(one.next).toBe(edges.items[0]!.planEdgeId);
    } finally {
      h.close();
    }
  });

  it("returns bounded Agent Definition metadata — identity, hash, safe provenance, derived roles, capabilities, Tool Policy, model policy, limits — and never instruction text or a foreign Workspace's definition", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      // A definition whose only revision is a file of another Workspace never appears.
      const foreignWorkspace = h.stores.workspaces.create({ name: "other", rootPath: `/tmp/other-${h.ctx.ids("workspace")}`, kind: "git" });
      const foreignSnapshot = h.stores.snapshots.record({ workspaceId: foreignWorkspace.id, runId: null, identity: { kind: "git", commitId: "a".repeat(40), treeId: "b".repeat(40) }, reason: "run_start" });
      const foreignDefinition = h.stores.agents.ensureDefinition("designer");
      h.stores.agents.appendRevision(foreignDefinition.id, {
        provenance: { kind: "workspace_file", path: ".claude/agents/designer.md", snapshotId: foreignSnapshot.id },
        modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
        instructions: "SECRET-DESIGNER-TEXT",
        capabilities: { tools: ["read"], mcpServers: [] },
        toolPolicy: { read: "allowed" },
        defaultLimits: { allocation: { costUsd: 2, tokens: 20_000, attempts: 2 }, maxWallClockMs: null },
      });
      const { port } = await rootPort(h, s);
      const result = readResult(await port.call(readAgents()), "read_agent_definitions");
      const names = result.items.map((i) => i.name);
      expect(names).toContain("orchestrator");
      expect(names).toContain("worker");
      expect(names).toContain("evaluator");
      expect(names).not.toContain("designer");
      expect(result.items.map((i) => i.revisionId)).toEqual([...result.items.map((i) => i.revisionId)].sort());
      const orchestrator = result.items.find((i) => i.name === "orchestrator")!;
      expect(orchestrator).toMatchObject({ agentDefinitionId: expect.any(String), revisionId: s.orchestrator.id, contentHash: s.orchestrator.contentHash, provenance: { kind: "builtin" }, roles: ["orchestrator"], modelPolicy: s.orchestrator.modelPolicy, defaultLimits: s.orchestrator.defaultLimits });
      expect(result.items.find((i) => i.name === "worker")!.roles).toEqual(["worker", "coordinator", "evaluator"]);
      // Bounded metadata only: no instruction text of any definition.
      expect(JSON.stringify(result)).not.toMatch(/instructions|SECRET-DESIGNER-TEXT|You are the/);
      // The exact-definition form; an unknown or foreign definition is out of scope without an existence oracle.
      const exact = readResult(await port.call(readAgents({ agentDefinitionId: orchestrator.agentDefinitionId })), "read_agent_definitions");
      expect(exact.items.map((i) => i.name)).toEqual(["orchestrator"]);
      expect(rejectionCodes(await port.call(readAgents({ agentDefinitionId: foreignDefinition.id })))).toEqual(["record_out_of_scope"]);
      expect(rejectionCodes(await port.call(readAgents({ agentDefinitionId: h.ctx.ids("agentDefinition") })))).toEqual(["record_out_of_scope"]);
    } finally {
      h.close();
    }
  });

  it("keeps read results canonical across a database reopen: the same projection before and after", async () => {
    const file = `${process.env.TMP ?? "/tmp"}/agentique-read-reopen-${process.pid}-${Date.now()}.db`;
    const base = openHarness(file);
    const h = openRuntimeHarness({ base });
    let before: string;
    let rootInvocationId: string;
    try {
      const s = seedPlanningRuntime(h);
      approveRevision(h, s, 8);
      planNodes(h, s, [{ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title: "work" } }]);
      const { invocation, port } = await rootPort(h, s);
      rootInvocationId = invocation.id;
      before = JSON.stringify([
        readResult(await port.call(readRequirements()), "read_requirements"),
        readResult(await port.call(readPlan()), "read_execution_plan"),
        readResult(await port.call(readAgents()), "read_agent_definitions"),
      ]);
    } finally {
      base.close();
    }
    const reopenedBase = openHarness(file);
    const g = openRuntimeHarness({ base: reopenedBase });
    try {
      // The restarted process recovers, then binds a port to the recovered Invocation's next Attempt.
      g.recovery.recover();
      const prepared = await g.executor.prepareNextAttempt(rootInvocationId as never);
      if (prepared.kind !== "prepared") throw new Error(`not prepared after reopen: ${prepared.kind}`);
      const port = portFor(g, prepared.invocation, prepared.attempt);
      const after = JSON.stringify([
        readResult(await port.call(readRequirements()), "read_requirements"),
        readResult(await port.call(readPlan()), "read_execution_plan"),
        readResult(await port.call(readAgents()), "read_agent_definitions"),
      ]);
      expect(after).toBe(before!);
    } finally {
      reopenedBase.close();
    }
  });

  it("write_artifact and read_artifact round-trip within one Invocation: the caller reads what its own logical turn produced, with metadata describing the whole Artifact", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const { port } = await rootPort(h, s);
      const written = writtenArtifact(await port.call(writeArtifact({ title: "notes", content: "alpha beta" })));
      const read = readResult(await port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact");
      expect(read).toEqual({ tool: "read_artifact", artifactId: written.artifactId, mediaType: "text/plain", digest: written.digest, byteSize: 10, offset: 0, byteCount: 10, encoding: "utf8", content: "alpha beta", nextOffset: null, eof: true });
    } finally {
      h.close();
    }
  });
});
