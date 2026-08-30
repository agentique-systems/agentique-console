import { ConflictError, IllegalTransitionError, NotFoundError, RUN_STATUSES, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, DEFAULT_FINAL_RESERVE, openHarness, seedFinalChangeset, seedRun, seedSignoffBoundary, seedSnapshot } from "../test-support.ts";

const NO_EVALUATOR = { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 3, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] };

describe("conversations", () => {
  it("creates, updates, and journals a Conversation and its messages", () => {
    const h = openHarness();
    try {
      const workspace = h.stores.workspaces.create({ name: "w", rootPath: "/w", kind: "git" });
      const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: null });
      expect(conversation.activeRunId).toBeNull();
      const updated = h.stores.conversations.update(conversation.id, { title: "Hello" });
      expect(updated.title).toBe("Hello");
      const message = h.stores.conversations.postMessage({ conversationId: conversation.id, author: "operator", content: "Build it", runId: null, invocationId: null });
      expect(h.stores.conversations.listMessages(conversation.id)).toEqual([message]);
      expect(() => h.stores.conversations.postMessage({ conversationId: conversation.id, author: "operator", content: "x", runId: null, invocationId: "inv_000000000000000000000000" })).toThrow(NotFoundError);
      expect(() => h.stores.conversations.postMessage({ conversationId: conversation.id, author: "operator", content: "", runId: null, invocationId: null })).toThrow(ValidationError);
      expect(h.ctx.journal.read({ conversationId: conversation.id }).map((e) => e.type)).toEqual(["conversation.created", "conversation.updated", "conversation.message_posted"]);
      expect(() => h.stores.workspaces.create({ name: "w2", rootPath: "/w", kind: "git" })).toThrow(/UNIQUE/);
    } finally {
      h.close();
    }
  });

  it("allows at most one active Run per Conversation", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      expect(h.stores.conversations.get(s.conversation.id).activeRunId).toBe(s.run.id);
      expect(() => h.stores.runs.create({ conversationId: s.conversation.id, kind: "code", target: { kind: "branch", branch: "main" }, budget: DEFAULT_BUDGET, finalReserve: DEFAULT_FINAL_RESERVE, verificationPolicy: NO_EVALUATOR })).toThrow(ConflictError);
      expect(h.stores.runs.listByConversation(s.conversation.id)).toHaveLength(1);
      h.stores.runs.transition(s.run.id, { to: "cancelled" });
      expect(h.stores.conversations.get(s.conversation.id).activeRunId).toBeNull();
      const next = h.stores.runs.create({ conversationId: s.conversation.id, kind: "other", target: { kind: "branch", branch: "main" }, budget: DEFAULT_BUDGET, finalReserve: DEFAULT_FINAL_RESERVE, verificationPolicy: NO_EVALUATOR });
      expect(h.stores.conversations.get(s.conversation.id).activeRunId).toBe(next.id);
    } finally {
      h.close();
    }
  });
});

