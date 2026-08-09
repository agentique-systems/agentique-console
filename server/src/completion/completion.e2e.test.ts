/**
 * When a run is done, and who says so.
 *
 * The second test in this file is db-live-2 replayed exactly. That run's last
 * three events were:
 *
 *   23:58:27  final handoff → main
 *   23:58:30  "Lane Runner is done and verified."
 *   23:58:38  user_session.question.asked   ← still pending in that DB today
 *
 * and then nothing. The turn never settled, because `AskUserQuestion` awaits
 * its resolution forever; `busy()` stayed true; the spinner kept turning. The
 * run had not gone quiet, it had gone interrogative — and the operator had no
 * way to tell "done" from "still working" from "blocked on me".
 */
import { describe, expect, it, vi } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { interactions as interactionRows, runSummaries } from "../db/schema.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";

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
  const stopParticipant = vi.fn((_a: string, _p: string) => [{ processId: "task_serve", pid: 4242 }]);
  const h = makeDelegationHarness(
    async function* () {
      yield initMessage();
      yield successMessage();
    },
    { hostOverrides: { processes: { stopParticipant, stopSession: vi.fn(), closeAll: vi.fn() } as unknown as ProcessManager } },
  );
  return { h, stopParticipant };
}

async function runToFinal(h: ReturnType<typeof harness>["h"]) {
  const userSessionId = h.addUserSession();
  const created = h.host.createSession({
    userSessionId, title: "lane runner", mode: "execute",
    agents: [{ name: "check", profileId: "visual-reviewer", owns: [] }],
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
  it("proposes completion once, after a final, and reaps the run's processes", async () => {
    const { h, stopParticipant } = harness();
    const { userSessionId } = await runToFinal(h);
    await send(h).handler(FINAL, {});

    const proposed = await collectUntil(h.bus, (event) => event.type === "run.completion.proposed", 10_000);
    const event = proposed.find((row) => row.type === "run.completion.proposed")!;
    expect((event.payload as { sessionId: string }).sessionId).toBe(userSessionId);

    // The state the operator can actually see, and the one db-live-2 could not
    // express: the Console believes this is done and is waiting on them.
    expect(h.repo.getUserSession(userSessionId)?.runState).toBe("awaiting_signoff");
    // `status` is untouched — completion is not archival.
    expect(h.repo.getUserSession(userSessionId)?.status).toBe("open");

    // Reaped BEFORE the card renders, so the operator never reads a summary
    // while a dev server the run started is still bound to a port.
    expect(stopParticipant).toHaveBeenCalled();

    // Idempotent: a second final does not propose again.
    await send(h).handler(FINAL, {});
    await settle();
    expect(h.db.select().from(runSummaries).all()).toHaveLength(1);
  });

  it("does NOT propose while a question is pending — db-live-2 replayed", async () => {
    const { h } = harness();
    const { userSessionId } = await runToFinal(h);

    // The exact db-live-2 sequence: report done, then ask.
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

  it("does not propose without a final, however quiet the run gets", async () => {
    const { h } = harness();
    const { userSessionId } = await runToFinal(h);
    await settle();
    // Idle is not done. db-live-1 went idle having reported nothing at all.
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
    expect(h.repo.getUserSession(userSessionId)?.status).toBe("open");
    expect(h.repo.getAgentSession(agentSessionId)?.status).toBe("archived");
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
