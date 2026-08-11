/**
 * The task ledger is console-owned.
 *
 * The native Task* tools are scoped to a provider session, and `#rotateNow`
 * nulls `sdkSessionId` — so in db-live-1 the coordinator created four tasks,
 * rotated once, found its own ledger empty seven minutes later, and never
 * touched the tools again. Two forked task sets survived, neither describing
 * reality, and the stale rows then jammed the final-report gate.
 *
 * Console tasks are keyed on a synthetic id derived from the AGENT SESSION, so
 * rotation cannot orphan them and every seat reads the same list.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { consoleTaskListId } from "../tasks/service.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

const parse = (result: { content: { type: string; text?: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? "null") as { tasks?: { sdkTaskId: string; status: string; subject: string }[] };

describe("console-owned task ledger (fake SDK)", () => {
  it("keys the ledger to the agent session so rotation cannot orphan it", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "ledger", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("investigate", "pending") });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    const create = h.fake.captured.tools.find((t) => t.name === "task_create");
    const update = h.fake.captured.tools.find((t) => t.name === "task_update");
    const list = h.fake.captured.tools.find((t) => t.name === "task_list");
    expect(create && update && list).toBeTruthy();

    // `owner` is required now: it names the seat that will DO the work, not the
    // one writing the row. Defaulting it to the writer put "orchestrator" on
    // every row of db-live-2's coordinator ledger.
    await create!.handler({ taskId: "1", subject: "Agree the module interface", description: "before either writes code", owner: "scout" }, {});
    await create!.handler({ taskId: "2", subject: "Implement src/game.js", description: "", owner: "scout" }, {});
    await update!.handler({ taskId: "1", status: "completed", owner: "orchestrator" }, {});

    // The key is derived from the agent session, never from a provider session.
    expect(consoleTaskListId(created.agentSessionId)).toContain(created.agentSessionId);
    const rows = parse(await list!.handler({}, {})).tasks ?? [];
    expect(rows).toHaveLength(2);

    // Simulate what used to destroy the ledger: the seat's provider session is
    // replaced. The console rows are untouched, and the list still reads back.
    h.repo.patchParticipant(created.agentSessionId, "orchestrator", { sdkSessionId: null, generation: 1 });
    const after = parse(await list!.handler({}, {}));
    expect(after.tasks).toHaveLength(2);
    expect(after.tasks?.find((task) => task.sdkTaskId === "1")?.status).toBe("completed");
    expect(after.tasks?.find((task) => task.sdkTaskId === "2")?.status).toBe("pending");
  });
});
