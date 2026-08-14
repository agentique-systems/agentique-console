import { describe, expect, it } from "vitest";
import {
  deltaMessage,
  errorMessage,
  initMessage,
  permissionContext,
  reasoningDeltaMessage,
  successMessage,
  textMessage,
  toolResultMessage,
  toolUseMessage,
} from "../sdk/fake.ts";
import { collectUntil, makeHarness } from "../test-helpers.ts";

const settled = (e: { type: string }): boolean =>
  e.type === "user_session.turn.settled";

describe("OrchestratorRunner", () => {
  it("runs a full streamed turn: message events, deltas, resume persistence", async () => {
    const h = makeHarness(async function* () {
      yield initMessage("sdk-sess-1");
      yield reasoningDeltaMessage("thinking about it");
      yield deltaMessage("Hello ");
      yield deltaMessage("operator");
      yield textMessage("Hello operator");
      yield successMessage(undefined, { session_id: "sdk-sess-1" });
    });
    const sessionId = h.addUserSession();

    const collected = collectUntil(h.bus, settled);
    const receipt = h.runner.postOperatorMessage(sessionId, "hi there");
    expect(receipt.seq).toBe(1);

    const events = await collected;
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "user_session.message.appended", // operator
      "user_session.turn.started",
      "agent_session.activity.changed", // thinking
      "stream.reasoning",
      "agent_session.activity.changed", // responding
      "stream.delta",
      "stream.delta",
      "user_session.message.appended", // orchestrator
      "usage.recorded",
      "agent_session.activity.changed", // idle
      "user_session.turn.settled",
    ]);

    const orchestratorMsg = events.filter(
      (e) => e.type === "user_session.message.appended",
    )[1];
    expect(orchestratorMsg?.payload).toMatchObject({
      message: {
        seq: 2,
        speaker: { kind: "orchestrator", name: "orchestrator" },
        text: "Hello operator",
      },
    });

    const settledEvent = events.at(-1);
    expect(settledEvent?.payload).toMatchObject({
      status: "completed",
      queuedJobs: 0,
    });

    expect(h.repo.getUserSession(sessionId)?.sdkSessionId).toBe("sdk-sess-1");
    expect(h.fake.captured.prompts[0]).toBe("hi there");
    expect(h.fake.captured.options[0]?.permissionMode).toBe("default");
  });

  it("broadcasts provider liveness so a slow turn never looks hung", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield { type: "system", subtype: "status", status: "requesting" };
      yield {
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 5,
        retry_delay_ms: 30_000,
        error_status: 429,
      };
      yield textMessage("finally");
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const collected = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "go");
    const events = await collected;

    const details = events
      .filter((e) => e.type === "agent_session.activity.changed")
      .map((e) => (e.payload as { detail?: string }).detail)
      .filter((detail) => detail !== undefined);
    expect(details).toEqual([
      "requesting…",
      "rate limited · retry 1/5 · in 30s",
    ]);

    // The note is cleared once real output arrives — a stale note reads as truth.
    const afterText = events
      .slice(
        events.findIndex(
          (e) =>
            e.type === "user_session.message.appended" &&
            (e.payload as { message: { text: string } }).message.text ===
              "finally",
        ),
      )
      .filter((e) => e.type === "agent_session.activity.changed");
    expect(
      afterText.every((e) => (e.payload as { detail?: string }).detail === undefined),
    ).toBe(true);
  });

  it("persists tool call/result events with capped payloads", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield toolUseMessage("tu_1", "Read", { file_path: "/tmp/a" });
      yield toolResultMessage("tu_1", "contents");
      yield textMessage("done");
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const collected = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "read something");
    const events = await collected;

    const call = events.find((e) => e.type === "user_session.tool.called");
    const result = events.find((e) => e.type === "user_session.tool.completed");
    expect(call?.payload).toMatchObject({
      callId: "tu_1",
      name: "Read",
      input: { file_path: "/tmp/a" },
    });
    expect(result?.payload).toMatchObject({ callId: "tu_1", output: "contents" });
  });

  it("marks the turn errored on an error result", async () => {
    const h = makeHarness(async function* () {
      yield initMessage();
      yield errorMessage("error_max_turns", { num_turns: 80 });
    });
    const sessionId = h.addUserSession();
    const collected = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "go");
    const events = await collected;
    expect(events.at(-1)?.payload).toMatchObject({
      status: "error",
      errorMessage:
        "The agent stopped after reaching the maximum number of turns (80).",
    });
  });

  it("serializes queued operator messages into separate turns", async () => {
    let calls = 0;
    const h = makeHarness(async function* () {
      calls += 1;
      const n = calls;
      yield initMessage(`sess-${n}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield textMessage(`reply ${n}`);
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    h.runner.postOperatorMessage(sessionId, "first");
    h.runner.postOperatorMessage(sessionId, "second");

    const events = await collectUntil(
      h.bus,
      (e) =>
        e.type === "user_session.turn.settled" &&
        (e.payload as { queuedJobs: number }).queuedJobs === 0 &&
        calls === 2,
    );
    const startSeqs = events
      .map((e, i) => ({ type: e.type, i }))
      .filter((x) => x.type === "user_session.turn.started")
      .map((x) => x.i);
    const settleSeqs = events
      .map((e, i) => ({ type: e.type, i }))
      .filter((x) => x.type === "user_session.turn.settled")
      .map((x) => x.i);
    expect(startSeqs).toHaveLength(2);
    // Second turn starts only after the first settles.
    expect(settleSeqs[0]).toBeLessThan(startSeqs[1] ?? -1);
    // One persistent lane serves both turns; the resume id tracks the stream.
    expect(h.fake.captured.options).toHaveLength(1);
    expect(h.repo.getUserSession(sessionId)?.sdkSessionId).toBe("sess-2");
  });

  it("routes AskUserQuestion through an interaction and back", async () => {
    const h = makeHarness(async function* (options) {
      yield initMessage();
      const result = await options.canUseTool?.(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Which database?",
              options: [{ label: "SQLite" }, { label: "Postgres" }],
            },
          ],
        },
        permissionContext(),
      );
      if (result?.behavior === "allow") {
        const answers = (result.updatedInput as { answers: Record<string, string> })
          .answers;
        yield textMessage(`You chose ${answers["Which database?"]}`);
      } else {
        yield textMessage("No answer.");
      }
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const collected = collectUntil(h.bus, settled);

    h.runner.postOperatorMessage(sessionId, "set up storage");
    await collectUntil(
      h.bus,
      (e) => e.type === "user_session.question.asked",
    );
    const pending = h.interactions.listPending(sessionId);
    expect(pending).toHaveLength(1);
    h.interactions.resolveFromApi(sessionId, pending[0]!.id, {
      answers: { "Which database?": ["SQLite"] },
    });

    const events = await collected;
    const answered = events.find(
      (e) => e.type === "user_session.question.answered",
    );
    expect(answered?.payload).toMatchObject({
      answers: { "Which database?": ["SQLite"] },
    });
    const reply = events
      .filter((e) => e.type === "user_session.message.appended")
      .at(-1);
    expect(reply?.payload).toMatchObject({
      message: { text: "You chose SQLite" },
    });
  });

  it("dismisses a pending question when the operator chats instead", async () => {
    const h = makeHarness(async function* (options) {
      yield initMessage();
      const result = await options.canUseTool?.(
        "AskUserQuestion",
        { questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
        permissionContext(),
      );
      yield textMessage(
        result?.behavior === "deny" ? `denied: ${result.message}` : "answered",
      );
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const collected = collectUntil(h.bus, settled);

    h.runner.postOperatorMessage(sessionId, "start");
    await collectUntil(h.bus, (e) => e.type === "user_session.question.asked");
    h.runner.postOperatorMessage(sessionId, "actually just do it");

    const events = await collected;
    const answered = events.find(
      (e) => e.type === "user_session.question.answered",
    );
    expect(answered?.payload).toMatchObject({ dismissed: true });
    const denyReply = events
      .filter((e) => e.type === "user_session.message.appended")
      .find((e) =>
        (e.payload as { message: { text: string } }).message.text.startsWith(
          "denied:",
        ),
      );
    expect(denyReply).toBeDefined();
    // The deny itself carries the operator's words — the model must not have
    // to correlate a contentless bounce with a later chat turn (a live run
    // proceeded on defaults exactly because of that gap).
    expect((denyReply?.payload as { message: { text: string } }).message.text)
      .toContain('"actually just do it"');
  });

  it("free-text answers reach the model merged with any picked labels", async () => {
    const h = makeHarness(async function* (options) {
      yield initMessage();
      const result = await options.canUseTool?.(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Which renderer?",
              options: [{ label: "ASCII" }, { label: "Canvas" }],
            },
          ],
        },
        permissionContext(),
      );
      if (result?.behavior === "allow") {
        const answers = (result.updatedInput as { answers: Record<string, string> }).answers;
        yield textMessage(`Renderer: ${answers["Which renderer?"]}`);
      } else {
        yield textMessage("No answer.");
      }
      yield successMessage();
    });
    const sessionId = h.addUserSession();
    const collected = collectUntil(h.bus, settled);

    h.runner.postOperatorMessage(sessionId, "build the game");
    await collectUntil(h.bus, (e) => e.type === "user_session.question.asked");
    const pending = h.interactions.listPending(sessionId);
    // Main-lane cards accept free text now; the operator's own words outrank
    // the offered options.
    expect(pending[0]?.allowFreeText).toBe(true);
    h.interactions.resolveFromApi(sessionId, pending[0]!.id, {
      answers: {},
      freeText: { "Which renderer?": "use three.js" },
    });

    const events = await collected;
    const reply = events
      .filter((e) => e.type === "user_session.message.appended")
      .at(-1);
    expect(reply?.payload).toMatchObject({
      message: { text: "Renderer: use three.js" },
    });
  });

  it("gates plan_execute sessions behind ExitPlanMode approval", async () => {
    const h = makeHarness(async function* (options) {
      yield initMessage();
      if (options.permissionMode === "plan") {
        yield textMessage("Here is my plan: do the thing.");
        const result = await options.canUseTool?.(
          "ExitPlanMode",
          {},
          permissionContext(),
        );
        yield textMessage(
          result?.behavior === "allow" ? "Executing now." : "Revising.",
        );
      }
      yield successMessage();
    });
    const sessionId = h.addUserSession("plan_execute");
    const collected = collectUntil(h.bus, settled);

    h.runner.postOperatorMessage(sessionId, "build me a thing");
    const proposed = await collectUntil(
      h.bus,
      (e) => e.type === "user_session.plan.proposed",
    );
    // Plan text falls back to the turn's last assistant message (D9).
    expect(proposed.at(-1)?.payload).toMatchObject({
      plan: "Here is my plan: do the thing.",
    });

    const pending = h.interactions.listPending(sessionId);
    h.interactions.resolveFromApi(sessionId, pending[0]!.id, {
      decision: "approve",
    });

    const events = await collected;
    expect(
      events.find((e) => e.type === "user_session.plan.resolved")?.payload,
    ).toMatchObject({ approved: true });
    expect(h.repo.getUserSession(sessionId)?.phase).toBe("executing");
    expect(h.fake.captured.options[0]?.permissionMode).toBe("plan");
    // The approved plan IS the governing spec, LINKED to the card that
    // approved it — the lineage the schema always promised.
    const approvedSpec = h.app.specs.latestApproved(sessionId);
    expect(approvedSpec?.interactionId).toBe(pending[0]!.id);
  });

  it("interrupt settles the turn aborted and the lane survives for the next", async () => {
    let calls = 0;
    const h = makeHarness(async function* () {
      calls += 1;
      yield initMessage(`sess-${calls}`);
      if (calls === 1) {
        // A slow scripted turn: the interrupt races the pending pull.
        yield deltaMessage("working…");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      yield textMessage(`reply ${calls}`);
      yield successMessage();
    });
    const sessionId = h.addUserSession();

    const firstSettled = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "long job");
    await collectUntil(h.bus, (e) => e.type === "stream.delta");
    h.runner.interrupt(sessionId);
    const first = await firstSettled;
    expect(first.at(-1)?.payload).toMatchObject({ status: "aborted" });

    // The same lane serves the next turn — no respawn, resume id intact.
    // collectUntil replays from seq 1, so count settles rather than calls.
    let settles = 0;
    const secondSettled = collectUntil(
      h.bus,
      (e) => settled(e) && ++settles === 2,
    );
    h.runner.postOperatorMessage(sessionId, "again");
    const second = await secondSettled;
    expect(second.at(-1)?.payload).toMatchObject({ status: "completed" });
    expect(h.fake.captured.options).toHaveLength(1);
    await h.runner.closeAll();
  });

  it("a dead lane settles the open turn, notices, and respawns on the next job", async () => {
    let calls = 0;
    const h = makeHarness(async function* () {
      calls += 1;
      yield initMessage(`sess-${calls}`);
      if (calls === 1) throw new Error("CLI exploded");
      yield textMessage("recovered");
      yield successMessage();
    });
    const sessionId = h.addUserSession();

    const firstSettled = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "boom");
    const first = await firstSettled;
    expect(first.at(-1)?.payload).toMatchObject({
      status: "error",
      errorMessage: "CLI exploded",
    });
    // The death notice lands after the settle; collectUntil replays it.
    const noticed = await collectUntil(
      h.bus,
      (e) =>
        e.type === "user_session.message.appended" &&
        (e.payload as { message: { kind: string } }).message.kind === "notice",
    );
    expect(
      (noticed.at(-1)?.payload as { message: { text: string } }).message.text,
    ).toContain("session process died");

    // Next job spawns a fresh query with the persisted resume id.
    let settles = 0;
    const secondSettled = collectUntil(
      h.bus,
      (e) => settled(e) && ++settles === 2,
    );
    h.runner.postOperatorMessage(sessionId, "try again");
    const second = await secondSettled;
    expect(second.at(-1)?.payload).toMatchObject({ status: "completed" });
    expect(h.fake.captured.options).toHaveLength(2);
    expect(h.fake.captured.options[1]?.resume).toBe("sess-1");
  });

  it("a mid-turn message steers the live turn instead of queueing behind it", async () => {
    let calls = 0;
    const h = makeHarness(async function* () {
      calls += 1;
      yield initMessage(`sess-${calls}`);
      if (calls === 1) {
        yield deltaMessage("working…");
        // Hold the turn open long enough for the steer to land.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      yield textMessage(`reply ${calls}`);
      yield successMessage();
    });
    const sessionId = h.addUserSession();

    h.runner.postOperatorMessage(sessionId, "start the job");
    await collectUntil(h.bus, (e) => e.type === "stream.delta");
    // Mid-turn: steer, don't queue.
    h.runner.postOperatorMessage(sessionId, "actually, use the other approach");

    let settles = 0;
    const events = await collectUntil(
      h.bus,
      (e) => settled(e) && ++settles === 2,
    );
    // The steer reached the stream as its own input (no new drain job), and
    // the follow-up turn caught the CLI's answer to it.
    expect(h.fake.captured.prompts).toEqual([
      "start the job",
      "actually, use the other approach",
    ]);
    const started = events.filter((e) => e.type === "user_session.turn.started");
    expect(started).toHaveLength(2);
    expect(started[1]?.payload).toMatchObject({ trigger: "operator" });
    expect(events.at(-1)?.payload).toMatchObject({ status: "completed" });
    expect(h.fake.captured.options).toHaveLength(1);
    // The steered operator message is stamped human.
    expect(h.fake.captured.inputs[1]?.origin).toEqual({ kind: "human" });
  });

  it("closeSession shuts the lane down; the next message reopens with resume", async () => {
    let calls = 0;
    const h = makeHarness(async function* () {
      calls += 1;
      yield initMessage(`sess-${calls}`);
      yield textMessage(`reply ${calls}`);
      yield successMessage();
    });
    const sessionId = h.addUserSession();

    const firstSettled = collectUntil(h.bus, settled);
    h.runner.postOperatorMessage(sessionId, "hello");
    await firstSettled;
    await h.runner.closeSession(sessionId);
    expect(h.fake.captured.closed).toBe(true);

    let settles = 0;
    const secondSettled = collectUntil(
      h.bus,
      (e) => settled(e) && ++settles === 2,
    );
    h.runner.postOperatorMessage(sessionId, "back again");
    const second = await secondSettled;
    expect(second.at(-1)?.payload).toMatchObject({ status: "completed" });
    expect(h.fake.captured.options).toHaveLength(2);
    expect(h.fake.captured.options[1]?.resume).toBe("sess-1");
  });
});
