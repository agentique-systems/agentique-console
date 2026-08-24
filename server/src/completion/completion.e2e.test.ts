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

  it("does NOT propose while the operator has paused the system; resume re-arms it", async () => {
    const { h } = harness();
    const { userSessionId } = await runToFinal(h);
    h.app.system.pause({ mode: "soft" });
    await send(h).handler(FINAL, {});
    await settle();
    expect(h.db.select().from(runSummaries).all()).toHaveLength(0);
    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("active");
    h.app.system.resume();
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);
    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("awaiting_signoff");
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
describe("the requirement graph as completion oracle", () => {
  const DOC = "## Requirements\n- The page renders\n- Verification ran";

  function approveRequirements(h: ReturnType<typeof harness>["h"], userSessionId: string): void {
    const draftRow = h.app.requirements.propose(userSessionId, DOC, "initial");
    h.app.requirements.approve(draftRow.id, { document: DOC, edited: false });
  }

  // Review regression: a summary persisted before the requirements field
  // existed has no key at all — getSummary must normalize it to null so the
  // sign-off card renders pre-branch runs.
  it("getSummary serves a pre-branch summary (no requirements key) with requirements null", () => {
    const { h } = harness();
    const userSessionId = h.addUserSession();
    h.db.insert(runSummaries).values({
      id: "rs_legacy", userSessionId, seqFrom: 0, seqTo: 1, verdict: "completed",
      document: { headline: "an old run", deviations: [], uncertainty: [], justification: null } as never,
      status: "proposed", note: null, createdAt: "2026-01-01T00:00:00Z", resolvedAt: null,
    }).run();
    const served = h.completion.getSummary(userSessionId, "rs_legacy");
    expect(served.document.requirements).toBeNull();
    expect(served.document.headline).toBe("an old run");
  });

  it("holds the proposal and nudges with the OPEN requirement ids until a record against the current revision lands", async () => {
    const { h } = harness();
    const userSessionId = h.addUserSession();
    approveRequirements(h, userSessionId);
    const created = h.host.createSession({
      userSessionId, title: "lane runner", agents: [{ name: "check", profileId: "visual-reviewer", owns: [] }],
      briefing: draft("verify the page"),
    });
    void created;
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    await send(h).handler(FINAL, {});
    await settle();

    // No proposal — and the nudge names what is unverified, by id.
    expect(h.db.select().from(runSummaries).all()).toHaveLength(0);
    const nudge = h.fake.captured.prompts.find((text) => text.includes("no completion record against requirements rev 1"));
    expect(nudge).toBeDefined();
    expect(nudge).toContain("Open requirements: r1 (The page renders); r2 (Verification ran)");

    // Requirements verified with evidence, record against the CURRENT revision → proposes.
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm start" }], claimant: { kind: "seat", agentSessionId: "as-check", agent: "check", profileRole: "reviewer", profileTools: ["Read", "Glob", "Grep"] } });
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "artifact", ref: "artifact_screen" }], claimant: { kind: "seat", agentSessionId: "as-check", agent: "check", profileRole: "reviewer", profileTools: ["Read", "Glob", "Grep"] } });
    h.app.orchestrationState.recordCompletion(userSessionId, {
      criteria: [
        { requirement: "r1", statement: "The page renders", met: true, evidence: [{ kind: "command", ref: "npm start" }] },
        { requirement: "r2", statement: "Verification ran", met: true, evidence: [] },
      ],
      knownGaps: [], nonGoals: [], requirementsRevision: 1,
    });
    h.completion.schedule(userSessionId);
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);

    // The summary snapshots the graph: counts, outline, and requirement-keyed
    // justification — and the verdict is clean because everything satisfied.
    const summaryRow = h.db.select().from(runSummaries).all()[0]!;
    const served = h.completion.getSummary(userSessionId, summaryRow.id);
    expect(served.verdict).toBe("completed");
    expect(served.document.requirements).toMatchObject({ revision: 1, counts: { satisfied: 2, open: 0 } });
    expect(served.document.requirements?.outline).toContain("[✓] r1: The page renders");
    expect(served.document.justification?.criteria[0]).toMatchObject({ requirement: "r1", statement: "The page renders", met: true });
  });

  it("names verification gaps in the nudge and persists them with the summary — never gating", async () => {
    const { h } = harness();
    const userSessionId = h.addUserSession();
    const doc = "## Requirements\n- (verify: independent) The page renders\n- Verification ran";
    const draftRow = h.app.requirements.propose(userSessionId, doc, "initial");
    h.app.requirements.approve(draftRow.id, { document: doc, edited: false });

    // Main satisfies both itself BEFORE the run settles: r1 (verify:
    // independent) records self → a gap the one-shot nudge must name.
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm start" }], claimant: { kind: "main" } });
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "artifact", ref: "artifact_screen" }], claimant: { kind: "main" } });
    await runToFinalWith(h, userSessionId);
    h.completion.schedule(userSessionId);
    await settle();
    const nudge = h.fake.captured.prompts.find((text) => text.includes("no completion record against requirements rev 1"));
    expect(nudge).toBeDefined();
    expect(nudge).toContain("Satisfied below their declared verification: r1 (needs independent, claimed self)");

    // A completion record still proposes — the gap is advisory, never a gate —
    // and the summary carries it for the sign-off card.
    h.app.orchestrationState.recordCompletion(userSessionId, {
      criteria: [
        { requirement: "r1", statement: "The page renders", met: true, evidence: [{ kind: "command", ref: "npm start" }] },
        { requirement: "r2", statement: "Verification ran", met: true, evidence: [] },
      ],
      knownGaps: [], nonGoals: [], requirementsRevision: 1,
    });
    h.completion.schedule(userSessionId);
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);
    const summaryRow = h.db.select().from(runSummaries).all()[0]!;
    const served = h.completion.getSummary(userSessionId, summaryRow.id);
    expect(served.document.requirements?.verificationGaps).toMatchObject([
      { requirementId: "r1", expected: "independent", recorded: { verifiedBy: "self", actor: "main" } },
    ]);
  });

  it("a stale record (superseded revision) does not satisfy the oracle", async () => {
    const { h } = harness();
    const userSessionId = h.addUserSession();
    approveRequirements(h, userSessionId);
    await runToFinalWith(h, userSessionId);
    h.app.orchestrationState.recordCompletion(userSessionId, {
      criteria: [{ requirement: "r1", statement: "The page renders", met: true, evidence: [] }],
      knownGaps: [], nonGoals: [], requirementsRevision: 1,
    });
    // Amend: rev 2 governs; the rev-1 record is now a stale claim.
    const amended = "## Requirements\n- r1: The page renders\n- r2: Verification ran\n- It survives a refresh";
    const draftRow = h.app.requirements.propose(userSessionId, amended, "one more");
    h.app.requirements.approve(draftRow.id, { document: amended, edited: false });
    await send(h).handler(FINAL, {});
    await settle();
    expect(h.db.select().from(runSummaries).all()).toHaveLength(0);
  });

  it("holds the proposal while a change impact is open, nudges with the impact id, and proposes once reconciled", async () => {
    const { h } = harness();
    const userSessionId = h.addUserSession();
    approveRequirements(h, userSessionId);
    // Claims land, r2 depends on r1, then r1's claim is withdrawn: the
    // Console records the transitive impact — r2's prior evidence is suspect.
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm start" }], claimant: { kind: "main" } });
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "artifact", ref: "artifact_screen" }], claimant: { kind: "main" } });
    h.app.requirements.link({ userSessionId, fromId: "r2", kind: "depends_on", toId: "r1", actor: "main" });
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r1", to: "open",
      evidence: [], claimant: { kind: "main" }, note: "page regressed" });
    const [impact] = h.app.changeImpacts.listOpen(userSessionId);
    expect(impact!.outstanding.claims).toEqual(["r2"]);

    // The regressed work is redone and re-verified; r2's suspect evidence
    // still awaits judgment — quiet ledgers and a current completion record
    // must NOT be enough to reach sign-off over it.
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm start again" }], claimant: { kind: "main" } });
    await runToFinalWith(h, userSessionId);
    h.app.orchestrationState.recordCompletion(userSessionId, {
      criteria: [
        { requirement: "r1", statement: "The page renders", met: true, evidence: [{ kind: "command", ref: "npm start" }] },
        { requirement: "r2", statement: "Verification ran", met: true, evidence: [] },
      ],
      knownGaps: [], nonGoals: [], requirementsRevision: 1,
    });
    h.completion.schedule(userSessionId);
    await settle();
    expect(h.db.select().from(runSummaries).all()).toHaveLength(0);
    const nudge = h.fake.captured.prompts.find((text) => text.includes("change impact(s) remain unreconciled"));
    expect(nudge).toBeDefined();
    expect(nudge).toContain(impact!.id);
    expect(nudge).toContain("r2");

    // Judgment recorded → the same quiet run proposes.
    h.app.changeImpacts.reconcile({ userSessionId, impactId: impact!.id, actor: "operator",
      items: [{ kind: "claim", id: "r2", disposition: "stands", note: "verification did not exercise the regressed path" }] });
    h.completion.schedule(userSessionId);
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);
    expect(h.db.select().from(runSummaries).all()).toHaveLength(1);
  });

  it("holds the proposal while a broken workstream link's consumer is open; releasing it proposes", async () => {
    const { h } = harness();
    const userSessionId = h.addUserSession();
    // A producer/consumer pair: the producer is abandoned mid-run, so its
    // link breaks — a quiet, fully-reported run must NOT reach sign-off over
    // a stale producer/consumer relationship nobody has judged.
    const producer = h.host.createSession({
      userSessionId, title: "auth-core", agents: [{ name: "dev", profileId: "explorer" }],
      briefing: draft("build the token API"),
    });
    const consumer = h.host.createSession({
      userSessionId, title: "ui", agents: [{ name: "check", profileId: "visual-reviewer", owns: [] }],
      briefing: draft("verify the page"),
    });
    const link = h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: producer.agentSessionId, subject: "token API", createdBy: "main",
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    h.host.closeSession(producer.agentSessionId, "reprioritized");
    // The consumer session reports; the run is otherwise quiet and done.
    const finals = h.fake.captured.tools.filter((tool) => tool.name === "send_handoff");
    await finals[finals.length - 1]!.handler(FINAL, {});
    await settle();
    expect(h.db.select().from(runSummaries).all()).toHaveLength(0);
    const nudge = h.fake.captured.prompts.find((text) => text.includes("workstream dependency link(s) are broken"));
    expect(nudge).toBeDefined();
    expect(nudge).toContain(link.id);
    expect(nudge).toContain("token API");

    // Judgment recorded (no successor will produce it) → the same quiet run proposes.
    h.app.workstreams.release({ userSessionId, linkId: link.id, by: "main", note: "auth work moved into the ui session itself" });
    h.completion.schedule(userSessionId);
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);
    expect(h.db.select().from(runSummaries).all()).toHaveLength(1);
  });

  it("an infeasible root yields the infeasible verdict, not failed", async () => {
    const { h } = harness();
    const userSessionId = h.addUserSession();
    approveRequirements(h, userSessionId);
    await runToFinalWith(h, userSessionId);
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r1", to: "infeasible",
      evidence: [{ kind: "artifact", ref: "artifact_probe" }], claimant: { kind: "main" }, note: "renderer API retired" });
    h.app.requirements.reportStatus({ userSessionId, requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "command", ref: "checked" }], claimant: { kind: "main" } });
    h.app.orchestrationState.recordCompletion(userSessionId, {
      criteria: [{ requirement: "r1", statement: "The page renders", met: false, evidence: [] }],
      knownGaps: ["renderer API retired"], nonGoals: [], requirementsRevision: 1,
    });
    h.completion.schedule(userSessionId);
    await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);
    const summaryRow = h.db.select().from(runSummaries).all()[0]!;
    expect(h.completion.getSummary(userSessionId, summaryRow.id).verdict).toBe("infeasible");
  });

  async function runToFinalWith(h: ReturnType<typeof harness>["h"], userSessionId: string) {
    h.host.createSession({
      userSessionId, title: "lane runner", agents: [{ name: "check", profileId: "visual-reviewer", owns: [] }],
      briefing: draft("verify the page"),
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    await send(h).handler(FINAL, {});
    await settle();
  }
});
