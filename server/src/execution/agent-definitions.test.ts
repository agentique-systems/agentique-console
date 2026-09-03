/**
 * Agent Definition provenance ownership at Run bootstrap and plan
 * compilation (execution-model §11): the one resolver both services use.
 */
import type { AgentDefinitionContent, AgentDefinitionRevision, PlanExpression } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { approvalDecision } from "../persistence/stores/agents.test.ts";
import { DEFAULT_BUDGET, INVOCATION_ALLOCATION, type Harness } from "../persistence/test-support.ts";
import { resolveExecutableAgentDefinitionRevision } from "./agent-definitions.ts";
import { accepted, openRuntimeHarness, propose, rejected, seedPlanningRuntime, type RuntimeSeed } from "./test-support.ts";

const leaf = (agent: string): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: agent as never } });

function reviewer(h: Harness, provenance: AgentDefinitionContent["provenance"], name = "reviewer"): AgentDefinitionRevision {
  const definition = h.stores.agents.ensureDefinition(name);
  return h.stores.agents.appendRevision(definition.id, {
    provenance,
    modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
    instructions: `You are ${name}.`,
    capabilities: { tools: ["read", "write", "shell"], mcpServers: [] },
    toolPolicy: { read: "allowed", write: "allowed", shell: "allowed" },
    defaultLimits: { allocation: INVOCATION_ALLOCATION, maxWallClockMs: null },
  });
}

function owner(seed: RuntimeSeed) {
  return { workspaceId: seed.created.run.workspaceId, conversationId: seed.created.run.conversationId };
}

