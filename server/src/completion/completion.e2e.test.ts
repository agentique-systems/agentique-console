/** When a run is done, and who says so. */
import { describe, expect, it, vi } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { interactions as interactionRows, runSummaries } from "../db/schema.ts";

const draft = (action: string, status: "pending" | "completed" = "pending") => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
    action, state: { summary: action, evidence: [] },
    result: { summary: status === "completed" ? action : null, artifacts: [] },
    uncertainty: [], nextAction: null, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

const FINAL = {
  to: "main", category: "final" as const, status: "completed" as const, risk: "low" as const,
  action: "Build and verify Lane Runner",
  stateSummary: "All four units landed and check verified the running page.",
  evidence: [], resultSummary: "Lane Runner is done and verified.", artifacts: [],
  uncertainty: [], nextAction: null, taskId: null, requestExpandedContext: false,
};

function harness() {
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
  return { h };
}

async function runToFinal(h: ReturnType<typeof harness>["h"]) {
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "lane runner", agents: [{ name: "check", profileId: "visual-reviewer", owns: [] }],
    briefing: draft("verify the page"),
  });
  await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
  return { userSessionId, agentSessionId: created.agentSessionId };
}

/** Longer than the harness's 25ms quiet window, short enough to be free. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

const send = (h: ReturnType<typeof harness>["h"]) =>
  h.fake.captured.tools.find((tool) => tool.name === "send_handoff")!;

describe("run completion", () => {
  it("proposes completion once, after a final, and releases the run's seats", async () => {
    const { h } = harness();
    const { userSessionId } = await runToFinal(h);
    await send(h).handler(FINAL, {});

    const proposed = await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);
    const event = proposed.find((row) => row.type === "run.completion.proposed")!;
    expect((event.payload as { userSessionId: string }).userSessionId).toBe(userSessionId);

    // The state the operator can actually see: the Console believes this is
    // done and is waiting on them.
    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("awaiting_signoff");
    // `status` is untouched — completion is not archival.
    expect(h.repo.getUserSession(userSessionId)?.lifecycle).toBe("open");

    // Seats are released BEFORE the card renders, so the operator never reads
    // a summary while a dev server one of them started still holds a port.
    // Closing the lane closes the CLI subprocess, and everything the agent
    // started is a child of it.
    expect((event.payload as { reaped: { seats: number } }).reaped.seats).toBeGreaterThan(0);

    // Idempotent: a second final does not propose again.
    await send(h).handler(FINAL, {});
    await settle();
    expect(h.db.select().from(runSummaries).all()).toHaveLength(1);

    // The full document is servable behind the card's scalars — the
    // justification/deviations/uncertainty LIST the stats payload omits.
    const summaryRow = h.db.select().from(runSummaries).all()[0]!;
    const served = h.completion.getSummary(userSessionId, summaryRow.id);
    expect(served.id).toBe(summaryRow.id);
    expect(served.status).toBe("proposed");
    expect(served.document.headline).toBeTruthy();
    expect(Array.isArray(served.document.uncertainty)).toBe(true);
    // justification is null here (no record_completion ran) — a VISIBLE
    // omission the card renders, not an absent field.
    expect(served.document.justification).toBeNull();
    // A foreign session cannot read it.
    expect(() => h.completion.getSummary("us_someone_else", summaryRow.id)).toThrow(/no run summary/);
  });

  it("does NOT propose while a question is pending", async () => {
    const { h } = harness();
    const { userSessionId } = await runToFinal(h);

    // Report done, then ask.
    await send(h).handler(FINAL, {});
    const ask = h.fake.captured.tools.find((tool) => tool.name === "ask_operator")!;
    await ask.handler({
      question: "Two low-severity items are open. Want either addressed?",
      options: [{ label: "Leave as-is" }, { label: "Fix them" }],
      urgency: "deferred", allowFreeText: true,
    }, {});

    // A pending question means the run is waiting on the operator, not
    // finished. No card, and no `completed`.
    await settle();
    expect(h.completion.isComplete(userSessionId)).toBe(false);
    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("active");

    // Answering it is what finishes the run.
    const row = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, row.id, {
      answers: { "Two low-severity items are open. Want either addressed?": ["Leave as-is"] },
    });
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);
    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("awaiting_signoff");
  });

  /**
   * The 2026-08-12 live run: the reporting agent sent its ACCEPT verdict to
   * main with a terminal status but the wrong category (it omitted the
   * parameter, and the schema defaulted it to `update`). Main never woke, no
   * card appeared, and the run sat `active` forever while three other
   * predicates believed the session had reported. What a report IS is the
   * Console's call.
   */
  it("treats a terminal-status report to main as final whatever category it carries", async () => {
    const { h } = harness();
    const { userSessionId, agentSessionId } = await runToFinal(h);

    const promoted = collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);
    await send(h).handler({ ...FINAL, category: "update" }, {});
    await promoted;

    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("awaiting_signoff");
    // Journaled as what it is, and the near-miss is on the record.
    expect(h.repo.latestHandoff({ userSessionId, agentSessionId, recipient: "main" })?.trigger).toBe("final");
  });

  it("closes the operator loop when a run goes quiet without any final", async () => {
    const { h } = harness();
    const { userSessionId, agentSessionId } = await runToFinal(h);

    // A seat reports its work to the coordinator, which then goes quiet
    // without ever addressing main — the shape that used to end in silence.
    const closed = collectUntil(h.bus, (event) => event.type === "agent_session.closeout.forced", 10_000);
    h.host.post({ agentSessionId, speaker: { kind: "agent", name: "check" }, to: "coordinator",
      handoff: draft("page verified, one defect open", "completed"), category: "final" });
    await closed;

    const toMain = h.repo.latestHandoff({ userSessionId, agentSessionId, recipient: "main" });
    expect(toMain?.core.state.summary).toContain("page verified, one defect open");
    // Told, but not signed off: a Console-assembled note is not a final report.
    expect(h.completion.isComplete(userSessionId)).toBe(false);
  });

  it("does not propose without a final, however quiet the run gets", async () => {
    const { h } = harness();
    const { userSessionId } = await runToFinal(h);
    await settle();
    // Idle is not done: a run can go idle having reported nothing at all.
    expect(h.completion.isComplete(userSessionId)).toBe(false);
  });

  it("never proposes for a session that delegated nothing", async () => {
    const { h } = harness();
    const userSessionId = h.addUserSession();
    h.completion.schedule(userSessionId);
    await settle();
    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("active");
  });

  it("accept completes the run and archives its agent sessions", async () => {
    const { h } = harness();
    const { userSessionId, agentSessionId } = await runToFinal(h);
    await send(h).handler(FINAL, {});
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);

    h.completion.resolve(userSessionId, "accept");

    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("completed");
    // Still open: a completed run reads "done" in the sidebar, not "hidden".
    expect(h.repo.getUserSession(userSessionId)?.lifecycle).toBe("open");
    expect(h.repo.getAgentSession(agentSessionId)?.lifecycle).toBe("archived");
    expect(h.db.select().from(runSummaries).all()[0]?.status).toBe("accepted");
  });

  it("request-changes reopens the run and can propose again", async () => {
    const { h } = harness();
    const { userSessionId } = await runToFinal(h);
    await send(h).handler(FINAL, {});
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);

    h.completion.resolve(userSessionId, "changes", "the HUD is misaligned");

    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("active");
    expect(h.db.select().from(runSummaries).all()[0]?.status).toBe("changes_requested");
    // The note reaches the orchestrator as a real operator message, so a live
    // lane is steered rather than being told nothing.
    const messages = h.repo.listMessages("user", userSessionId);
    expect(messages.some((row) => row.speakerKind === "operator" && row.text.includes("HUD"))).toBe(true);
    // And the run can complete again — #armed was cleared.
    expect(h.completion.evaluate(userSessionId)).toBe(false); // still active, no new final yet
  });

  it("409s a sign-off on a run that is not awaiting one", async () => {
    const { h } = harness();
    const { userSessionId } = await runToFinal(h);
    expect(() => h.completion.resolve(userSessionId, "accept")).toThrow(/not awaiting sign-off/);
  });

  it("treats chat during sign-off as a change request", async () => {
    const { h } = harness();
    const { userSessionId } = await runToFinal(h);
    await send(h).handler(FINAL, {});
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);

    // Otherwise the operator types "actually add X", the orchestrator answers,
    // and the card sits there still claiming the run is done.
    h.runner.postOperatorMessage(userSessionId, "actually, add a start gate");

    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("active");
    expect(h.db.select().from(runSummaries).all()[0]?.status).toBe("changes_requested");
  });
});
