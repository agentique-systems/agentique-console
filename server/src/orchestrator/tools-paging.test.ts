/** Paged retrieval on the model-facing big-payload tools. */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

const envelope = (action: string, status: "pending" | "completed", category: string) =>
  JSON.stringify({ handoff: handoff(action, status), category, checkpointReadiness: "stable" });

async function runFlow() {
  let coordinatorTurns = 0;
  const h = makeDelegationHarness(async function* (options) {
    const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
    const coordinator = append.includes("sole coordinator");
    yield initMessage(coordinator ? `coord-${coordinatorTurns}` : "scout-1");
    if (coordinator) {
      coordinatorTurns += 1;
      yield coordinatorTurns === 1
        ? sendHandoffUse("send-1", "scout", { action: "Report a very long observation about the workspace state.", status: "pending", category: "assignment" })
        : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "Session done", status: "completed", category: "final" });
      yield successMessage();
    } else {
      yield sendHandoffUse("scout-close", "orchestrator", { action: `observation: ${"x".repeat(2_000)}`, status: "completed", category: "milestone" });
      yield successMessage();
    }
  });
  const userSessionId = h.addUserSession();
  const done = collectUntil(h.bus, (event) => event.type === "flow.result", 10_000);
  const created = h.host.createSession({ userSessionId, title: "paging", mode: "execute",
    agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe", "pending") });
  await done;
  return { h, created, userSessionId };
}

const parse = (result: { content: { type: string; text?: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown> & { transcript?: { content: string; nextCursor: string | null; previousCursor: string | null } };

describe("paged tool retrieval", () => {
  it("read_agent_session pages the transcript and keeps metadata whole", async () => {
    const { h, created } = await runFlow();
    const tool = h.fake.captured.tools.find((t) => t.name === "read_agent_session");
    expect(tool).toBeDefined();
    const first = parse(await tool!.handler({ agentSessionId: created.agentSessionId, maxBytes: 256 }, {}));
    expect(first.messageCount).toBeGreaterThan(0);
    expect(first.transcript).toBeDefined();
    expect(Buffer.byteLength(first.transcript!.content)).toBeLessThanOrEqual(256);
    expect(first.transcript!.previousCursor).not.toBeNull();
    const earlier = parse(await tool!.handler({ agentSessionId: created.agentSessionId, cursor: first.transcript!.previousCursor, maxBytes: 256 }, {}));
    expect(Buffer.byteLength(earlier.transcript!.content)).toBeLessThanOrEqual(256);
  });

  it("read_handoff pages a lossless section with cursors", async () => {
    const { h, created } = await runFlow();
    const record = h.repo.latestHandoff({ userSessionId: h.repo.getAgentSession(created.agentSessionId)!.userSessionId, agentSessionId: created.agentSessionId });
    expect(record).toBeDefined();
    const tool = h.fake.captured.tools.find((t) => t.name === "read_handoff");
    expect(tool).toBeDefined();
    const window = parse(await tool!.handler({ handoffId: record!.id, section: "core", maxBytes: 128 }, {}));
    expect(Buffer.byteLength((window as unknown as { content: string }).content)).toBeLessThanOrEqual(128);
    expect((window as unknown as { nextCursor: string | null }).nextCursor).not.toBeNull();
  });
});
