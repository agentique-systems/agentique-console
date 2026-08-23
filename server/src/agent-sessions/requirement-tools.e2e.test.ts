/**
 * Seat-side requirement tools, end to end: a session commissioned against
 * requirement ids gets the delegated block in its deliveries and scoped
 * report/decompose tools; out-of-subtree acts are refused naming the
 * delegated roots; a child session's sub-scope must be a subset of its
 * parent's; a delegation-less session's prompts carry no empty block.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { interactions as interactionRows } from "../db/schema.ts";

const briefing = (action: string) => ({
  core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false },
  extension: { kind: "generic" as const, data: {} },
});

const DOC = `## Requirements
- Auth works end to end
  - Login issues a session token
- \`npm run verify\` passes
`;

/** Approve the fixture graph: r1 (parent), r2 (leaf under r1), r3 (top leaf). */
function approveRequirements(h: ReturnType<typeof makeDelegationHarness>, userSessionId: string): void {
  const draft = h.app.requirements.propose(userSessionId, DOC, "initial");
  h.app.requirements.approve(draft.id, { document: DOC, edited: false });
}

describe("seat requirement tools (fake SDK)", () => {
  it("a commissioned session reports within its sub-scope; the delivery renders the delegated block", async () => {
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "coordinator") {
        coordinatorTurns += 1;
        if (coordinatorTurns === 1) {
          // Within the sub-scope (r2 sits under the delegated r1)… The stale
          // `verifiedBy` arg is passed on purpose: the tier is console-derived
          // now, and a model still sending the old field must be ignored.
          yield toolUseMessage("rep-ok", "mcp__console_agent__report_requirement", {
            requirementId: "r2", status: "satisfied",
            evidence: [{ kind: "command", ref: "curl /login" }], verifiedBy: "independent" });
          // …outside it (r3 was never delegated) — refused, named.
          yield toolUseMessage("rep-out", "mcp__console_agent__report_requirement", {
            requirementId: "r3", status: "satisfied",
            evidence: [{ kind: "command", ref: "npm run verify" }] });
          // …and refine below the delegated node, visible on the next delivery.
          yield toolUseMessage("dec-ok", "mcp__console_agent__decompose_requirement", {
            parentId: "r2", children: [{ statement: "Token refresh rotates" }] });
          yield sendHandoffUse("assign-1", "scout", { action: "verify refresh", status: "pending", category: "assignment" });
        } else {
          yield sendHandoffUse("final-1", "main", { action: "auth done", status: "completed", category: "final" });
        }
      } else {
        yield sendHandoffUse("s-1", "coordinator", { action: "refresh verified", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    approveRequirements(h, userSessionId);
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    const created = h.host.createSession({
      userSessionId, title: "auth work", agents: [{ name: "scout", profileId: "explorer" }],
      briefing: briefing("make auth work"), requirements: ["r1"],
    });
    await done;

    // The delegation was journaled at creation, before the briefing.
    const delegated = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'requirement.delegated'").all()
      .map((row) => JSON.parse(String((row as { payload: string }).payload)));
    expect(delegated[0]).toMatchObject({ agentSessionId: created.agentSessionId, requirementIds: ["r1"], source: "commission" });

    // The in-scope report landed with evidence and actor attribution.
    const r2 = h.app.requirements.derive(userSessionId).find((node) => node.id === "r2");
    expect(r2?.status).toBe("satisfied");
    expect(r2?.latestChange).toMatchObject({ actor: "coordinator", verifiedBy: "self", evidenceCount: 1 });
    // The out-of-scope report failed, naming the delegated roots.
    const refusal = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.tool.completed'").all()
      .map((row) => String((row as { payload: string }).payload))
      .find((payload) => payload.includes("outside this session's delegated requirements"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("r1");
    expect(h.app.requirements.derive(userSessionId).find((node) => node.id === "r3")?.status).toBe("open");
    // The refinement is a live node attributed to this session.
    const refined = h.app.requirements.derive(userSessionId).find((node) => node.origin === "refinement");
    expect(refined).toMatchObject({ parentId: "r2", statement: "Token refresh rotates", refinedByAgentSessionId: created.agentSessionId });

    // A delegated session is never branded unscoped.
    expect(h.host.unscoped(h.repo.getAgentSession(created.agentSessionId)!)).toBe(false);
    expect(h.host.listForUserSession(userSessionId)[0]?.unscoped).toBeUndefined();

    // The coordinator's FIRST delivery carried the delegated block (statements
    // and statuses), so the sub-scope was in hand from the briefing on.
    const firstDelivery = h.fake.captured.prompts.find((text) => text.includes("Your delegated requirements"));
    expect(firstDelivery).toBeDefined();
    expect(firstDelivery).toContain("- r1 [open]: Auth works end to end");
    expect(firstDelivery).toContain("  - r2 [open]: Login issues a session token");
    expect(firstDelivery).not.toContain("r3");
  });

  it("a delegation-less session's prompts carry no delegated block, and specialists hold no report tool", async () => {
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "coordinator") {
        coordinatorTurns += 1;
        yield coordinatorTurns === 1
          ? sendHandoffUse("a-1", "scout", { action: "look", status: "pending", category: "assignment" })
          : sendHandoffUse("f-1", "main", { action: "done", status: "completed", category: "final" });
      } else {
        yield sendHandoffUse("s-1", "coordinator", { action: "seen", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    approveRequirements(h, userSessionId);
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 15_000);
    h.host.createSession({ userSessionId, title: "bare", agents: [{ name: "scout", profileId: "explorer" }], briefing: briefing("go") });
    await done;

    for (const prompt of h.fake.captured.prompts) {
      expect(prompt).not.toContain("Your delegated requirements");
    }
    // Commissioned under a governing graph with zero delegations → the
    // session renders as UNSCOPED on every read surface (soft annotation,
    // derived, never a rejection — the session launched fine).
    const bare = h.repo.listAgentSessions(userSessionId)[0]!;
    expect(h.host.unscoped(bare)).toBe(true);
    expect(h.host.listForUserSession(userSessionId)[0]).toMatchObject({ unscoped: true });
    expect(h.host.activity(bare.id)).toMatchObject({ unscoped: true });
    expect(h.host.wireSession(bare).unscoped).toBe(true);
    // A session from BEFORE the first approval is never retroactively branded
    // (matching the eval checker's created-after-first-approval semantics).
    expect(h.host.unscoped({ ...bare, createdAt: "2000-01-01T00:00:00.000Z" })).toBe(false);
    // Every seat reads; only the entry/granted roles report. The specialist's
    // allow-list carries read_requirements but not report_requirement.
    const scoutOptions = h.fake.captured.options.find((options) => agentRoleOf(options).role === "specialist");
    expect(scoutOptions?.allowedTools ?? []).toContain("mcp__console_agent__read_requirements");
    expect(scoutOptions?.allowedTools ?? []).not.toContain("mcp__console_agent__report_requirement");
    // The coordinator holds report/decompose via its role grant.
    const coordOptions = h.fake.captured.options.find((options) => agentRoleOf(options).role === "coordinator");
    expect(coordOptions?.allowedTools ?? []).toContain("mcp__console_agent__report_requirement");
  });

  it("a child session's sub-scope must be a subset of its parent's", { timeout: 25_000 }, async () => {
    let parentCoordTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const id = agentRoleOf(options);
      yield initMessage();
      if (id.role === "coordinator" && id.depth === 0) {
        parentCoordTurns += 1;
        if (parentCoordTurns === 1) {
          // Outside the parent's delegation (r3) — refused before anything spawns.
          yield toolUseMessage("spawn-bad", "mcp__console_agent__create_child_session", {
            pattern: "hub_and_spoke", title: "too wide", agents: [{ name: "kid", profileId: "explorer", owns: [] }],
            briefing: briefing("overreach"), requirements: ["r3"] });
          // A subset (r2 under the delegated r1) — spawns and delegates down.
          yield toolUseMessage("spawn-ok", "mcp__console_agent__create_child_session", {
            pattern: "hub_and_spoke", title: "narrow", agents: [{ name: "kid", profileId: "explorer", owns: [] }],
            briefing: briefing("verify login"), requirements: ["r2"] });
        } else {
          yield sendHandoffUse("p-final", "main", { action: "done", status: "completed", category: "final" });
        }
      } else if (id.role === "coordinator" && id.depth === 1) {
        yield sendHandoffUse("c-final", "main", { action: "login verified", status: "completed", category: "final" });
      } else if (id.role === "specialist") {
        yield sendHandoffUse("s-1", "coordinator", { action: "ok", status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    approveRequirements(h, userSessionId);
    // The parent's final reaching main is the settle point; run COMPLETION is
    // deliberately not awaited — the requirement oracle holds it (correctly)
    // until a completion record lands, which is the completion suite's story.
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 20_000);
    const created = h.host.createSession({
      userSessionId, title: "mission", agents: [{ name: "aux", profileId: "explorer" }],
      briefing: briefing("run it"), requirements: ["r1"],
    });
    const events = await done;

    const refusal = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'agent_session.tool.completed'").all()
      .map((row) => String((row as { payload: string }).payload))
      .find((payload) => payload.includes("must be a subset"));
    expect(refusal).toBeDefined();

    const spawned = events.find((event) => event.type === "agent_session.child.spawned");
    expect(spawned).toBeDefined();
    const childId = (spawned!.payload as { childAgentSessionId: string }).childAgentSessionId;
    expect(h.app.requirements.delegationSet(childId)).toEqual(["r2"]);
    const childDelegation = h.sqlite.prepare("SELECT payload FROM events WHERE type = 'requirement.delegated'").all()
      .map((row) => JSON.parse(String((row as { payload: string }).payload)))
      .find((payload) => payload.agentSessionId === childId);
    expect(childDelegation).toMatchObject({ requirementIds: ["r2"], source: "child" });
    expect(h.repo.getAgentSession(childId)).toMatchObject({ parentAgentSessionId: created.agentSessionId });
  });
});

describe("requirement-linked ask_operator", () => {
  it("carries in-scope requirement ids into the card and pins the decision; out-of-scope links are refused", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    approveRequirements(h, userSessionId);
    h.host.createSession({
      userSessionId, title: "asker", agents: [{ name: "scout", profileId: "explorer" }],
      briefing: briefing("investigate"), requirements: ["r1"],
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    const ask = h.fake.captured.tools.find((t) => t.name === "ask_operator")!;

    // Out of scope (r3 was never delegated): refused with the law named, and
    // NOT as a tool error — a refusal must not feed the error-streak watchdog.
    const denied = JSON.parse(((await ask.handler({
      question: "Ship without the verify gate?", options: [{ label: "Yes" }, { label: "No" }],
      urgency: "deferred", allowFreeText: true, requirementIds: ["r3"],
    }, {})) as { content: { text?: string }[] }).content[0]!.text!) as { invalidRequirementIds?: boolean };
    expect(denied.invalidRequirementIds).toBe(true);

    // In scope: the card's payload carries the ids; the resolved answer is a
    // decision PINNED to them, rendered with the ids for every seat.
    await ask.handler({
      question: "Which token lifetime?", options: [{ label: "1h" }, { label: "24h" }],
      urgency: "deferred", allowFreeText: true, requirementIds: ["r2"],
    }, {});
    const row = h.db.select().from(interactionRows).all().find((r) => r.status === "pending")!;
    expect((row.payload as { requirementIds?: string[] }).requirementIds).toEqual(["r2"]);
    h.interactions.resolveFromApi(userSessionId, row.id, { answers: { "Which token lifetime?": ["1h"] } });
    const decision = h.decisions.list(userSessionId).find((d) => d.question.includes("token lifetime"))!;
    expect(decision.requirementIds).toEqual(["r2"]);
    expect(h.decisions.digest(userSessionId)).toContain("[r2]");
  });
});

describe("vision propagation to seats", () => {
  const PROSE_DOC = `# Auth hardening

## Context
Session security outranks convenience.

## Requirements
- Auth works end to end
  - Login issues a session token
- \`npm run verify\` passes
`;

  it("seats get the intent prose + top-level shape at spawn, and ancestor chains on delegated subtrees", async () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage();
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    const draft = h.app.requirements.propose(userSessionId, PROSE_DOC, "initial");
    h.app.requirements.approve(draft.id, { document: PROSE_DOC, edited: false });

    // Delegate a CHILD node (r2): the delivery must name the chain above it.
    h.host.createSession({
      userSessionId, title: "token work", agents: [{ name: "scout", profileId: "explorer" }],
      briefing: briefing("harden token issuance"), requirements: ["r2"],
    });
    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);

    // System prompt: the vision prose and the top-level shape, NOT the whole
    // outline — the subtree arrives with the delivery instead.
    const spawnOptions = h.fake.captured.options
      .map((options) => (typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : ""))
      .join("\n");
    expect(spawnOptions).toContain("Session security outranks convenience.");
    expect(spawnOptions).toContain("Top-level requirements:");
    expect(spawnOptions).toContain("(subtree: 0/1 satisfied)");

    // Delivery prompt: ancestor chain above the delegated subtree.
    const delivery = h.fake.captured.prompts.find((text) => text.includes("Your delegated requirements"))!;
    expect(delivery).toContain("Under: r1 Auth works end to end › r2");
    expect(delivery).toContain("- r2 [open]: Login issues a session token");
  });
});
