/**
 * Workstream dependency links (portfolio/workstreams.ts): the durable
 * cross-session claim "this workstream cannot safely complete until that one
 * produces X", with status DERIVED from console-owned facts — never stored,
 * so it is true after any restart by construction. The invariant under test:
 * a producer that reports satisfies its consumers mechanically; a producer
 * that is abandoned leaves them VISIBLY broken, never silently satisfied.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { events as eventsTable } from "../db/schema.ts";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { makeDelegationHarness, restartHarness } from "../test-helpers.ts";

const draft = (action: string, status: "pending" | "in_progress" | "completed" = "pending") => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
    action, state: { summary: action, evidence: [] },
    result: { summary: status === "completed" ? action : null, artifacts: [] },
    uncertainty: [], nextAction: null, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

function harness() {
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
  const userSessionId = h.addUserSession();
  const make = (title: string) => h.host.createSession({
    userSessionId, title, agents: [{ name: "dev", profileId: "explorer" }],
  });
  const reportFinal = (agentSessionId: string) => h.host.post({
    agentSessionId, speaker: { kind: "agent", name: "coordinator" }, to: "main",
    handoff: draft("all delivered", "completed"), category: "final",
  });
  return { h, userSessionId, make, reportFinal };
}

describe("workstream dependency links (e2e, fake SDK)", () => {
  it("pending while the producer works, satisfied when it reports — and both sessions see the link", () => {
    const { h, userSessionId, make, reportFinal } = harness();
    const producer = make("auth-core");
    const consumer = make("ui");
    const wire = h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: producer.agentSessionId,
      subject: "token validation API", createdBy: "main",
    });
    expect(wire.status).toBe("pending");
    expect(h.app.workstreams.promptLines(consumer.agentSessionId).join("\n"))
      .toContain('depends on "auth-core"');
    expect(h.app.workstreams.promptLines(producer.agentSessionId).join("\n"))
      .toContain('"ui"');
    expect(h.app.workstreams.finalCaveats(consumer.agentSessionId).join("\n"))
      .toContain("pending: token validation API");

    reportFinal(producer.agentSessionId);
    const [after] = h.app.workstreams.list(userSessionId);
    expect(after!.status).toBe("satisfied");
    expect(h.app.workstreams.finalCaveats(consumer.agentSessionId)).toEqual([]);

    // Satisfaction is a projection, not a ratchet: the producer picking work
    // back up (a later non-terminal report) regresses the link to pending.
    h.host.post({ agentSessionId: producer.agentSessionId, speaker: { kind: "agent", name: "coordinator" },
      to: "main", handoff: draft("reopened for a fix", "in_progress"), category: "update" });
    expect(h.app.workstreams.list(userSessionId)[0]!.status).toBe("pending");
  });

  it("re-declaring the same live link is idempotent; validation teaches the boundary", () => {
    const { h, userSessionId, make } = harness();
    const producer = make("auth-core");
    const consumer = make("ui");
    const link = () => h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: producer.agentSessionId, subject: "token API", createdBy: "main",
    });
    const first = link();
    expect(link().id).toBe(first.id);
    expect(h.db.select().from(eventsTable).where(eq(eventsTable.type, "workstream.link.created")).all()).toHaveLength(1);
    expect(() => h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: consumer.agentSessionId, subject: "itself", createdBy: "main",
    })).toThrow(/cannot depend on itself/);
    expect(() => h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: "as_nowhere", subject: "ghost", createdBy: "main",
    })).toThrow(/no agent session/);
  });

  it("a producer that already reported yields a link born satisfied; an abandoned one is rejected", () => {
    const { h, userSessionId, make, reportFinal } = harness();
    const done = make("already-done");
    reportFinal(done.agentSessionId);
    const consumer = make("late-consumer");
    const wire = h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: done.agentSessionId, subject: "schema file", createdBy: "main",
    });
    expect(wire.status).toBe("satisfied");

    const doomed = make("doomed");
    h.host.closeSession(doomed.agentSessionId, "reprioritized");
    expect(() => h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: doomed.agentSessionId, subject: "never", createdBy: "main",
    })).toThrow(/archived without reporting/);
  });

  it("abandoning a producer leaves consumers VISIBLY broken — event, wake note, and the open hold", async () => {
    const { h, userSessionId, make } = harness();
    const producer = make("auth-core");
    const consumer = make("ui");
    const wire = h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: producer.agentSessionId, subject: "token API", createdBy: "main",
    });
    h.host.closeSession(producer.agentSessionId, "budget cut");
    expect(h.app.workstreams.list(userSessionId)[0]!.status).toBe("broken");
    expect(h.app.workstreams.brokenOpen(userSessionId).map((row) => row.id)).toEqual([wire.id]);
    const broken = h.db.select().from(eventsTable).where(eq(eventsTable.type, "workstream.link.broken")).all();
    expect(broken).toHaveLength(1);
    expect(h.app.workstreams.finalCaveats(consumer.agentSessionId).join("\n")).toContain("broken");
    // Main is woken with the fact and the remedy, not left to notice.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.fake.captured.prompts.some((text) =>
      text.includes("Workstream dependency producer abandoned") && text.includes("token API"))).toBe(true);

    // Releasing with a judgment note clears the hold and keeps the history.
    const released = h.app.workstreams.release({ userSessionId, linkId: wire.id, by: "main", note: "successor session will re-own auth" });
    expect(released.status).toBe("released");
    expect(h.app.workstreams.brokenOpen(userSessionId)).toEqual([]);
    // Releasing again is a no-op that preserves the recorded judgment.
    const again = h.app.workstreams.release({ userSessionId, linkId: wire.id, by: "main", note: "different words" });
    expect(again.releaseNote).toBe("successor session will re-own auth");
  });

  it("archiving the CONSUMER clears the broken hold mechanically — nobody is consuming any more", () => {
    const { h, userSessionId, make } = harness();
    const producer = make("auth-core");
    const consumer = make("ui");
    h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: producer.agentSessionId, subject: "token API", createdBy: "main",
    });
    h.host.closeSession(producer.agentSessionId, "budget cut");
    expect(h.app.workstreams.brokenOpen(userSessionId)).toHaveLength(1);
    h.host.closeSession(consumer.agentSessionId, "moot without auth");
    expect(h.app.workstreams.brokenOpen(userSessionId)).toEqual([]);
  });

  it("restart preserves link truth: derived statuses and the release path survive a reboot", async () => {
    const { h, userSessionId, make, reportFinal } = harness();
    const satisfiedProducer = make("done-before");
    const brokenProducer = make("gone");
    const consumer = make("ui");
    reportFinal(satisfiedProducer.agentSessionId);
    const okLink = h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: satisfiedProducer.agentSessionId, subject: "schema", createdBy: "main",
    });
    const badLink = h.app.workstreams.link({
      userSessionId, consumerAgentSessionId: consumer.agentSessionId,
      producerAgentSessionId: brokenProducer.agentSessionId, subject: "renderer", createdBy: "main",
    });
    h.host.closeSession(brokenProducer.agentSessionId, "abandoned");

    const restarted = await restartHarness(h);
    const byId = new Map(restarted.app.workstreams.list(userSessionId).map((row) => [row.id, row.status]));
    expect(byId.get(okLink.id)).toBe("satisfied");
    expect(byId.get(badLink.id)).toBe("broken");
    expect(restarted.app.workstreams.brokenOpen(userSessionId).map((row) => row.id)).toEqual([badLink.id]);
    const released = restarted.app.workstreams.release({ userSessionId, linkId: badLink.id, by: "main", note: "no successor planned" });
    expect(released.status).toBe("released");
  });
});
