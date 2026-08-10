/**
 * A `final` report may not precede its own unanswered questions.
 *
 * db-live-2, verbatim from the journal:
 *
 *   23:58:27  handoff_9e39c4… orchestrator → main   final · completed
 *   23:58:30  "Lane Runner is done and verified."   (to the operator)
 *   23:58:38  user_session.question.asked  int_71e4b2b4…
 *             "Lane Runner is done and verified. Two low-severity items are
 *              open… Want either addressed?"
 *
 * That question is `status='pending'` in that database today, and is the last
 * row ever written to it. The run declared itself done and THEN asked whether
 * the open items mattered — a post-hoc courtesy, not a decision gate, and the
 * operator's last sight of the run was a card that looked identical to
 * work-in-progress.
 *
 * The gate enforces only what the CONSOLE owns: it knows the question was
 * asked, that nobody but the operator can answer it, and that they have not.
 * Ledger state and running specialists deliberately stay caveats — blocking on
 * model-maintained facts is what produced db-live-1's 35-minute silence.
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

const finalArgs = {
  to: "main", category: "final" as const, status: "completed" as const, risk: "low" as const,
  action: "Build and verify Lane Runner",
  stateSummary: "All four units landed; check verified the running page in a real browser.",
  evidence: [], resultSummary: "Lane Runner is done and verified.", artifacts: [],
  uncertainty: [], nextAction: null, taskId: null, requestExpandedContext: false,
};

const ASK = {
  question: "The game auto-starts with no press-to-start. Want a start gate?",
  options: [{ label: "Leave as-is" }, { label: "Add a start gate" }],
  urgency: "blocking" as const,
  allowFreeText: true,
};

async function sessionWithOpenQuestion() {
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "lane runner", agents: [{ name: "check", profileId: "visual-reviewer", owns: [] }],
    briefing: handoff("verify the page"),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

  const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
  const asked = collectUntil(h.bus, (event) => event.type === "user_session.question.asked", 10_000);
  void ask.handler(ASK, {});
  await asked;

  const send = h.fake.captured.tools.find((t) => t.name === "send_handoff")!;
  return { h, userSessionId, agentSessionId: created.agentSessionId, send };
}

describe("final report gate", () => {
  it("withholds a final while a question this session asked is unanswered", async () => {
    const { h, agentSessionId, send } = await sessionWithOpenQuestion();
    const blocked = collectUntil(h.bus, (event) => event.type === "handoff.final.blocked", 10_000);

    const result = await send.handler(finalArgs, {});

    // A hold, NOT an error: an isError result feeds WATCHDOG_ERROR_STREAK and
    // a retry feeds WATCHDOG_IDENTICAL_CALLS — the Console must not punish the
    // seat for its own gate. Same doctrine as ask_operator and queued
    // assignments.
    expect(result.isError).not.toBe(true);
    const hold = JSON.parse((result.content[0] as { text: string }).text) as {
      delivered: boolean; withheld: boolean; guidance: string;
      blockers: { question: string; asker: string; ageMinutes: number }[];
    };
    expect(hold.delivered).toBe(false);
    expect(hold.withheld).toBe(true);
    // It must name the question, its asker and its age — a refusal the
    // coordinator cannot act on is just a different kind of silence.
    expect(hold.blockers[0]?.question).toContain("start gate");
    // The captured ask_operator belongs to the coordinator seat — the first
    // to spawn — so that is who the card is attributed to.
    expect(hold.blockers[0]?.asker).toBe("orchestrator");
    expect(hold.guidance).toMatch(/final report withheld/);
    expect(hold.guidance).toMatch(/asked \d+m ago/);
    expect(hold.guidance).toMatch(/do not re-send/i);
    expect(hold.guidance).toMatch(/milestone/);

    await blocked;
    // Nothing was journalled — a withheld final leaves no half-record.
    const userSessionId = h.repo.getAgentSession(agentSessionId)!.userSessionId;
    expect(h.repo.latestHandoff({ userSessionId, agentSessionId, participant: "main", sender: "orchestrator" })).toBeUndefined();
  });

  it("lets the final through once the operator answers, and tells main why it was late", async () => {
    const { h, userSessionId, agentSessionId, send } = await sessionWithOpenQuestion();
    await send.handler(finalArgs, {});   // withheld

    const row = h.db.select().from(interactionRows).all()[0]!;
    const cleared = collectUntil(
      h.bus,
      (event) => event.type === "agent_session.mailbox"
        && (event.payload as { recipient?: string }).recipient === "main"
        && (event.payload as { category?: string }).category === "milestone",
      10_000,
    );
    h.interactions.resolveFromApi(userSessionId, row.id, { answers: { [ASK.question]: ["Leave as-is"] } });

    // The gate must never produce silence: main is told the withheld report is
    // now unblocked, rather than being left wondering why nothing arrived.
    await cleared;

    const second = await send.handler(finalArgs, {});
    expect(second.isError).not.toBe(true);
    const record = h.repo.latestHandoff({ userSessionId, agentSessionId, participant: "main", sender: "orchestrator" });
    expect(record?.core.status).toBe("completed");
  });

  it("promotes a DEFERRED question to blocking when a final is attempted", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    h.host.createSession({
      userSessionId, title: "lane runner", agents: [{ name: "check", profileId: "visual-reviewer", owns: [] }],
      briefing: handoff("verify"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;
    await ask.handler({ ...ASK, urgency: "deferred" }, {});

    const send = h.fake.captured.tools.find((t) => t.name === "send_handoff")!;
    const result = await send.handler(finalArgs, {});
    // "Deferred" was a judgement that the answer could wait until later. A
    // final says there is no later. So the attempt promotes it and is
    // withheld — which is exactly the moment db-live-2 skipped past.
    expect(result.isError).not.toBe(true);
    const hold = JSON.parse((result.content[0] as { text: string }).text) as { withheld: boolean; guidance: string };
    expect(hold.withheld).toBe(true);
    expect(hold.guidance).toMatch(/no "later" left/);
    expect(h.db.select().from(interactionRows).all()[0]?.urgency).toBe("blocking");
  });

  it("leaves an open ledger task as a caveat, never a blocker", async () => {
    // The deliberate non-change. db-live-1's ledger orphaned at rotation, so a
    // blocking rule on ledger state made `final` structurally impossible and
    // the operator heard nothing for 35 minutes. Only console-owned facts
    // block.
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    h.host.createSession({
      userSessionId, title: "lane runner", agents: [{ name: "dev", profileId: "implementer", owns: ["src/a.ts"] }],
      briefing: handoff("build"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    const create = h.fake.captured.tools.find((t) => t.name === "task_create")!;
    await create.handler({ taskId: "1", subject: "never finished", description: "", owner: "dev" }, {});

    const send = h.fake.captured.tools.find((t) => t.name === "send_handoff")!;
    const result = await send.handler(finalArgs, {});
    expect(result.isError).not.toBe(true);
    const record = h.repo.latestHandoff({ userSessionId, participant: "main", sender: "orchestrator" });
    expect(record?.core.uncertainty.join(" ")).toMatch(/reported final with work outstanding/);
  });
});
