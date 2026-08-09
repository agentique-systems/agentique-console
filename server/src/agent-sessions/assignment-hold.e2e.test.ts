/**
 * An assignment whose declared blocker is open is JOURNALED AND HELD — and the
 * hold must survive everything that once silently dissolved it:
 *
 * - the sender being told `delivered: true` (it must learn it was queued);
 * - a task change on ANYTHING (the old release path derived `taskId` from a
 *   HandoffSummary, which has no such field — every hold released on the
 *   first ledger write of any kind);
 * - a server restart (`boot()` used to re-deliver every queued row with no
 *   blocker check);
 * - a blocker nobody touches again (the grace period only ran inside
 *   `tasks.onChange`, so it could never expire on its own — the governance
 *   sweep gives it a clock).
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { loadConfig } from "../config.ts";
import { collectUntil, makeDelegationHarness, restartHarness, type DelegationHarness } from "../test-helpers.ts";
import { consoleTaskListId } from "../orchestrator/tools.ts";

const briefing = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

const assignmentArgs = {
  to: "builder", category: "assignment" as const, status: "pending" as const, risk: "low" as const,
  action: "Implement src/game.js against the agreed interface",
  stateSummary: "The interface contract is task 1; build once it lands.",
  evidence: [], resultSummary: null, artifacts: [], uncertainty: [],
  nextAction: "Implement the module.", taskId: "2", requestExpandedContext: false,
};

const parse = (result: { content: { type: string; text?: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;

async function heldAssignment(config: Partial<ReturnType<typeof loadConfig>> = {}): Promise<{
  h: DelegationHarness; agentSessionId: string; deliveryId: string;
}> {
  const h = makeDelegationHarness(
    async function* () {
      yield initMessage();
      yield successMessage();
    },
    { hostOverrides: { config: { ...loadConfig({}), ...config } } },
  );
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "hold", mode: "execute",
    agents: [{ name: "builder", profileId: "implementer", owns: ["src/game.js"] }],
    briefing: briefing("build the game"),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

  const tool = (name: string) => h.fake.captured.tools.find((entry) => entry.name === name)!;
  await tool("task_create").handler({ taskId: "1", subject: "Agree the interface", description: "", owner: "builder" }, {});
  await tool("task_create").handler({ taskId: "2", subject: "Implement src/game.js", description: "", owner: "builder" }, {});
  await tool("task_update").handler({ taskId: "2", addBlockedBy: ["1"] }, {});

  const result = parse(await tool("send_handoff").handler(assignmentArgs, {}));
  // The sender learns the truth: journaled and queued, NOT delivered.
  expect(result).toMatchObject({ delivered: false, queued: true });
  expect(result.blockedBy).toEqual([expect.stringContaining("Agree the interface")]);

  const queued = h.repo.listQueuedDeliveries(created.agentSessionId).filter((row) => row.recipient === "builder");
  expect(queued).toHaveLength(1);
  return { h, agentSessionId: created.agentSessionId, deliveryId: queued[0]!.id };
}

describe("assignment holds", () => {
  it("holds while the blocker is open, and an unrelated ledger write does not release it", async () => {
    const { h, agentSessionId, deliveryId } = await heldAssignment();
    // A change to a DIFFERENT task fires onChange → release scan; the hold
    // must survive it (the old summary-derived taskId made this release).
    h.tasks.applyUpdate({ sdkSessionId: consoleTaskListId(agentSessionId), sdkTaskId: "2", patch: { subject: "Implement src/game.js (renamed)" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.repo.getDeliveryById(deliveryId)?.status).toBe("queued");
  });

  it("releases when the blocker completes", async () => {
    const { h, deliveryId, agentSessionId } = await heldAssignment();
    h.tasks.applyUpdate({ sdkSessionId: consoleTaskListId(agentSessionId), sdkTaskId: "1", patch: { status: "completed" } });
    await expect.poll(() => h.repo.getDeliveryById(deliveryId)?.status, { timeout: 5_000 }).not.toBe("queued");
  });

  it("survives a restart: boot() recomputes the hold from the task rows", async () => {
    const { h, deliveryId } = await heldAssignment();
    const h2 = restartHarness(h);
    h2.host.boot();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The blocker is still open, so the reboot must NOT leak the assignment.
    expect(h2.repo.getDeliveryById(deliveryId)?.status).toBe("queued");
    // And the recomputed hold still releases on the blocker completing.
    h2.tasks.applyUpdate({ sdkSessionId: consoleTaskListId((h2.repo.getDeliveryById(deliveryId)!).agentSessionId), sdkTaskId: "1", patch: { status: "completed" } });
    await expect.poll(() => h2.repo.getDeliveryById(deliveryId)?.status, { timeout: 5_000 }).not.toBe("queued");
  });

  it("the grace period expires on the sweep clock even when no task ever changes", async () => {
    const { h, deliveryId } = await heldAssignment({ assignmentBlockGraceMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // What the governance sweep runs on its interval — a mis-declared
    // dependency must never deadlock a run.
    h.host.releaseBlockedAssignments();
    await expect.poll(() => h.repo.getDeliveryById(deliveryId)?.status, { timeout: 5_000 }).not.toBe("queued");
  });
});
