/**
 * Run bootstrap tests (execution-model §3 `created`, §4.6; invariants 1
 * single-agent default, 5 deterministic runtime ownership, 22 explicit
 * atomic allocation).
 */
import { ConflictError, NotFoundError, ROOT_SOURCE_PATH, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, seedAgentRevision } from "../persistence/test-support.ts";
import { openRuntimeHarness, seedRuntime, TEST_POLICY, type RuntimeHarness, seedCompletionCriterion } from "./test-support.ts";

function tableCounts(h: RuntimeHarness): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of ["runs", "snapshots", "execution_plan_revisions", "plan_nodes", "plan_revision_nodes", "plan_edges", "plan_node_requirements", "budget_reservations", "invocations"]) {
    out[table] = (h.database.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return out;
}

describe("RunCreationService", () => {
  it("establishes the complete initial state of a Run in one transaction (invariants 1, 5, 22)", () => {
    const h = openRuntimeHarness();
    try {
      const { created, orchestrator } = seedRuntime(h, { correlationId: "req-1" });
      const { run, root, baseSnapshot, revision, graph } = created;
      expect(run.status).toBe("created");
      expect(run.finalReserve).toEqual(TEST_POLICY.finalReserve.code);
      expect(run.baseSnapshotId).toBe(baseSnapshot.id);
      expect(run.integrationWorkspacePath).toBe(`${h.stores.workspaces.get(run.workspaceId).rootPath}/.agentique/runs/${run.id}`);
      expect(baseSnapshot).toMatchObject({ runId: run.id, reason: "run_start", identity: { kind: "git" } });
      expect(h.stores.conversations.get(run.conversationId).activeRunId).toBe(run.id);
      // Revision 1 is the empty source; its membership is exactly the root.
      expect(revision).toMatchObject({ number: 1, source: { version: 1, expressions: [] }, proposedByInvocationId: null });
      expect(graph).toEqual(h.stores.plans.currentGraph(run.id));
      expect(graph.nodes.map((n) => n.id)).toEqual([root.id]);
      expect(graph.edges).toEqual([]);
      expect(h.stores.plans.listMembership(run.id, 1)).toEqual([{ runId: run.id, revisionNumber: 1, planNodeId: root.id, position: 0 }]);
      // The root: single Orchestrator node, no scope, explicit allocation, extend policy, pending.
      expect(root).toMatchObject({
        kind: "pattern",
        pattern: "single",
        sourcePath: ROOT_SOURCE_PATH,
        status: "pending",
        allocation: TEST_POLICY.initialOrchestratorAllocation,
        onAllocationExhausted: "extend",
        scope: null,
        createdInRevisionNumber: 1,
      });
      if (root.kind === "pattern" && root.shape.pattern === "single") {
        expect(root.shape.role).toBe("orchestrator");
        expect(root.shape.operation.agentDefinitionRevisionId).toBe(orchestrator.id);
      }
      expect(h.stores.plans.listScope(root.id)).toEqual([]);
      // The root's reservation is the explicit initial allocation from ordinary capacity; the reserve is untouched.
      const reservations = h.stores.reservations.listByChild({ type: "plan_node", id: root.id });
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({ parent: { type: "run", id: run.id }, reserved: TEST_POLICY.initialOrchestratorAllocation, capacitySource: "ordinary", status: "active" });
      const capacity = h.stores.reservations.runCapacity(run.id);
      expect(capacity.ordinary.available).toEqual({ costUsd: 85, tokens: 850_000, attempts: 42 });
      expect(capacity.final.available).toEqual(TEST_POLICY.finalReserve.code);
      // Creation writes exactly these Events, all correlated; no Invocation exists until the Run starts.
      const events = h.ctx.journal.read({ runId: run.id });
      expect(events.map((e) => e.type)).toEqual([
        "run.created",
        "conversation.updated",
        "snapshot.taken",
        "execution_plan.revised",
        "execution_plan.compiled",
        "plan_node.created",
        "budget_reservation.created",
        "conversation.message_posted",
      ]);
      expect(h.stores.invocations.listByRun(run.id)).toEqual([]);
      expect(events.slice(0, 7).every((e) => e.correlationId === "req-1")).toBe(true);
      expect(events[0]!.payload).toEqual(h.stores.runs.get(run.id) && { ...run, baseSnapshotId: null, integrationWorkspacePath: null, updatedAt: (events[0]!.payload as { updatedAt: string }).updatedAt });
      expect(h.workspacePreparation.prepared).toHaveLength(1);
      expect(h.workspacePreparation.discarded).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("persists the effective final reserve chosen at creation: explicit, or the policy default per kind", () => {
    const h = openRuntimeHarness();
    try {
      const explicit = seedRuntime(h, { finalReserve: { costUsd: 1, tokens: 1000, attempts: 1 } });
      expect(explicit.created.run.finalReserve).toEqual({ costUsd: 1, tokens: 1000, attempts: 1 });
      const other = seedRuntime(h, { kind: "other" });
      expect(other.created.run.finalReserve).toEqual({ costUsd: 0, tokens: 0, attempts: 0 });
      expect(h.stores.reservations.runCapacity(other.created.run.id).ordinary.limit).toEqual({ costUsd: 100, tokens: 1_000_000, attempts: 50 });
    } finally {
      h.close();
    }
  });

  it("rejects allocations that do not fit: reserve, initial allocation, their sum, and a whole-Budget allocation", () => {
    const h = openRuntimeHarness();
    try {
      const workspace = h.stores.workspaces.create({ name: "w", rootPath: "/w", kind: "git" });
      const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: null });
      const orchestrator = seedAgentRevision(h, "orchestrator");
      const budget = { maxCostUsd: 10, maxTokens: 10_000, maxAttempts: 5, maxWallClockMs: null, maxConcurrency: null };
      const base = { conversationId: conversation.id, kind: "code" as const, target: { kind: "branch" as const, branch: "main" }, budget, orchestratorAgentDefinitionRevisionId: orchestrator.id, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [seedCompletionCriterion(h, conversation.id).criterionId] } };
      const attempt = (overrides: Partial<typeof base> & { finalReserve?: { costUsd: number; tokens: number; attempts: number }; orchestratorAllocation?: { costUsd: number; tokens: number; attempts: number } }) => () => h.runCreation.create({ ...base, ...overrides });
      expect(attempt({ finalReserve: { costUsd: 11, tokens: 0, attempts: 0 }, orchestratorAllocation: { costUsd: 1, tokens: 1, attempts: 1 } })).toThrow(/final reserve does not fit/);
      expect(attempt({ finalReserve: { costUsd: 0, tokens: 0, attempts: 0 }, orchestratorAllocation: { costUsd: 11, tokens: 1, attempts: 1 } })).toThrow(/initial Orchestrator allocation does not fit/);
      expect(attempt({ finalReserve: { costUsd: 4, tokens: 0, attempts: 0 }, orchestratorAllocation: { costUsd: 7, tokens: 1, attempts: 1 } })).toThrow(/plus the final reserve does not fit/);
      expect(attempt({ finalReserve: { costUsd: 0, tokens: 0, attempts: 0 }, orchestratorAllocation: { costUsd: 10, tokens: 10_000, attempts: 5 } })).toThrow(/never the whole Run Budget/);
      expect(attempt({ finalReserve: { costUsd: -1, tokens: 0, attempts: 0 } })).toThrow(ValidationError);
      // The policy default itself must fit the offered Budget.
      expect(attempt({ budget: { ...budget, maxCostUsd: 12, maxTokens: 1_000_000, maxAttempts: 50 } })).toThrow(/plus the final reserve does not fit/);
      expect(h.stores.runs.listByConversation(conversation.id)).toHaveLength(0);
      expect(h.workspacePreparation.prepared).toHaveLength(0);
      // With a fitting allocation the same request succeeds.
      expect(h.runCreation.create({ ...base, finalReserve: { costUsd: 2, tokens: 0, attempts: 0 }, orchestratorAllocation: { costUsd: 7, tokens: 1, attempts: 1 } }).run.status).toBe("created");
    } finally {
      h.close();
    }
  });

  it("requires an Orchestrator definition with the required capabilities and an existing Conversation", () => {
    const h = openRuntimeHarness();
    try {
      const workspace = h.stores.workspaces.create({ name: "w", rootPath: "/w", kind: "git" });
      const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: null });
      const worker = seedAgentRevision(h, "worker");
      const base = { conversationId: conversation.id, kind: "code" as const, target: { kind: "branch" as const, branch: "main" }, budget: DEFAULT_BUDGET };
      expect(() => h.runCreation.create({ ...base, orchestratorAgentDefinitionRevisionId: worker.id })).toThrow(/cannot hold the Orchestrator role.*not the orchestrator definition/);
      const definition = h.stores.agents.ensureDefinition("orchestrator");
      const readOnly = h.stores.agents.appendRevision(definition.id, {
        provenance: { kind: "builtin" },
        modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
        instructions: "read only",
        capabilities: { tools: ["read"], mcpServers: [] },
        toolPolicy: { read: "allowed" },
        defaultLimits: { allocation: { costUsd: 1, tokens: 1, attempts: 1 }, maxWallClockMs: null },
      });
      expect(() => h.runCreation.create({ ...base, orchestratorAgentDefinitionRevisionId: readOnly.id })).toThrow(/capability write is not declared; capability shell is not declared/);
      const denied = h.stores.agents.appendRevision(definition.id, {
        provenance: { kind: "builtin" },
        modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
        instructions: "denied shell",
        capabilities: { tools: ["read", "write", "shell"], mcpServers: [] },
        toolPolicy: { shell: "denied" },
        defaultLimits: { allocation: { costUsd: 1, tokens: 1, attempts: 1 }, maxWallClockMs: null },
      });
      expect(() => h.runCreation.create({ ...base, orchestratorAgentDefinitionRevisionId: denied.id })).toThrow(/capability shell is denied/);
      expect(() => h.runCreation.create({ ...base, orchestratorAgentDefinitionRevisionId: "agdr_000000000000000000000000" })).toThrow(/not executable by this Run.*does not exist/);
      expect(() => h.runCreation.create({ ...base, conversationId: "cv_000000000000000000000000", orchestratorAgentDefinitionRevisionId: seedAgentRevision(h, "orchestrator").id })).toThrow(NotFoundError);
      expect(h.stores.runs.listByConversation(conversation.id)).toHaveLength(0);
      expect(h.workspacePreparation.prepared).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("rolls back everything when the Conversation already has an active Run, before any Workspace preparation", () => {
    const h = openRuntimeHarness();
    try {
      const first = seedRuntime(h);
      const before = tableCounts(h);
      const seq = h.ctx.journal.lastSeq();
      expect(() =>
        h.runCreation.create({
          conversationId: first.created.run.conversationId,
          kind: "code",
          target: { kind: "branch", branch: "main" },
          budget: DEFAULT_BUDGET,
          orchestratorAgentDefinitionRevisionId: first.orchestrator.id,
          verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [first.completion.criterionId] },
        }),
      ).toThrow(ConflictError);
      expect(tableCounts(h)).toEqual(before);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.workspacePreparation.prepared).toHaveLength(1);
      expect(h.workspacePreparation.discarded).toHaveLength(0);
      expect(h.stores.conversations.get(first.created.run.conversationId).activeRunId).toBe(first.created.run.id);
    } finally {
      h.close();
    }
  });

  it("creates nothing when Workspace preparation fails, and compensates preparation when persistence fails afterwards", () => {
    const h = openRuntimeHarness();
    try {
      const workspace = h.stores.workspaces.create({ name: "w", rootPath: "/w", kind: "git" });
      const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: null });
      const orchestrator = seedAgentRevision(h, "orchestrator");
      const request = { conversationId: conversation.id, kind: "code" as const, target: { kind: "branch" as const, branch: "main" }, budget: DEFAULT_BUDGET, orchestratorAgentDefinitionRevisionId: orchestrator.id, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [seedCompletionCriterion(h, conversation.id).criterionId] } };
      const before = tableCounts(h);
      const seq = h.ctx.journal.lastSeq();

      h.workspacePreparation.failWith = new Error("git worktree add failed");
      expect(() => h.runCreation.create(request)).toThrow(/git worktree add failed/);
      expect(tableCounts(h)).toEqual(before);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.conversations.get(conversation.id).activeRunId).toBeNull();
      expect(h.workspacePreparation.discarded).toHaveLength(0);

      // A Snapshot identity the persistence layer refuses makes the transaction fail after preparation succeeded.
      h.workspacePreparation.nextBaseSnapshot = { kind: "directory", contentDigest: "d".repeat(64) };
      expect(() => h.runCreation.create(request)).toThrow(/git Workspace takes git Snapshots/);
      expect(tableCounts(h)).toEqual(before);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.workspacePreparation.prepared).toHaveLength(1);
      expect(h.workspacePreparation.discarded).toHaveLength(1);
      expect(h.workspacePreparation.discarded[0]!.prepared.integrationWorkspacePath).toBe(h.workspacePreparation.prepared[0]!.result.integrationWorkspacePath);
      expect(h.diagnostics).toEqual([]);

      // The compensation failure is reported, never hidden, and never replaces the canonical error.
      h.workspacePreparation.nextBaseSnapshot = { kind: "directory", contentDigest: "d".repeat(64) };
      h.workspacePreparation.discard = () => {
        throw new Error("cleanup failed");
      };
      expect(() => h.runCreation.create(request)).toThrow(/git Workspace takes git Snapshots/);
      expect(h.diagnostics).toEqual([{ kind: "rollback_hook_failed", index: 0, message: "cleanup failed" }]);
      expect(tableCounts(h)).toEqual(before);

      // After the failures a normal creation still succeeds.
      h.workspacePreparation.discard = () => {};
      expect(h.runCreation.create(request).run.status).toBe("created");
    } finally {
      h.close();
    }
  });
});