describe("runs", () => {
  it("creates a Run in created with its Budget, persisted final reserve, and workspace attribution", () => {
    const h = openHarness();
    try {
      const workspace = h.stores.workspaces.create({ name: "w", rootPath: "/w", kind: "git" });
      const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: null });
      const run = h.stores.runs.create({ conversationId: conversation.id, kind: "code", target: { kind: "branch", branch: "main" }, budget: DEFAULT_BUDGET, finalReserve: DEFAULT_FINAL_RESERVE, verificationPolicy: NO_EVALUATOR });
      expect(run.status).toBe("created");
      expect(run.workspaceId).toBe(workspace.id);
      expect(run.budget).toEqual(DEFAULT_BUDGET);
      expect(run.finalReserve).toEqual(DEFAULT_FINAL_RESERVE);
      expect(h.stores.runs.get(run.id)).toEqual(run);
      const events = h.ctx.journal.read({ runId: run.id });
      expect(events.map((e) => e.type)).toEqual(["run.created", "conversation.updated"]);
      expect(events[0]!.payload).toEqual(run);
      // The final reserve is part of the Run's immutable definition.
      expect(() => h.database.sqlite.prepare("UPDATE runs SET final_reserve_cost_usd = 0 WHERE id = ?").run(run.id)).toThrow(/immutable/);
      expect(() => h.database.sqlite.prepare("DELETE FROM runs WHERE id = ?").run(run.id)).toThrow(/never deleted/);
    } finally {
      h.close();
    }
  });

  it("rejects a final reserve that does not fit within the Run Budget", () => {
    const h = openHarness();
    try {
      const workspace = h.stores.workspaces.create({ name: "w", rootPath: "/w", kind: "git" });
      const conversation = h.stores.conversations.create({ workspaceId: workspace.id, title: null });
      const input = { conversationId: conversation.id, kind: "code" as const, target: { kind: "branch" as const, branch: "main" }, budget: DEFAULT_BUDGET, verificationPolicy: NO_EVALUATOR };
      expect(() => h.stores.runs.create({ ...input, finalReserve: { costUsd: DEFAULT_BUDGET.maxCostUsd + 1, tokens: 0, attempts: 0 } })).toThrow(ValidationError);
      expect(() => h.stores.runs.create({ ...input, finalReserve: { costUsd: -1, tokens: 0, attempts: 0 } })).toThrow(ValidationError);
      expect(h.stores.runs.listByConversation(conversation.id)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("walks the happy path and records the final Snapshot, the final Changeset, and the ended time", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const boundary = seedSignoffBoundary(h, s, { distinctIntegrationSnapshot: true });
      const { changeset } = seedFinalChangeset(h, s, boundary, "+final");
      // Both final references are required, must agree with the final Changeset, and exist only on a completed Run.
      expect(() => h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: boundary.baseSnapshotId, finalChangesetId: changeset.id })).toThrow(/ends at Snapshot/);
      expect(h.stores.runs.get(s.run.id)).toMatchObject({ status: "awaiting_signoff", finalSnapshotId: null, finalChangesetId: null });
      const completed = h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: boundary.verifiedSnapshotId, finalChangesetId: changeset.id });
      expect(completed.status).toBe("completed");
      expect(completed.finalSnapshotId).toBe(boundary.verifiedSnapshotId);
      expect(completed.finalChangesetId).toBe(changeset.id);
      expect(completed.endedAt).not.toBeNull();
      expect(h.stores.conversations.get(s.conversation.id).activeRunId).toBeNull();
      expect(() => h.database.sqlite.prepare("UPDATE runs SET final_changeset_id = NULL, final_snapshot_id = NULL WHERE id = ?").run(s.run.id)).toThrow(/final references never change/);
      expect(h.ctx.journal.read({ runId: s.run.id }).map((e) => e.type)).toEqual(
        expect.arrayContaining(["run.started", "run.verifying", "run.awaiting_signoff", "run.completed"]),
      );
    } finally {
      h.close();
    }
  });

  it("terminal Runs never resume", () => {
    const h = openHarness();
    try {
      for (const terminal of ["cancelled", "failed"] as const) {
        const s = seedRun(h);
        if (terminal === "failed") h.stores.runs.transition(s.run.id, { to: "failed", failure: { kind: "root_node_failed", summary: "root failed", evidenceArtifactIds: [] } });
        else h.stores.runs.transition(s.run.id, { to: "cancelled" });
        for (const to of RUN_STATUSES) {
          expect(() => h.stores.runs.transition(s.run.id, { to } as never), `${terminal} -> ${to}`).toThrow(IllegalTransitionError);
        }
        expect(h.stores.runs.get(s.run.id).status).toBe(terminal);
      }
    } finally {
      h.close();
    }
  });

  it("waiting requires a reason and returns to running only by clearing that reason", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const waiting = h.stores.runs.transition(s.run.id, { to: "waiting", waitReason: "budget" });
      expect(waiting.waitReason).toBe("budget");
      expect(() => h.stores.runs.transition(s.run.id, { to: "running" })).toThrow(ValidationError);
      expect(() => h.stores.runs.transition(s.run.id, { to: "running", clearedWaitReason: "decision" })).toThrow(ValidationError);
      const running = h.stores.runs.transition(s.run.id, { to: "running", clearedWaitReason: "budget" });
      expect(running.waitReason).toBeNull();
      expect(h.ctx.journal.read({ runId: s.run.id, type: "run.wait_cleared" })).toHaveLength(1);
      expect(() => h.stores.runs.transition(s.run.id, { to: "waiting", waitReason: "sleepy" as never })).toThrow(ValidationError);
    } finally {
      h.close();
    }
  });

  it("failure needs a terminal failure transition and infeasible needs Evidence", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      expect(() => h.stores.runs.transition(s.run.id, { to: "failed", failure: { kind: "infeasible", summary: "no", evidenceArtifactIds: [] } })).toThrow(ValidationError);
      expect(() => h.stores.runs.transition(s.run.id, { to: "verifying" })).not.toThrow();
      expect(() => h.stores.runs.transition(s.run.id, { to: "failed", failure: { kind: "root_node_failed", summary: "x", evidenceArtifactIds: [] } })).toThrow(IllegalTransitionError);
    } finally {
      h.close();
    }
  });

  it("records base and integration Snapshots of the same Workspace only, and the base Snapshot and Integration Workspace once", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const snapshot = seedSnapshot(h, s);
      const recorded = h.stores.runs.recordWorkspaceState(s.run.id, { baseSnapshotId: snapshot.id, integrationWorkspacePath: "/tmp/integration" });
      expect(recorded.baseSnapshotId).toBe(snapshot.id);
      expect(recorded.integrationWorkspacePath).toBe("/tmp/integration");
      expect(() => h.stores.runs.recordWorkspaceState(s.run.id, { baseSnapshotId: snapshot.id })).toThrow(ConflictError);
      expect(() => h.stores.runs.recordWorkspaceState(s.run.id, { integrationWorkspacePath: "/tmp/other" })).toThrow(ConflictError);
      const other = h.stores.workspaces.create({ name: "o", rootPath: "/o", kind: "git" });
      const foreign = h.stores.snapshots.record({ workspaceId: other.id, runId: null, identity: { kind: "git", commitId: "c".repeat(40), treeId: "d".repeat(40) }, reason: "run_start" });
      expect(() => h.stores.runs.recordWorkspaceState(s.run.id, { integrationSnapshotId: foreign.id })).toThrow(ConflictError);
      expect(h.stores.runs.recordWorkspaceState(s.run.id, { integrationSnapshotId: seedSnapshot(h, s, "integration").id }).integrationSnapshotId).not.toBeNull();
    } finally {
      h.close();
    }
  });
});
