/**
 * Spec currency for seats: the governing revision re-anchors every delivery
 * prompt, and rides seat rotation checkpoints — a seat that outlives an
 * amendment must not keep working from a superseded revision it has no way
 * to notice, and a checkpoint must be self-sufficiently true.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string) => ({ core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
  uncertainty: [], nextAction: action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

function makeFlowHarness(harnessOptions: Parameters<typeof makeDelegationHarness>[1] = {}) {
  let coordinatorTurns = 0;
  return makeDelegationHarness(async function* (options) {
    const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
    const coordinator = append.includes("sole coordinator");
    yield initMessage(coordinator ? `coord-${coordinatorTurns}` : "scout-1");
    if (coordinator) {
      coordinatorTurns += 1;
      yield coordinatorTurns === 1
        ? sendHandoffUse("send-1", "scout", { action: "look around", status: "pending", category: "assignment" })
        : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "done", status: "completed", category: "final" });
      yield successMessage();
    } else {
      yield sendHandoffUse("scout-close", "coordinator", { action: "seen", status: "completed", category: "milestone" });
      yield successMessage();
    }
  }, harnessOptions);
}

function approveSpec(h: ReturnType<typeof makeFlowHarness>, userSessionId: string): void {
  const draft = h.app.specs.propose(userSessionId, "# Game spec\n\nDeterministic dungeons.", "initial spec");
  h.app.specs.approve(draft.id, { document: draft.document, edited: false });
}

describe("spec currency for seats (fake SDK)", () => {
  it("every delivery prompt re-anchors on the governing revision", async () => {
    const h = makeFlowHarness();
    const userSessionId = h.addUserSession();
    approveSpec(h, userSessionId);
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 10_000);
    h.host.createSession({ userSessionId, title: "anchored", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("go") });
    await done;

    const scoutPrompt = h.fake.captured.prompts.find((text) => text.includes("You are scout."));
    expect(scoutPrompt).toBeDefined();
    expect(scoutPrompt).toContain("Governing requirements: spec rev 1 — initial spec");
    expect(scoutPrompt).toContain("read_requirements before continuing");
  });

  it("a spec-less session's delivery prompt is unchanged — no empty block", async () => {
    const h = makeFlowHarness();
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 10_000);
    h.host.createSession({ userSessionId, title: "bare", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("go") });
    await done;

    const scoutPrompt = h.fake.captured.prompts.find((text) => text.includes("You are scout."))!;
    expect(scoutPrompt).not.toContain("Governing requirements");
    expect(scoutPrompt).toMatch(/Participants: [^\n]*\.\n\nOnly the following addressed handoffs are new:/);
  });

  it("a seat rotation checkpoint carries the spec pointer", async () => {
    const h = makeFlowHarness({ config: { policy: { contextRotation: true } } });
    const userSessionId = h.addUserSession();
    approveSpec(h, userSessionId);
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.context.rotated", 10_000);
    const created = h.host.createSession({ userSessionId, title: "rotate", agents: [{ name: "scout", profileId: "explorer", model: "mystery-model" }], briefing: handoff("go") });
    h.repo.patchAgent(created.agentSessionId, "scout", { contextTokens: 70_000 });
    await done;

    const checkpoint = h.sqlite.prepare(
      "SELECT extension FROM handoff_records WHERE agent_session_id = ? AND trigger IN ('rotation','recovery')",
    ).get(created.agentSessionId) as { extension: string } | undefined;
    expect(checkpoint).toBeDefined();
    expect(JSON.parse(checkpoint!.extension).data.approvedSpec).toContain("rev 1 — initial spec");
  });
});
