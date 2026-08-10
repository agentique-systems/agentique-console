/**
 * `send_handoff` — the disciplined transfer path.
 *
 * Its parameters ARE the handoff core, so the provider validates the shape and
 * the seat never hand-serializes JSON. That removes the failure class that
 * destroyed the db-live-1 run's best output: `check` finished a real review,
 * could not escape a 4KB body into a JSON string parameter, retried 15 times,
 * tripped the watchdog, and its findings reached nobody.
 *
 * It is also console-carried rather than peer-carried, so it has no ref
 * handshake to lose across a rotation.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

const parse = (result: { content: { type: string; text?: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;

describe("send_handoff (fake SDK)", () => {
  it("is registered for every seat and carries a typed transfer end to end", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "typed", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe", "pending") });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    // The fake flattens every seat's MCP tools into one list; the coordinator
    // spawns first, so this instance is bound to that seat.
    const tool = h.fake.captured.tools.find((t) => t.name === "send_handoff");
    expect(tool).toBeDefined();

    // A body that is hostile to hand-serialization: newlines, quotes,
    // backslashes. Through typed fields none of it needs escaping — which is
    // the entire reason this tool exists.
    const summary = 'Collision tunneling at src/game.js:191.\nObstacles step 2.4 units through a 2.0-unit window.\nSaid "not observed" — derived from constants, path C:\\tmp\\x.';
    const result = parse(await tool!.handler({
      to: "scout", category: "assignment", status: "in_progress", risk: "medium",
      action: "Verify the merged build",
      stateSummary: summary,
      evidence: [{ kind: "file", ref: "src/game.js" }],
      resultSummary: "One medium defect found.",
      artifacts: [], uncertainty: ["Gameplay untested — no keyboard primitive"],
      nextAction: "Fix D1 before shipping", taskId: null, requestExpandedContext: false,
    }, {}));

    expect(result).toMatchObject({ delivered: true, to: "scout", category: "assignment" });
    const record = h.repo.latestHandoff({ userSessionId, agentSessionId: created.agentSessionId, sender: "orchestrator" });
    // Byte-for-byte: newlines, quotes and backslashes all survived intact.
    expect(record?.core.state.summary).toBe(summary);
    expect(record?.core.status).toBe("in_progress");
    expect(record?.core.uncertainty).toEqual(["Gameplay untested — no keyboard primitive"]);
    expect(record?.core.state.evidence).toEqual([{ kind: "file", ref: "src/game.js" }]);
    // The server owns the extension kind, not the model.
    expect(record?.extension.kind).toBe("coordination");
  });

  it("rejects an unknown recipient without inventing a destination", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    h.host.createSession({ userSessionId, title: "typed", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe", "pending") });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    const tool = h.fake.captured.tools.find((t) => t.name === "send_handoff");
    // Surfaced as a tool ERROR the seat can read and act on, not as a throw
    // escaping the handler. The in-process MCP server's behaviour on a
    // throwing handler is not something the route check — or the final gate,
    // which shares this path — should be betting on.
    const result = await tool!.handler({
      to: "nobody", category: "update", status: "in_progress", risk: "low", action: "x",
      stateSummary: "y", evidence: [], resultSummary: null, artifacts: [], uncertainty: [],
      nextAction: null, taskId: null, requestExpandedContext: false,
    }, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/route .* is not allowed/);
  });
});
