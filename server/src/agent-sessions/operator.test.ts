/**
 * The status matrix the operator surface derives: working / idle / reported /
 * archived, pinned cell by cell over the real composition root — a busy turn
 * vs one parked in `ask_operator`, queued deliveries by recipient, synthetic
 * vs agent-sent finals, and the unsettled-child hold on a reported parent.
 */
import { describe, expect, it } from "vitest";
import { interactions as interactionRows } from "../db/schema.ts";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const draft = (action: string, status: "pending" | "completed", data: Record<string, unknown> = {}) => ({
  core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
    uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false },
  extension: { kind: "generic" as const, data },
});

describe("session status derivation (operator surface)", () => {
  it("a busy turn is working; the same turn parked in ask_operator is not", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      // Hold the turn open until the test releases it.
      await gate;
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "status", agents: [{ name: "scout", profileId: "explorer" }], briefing: draft("investigate", "pending") });
    const row = () => h.repo.getAgentSession(created.agentSessionId)!;
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.started", 10_000);
    expect(h.host.statusOf(row())).toBe("working");

    const ask = h.fake.captured.tools.find((tool) => tool.name === "ask_operator")!;
    // The runtime note fires AFTER the wait is parked, so it is the safe cue.
    const noted = collectUntil(h.bus, (event) => event.type === "agent_session.runtime.noted"
      && String((event.payload as { detail?: string }).detail ?? "").startsWith("waiting on the operator"), 10_000);
    const question = "Ship it?";
    const call = ask.handler({ question, options: [{ label: "Yes" }, { label: "No" }], urgency: "blocking", allowFreeText: false }, {});
    await noted;
    // The turn is still open, but the agent is waiting on a human — not working.
    expect(h.host.statusOf(row())).toBe("idle");

    const card = h.db.select().from(interactionRows).all()[0]!;
    h.interactions.resolveFromApi(userSessionId, card.id, { answers: { [question]: ["Yes"] } });
    await call;
    // Answered: the same still-open turn counts as working again.
    expect(h.host.statusOf(row())).toBe("working");

    const settled = collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    release();
    await settled;
    expect(h.host.statusOf(row())).toBe("idle");
  });

  it("queued deliveries to an agent keep the session working; main's own mail does not", () => {
    const h = makeDelegationHarness(async function* () { yield initMessage(); yield successMessage(); });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "queued", agents: [{ name: "scout", profileId: "explorer" }] });
    const row = () => h.repo.getAgentSession(created.agentSessionId)!;
    expect(h.host.statusOf(row())).toBe("idle");

    // Journal rows minted directly, so they STAY queued — no delivery races.
    const queue = (sender: string, recipient: string, category: "assignment" | "final") => {
      const prepared = h.handoffs.prepare({ draft: draft(`${category} for ${recipient}`, category === "final" ? "completed" : "pending"),
        userSessionId, agentSessionId: created.agentSessionId, sender, recipient, profileId: null, generation: 0,
        trigger: category, parentHandoffId: null });
      return h.repo.appendHandoffMailbox({ sessionKind: "agent", sessionId: created.agentSessionId, userSessionId,
        agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: sender }, to: recipient, recipient,
        kind: "message", text: prepared.text, category, handoff: prepared.row, summary: prepared.summary });
    };

    const toAgent = queue("coordinator", "scout", "assignment");
    expect(h.host.statusOf(row())).toBe("working");
    h.repo.patchDelivery(toAgent.delivery.id, { status: "cancelled" });
    expect(h.host.statusOf(row())).toBe("idle");

    // A final queued TOWARD main is not "working" — but while unacknowledged
    // it is still an active delivery, which holds off "reported".
    const toMain = queue("coordinator", "main", "final");
    expect(h.host.statusOf(row())).toBe("idle");
    h.repo.patchDelivery(toMain.delivery.id, { status: "acknowledged" });
    expect(h.host.statusOf(row())).toBe("reported");
  });

  it("a console-synthesized final does not report; the agent's own final does; archived wins", () => {
    const h = makeDelegationHarness(async function* () { yield initMessage(); yield successMessage(); });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "final", agents: [{ name: "scout", profileId: "explorer" }] });
    const row = () => h.repo.getAgentSession(created.agentSessionId)!;

    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "main",
      handoff: draft("done, says the console", "completed", { consoleSynthesized: true }), category: "final" });
    expect(h.host.statusOf(row())).toBe("idle");

    h.host.post({ agentSessionId: created.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "main",
      handoff: draft("done", "completed"), category: "final" });
    expect(h.host.statusOf(row())).toBe("reported");

    h.repo.patchAgentSession(created.agentSessionId, { lifecycle: "archived" });
    expect(h.host.statusOf(row())).toBe("archived");
  });

  it("an open child holds a reported parent at idle until the child itself reports", async () => {
    const h = makeDelegationHarness(async function* () { yield initMessage(); yield successMessage(); });
    const userSessionId = h.addUserSession();
    const parent = h.host.createSession({ userSessionId, title: "parent", agents: [{ name: "scout", profileId: "explorer" }] });
    const parentRow = () => h.repo.getAgentSession(parent.agentSessionId)!;
    h.host.post({ agentSessionId: parent.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "main",
      handoff: draft("done", "completed"), category: "final" });
    expect(h.host.statusOf(parentRow())).toBe("reported");

    const child = h.host.createSession({ userSessionId, title: "child", agents: [{ name: "kid", profileId: "explorer" }],
      parent: { agentSessionId: parent.agentSessionId, controllerAgent: "coordinator" } });
    const childRow = () => h.repo.getAgentSession(child.agentSessionId)!;
    expect(h.host.statusOf(childRow())).toBe("idle");
    expect(h.host.statusOf(parentRow())).toBe("idle");

    const settled = collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled"
      && (event.payload as { agentSessionId?: string }).agentSessionId === parent.agentSessionId, 10_000);
    h.host.post({ agentSessionId: child.agentSessionId, speaker: { kind: "orchestrator", name: "coordinator" }, to: "main",
      handoff: draft("child done", "completed"), category: "final" });
    // The child settled the moment its boundary hop was acknowledged...
    expect(h.host.statusOf(childRow())).toBe("reported");
    // ...while its milestone is still queued into the parent's controller.
    expect(h.host.statusOf(parentRow())).toBe("working");
    await settled;
    expect(h.host.statusOf(parentRow())).toBe("reported");
  });
});