describe("executable-revision resolver", () => {
  it("accepts builtin everywhere, Workspace-file revisions in their Workspace, and Conversation revisions in their Conversation", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const other = seedPlanningRuntime(h);
      const builtin = reviewer(h, { kind: "builtin" });
      const file = reviewer(h, { kind: "workspace_file", path: ".claude/agents/reviewer.md", snapshotId: s.created.baseSnapshot.id });
      const conversation = reviewer(h, { kind: "conversation", conversationId: s.created.run.conversationId, approvedByDecisionId: approvalDecision(h, s.created.run.conversationId) });
      for (const revision of [builtin, file, conversation]) {
        const resolved = resolveExecutableAgentDefinitionRevision(h.stores, owner(s), revision.id);
        expect(resolved.ok, revision.provenance.kind).toBe(true);
        if (resolved.ok) {
          expect(resolved.revision).toEqual({ id: revision.id, definitionName: "reviewer", provenanceKind: revision.provenance.kind, capabilities: revision.capabilities, toolPolicy: revision.toolPolicy, defaultLimits: revision.defaultLimits });
        }
      }
      expect(resolveExecutableAgentDefinitionRevision(h.stores, owner(other), builtin.id).ok).toBe(true);
      expect(resolveExecutableAgentDefinitionRevision(h.stores, owner(other), file.id)).toMatchObject({ ok: false, message: expect.stringContaining("another Workspace") });
      expect(resolveExecutableAgentDefinitionRevision(h.stores, owner(other), conversation.id)).toMatchObject({ ok: false, message: expect.stringContaining("another Conversation") });
      expect(resolveExecutableAgentDefinitionRevision(h.stores, owner(s), "agdr_000000000000000000000000")).toMatchObject({ ok: false, message: expect.stringContaining("does not exist") });
      // A Snapshot of the same Workspace taken by another Run still belongs to the Workspace.
      const sibling = reviewer(h, { kind: "workspace_file", path: ".claude/agents/reviewer.md", snapshotId: other.created.baseSnapshot.id }, "sibling");
      expect(resolveExecutableAgentDefinitionRevision(h.stores, owner(other), sibling.id).ok).toBe(true);
      expect(resolveExecutableAgentDefinitionRevision(h.stores, owner(s), sibling.id).ok).toBe(false);
    } finally {
      h.close();
    }
  });

  it("rejects a foreign-provenance Orchestrator before Workspace preparation or any canonical write", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const other = seedPlanningRuntime(h);
      // Two candidate Orchestrator definitions of the other Run's origin: a Workspace file and a Conversation authoring.
      const foreignFile = reviewer(h, { kind: "workspace_file", path: ".claude/agents/orchestrator.md", snapshotId: other.created.baseSnapshot.id }, "orchestrator");
      const foreignConversation = reviewer(h, { kind: "conversation", conversationId: other.created.run.conversationId, approvedByDecisionId: approvalDecision(h, other.created.run.conversationId) }, "orchestrator");
      h.stores.runs.transition(s.created.run.id, { to: "cancelled" });
      const prepared = h.workspacePreparation.prepared.length;
      const seq = h.ctx.journal.lastSeq();
      const request = { conversationId: s.created.run.conversationId, kind: "code" as const, target: { kind: "branch" as const, branch: "main" }, budget: DEFAULT_BUDGET, verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [s.completion.criterionId] } };
      expect(() => h.runCreation.create({ ...request, orchestratorAgentDefinitionRevisionId: foreignFile.id })).toThrow(/not executable by this Run.*another Workspace/);
      expect(() => h.runCreation.create({ ...request, orchestratorAgentDefinitionRevisionId: foreignConversation.id })).toThrow(/not executable by this Run.*another Conversation/);
      expect(h.workspacePreparation.prepared).toHaveLength(prepared);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.stores.runs.listByConversation(s.created.run.conversationId)).toHaveLength(1);
      // The same definitions authored for this Run's origin are accepted.
      const own = reviewer(h, { kind: "workspace_file", path: ".claude/agents/orchestrator.md", snapshotId: s.created.baseSnapshot.id }, "orchestrator");
      expect(h.runCreation.create({ ...request, orchestratorAgentDefinitionRevisionId: own.id }).run.status).toBe("created");
    } finally {
      h.close();
    }
  });

  it("a foreign-provenance plan Worker produces exactly one rejected Event and consumes no revision number; own-provenance Workers compile", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const other = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      const foreignFile = reviewer(h, { kind: "workspace_file", path: ".claude/agents/reviewer.md", snapshotId: other.created.baseSnapshot.id });
      const foreignConversation = reviewer(h, { kind: "conversation", conversationId: other.created.run.conversationId, approvedByDecisionId: approvalDecision(h, other.created.run.conversationId) }, "author");
      for (const revision of [foreignFile, foreignConversation]) {
        const seq = h.ctx.journal.lastSeq();
        const outcome = rejected(propose(h, s, [leaf(s.worker.id), leaf(revision.id)]));
        expect(outcome.reasons).toEqual([{ code: "invalid_agent_definition_revision", message: expect.stringContaining(revision.id), path: null }]);
        expect(h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type)).toEqual(["execution_plan.rejected"]);
        expect(outcome.currentRevisionNumber).toBe(1);
      }
      const ownFile = reviewer(h, { kind: "workspace_file", path: ".claude/agents/reviewer.md", snapshotId: s.created.baseSnapshot.id });
      const ownConversation = reviewer(h, { kind: "conversation", conversationId: s.created.run.conversationId, approvedByDecisionId: approvalDecision(h, s.created.run.conversationId) }, "author");
      const outcome = accepted(propose(h, s, [leaf(ownFile.id), { pattern: "evaluator_optimizer", producer: leaf(s.worker.id), evaluator: { agentDefinitionRevisionId: ownConversation.id }, maxRounds: 2 }]));
      expect(outcome.revision.number).toBe(2);
      // The evaluator declares write and shell tools; it is bound read-only for the manifest to intersect later.
      const node = outcome.graph.nodes[2]!;
      if (node.kind === "pattern" && node.shape.pattern === "evaluator_optimizer") expect(node.shape.evaluator).toMatchObject({ role: "evaluator", readOnly: true, agentDefinitionRevisionId: ownConversation.id });
      else throw new Error("expected an evaluator_optimizer node");
      // The Orchestrator's own definition cannot be bound to another role.
      expect(rejected(propose(h, s, [leaf(s.orchestrator.id)])).reasons[0]).toMatchObject({ code: "invalid_role_binding" });
    } finally {
      h.close();
    }
  });

  it("the compiler receives only already-authorized revision facts", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedPlanningRuntime(h);
      const other = seedPlanningRuntime(h);
      const foreign = reviewer(h, { kind: "workspace_file", path: ".claude/agents/reviewer.md", snapshotId: other.created.baseSnapshot.id });
      const lookups: string[] = [];
      const original = h.stores.agents.getRevision.bind(h.stores.agents);
      h.stores.agents.getRevision = (id) => {
        lookups.push(id);
        return original(id);
      };
      rejected(propose(h, s, [leaf(foreign.id)]));
      // The resolver looked the revision up once and the proposal never reached compilation with it.
      expect(lookups).toEqual([foreign.id]);
      h.stores.agents.getRevision = original;
    } finally {
      h.close();
    }
  });
});

