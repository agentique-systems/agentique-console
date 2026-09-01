/**
 * The Orchestrator's `node_result` turn (execution-model §4.6): when a
 * current non-root node ends and no Orchestrator turn has received its
 * result, the idle root advises one turn delivering every such result as a
 * typed `node_result` input — exactly once, from rows alone, funded like
 * every root turn — so the Orchestrator can act on it (request completion,
 * revise the plan) through canonical turns. Node results and queued operator
 * inputs travel in one turn whose purpose follows the input table.
 */
import type { ManifestInput } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { finishRoot, WIDE_GOVERNOR } from "../coordinator-test-support.ts";
import { workerPort } from "../decision-test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime } from "../test-support.ts";

describe("root node_result turns", () => {
  it("delivers an ended node's result to the Orchestrator once, as a node_result turn prepared from rows, and never again", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      await finishRoot(h, s);
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      const w = await workerPort(h, s);
      // While the node runs the root has nothing to act on.
      expect(h.runners.root.inspect(runId)).toMatchObject({ kind: "idle" });
      expect(h.runners.root.pendingNodeResults(runId)).toEqual([]);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(w.attempt.id);
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      expect(h.stores.plans.getNode(w.node.id).status).toBe("succeeded");
      // The ended node's result is pending exactly until a root turn carries it.
      expect(h.runners.root.pendingNodeResults(runId).map((n) => n.id)).toEqual([w.node.id]);
      expect(h.runners.root.inspect(runId)).toMatchObject({ kind: "prepare_turn", inputIds: [], nodeIds: [w.node.id], funded: true });
      const pass = await h.scheduler.advanceRun(runId, { maxActions: 1 });
      expect(pass.actions.map((a) => [a.action.kind, a.outcome.kind])).toEqual([["prepare_root_turn", "turn_prepared"]]);
      const turn = h.stores.invocations.latestAtPosition(s.created.root.id, "orchestrator")!;
      expect(turn).toMatchObject({ purpose: "node_result", continuedFromInvocationId: s.invocation.id, status: "pending" });
      const inputs = h.stores.invocations.getManifest(turn.id).content.inputs;
      expect(inputs).toEqual([{ kind: "node_result", planNodeId: w.node.id, status: "succeeded", outputArtifactIds: h.stores.plans.getNode(w.node.id).outputArtifactIds ?? [] }]);
      expect(h.runners.root.pendingNodeResults(runId)).toEqual([]);
      // The turn is funded from the root's allocation; nothing more is prepared while it is pending or after it ends.
      expect(h.stores.reservations.listByChild({ type: "invocation", id: turn.id })).toHaveLength(1);
      expect(h.runners.root.inspect(runId).kind).not.toBe("prepare_turn");
      const prepared = await h.executor.prepareNextAttempt(turn.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(prepared.attempt.id);
      await h.scheduler.advanceRun(runId, { maxActions: 2 });
      expect(h.runners.root.inspect(runId)).toMatchObject({ kind: "idle" });
      expect(h.stores.invocations.listAtPosition(s.created.root.id, "orchestrator").filter((t) => t.purpose === "node_result")).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("carries a queued operator message and an ended node's result in one turn whose purpose follows the input table", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const s = seedPlanningRuntime(h);
      const runId = s.created.run.id;
      await finishRoot(h, s);
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      const w = await workerPort(h, s);
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      await h.executor.executePreparedAttempt(w.attempt.id);
      // The node settles; its result is pending. An operator message arrives before the next pass: one turn carries both.
      await h.scheduler.advanceRun(runId, { maxActions: 1 });
      expect(h.runners.root.pendingNodeResults(runId).map((n) => n.id)).toEqual([w.node.id]);
      const posted = h.orchestratorInputs.postOperatorMessage({ runId, content: "Prefer a smaller change." });
      expect(h.runners.root.inspect(runId)).toMatchObject({ kind: "prepare_turn", inputIds: [posted.queued.id], nodeIds: [w.node.id] });
      const pass = await h.scheduler.advanceRun(runId, { maxActions: 1 });
      expect(pass.actions.map((a) => a.action.kind)).toEqual(["prepare_root_turn"]);
      const turn = h.stores.invocations.latestAtPosition(s.created.root.id, "orchestrator")!;
      expect(turn.purpose).toBe("operator_input");
      const kinds = h.stores.invocations.getManifest(turn.id).content.inputs.map((i: ManifestInput) => i.kind);
      expect(kinds).toEqual(["operator_message", "node_result"]);
      expect(h.orchestratorInputs.pending(runId)).toEqual([]);
      expect(h.runners.root.pendingNodeResults(runId)).toEqual([]);
    } finally {
      h.close();
    }
  });
});
