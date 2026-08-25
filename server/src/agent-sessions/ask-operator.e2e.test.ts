/**
 * `ask_operator` — an agent reaching the human directly, with no model hop
 * between that could judge, rewrite, or drop the question.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { interactions as interactionRows } from "../db/schema.ts";

const handoff = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

const parse = (result: { content: { type: string; text?: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;

const ASK = {
  question: "Ship three.js r169, or hold for the r160 you specified?",
  header: "Version",
  options: [
    { label: "Ship r169", description: "Verified against all 12 APIs game.js uses." },
    { label: "Hold for r160", description: "The version you named; needs network that is currently failing." },
  ],
  recommendation: "Ship r169 — the APIs are verified and r160 is unreachable.",
  urgency: "blocking" as const,
  allowFreeText: true,
};

async function session() {
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "lane runner", agents: [{ name: "renderer", profileId: "implementer", owns: ["src/game.js"] }],
    briefing: handoff("build the game"),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
  return { h, userSessionId, agentSessionId: created.agentSessionId };
}

describe("ask_operator", () => {
  it("is registered for a SPECIALIST, not just the coordinator", async () => {
    const { h } = await session();
    // The fake flattens every agent's tools into one list; both agents' copies
    // must be there.
    const asks = h.fake.captured.tools.filter((tool) => tool.name === "ask_operator");
    expect(asks.length).toBeGreaterThanOrEqual(1);
    expect(h.fake.captured.tools.some((tool) => tool.name === "request_decision")).toBe(false);
  });

  it("puts a specialist's question in front of the operator and hands back their answer", async () => {
    const { h, userSessionId, agentSessionId } = await session();
    const tool = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;

    const asked = collectUntil(h.bus, (event) => event.type === "user_session.question.asked", 10_000);
    const call = tool.handler(ASK, {});
    await asked;

    // The card is attributed to the agent, carries its recommendation, and is
    // blocking.
    const row = h.db.select().from(interactionRows).all()[0]!;
    expect(row.agentSessionId).toBe(agentSessionId);
    expect(row.participant).toBe("coordinator");
    expect(row.urgency).toBe("blocking");
    expect(row.allowFreeText).toBe(true);
    const questions = (row.payload as { questions: { recommendation?: string }[] }).questions;
    expect(questions[0]?.recommendation).toBe(ASK.recommendation);

    h.interactions.resolveFromApi(userSessionId, row.id, {
      answers: { [ASK.question]: ["Hold for r160"] },
      note: "vendor it once the network is back",
    });

    const result = parse(await call);
    expect(result.resolved).toBe(true);
    expect(result.answers).toEqual({ [ASK.question]: ["Hold for r160"] });
    expect(result.note).toBe("vendor it once the network is back");
  });

  it("returns the open card instead of minting a second one for the same question", async () => {
    const { h } = await session();
    const tool = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    const asked = collectUntil(h.bus, (event) => event.type === "user_session.question.asked", 10_000);
    void tool.handler(ASK, {});
    await asked;

    // Same question, different whitespace and case — a re-ask, not a new one.
    const again = parse(await tool.handler({ ...ASK, question: `  ${ASK.question.toUpperCase()}  ` }, {}));
    expect(again.deduped).toBe(true);
    expect(h.db.select().from(interactionRows).all()).toHaveLength(1);
    // Crucially it is NOT an error result: ten of those in a row trip
    // WATCHDOG_ERROR_STREAK and kill the agent's turn.
    expect(again.resolved).toBeUndefined();
  });

  it("a deferred ask returns immediately and does not park the agent", async () => {
    const { h } = await session();
    const tool = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    const result = parse(await tool.handler({ ...ASK, urgency: "deferred" }, {}));
    expect(result.queued).toBe(true);
    expect(result.urgency).toBe("deferred");
    expect(result.note).toMatch(/keep working; do not poll/);
  });

  it("hands a deferred answer to the asking agent in its next prompt", async () => {
    const { h, userSessionId, agentSessionId } = await session();
    const tool = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    const result = parse(await tool.handler({ ...ASK, urgency: "deferred" }, {}));
    expect(result.queued).toBe(true);

    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, {
      answers: { [ASK.question]: ["Hold for r160"] },
    });

    // The next delivery to that agent must carry the answer — the promise a
    // deferred ask makes ("their answer will be handed to you at your next
    // delivery") is only true if this path exists.
    h.host.post({
      agentSessionId,
      speaker: { kind: "orchestrator", name: "main" },
      to: "coordinator", handoff: handoff("carry on"), category: "assignment",
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.delivery.updated"
        && (event.payload as { recipient?: string }).recipient === "coordinator"
        && (event.payload as { status?: string }).status === "delivered",
      10_000,
    );

    const prompt = h.fake.captured.prompts.find((text) => text.includes("The operator answered your question(s)"));
    expect(prompt).toBeDefined();
    expect(prompt).toContain("Hold for r160");
    expect(prompt).toMatch(/Authoritative — act on these and do not ask again/);

    // Flushed exactly once: the agent has been told, so the next prompt is clean.
    expect(h.interactions.listAnsweredUnflushed(agentSessionId, "coordinator")).toHaveLength(0);
  });

  it("asks from two AgentSessions sharing an issueKey become ONE issue; one answer resolves both", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    h.host.createSession({
      userSessionId, title: "auth stream", agents: [{ name: "auth-dev", profileId: "implementer", owns: ["src/auth"] }],
      briefing: handoff("build auth"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    const authAsk = h.fake.captured.tools.filter((t) => t.name === "ask_operator").at(-1)!;
    h.host.createSession({
      userSessionId, title: "api stream", agents: [{ name: "api-dev", profileId: "implementer", owns: ["src/api"] }],
      briefing: handoff("build api"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    const apiAsk = h.fake.captured.tools.filter((t) => t.name === "ask_operator").at(-1)!;

    const askedOnce = collectUntil(h.bus, (event) => event.type === "user_session.question.asked", 10_000);
    const authCall = authAsk.handler({ ...ASK, question: "Should authentication use organization-wide SSO?", issueKey: "auth-identity" }, {});
    await askedOnce;
    const askedTwice = collectUntil(h.bus, (event) => event.type === "decision_issue.ask_attached", 10_000);
    const apiCall = apiAsk.handler({ ...ASK, question: "Can this flow assume enterprise identity?", issueKey: "auth-identity" }, {});
    await askedTwice;

    // One durable project-level issue, two participating asks from two sessions.
    const rows = h.db.select().from(interactionRows).all();
    expect(rows).toHaveLength(2);
    const issueIds = new Set(rows.map((row) => row.issueId));
    expect(issueIds.size).toBe(1);
    expect(new Set(rows.map((row) => row.agentSessionId)).size).toBe(2);

    // One operator answer, on either card, resolves the issue AND both parked askers.
    const first = rows.find((row) => (row.payload as { questions: { question: string }[] }).questions[0]!.question.includes("SSO"))!;
    h.interactions.resolveFromApi(userSessionId, first.id, {
      answers: {}, freeText: { "Should authentication use organization-wide SSO?": "Yes — SSO everywhere" },
    });
    const authResult = parse(await authCall);
    expect(authResult.resolved).toBe(true);
    const apiResult = parse(await apiCall);
    expect(apiResult.resolved).toBe(true);
    expect(JSON.stringify(apiResult)).toContain("SSO everywhere");
    const issue = h.app.decisionIssues.get(userSessionId, [...issueIds][0]! as string);
    expect(issue.status).toBe("resolved");
    expect(issue.resolution?.answer).toContain("SSO everywhere");
  });

  it("never reports a dismissal as a tool error", async () => {
    const { h, userSessionId } = await session();
    const tool = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    const asked = collectUntil(h.bus, (event) => event.type === "user_session.question.asked", 10_000);
    const call = tool.handler(ASK, {});
    await asked;

    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.detach(row.id, "the operator stepped away");

    const settled = await call;
    // Not `isError`. The operator's silence is not the agent's mistake, and
    // WATCHDOG_ERROR_STREAK (10) does not distinguish between the two.
    expect(settled.isError).not.toBe(true);
    const result = parse(settled);
    expect(result.resolved).toBe(false);
    expect(result.reason).toMatch(/stepped away/);
    // The row stays answerable — detach releases the wait, not the question.
    expect(h.db.select().from(interactionRows).all()[0]?.status).toBe("pending");
    expect(h.db.select().from(interactionRows).all()[0]?.detached).toBe(true);
  });
});
