import { describe, expect, it } from "vitest";
import type { HandoffDraft } from "@agentique-console/shared";
import { handoffRecords } from "../db/schema.ts";
import { successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { ORCHESTRATOR_SEAT } from "./host.ts";

function draft(action: string, taskId: string | null = null): HandoffDraft {
  return {
    core: {
      schemaVersion: 1,
      taskId,
      status: "pending",
      risk: "low",
      action,
      state: { summary: action, evidence: [] },
      result: { summary: null, artifacts: [] },
      uncertainty: [],
      nextAction: action,
      requestExpandedContext: false,
    },
    extension: { kind: "generic", data: {} },
  };
}

const idleProgram = async function* () {
  yield successMessage();
};

describe("canonical forwarding and dependency dispatch", () => {
  it("forwards one canonical record and can seed a new AgentSession from it", () => {
    const h = makeDelegationHarness(idleProgram);
    const userSessionId = h.addUserSession();
    const first = h.host.createSession({
      userSessionId,
      title: "first",
      mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }],
    });
    const sourceMessage = h.host.post({
      agentSessionId: first.agentSessionId,
      speaker: { kind: "orchestrator", name: "main" },
      to: ORCHESTRATOR_SEAT,
      handoff: draft("Inspect the parser"),
      category: "assignment",
    });
    const handoffId = (sourceMessage.payload?.handoff as { id: string }).id;

    const forwarded = h.host.forward({
      agentSessionId: first.agentSessionId,
      speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT },
      to: "scout",
      handoffId,
      purpose: "assignment_context",
      expectedAction: "Use the original evidence while inspecting the parser.",
      category: "update",
    });

    expect(h.db.select().from(handoffRecords).all()).toHaveLength(1);
    expect(forwarded.payload).toMatchObject({
      handoff: { id: handoffId },
      handoffReference: {
        handoffId,
        forwardedBy: ORCHESTRATOR_SEAT,
        recipient: "scout",
      },
    });

    const successor = h.host.createSession({
      userSessionId,
      title: "revised scope",
      mode: "execute",
      agents: [{ name: "parser-scout", profileId: "explorer" }],
      briefingReference: {
        handoffId,
        purpose: "scope_change",
        expectedAction: "Coordinate the revised parser scope from this checkpoint.",
      },
    });
    const briefing = h.repo.listMessages("agent", successor.agentSessionId)[0];
    expect(briefing?.payload).toMatchObject({
      handoff: { id: handoffId },
      handoffReference: { purpose: "scope_change" },
    });
    expect(h.db.select().from(handoffRecords).all()).toHaveLength(1);
  });

  it("keeps an authorized assignment queued until its dependencies complete", async () => {
    const h = makeDelegationHarness(idleProgram);
    const userSessionId = h.addUserSession();
    const { agentSessionId } = h.host.createSession({
      userSessionId,
      title: "dependency chain",
      mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }],
    });
    const listId = `console:${agentSessionId}:${ORCHESTRATOR_SEAT}`;
    const attribution = {
      workspaceId: h.workspaceId,
      userSessionId,
      agentSessionId,
      participant: "scout",
    };
    h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: "task-a", subject: "Foundation", attribution });
    h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: "task-b", subject: "Dependent", attribution });
    h.tasks.applyUpdate({
      sdkSessionId: listId,
      sdkTaskId: "task-b",
      validateDependencies: true,
      patch: { addBlockedBy: ["task-a"] },
    });

    h.host.post({
      agentSessionId,
      speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT },
      to: "scout",
      handoff: draft("Run the dependent investigation", "task-b"),
      category: "assignment",
    });
    const [waiting] = h.repo.listQueuedDeliveries(agentSessionId);
    expect(waiting).toMatchObject({
      gateTaskId: "task-b",
      dispatchState: "waiting_dependencies",
    });
    expect(h.host.wireSession(h.repo.getAgentSession(agentSessionId)!).status).toBe("idle");

    const started = collectUntil(
      h.bus,
      (event) =>
        event.type === "agent_session.turn.started" &&
        event.payload.participant === "scout",
    );
    h.tasks.markCompleted(listId, "task-a");
    await started;

    const delivery = h.repo.listAllDeliveries()
      .find((row) => row.gateTaskId === "task-b");
    expect(delivery?.dispatchState).toBe("ready");
  });

  it("rejects invalid and cyclic Console-owned dependencies", () => {
    const h = makeDelegationHarness(idleProgram);
    const userSessionId = h.addUserSession();
    const { agentSessionId } = h.host.createSession({
      userSessionId,
      title: "dependency validation",
      mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }],
    });
    const listId = `console:${agentSessionId}:${ORCHESTRATOR_SEAT}`;
    const attribution = { workspaceId: h.workspaceId, userSessionId, agentSessionId, participant: "scout" };
    h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: "a", subject: "A", attribution });
    h.tasks.upsertFromCreate({ sdkSessionId: listId, sdkTaskId: "b", subject: "B", attribution });

    expect(() => h.tasks.applyUpdate({
      sdkSessionId: listId,
      sdkTaskId: "a",
      validateDependencies: true,
      patch: { addBlockedBy: ["missing"] },
    })).toThrow(/does not exist/);

    h.tasks.applyUpdate({
      sdkSessionId: listId,
      sdkTaskId: "b",
      validateDependencies: true,
      patch: { addBlockedBy: ["a"] },
    });
    expect(() => h.tasks.applyUpdate({
      sdkSessionId: listId,
      sdkTaskId: "a",
      validateDependencies: true,
      patch: { addBlockedBy: ["b"] },
    })).toThrow(/cycle/);
  });
});
