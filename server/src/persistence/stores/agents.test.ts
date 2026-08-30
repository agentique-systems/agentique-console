/**
 * Agent Definition provenance at revision creation (execution-model §11):
 * every provenance target must exist and be appropriate before a revision
 * is appended. Which Runs may execute a revision is the execution
 * boundary's decision (see `execution/agent-definitions.test.ts`).
 */
import { InvariantViolationError, NotFoundError, ValidationError, type AgentDefinitionContent, type DecisionId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { createPersistenceContext } from "../context.ts";
import { MemoryBlobStore } from "../blob-store.ts";
import { openDatabase } from "../database.ts";
import { createStores } from "../stores/index.ts";
import { INVOCATION_ALLOCATION, openHarness, seedRun, seedSnapshot, testClock, type Harness } from "../test-support.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function content(provenance: AgentDefinitionContent["provenance"]): AgentDefinitionContent {
  return {
    provenance,
    modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
    instructions: "review",
    capabilities: { tools: ["read"], mcpServers: [] },
    toolPolicy: { read: "allowed" },
    defaultLimits: { allocation: INVOCATION_ALLOCATION, maxWallClockMs: null },
  };
}

/** An operator-resolved `operator_choice` Decision of the Conversation, as approves a Conversation-authored definition. */
export function approvalDecision(h: Harness, conversationId: string, resolve = true): DecisionId {
  const decision = h.stores.decisions.request({
    conversationId: conversationId as never,
    runId: null,
    kind: "operator_choice",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "runtime" },
    question: "Approve the reviewer definition?",
    options: [{ id: "yes", label: "Yes", description: null }, { id: "no", label: "No", description: null }],
    recommendedOptionId: "yes",
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [] },
    deadlineAt: null,
    activationCondition: null,
    subject: null,
    supersedesDecisionId: null,
  });
  if (resolve) h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "yes", rationale: null, artifactIds: [] });
  return decision.id;
}

describe("agent definition provenance", () => {
  it("accepts a builtin revision and a Workspace-file revision pinned to an existing Snapshot with a normalized definition path", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const definition = h.stores.agents.ensureDefinition("reviewer");
      expect(h.stores.agents.appendRevision(definition.id, content({ kind: "builtin" })).provenance).toEqual({ kind: "builtin" });
      const snapshot = seedSnapshot(h, s);
      const file = h.stores.agents.appendRevision(definition.id, content({ kind: "workspace_file", path: ".\\.claude\\agents\\reviewer.md", snapshotId: snapshot.id }));
      expect(file.provenance).toEqual({ kind: "workspace_file", path: ".claude/agents/reviewer.md", snapshotId: snapshot.id });
      // The same normalized path and Snapshot hash to the same revision.
      expect(h.stores.agents.appendRevision(definition.id, content({ kind: "workspace_file", path: ".claude/agents/reviewer.md", snapshotId: snapshot.id })).id).toBe(file.id);
      for (const bad of ["agents/reviewer.md", ".claude/agents/../x.md", "/abs/.claude/agents/r.md", ".claude/agents/r.txt", ".claude/agents/sub/r.md", ".claude/agents/.hidden.md"]) {
        expect(() => h.stores.agents.appendRevision(definition.id, content({ kind: "workspace_file", path: bad, snapshotId: snapshot.id })), bad).toThrow(ValidationError);
      }
      expect(() => h.stores.agents.appendRevision(definition.id, content({ kind: "workspace_file", path: ".claude/agents/reviewer.md", snapshotId: "snap_000000000000000000000000" }))).toThrow(NotFoundError);
    } finally {
      h.close();
    }
  });

  it("accepts a Conversation revision approved by an operator-resolved operator_choice Decision of that Conversation, and rejects every other approval", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const definition = h.stores.agents.ensureDefinition("reviewer");
      const approved = approvalDecision(h, s.conversation.id);
      const revision = h.stores.agents.appendRevision(definition.id, content({ kind: "conversation", conversationId: s.conversation.id, approvedByDecisionId: approved }));
      expect(revision.provenance).toEqual({ kind: "conversation", conversationId: s.conversation.id, approvedByDecisionId: approved });
      expect(h.ctx.journal.read({ conversationId: s.conversation.id, type: "agent_definition_revision.created" })).toHaveLength(1);
      // Missing Conversation or Decision.
      expect(() => h.stores.agents.appendRevision(definition.id, content({ kind: "conversation", conversationId: "cv_000000000000000000000000", approvedByDecisionId: approved }))).toThrow(NotFoundError);
      expect(() => h.stores.agents.appendRevision(definition.id, content({ kind: "conversation", conversationId: s.conversation.id, approvedByDecisionId: "dec_000000000000000000000000" }))).toThrow(NotFoundError);
      // A Decision of another Conversation.
      const other = seedRun(h);
      const foreign = approvalDecision(h, other.conversation.id);
      expect(() => h.stores.agents.appendRevision(definition.id, content({ kind: "conversation", conversationId: s.conversation.id, approvedByDecisionId: foreign }))).toThrow(InvariantViolationError);
      // An unresolved Decision.
      const open = approvalDecision(h, s.conversation.id, false);
      expect(() => h.stores.agents.appendRevision(definition.id, content({ kind: "conversation", conversationId: s.conversation.id, approvedByDecisionId: open }))).toThrow(/not been resolved by the operator/);
      // A Decision of an inappropriate kind (an Orchestrator's own choice cannot approve a definition).
      const orchestratorChoice = h.stores.decisions.request({ conversationId: s.conversation.id, runId: null, kind: "orchestrator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "runtime" }, question: "q", options: [{ id: "a", label: "A", description: null }], recommendedOptionId: "a", rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      h.stores.decisions.resolve(orchestratorChoice.id, { resolvedBy: "orchestrator", chosenOptionId: "a", rationale: null, artifactIds: [] });
      expect(() => h.stores.agents.appendRevision(definition.id, content({ kind: "conversation", conversationId: s.conversation.id, approvedByDecisionId: orchestratorChoice.id }))).toThrow(/operator_choice/);
      expect(h.stores.agents.listRevisions(definition.id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("provenance survives closing and reopening the database identically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-provenance-"));
    const file = path.join(dir, "console.db");
    const first = openDatabase(file);
    let expected: unknown[];
    let definitionId!: string;
    try {
      // A deterministic clock: revisions created within one real millisecond would otherwise order by random id.
      const ctx = createPersistenceContext(first, new MemoryBlobStore(), { clock: testClock().now });
      const stores = createStores(ctx);
      const h = { ctx, stores, database: first } as unknown as Harness;
      const s = seedRun(h);
      const definition = stores.agents.ensureDefinition("reviewer");
      definitionId = definition.id;
      const snapshot = seedSnapshot(h, s);
      stores.agents.appendRevision(definition.id, content({ kind: "builtin" }));
      stores.agents.appendRevision(definition.id, content({ kind: "workspace_file", path: ".claude/agents/reviewer.md", snapshotId: snapshot.id }));
      stores.agents.appendRevision(definition.id, content({ kind: "conversation", conversationId: s.conversation.id, approvedByDecisionId: approvalDecision(h, s.conversation.id) }));
      expected = stores.agents.listRevisions(definition.id);
    } finally {
      first.close();
    }
    const second = openDatabase(file);
    try {
      const stores = createStores(createPersistenceContext(second, new MemoryBlobStore()));
      expect(stores.agents.listRevisions(definitionId as never)).toEqual(expected);
      expect(stores.agents.listRevisions(definitionId as never).map((r) => r.provenance.kind)).toEqual(["builtin", "workspace_file", "conversation"]);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
