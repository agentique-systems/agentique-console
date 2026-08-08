/**
 * Checkpoint quality gate over the fake SDK: one feedback retry, soft
 * thresholds defer on a gate-failing pair, hard thresholds accept the better
 * draft and journal the decision.
 */
import { describe, expect, it } from "vitest";
import type { HandoffDraft } from "@agentique-console/shared";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

/** Fails the gate: in_progress with no evidence refs. */
const failingDraft: HandoffDraft = { core: { schemaVersion: 1, taskId: null, status: "in_progress", risk: "low",
  action: "mid-flight state", state: { summary: "partial", evidence: [] }, result: { summary: null, artifacts: [] },
  uncertainty: [], nextAction: "keep going", requestExpandedContext: false }, extension: { kind: "generic", data: {} } };

/** Passes the gate: honest completed checkpoint. */
const passingDraft: HandoffDraft = { core: { schemaVersion: 1, taskId: null, status: "completed", risk: "low",
  action: "all assigned work landed", state: { summary: "everything completed and reported", evidence: [] },
  result: { summary: "done", artifacts: [] }, uncertainty: [], nextAction: null, requestExpandedContext: false }, extension: { kind: "generic", data: {} } };

function makeGateHarness(checkpointDrafts: HandoffDraft[]) {
  let coordinatorTurns = 0;
  let checkpoints = 0;
  const h = makeDelegationHarness(async function* (options) {
    if (options.permissionMode === "plan" && options.maxTurns === 2) {
      const draft = checkpointDrafts[Math.min(checkpoints, checkpointDrafts.length - 1)]!;
      checkpoints += 1;
      yield initMessage(`ckpt-${checkpoints}`);
      yield successMessage(draft as unknown as Record<string, unknown>);
      return;
    }
    const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
    const coordinator = append.includes("sole coordinator");
    yield initMessage(coordinator ? `coord-${coordinatorTurns}` : "scout-1");
    if (coordinator) {
      coordinatorTurns += 1;
      yield successMessage(coordinatorTurns === 1
        ? { handoff: handoff("inspect", "pending"), to: "scout", category: "assignment", checkpointReadiness: "stable" }
        : { handoff: handoff("done", "completed"), to: "main", category: "final", checkpointReadiness: "stable" });
    } else {
      yield successMessage({ handoff: handoff("looked", "completed"), to: "orchestrator", category: "milestone", checkpointReadiness: "stable" });
    }
  });
  return { h, checkpointCount: () => checkpoints };
}

async function runToResult(h: ReturnType<typeof makeGateHarness>["h"], contextTokens: number) {
  const userSessionId = h.addUserSession();
  const done = collectUntil(h.bus, (event) => event.type === "flow.result", 10_000);
  const created = h.host.createSession({ userSessionId, title: "gate", mode: "execute",
    agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("go", "pending") });
  h.repo.patchParticipant(created.agentSessionId, "scout", { contextTokens, sdkSessionId: "seed" });
  return { created, events: await done };
}

describe("checkpoint quality gate (fake SDK)", () => {
  it("hard threshold: failing draft retried once with feedback, retry accepted", async () => {
    const { h, checkpointCount } = makeGateHarness([failingDraft, passingDraft]);
    const { created, events } = await runToResult(h, 200_000);
    expect(checkpointCount()).toBe(2);
    const retried = events.filter((event) => event.type === "handoff.checkpoint.retried");
    expect(retried.map((event) => event.payload.accepted)).toEqual(["none", "retry"]);
    expect(retried[0]?.payload.failures).toContain("no evidence refs on a non-completed checkpoint");
    const retryPrompt = h.fake.captured.prompts.find((prompt) => prompt.includes("failed these deterministic checks"));
    expect(retryPrompt).toContain("no evidence refs on a non-completed checkpoint");
    const rotated = events.filter((event) => event.type === "agent_session.context.rotated");
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.payload).toMatchObject({ participant: "scout", degraded: false });
    expect(h.repo.getParticipant(created.agentSessionId, "scout")?.generation).toBe(1);
  });

  it("soft threshold: a gate-failing pair defers rotation", async () => {
    const { h, checkpointCount } = makeGateHarness([failingDraft, failingDraft]);
    const { events } = await runToResult(h, 95_000);
    expect(checkpointCount()).toBe(2);
    const failed = events.filter((event) => event.type === "handoff.checkpoint.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ participant: "scout", threshold: "soft", degraded: false });
    expect(failed[0]?.payload.checkFailures).toContain("no evidence refs on a non-completed checkpoint");
    expect(events.some((event) => event.type === "agent_session.context.rotated")).toBe(false);
  });

  it("hard threshold: a gate-failing pair still rotates with the better draft, journaled", async () => {
    const { h } = makeGateHarness([failingDraft, failingDraft]);
    const { created, events } = await runToResult(h, 200_000);
    const retried = events.filter((event) => event.type === "handoff.checkpoint.retried");
    expect(retried.map((event) => event.payload.accepted)).toEqual(["none", "retry"]);
    expect(retried[1]?.payload.failures).not.toHaveLength(0);
    expect(events.filter((event) => event.type === "agent_session.context.rotated")).toHaveLength(1);
    expect(h.repo.getParticipant(created.agentSessionId, "scout")?.generation).toBe(1);
  });
});
