/**
 * Starting a Run (execution-model §3, §4.6; invariants 1 single-agent
 * default, 2 the Orchestrator works directly, 20 one Invocation per
 * logical turn).
 */
import { ConflictError, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { COMPLETED_RESULT, openRuntimeHarness, seedRuntime, startRun, TEST_GOVERNOR } from "./test-support.ts";

describe("RunStartService", () => {
  it("moves the root node and the Run to running and prepares the first Orchestrator Invocation with purpose operator_input, once", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const seq = h.ctx.journal.lastSeq();
      const started = startRun(h, s);
      expect(started.run.status).toBe("running");
      expect(started.root.status).toBe("running");
      expect(started.prepared.invocation).toMatchObject({
        role: "orchestrator",
        purpose: "operator_input",
        planNodeId: s.created.root.id,
        agentDefinitionRevisionId: s.orchestrator.id,
        continuedFromInvocationId: null,
        allocationSource: "plan_node",
        finalReserveUse: null,
        taskIds: [],
        status: "pending",
      });
      expect(started.prepared.manifest.content.inputs).toEqual([{ kind: "operator_message", conversationMessageId: s.message.id, content: s.message.content }]);
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual(["plan_node.ready", "plan_node.started", "run.started", "invocation.created", "budget_reservation.created", "invocation.workspace_prepared", "snapshot.taken", "context_manifest.created"]);
      // Nothing executed yet.
      expect(h.stores.invocations.listAttempts(started.prepared.invocation.id)).toEqual([]);
      expect(h.provider.requests).toHaveLength(0);
      // Starting twice is a conflict that creates no second first Invocation.
      expect(() => startRun(h, s)).toThrow(ConflictError);
      expect(h.stores.invocations.listByRun(s.created.run.id)).toHaveLength(1);
      expect(h.ctx.journal.lastSeq()).toBe(seq + 8);
    } finally {
      h.close();
    }
  });

  it("validates the operator message belongs to the Run's Conversation and creates nothing otherwise", () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const other = seedRuntime(h);
      const seq = h.ctx.journal.lastSeq();
      expect(() => h.runStart.start({ runId: s.created.run.id, conversationMessageId: other.message.id })).toThrow(ValidationError);
      const orchestratorMessage = h.stores.conversations.postMessage({ conversationId: s.created.run.conversationId, author: "orchestrator", content: "hello", runId: null, invocationId: null });
      expect(() => h.runStart.start({ runId: s.created.run.id, conversationMessageId: orchestratorMessage.id })).toThrow(/not an operator message/);
      expect(() => h.runStart.start({ runId: s.created.run.id, conversationMessageId: "cvm_000000000000000000000000" })).toThrow(/not found/);
      expect(h.stores.runs.get(s.created.run.id).status).toBe("created");
      expect(h.stores.plans.getNode(s.created.root.id).status).toBe("pending");
      expect(h.stores.invocations.listByRun(s.created.run.id)).toEqual([]);
      expect(h.ctx.journal.read({ runId: s.created.run.id, afterSeq: seq }).map((e) => e.type)).toEqual([]);
      expect(h.executionWorkspace.prepared).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("executes the first turn only when asked, leaving the root node and the Run running after it completes", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { prepared } = startRun(h, s);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const outcome = await h.executor.advanceInvocation(prepared.invocation.id);
      expect(outcome).toMatchObject({ kind: "finalized", attempt: { kind: "initial", status: "succeeded" }, settlement: { kind: "settled", invocation: { status: "succeeded" } } });
      expect(h.stores.plans.getNode(s.created.root.id).status).toBe("running");
      expect(h.stores.runs.get(s.created.run.id).status).toBe("running");
      expect(h.stores.reservations.activeForChild({ type: "plan_node", id: s.created.root.id })).not.toBeNull();
      expect(h.stores.usage.totalsForRun(s.created.run.id).rows).toBe(1);
      // The Orchestrator worked directly: its Changeset is recorded like any other Invocation's.
      expect(h.stores.changesets.listByRun(s.created.run.id).map((c) => c.invocationId)).toEqual([prepared.invocation.id]);
    } finally {
      h.close();
    }
  });

  it("returns the structured capacity refusal without creating an Attempt when the governor has nothing to grant", async () => {
    const h = openRuntimeHarness({ governor: { ...TEST_GOVERNOR, providers: { fake: { maxConcurrency: 0 } } } });
    try {
      const s = seedRuntime(h);
      const { prepared } = startRun(h, s);
      const seq = h.ctx.journal.lastSeq();
      const outcome = await h.executor.advanceInvocation(prepared.invocation.id);
      expect(outcome).toMatchObject({ kind: "capacity_refused", refusal: { reason: "configured_limit", retryAfter: null }, invocation: { id: prepared.invocation.id, status: "pending" } });
      expect(h.stores.invocations.listAttempts(prepared.invocation.id)).toEqual([]);
      expect(h.stores.invocations.attemptsConsumed(prepared.invocation.id)).toBe(0);
      expect(h.stores.leases.listByRun(s.created.run.id)).toEqual([]);
      expect(h.ctx.journal.lastSeq()).toBe(seq);
      expect(h.provider.requests).toHaveLength(0);
      // Canonical state is ready for the scheduler to place the Run in waiting: root and Run still running, Invocation pending with its manifest.
      expect(h.stores.plans.getNode(s.created.root.id).status).toBe("running");
      expect(h.stores.runs.get(s.created.run.id).status).toBe("running");
      expect(h.executor.inspectInvocation(prepared.invocation.id).next).toEqual({ permitted: true });
    } finally {
      h.close();
    }
  });
});
