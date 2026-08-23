/**
 * Chat words reach every open card WITH the words attached (hedged for agent
 * cards), the autonomy sweep converts stale deferred asks into provisional
 * decisions, and the boot revival path (which replays a stale answer into
 * MAIN's lane) must not swallow an agent's question.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { ArtifactStore } from "../events/artifact-store.ts";
import { EventBus } from "../events/bus.ts";
import { InteractionService } from "./interactions.ts";
import { InteractionStore } from "../db/stores/interaction-store.ts";
import { events, interactions as rows } from "../db/schema.ts";
import { projects, userSessions, workspaces } from "../db/schema.ts";
import { newId, nowIso } from "../ids.ts";

function harness() {
  const { db, sqlite } = openDb(":memory:");
  const bus = new EventBus(db, new ArtifactStore(db));
  const service = new InteractionService(new InteractionStore(db), bus);
  const workspaceId = newId("ws");
  db.insert(workspaces).values({ id: workspaceId, name: "w", rootPath: `/tmp/${workspaceId}`, metadata: {}, createdAt: nowIso(), updatedAt: nowIso() }).run();
  const userSessionId = newId("us");
  const projectId = newId("proj");
  db.insert(projects).values({ id: projectId, workspaceId, title: null, intentDocument: null, createdAt: nowIso() }).run();
  db.insert(userSessions).values({
    id: userSessionId, workspaceId, projectId, title: "t", mode: "execute", phase: "executing",
    lifecycle: "open", purpose: "work", subjectKey: null, sdkSessionId: null, sdkGeneration: 0,
    sdkTurnCount: 0, contextTokens: 0, memory: "", latestHandoffId: null,
    cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, createdAt: nowIso(), updatedAt: nowIso(),
  }).run();
  return { db, sqlite, bus, service, userSessionId };
}

const QUESTION = [{ question: "Ship r169 or hold for r160?", options: [{ label: "Ship" }, { label: "Hold" }] }];

describe("chat answers agent questions too, with the words attached", () => {
  // The old policy held agent cards ("chatting does not answer them") — a
  // live run's operator typed answers in chat three times, was refused three
  // times, and four questions aged 5–7.5 hours.
  it("resolves both a main-lane card and an agent's card", () => {
    const { db, service, userSessionId } = harness();
    const main = service.createOperatorQuestion({ userSessionId, questions: QUESTION });
    const seat = service.createOperatorQuestion({
      userSessionId, agentSessionId: "as_1", agent: "renderer", questions: QUESTION,
    });

    service.dismissPendingForChat(userSessionId, "actually, use whatever works");

    const all = db.select().from(rows).all();
    expect(all.find((row) => row.id === main.id)?.status).toBe("dismissed");
    expect(all.find((row) => row.id === seat.id)?.status).toBe("dismissed");
  });

  it("tells the operator their chat was delivered as the answer", () => {
    const { db, service, userSessionId } = harness();
    service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "renderer", questions: QUESTION });
    service.dismissPendingForChat(userSessionId, "hello");

    const notices = db.select().from(events).all()
      .filter((row) => row.type === "user_session.runtime.noted")
      .map((row) => String((row.payload as { detail?: string }).detail ?? ""));
    expect(notices.join(" ")).toMatch(/delivered to 1 agent question/);
  });

  it("resolves an agent's parked promise with the words, hedged", async () => {
    const { service, userSessionId } = harness();
    const seat = service.createOperatorQuestion({
      userSessionId, agentSessionId: "as_1", agent: "renderer", questions: QUESTION,
    });

    service.dismissPendingForChat(userSessionId, "ship r169");

    const resolved = await seat.resolution;
    expect(resolved).toMatchObject({ kind: "dismissed" });
    // Hedged: one chat message may address only some of several open cards.
    expect((resolved as { reason: string }).reason).toContain('"ship r169"');
    expect((resolved as { reason: string }).reason).toContain("if it addresses your question");
  });
});

describe("the autonomy sweep", () => {
  const age = (db: ReturnType<typeof harness>["db"], id: string, minutes: number) => {
    db.update(rows).set({ createdAt: new Date(Date.now() - minutes * 60_000).toISOString() }).where(eq(rows.id, id)).run();
  };
  const sweep = (service: InteractionService, over: Partial<Parameters<InteractionService["sweepStaleAsks"]>[0]> = {}) =>
    service.sweepStaleAsks({ deferredAutoProceedMs: 900_000, blockingAskEscalateMs: 900_000,
      autonomyOf: () => "standard", escalate: () => {}, ...over });

  it("a stale deferred ask with a recommendation auto-proceeds as a provisional decision", async () => {
    const { db, service, userSessionId } = harness();
    const seat = service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "verifier",
      questions: QUESTION, urgency: "deferred", recommendation: "Ship r169" });
    age(db, seat.id, 20);

    sweep(service);

    expect(db.select().from(rows).all().find((row) => row.id === seat.id)?.status).toBe("answered");
    const resolved = await seat.resolution;
    expect(resolved).toMatchObject({ kind: "dismissed" });
    expect((resolved as { reason: string }).reason).toContain("Ship r169");
    expect((resolved as { reason: string }).reason).toContain("provisional");
  });

  it("a fresh deferred ask and one without a recommendation are left alone", () => {
    const { db, service, userSessionId } = harness();
    const fresh = service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "a",
      questions: QUESTION, urgency: "deferred", recommendation: "do X" });
    const bare = service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "b",
      questions: QUESTION, urgency: "deferred" });
    age(db, bare.id, 20);

    sweep(service);

    const all = db.select().from(rows).all();
    expect(all.find((row) => row.id === fresh.id)?.status).toBe("pending");
    expect(all.find((row) => row.id === bare.id)?.status).toBe("pending");
  });

  it("a stale blocking ask escalates once, and never auto-proceeds in standard mode", () => {
    const { db, service, userSessionId } = harness();
    const seat = service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "architect",
      questions: QUESTION, urgency: "blocking", recommendation: "fix C4" });
    age(db, seat.id, 90);

    let escalations = 0;
    sweep(service, { escalate: () => { escalations += 1; } });
    sweep(service, { escalate: () => { escalations += 1; } });

    expect(escalations).toBe(1);
    expect(db.select().from(rows).all().find((row) => row.id === seat.id)?.status).toBe("pending");
  });

  it("in away mode a stale blocking ask WITH a recommendation auto-proceeds", () => {
    const { db, service, userSessionId } = harness();
    const seat = service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "architect",
      questions: QUESTION, urgency: "blocking", recommendation: "fix C4" });
    age(db, seat.id, 90);

    sweep(service, { autonomyOf: () => "away" });

    expect(db.select().from(rows).all().find((row) => row.id === seat.id)?.status).toBe("answered");
  });

  it("the operator can retroactively override an auto-proceeded decision", async () => {
    const { db, service, userSessionId } = harness();
    const seat = service.createOperatorQuestion({ userSessionId, agentSessionId: "as_1", agent: "verifier",
      questions: QUESTION, urgency: "deferred", recommendation: "Ship r169" });
    age(db, seat.id, 20);
    sweep(service);
    await seat.resolution;

    const overridden = service.resolveFromApi(userSessionId, seat.id,
      { answers: { "Ship r169 or hold for r160?": ["Hold"] } });
    expect(overridden.status).toBe("answered");
    // A second override attempt now conflicts — the human answer is final.
    expect(() => service.resolveFromApi(userSessionId, seat.id,
      { answers: { "Ship r169 or hold for r160?": ["Ship"] } })).toThrow(/already answered/);
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

