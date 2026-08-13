/**
 * Who a card belongs to determines what may happen to it. An agent has no
 * access to the operator's chat lane — only main does — so chat must not
 * dismiss agent cards, and the boot revival path (which replays a stale answer
 * into MAIN's lane) must not swallow an agent's question.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { ArtifactStore } from "../events/artifact-store.ts";
import { EventBus } from "../events/bus.ts";
import { InteractionService } from "./interactions.ts";
import { InteractionStore } from "../db/stores/interaction-store.ts";
import { events, interactions as rows } from "../db/schema.ts";
import { userSessions, workspaces } from "../db/schema.ts";
import { newId, nowIso } from "../ids.ts";

function harness() {
  const { db, sqlite } = openDb(":memory:");
  const bus = new EventBus(db, new ArtifactStore(db));
  const service = new InteractionService(new InteractionStore(db), bus);
  const workspaceId = newId("ws");
  db.insert(workspaces).values({ id: workspaceId, name: "w", rootPath: `/tmp/${workspaceId}`, metadata: {}, createdAt: nowIso(), updatedAt: nowIso() }).run();
  const userSessionId = newId("us");
  db.insert(userSessions).values({
    id: userSessionId, workspaceId, title: "t", mode: "execute", phase: "executing",
    lifecycle: "open", purpose: "work", subjectKey: null, sdkSessionId: null, sdkGeneration: 0,
    sdkTurnCount: 0, contextTokens: 0, memory: "", latestHandoffId: null,
    cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, createdAt: nowIso(), updatedAt: nowIso(),
  }).run();
  return { db, sqlite, bus, service, userSessionId };
}

const QUESTION = [{ question: "Ship r169 or hold for r160?", options: [{ label: "Ship" }, { label: "Hold" }] }];

describe("chat does not answer an agent's question", () => {
  it("dismisses a main-lane card but leaves an agent's card open", () => {
    const { db, service, userSessionId } = harness();
    const main = service.createOperatorQuestion({ userSessionId, questions: QUESTION });
    const seat = service.createOperatorQuestion({
      userSessionId, agentSessionId: "as_1", agent: "renderer", questions: QUESTION,
    });

    service.dismissPendingForChat(userSessionId, "actually, use whatever works");

    const all = db.select().from(rows).all();
    expect(all.find((row) => row.id === main.id)?.status).toBe("dismissed");
    // Still open: the operator's chat went to main, and the agent cannot read it.
    expect(all.find((row) => row.id === seat.id)?.status).toBe("pending");
  });

  it("tells the operator that agent questions are still waiting", () => {
    const { db, service, userSessionId } = harness();
    service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "renderer", questions: QUESTION });
    service.dismissPendingForChat(userSessionId, "hello");

    const notices = db.select().from(events).all()
      .filter((row) => row.type === "user_session.runtime.noted")
      .map((row) => String((row.payload as { detail?: string }).detail ?? ""));
    // Silently keeping the card open would be its own trap: the operator needs
    // to know their chat did not answer it.
    expect(notices.join(" ")).toMatch(/stay open — chatting does not answer them/);
  });

  it("resolves a main-lane card's parked promise but not an agent's", async () => {
    const { service, userSessionId } = harness();
    const main = service.createOperatorQuestion({ userSessionId, questions: QUESTION });
    const seat = service.createOperatorQuestion({
      userSessionId, agentSessionId: "as_1", agent: "renderer", questions: QUESTION,
    });
    let seatSettled = false;
    void seat.resolution.then(() => { seatSettled = true; });

    service.dismissPendingForChat(userSessionId, "hello");

    await expect(main.resolution).resolves.toMatchObject({ kind: "dismissed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seatSettled).toBe(false);
  });
});

describe("a chat reply IS the answer", () => {
  it("the dismissal's deny reason carries the operator's words", async () => {
    const { service, userSessionId } = harness();
    const main = service.createOperatorQuestion({ userSessionId, questions: QUESTION });

    service.dismissPendingForChat(userSessionId, "use three.js");

    // The model reads THIS when it decides its next action — a forward
    // reference ("read their next message") lost a live run's answer.
    const resolved = await main.resolution;
    expect(resolved).toMatchObject({ kind: "dismissed" });
    expect((resolved as { reason: string }).reason).toContain('"use three.js"');
    expect((resolved as { reason: string }).reason).toContain("do not proceed on defaults");
  });

  it("stores the chat text on the row and records an operator decision", () => {
    const { db, service, userSessionId } = harness();
    const main = service.createOperatorQuestion({ userSessionId, questions: QUESTION });

    service.dismissPendingForChat(userSessionId, "use three.js");

    const row = db.select().from(rows).all().find((entry) => entry.id === main.id);
    expect((row?.response as { chatText?: string })?.chatText).toBe("use three.js");
    const decisions = db.select().from(events).all().filter((entry) => entry.type === "operator.decision.recorded");
    expect(decisions).toHaveLength(1);
    expect((decisions[0]?.payload as { answer?: string }).answer).toBe("(answered in chat) use three.js");
  });

  it("a chat-rejected plan records a decision too (event parity with the card)", () => {
    const { db, service, userSessionId } = harness();
    service.createPlanApproval(userSessionId, "the plan", undefined, undefined);

    service.dismissPendingForChat(userSessionId, "no, do it with vite");

    const decisions = db.select().from(events).all().filter((entry) => entry.type === "operator.decision.recorded");
    expect(decisions).toHaveLength(1);
    expect((decisions[0]?.payload as { answer?: string }).answer).toContain("Requested changes to the plan (in chat): no, do it with vite");
  });
});

describe("boot splits by asker", () => {
  it("stales main-lane rows and detaches agent rows", () => {
    const { db, service, userSessionId } = harness();
    const main = service.createOperatorQuestion({ userSessionId, questions: QUESTION });
    const seat = service.createOperatorQuestion({
      userSessionId, agentSessionId: "as_1", agent: "renderer", questions: QUESTION,
    });

    service.expirePendingOnBoot();

    const all = db.select().from(rows).all();
    const mainRow = all.find((row) => row.id === main.id)!;
    const seatRow = all.find((row) => row.id === seat.id)!;
    // Main's answer replays as a resumed turn, so `stale` is right for it.
    expect(mainRow.status).toBe("stale");
    // An agent is woken by a DELIVERY, not by lane revival — so its question is
    // still genuinely open, and answering it still reaches somebody.
    expect(seatRow.status).toBe("pending");
    expect(seatRow.detached).toBe(true);
  });
});

describe("answers owed to the asking agent", () => {
  it("lists an answered question as unflushed until the agent is told", () => {
    const { service, userSessionId } = harness();
    const seat = service.createOperatorQuestion({
      userSessionId, agentSessionId: "as_1", agent: "renderer", questions: QUESTION,
      urgency: "deferred",
    });
    expect(service.listAnsweredUnflushed("as_1", "renderer")).toHaveLength(0);

    service.resolveFromApi(userSessionId, seat.id, { answers: { [QUESTION[0]!.question]: ["Hold"] } });

    // Owed to the agent: this is the delivery,
    // where a deferred ask promised "their answer will reach you" and nothing
    // ever did.
    const owed = service.listAnsweredUnflushed("as_1", "renderer");
    expect(owed).toHaveLength(1);
    service.markFlushed(owed.map((row) => row.id));
    expect(service.listAnsweredUnflushed("as_1", "renderer")).toHaveLength(0);
  });

  it("scopes unflushed answers to the agent that asked", () => {
    const { service, userSessionId } = harness();
    const a = service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "renderer", questions: QUESTION });
    service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "page", questions: QUESTION });
    service.resolveFromApi(userSessionId, a.id, { answers: {} });

    expect(service.listAnsweredUnflushed("as_1", "renderer")).toHaveLength(1);
    expect(service.listAnsweredUnflushed("as_1", "page")).toHaveLength(0);
  });
});

describe("free text", () => {
  it("is rejected unless the card allowed it", () => {
    const { service, userSessionId } = harness();
    const card = service.createOperatorQuestion({ userSessionId, questions: QUESTION, allowFreeText: false });
    expect(() => service.resolveFromApi(userSessionId, card.id, {
      answers: {}, freeText: { [QUESTION[0]!.question]: "neither — vendor it" },
    })).toThrow(/does not accept a free-text answer/);
  });

  it("is carried through to the asker when allowed", async () => {
    const { service, userSessionId } = harness();
    const card = service.createOperatorQuestion({ userSessionId, questions: QUESTION, allowFreeText: true });
    service.resolveFromApi(userSessionId, card.id, {
      answers: {}, freeText: { [QUESTION[0]!.question]: "neither — vendor it" },
    });
    await expect(card.resolution).resolves.toMatchObject({
      kind: "answers", freeText: { [QUESTION[0]!.question]: "neither — vendor it" },
    });
  });
});

