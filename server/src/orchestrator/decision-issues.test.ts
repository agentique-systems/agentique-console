/**
 * The decision-issue invariant: one durable project-level issue per
 * unresolved human choice — related asks attach to it, exactly one operator
 * answer resolves the issue and every participating ask, ordinary chat can
 * never resolve more than one issue, the issue outlives its askers and its
 * process, and a reversal keeps history while reaching affected work.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db/client.ts";
import { ArtifactStore } from "../events/artifact-store.ts";
import { EventBus } from "../events/bus.ts";
import { DecisionIssueStore } from "../db/stores/decision-issue-store.ts";
import { InteractionStore } from "../db/stores/interaction-store.ts";
import { DecisionIssueService, normalizeIssueKey, renderDecisionIssue } from "./decision-issues.ts";
import { DecisionLedger } from "./decisions.ts";
import { InteractionService } from "./interactions.ts";
import { events, interactions as interactionRows, projects, userSessions, workspaces } from "../db/schema.ts";
import { newId, nowIso } from "../ids.ts";

function harness(opts: { openSessions?: Set<string> } = {}) {
  const { db, sqlite } = openDb(":memory:");
  const bus = new EventBus(db, new ArtifactStore(db));
  const interactionStore = new InteractionStore(db);
  const issueStore = new DecisionIssueStore(db);
  const workspaceId = newId("ws");
  db.insert(workspaces).values({ id: workspaceId, name: "w", rootPath: `/tmp/${workspaceId}`, metadata: {}, createdAt: nowIso(), updatedAt: nowIso() }).run();
  const projectId = newId("proj");
  db.insert(projects).values({ id: projectId, workspaceId, title: null, intentDocument: null, createdAt: nowIso() }).run();
  const sessionProjects = new Map<string, string>();
  const resolveProject = (userSessionId: string): string => {
    const mapped = sessionProjects.get(userSessionId);
    if (!mapped) throw new Error(`no user session ${userSessionId}`);
    return mapped;
  };
  const addUserSession = (): string => {
    const id = newId("us");
    // Sequential continuation is a DB invariant (one OPEN session per
    // project): a later session on the shared project continues from the
    // archived previous one, exactly the production shape.
    db.update(userSessions).set({ lifecycle: "archived" })
      .where(eq(userSessions.projectId, projectId)).run();
    db.insert(userSessions).values({
      id, workspaceId, projectId, title: "t", mode: "execute", phase: "executing",
      lifecycle: "open", purpose: "work", subjectKey: null, sdkSessionId: null, sdkGeneration: 0,
      sdkTurnCount: 0, contextTokens: 0, memory: "", latestHandoffId: null,
      cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, createdAt: nowIso(), updatedAt: nowIso(),
    }).run();
    sessionProjects.set(id, projectId);
    return id;
  };
  const openSessions = opts.openSessions ?? new Set<string>(["as_1", "as_2", "as_3"]);
  const issues = new DecisionIssueService(issueStore, interactionStore, bus, resolveProject);
  issues.setDeps({ isAgentSessionOpen: (id) => openSessions.has(id) });
  const service = new InteractionService(interactionStore, bus, issues);
  const ledger = new DecisionLedger(interactionStore, resolveProject, issueStore);
  const userSessionId = addUserSession();
  const delivered: string[] = [];
  const issueUpdates: { to: string; text: string; dedupeKey: string }[] = [];
  const routing = {
    deliverToAgent: vi.fn((interaction: { id: string }) => { delivered.push(interaction.id); }),
    reviveMain: vi.fn(),
    beginExecuting: vi.fn(),
    deliverIssueUpdate: vi.fn((interaction: { agent: string | null }, text: string, dedupeKey: string) => {
      issueUpdates.push({ to: interaction.agent ?? "main", text, dedupeKey });
    }),
  };
  service.onStaleAnswerRouting(routing);
  /** A fresh process over the SAME database: parked promises are gone, rows are not. */
  const reboot = () => {
    const rebooted = new DecisionIssueService(issueStore, interactionStore, bus, resolveProject);
    rebooted.setDeps({ isAgentSessionOpen: (id) => openSessions.has(id) });
    const freshService = new InteractionService(interactionStore, bus, rebooted);
    freshService.onStaleAnswerRouting(routing);
    freshService.expirePendingOnBoot();
    return { service: freshService, issues: rebooted };
  };
  return { db, sqlite, bus, service, issues, issueStore, interactionStore, ledger, userSessionId, addUserSession, openSessions, delivered, issueUpdates, routing, projectId, reboot };
}

const QUESTION = (text: string) => [{ question: text, options: [{ label: "Yes" }, { label: "No" }] }];

/** An agent ask attached to an issue, the way askOperator wires it. */
function ask(h: ReturnType<typeof harness>, input: {
  agentSessionId: string; agent: string; question: string; issueKey?: string;
  urgency?: "blocking" | "deferred"; recommendation?: string; requirementIds?: string[];
  userSessionId?: string;
}) {
  const userSessionId = input.userSessionId ?? h.userSessionId;
  const opened = h.issues.openForAsk({
    userSessionId,
    issueKey: input.issueKey,
    subject: input.question,
    requirementIds: input.requirementIds ?? [],
    createdBy: input.agent,
  });
  const pending = h.service.createOperatorQuestion({
    userSessionId,
    agentSessionId: input.agentSessionId,
    agent: input.agent,
    questions: QUESTION(input.question),
    urgency: input.urgency ?? "blocking",
    allowFreeText: true,
    ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
    ...(input.requirementIds === undefined ? {} : { requirementIds: input.requirementIds }),
    issue: { id: opened.issue.id, created: !opened.attachedToExisting },
  });
  return { ...pending, issueId: opened.issue.id, attached: opened.attachedToExisting };
}

describe("issue identity is explicit", () => {
  it("two agents in different sessions sharing a key land on ONE issue with two asks", () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should authentication use organization-wide SSO?", issueKey: "auth-identity" });
    const b = ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Can this flow assume enterprise identity?", issueKey: "auth-identity" });
    expect(a.attached).toBe(false);
    expect(b.attached).toBe(true);
    expect(b.issueId).toBe(a.issueId);
    expect(h.service.listAsksForIssue(a.issueId)).toHaveLength(2);
    const wire = h.issues.get(h.userSessionId, a.issueId);
    // The subject stays the FIRST asker's wording; both askers are visible.
    expect(wire.subject).toBe("Should authentication use organization-wide SSO?");
    expect(wire.asks.map((entry) => entry.asker)).toEqual(["auth-dev", "api-dev"]);
  });

  it("superficially similar questions WITHOUT a shared key stay separate issues", () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should this service support local passwords?" });
    const b = ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Should this service support local passwords?" });
    expect(b.issueId).not.toBe(a.issueId);
    expect(h.issues.listOpenForProject(h.userSessionId)).toHaveLength(2);
  });

  it("normalizes keys lexically, never semantically", () => {
    expect(normalizeIssueKey("Auth Identity??")).toBe("auth-identity");
    expect(normalizeIssueKey("  AUTH_identity  ")).toBe("auth-identity");
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "x", question: "q1", issueKey: "Auth Identity" });
    const b = ask(h, { agentSessionId: "as_2", agent: "y", question: "q2", issueKey: "auth-identity" });
    expect(b.issueId).toBe(a.issueId);
  });
});

describe("one answer resolves exactly the intended issue", () => {
  it("answering one card resolves the issue and every sibling ask — and nothing else", async () => {
    const h = harness();
    const a1 = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    const a2 = ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Can flows assume enterprise identity?", issueKey: "auth" });
    const other = ask(h, { agentSessionId: "as_3", agent: "export-dev", question: "Should export support PDF?", issueKey: "export-pdf" });

    h.service.resolveFromApi(h.userSessionId, a1.id, {
      answers: { "Should auth use SSO?": ["Yes"] },
      freeText: { "Should auth use SSO?": "Yes — but keep a break-glass local admin login" },
    });

    // The issue carries the human's words, qualification included.
    const wire = h.issues.get(h.userSessionId, a1.issueId);
    expect(wire.status).toBe("resolved");
    expect(wire.resolution?.answer).toContain("break-glass local admin login");
    expect(wire.resolution?.via).toBe("card");
    // Both asks resolved; the sibling's parked promise got the words keyed by ITS question.
    const sibling = await a2.resolution;
    expect(sibling).toMatchObject({ kind: "answers" });
    expect((sibling as { freeText: Record<string, string> }).freeText["Can flows assume enterprise identity?"]).toContain("break-glass");
    // The unrelated issue is untouched.
    expect(h.issues.get(h.userSessionId, other.issueId).status).toBe("open");
    expect(h.db.select().from(interactionRows).all().find((row) => row.id === other.id)?.status).toBe("pending");
  });

  it("the ledger records ONE decision for a two-ask issue; the echo still renders for its asker", () => {
    const h = harness();
    const a1 = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Can flows assume enterprise identity?", issueKey: "auth" });
    h.service.resolveFromApi(h.userSessionId, a1.id, { answers: { "Should auth use SSO?": ["Yes"] } });

    const decisions = h.ledger.list(h.userSessionId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.question).toBe("Should auth use SSO?");
    // The echo row is answered and delivery-renderable (its own question → the answer).
    const echo = h.service.listAnsweredUnflushed("as_2", "api-dev");
    expect(echo).toHaveLength(1);
    expect((echo[0]!.response as { issueEcho?: boolean }).issueEcho).toBe(true);
  });

  it("duplicate resolution retries are idempotent — the sibling card 409s, no second decision", () => {
    const h = harness();
    const a1 = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    const a2 = ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Same choice?", issueKey: "auth" });
    h.service.resolveFromApi(h.userSessionId, a1.id, { answers: { "Should auth use SSO?": ["Yes"] } });

    expect(() => h.service.resolveFromApi(h.userSessionId, a2.id, { answers: { "Same choice?": ["No"] } }))
      .toThrow(/already answered/);
    expect(h.ledger.list(h.userSessionId)).toHaveLength(1);
    expect(h.issues.get(h.userSessionId, a1.issueId).resolutions).toHaveLength(1);
  });

  it("resolving a shared issue wakes all and only the affected detached askers", () => {
    const h = harness();
    const a1 = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    const a2 = ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Enterprise identity?", issueKey: "auth" });
    const other = ask(h, { agentSessionId: "as_3", agent: "export-dev", question: "PDF export?", issueKey: "export" });
    // Both auth askers' turns died (park/restart); the answer must reach them by mailbox.
    h.service.detach(a1.id, "parked");
    h.service.detach(a2.id, "parked");
    h.service.resolveAndRoute(h.userSessionId, a1.id, { answers: { "Should auth use SSO?": ["Yes"] } });

    expect(h.delivered.sort()).toEqual([a1.id, a2.id].sort());
    expect(h.delivered).not.toContain(other.id);
  });
});

describe("chat cannot resolve more than one issue", () => {
  it("with several distinct issues pending, chat resolves NOTHING and returns held descriptors", () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    const b = ask(h, { agentSessionId: "as_2", agent: "export-dev", question: "Should export support PDF?", issueKey: "export" });

    const { held } = h.service.dismissPendingForChat(h.userSessionId, "yes please");

    expect(held.map((entry) => entry.issueId).sort()).toEqual([a.issueId, b.issueId].sort());
    const rows = h.db.select().from(interactionRows).all();
    expect(rows.find((row) => row.id === a.id)?.status).toBe("pending");
    expect(rows.find((row) => row.id === b.id)?.status).toBe("pending");
    expect(h.issues.get(h.userSessionId, a.issueId).status).toBe("open");
    expect(h.issues.get(h.userSessionId, b.issueId).status).toBe("open");
    // And no decision was minted from the ambiguous words.
    expect(h.ledger.list(h.userSessionId)).toHaveLength(0);
  });

  it("with exactly ONE issue pending, chat binds to it — every participating ask resolves", async () => {
    const h = harness();
    const a1 = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    const a2 = ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Enterprise identity?", issueKey: "auth" });

    const { held } = h.service.dismissPendingForChat(h.userSessionId, "use SSO everywhere");

    expect(held).toHaveLength(0);
    const wire = h.issues.get(h.userSessionId, a1.issueId);
    expect(wire.status).toBe("resolved");
    expect(wire.resolution?.via).toBe("chat");
    const first = await a1.resolution;
    expect((first as { reason: string }).reason).toContain('"use SSO everywhere"');
    const second = await a2.resolution;
    expect(JSON.stringify(second)).toContain("use SSO everywhere");
    expect(h.ledger.list(h.userSessionId)).toHaveLength(1);
  });

  it("main explicitly binds the chat words to one held issue; the other stays open", async () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    const b = ask(h, { agentSessionId: "as_2", agent: "export-dev", question: "Should export support PDF?", issueKey: "export" });
    h.service.dismissPendingForChat(h.userSessionId, "yes, PDF is required");

    const bound = h.service.bindIssueResolution({
      userSessionId: h.userSessionId, issueId: b.issueId, answer: "yes, PDF is required", via: "main",
    });

    expect(bound.outcome).toBe("resolved");
    expect(bound.resolvedAskIds).toEqual([b.id]);
    expect(h.issues.get(h.userSessionId, b.issueId).status).toBe("resolved");
    expect(h.issues.get(h.userSessionId, a.issueId).status).toBe("open");
    const answered = await b.resolution;
    expect((answered as { reason: string }).reason).toContain("yes, PDF is required");
    // Provenance: the row records main bound the operator's chat words.
    const row = h.db.select().from(interactionRows).all().find((entry) => entry.id === b.id);
    expect((row?.response as { boundBy?: string }).boundBy).toBe("main");
  });

  it("plan approvals never join issue grouping — chat still rejects them while issues hold", () => {
    const h = harness();
    ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "SSO?", issueKey: "auth" });
    ask(h, { agentSessionId: "as_2", agent: "export-dev", question: "PDF?", issueKey: "export" });
    const plan = h.service.createPlanApproval(h.userSessionId, "the plan", undefined, undefined);

    const { held } = h.service.dismissPendingForChat(h.userSessionId, "actually, change the plan");

    expect(held).toHaveLength(2);
    expect(h.db.select().from(interactionRows).all().find((row) => row.id === plan.id)?.status).toBe("rejected");
  });
});

describe("issues outlive their askers and their process", () => {
  it("a terminated asker's session does not delete the issue; derived blocking drops to zero", () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    h.openSessions.delete("as_1");

    const wire = h.issues.get(h.userSessionId, a.issueId);
    expect(wire.status).toBe("open");
    expect(wire.blockingAsksActive).toBe(0);
    expect(wire.pendingAsksActive).toBe(0);
    // Still answerable: the choice outlives the asker.
    h.service.resolveFromApi(h.userSessionId, a.id, { answers: { "Should auth use SSO?": ["Yes"] } });
    expect(h.issues.get(h.userSessionId, a.issueId).status).toBe("resolved");
  });

  it("restart preserves issue/ask state; answering after boot resolves and routes by mailbox", () => {
    const h = harness();
    const a1 = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    const a2 = ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Enterprise identity?", issueKey: "auth" });
    // A new process over the same database: the parked promises died with the
    // old one; the rows — asks AND issue — did not.
    const rebooted = h.reboot();

    const rows = h.db.select().from(interactionRows).all();
    expect(rows.find((row) => row.id === a1.id)).toMatchObject({ status: "pending", detached: true });
    expect(rebooted.issues.get(h.userSessionId, a1.issueId).status).toBe("open");

    rebooted.service.resolveAndRoute(h.userSessionId, a1.id, { answers: { "Should auth use SSO?": ["Yes"] } });
    expect(rebooted.issues.get(h.userSessionId, a1.issueId).status).toBe("resolved");
    expect(h.delivered.sort()).toEqual([a1.id, a2.id].sort());
  });

  it("a later session of the same project inherits the open issue and can attach to it", () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth" });
    const laterSession = h.addUserSession();

    const inherited = h.issues.listOpenForProject(laterSession);
    expect(inherited.map((issue) => issue.id)).toContain(a.issueId);
    const again = ask(h, { agentSessionId: "as_2", agent: "later-dev", question: "SSO again?", issueKey: "auth", userSessionId: laterSession });
    expect(again.issueId).toBe(a.issueId);
  });
});

describe("provisional is visibly not a human decision", () => {
  it("an auto-proceeded ask leaves the issue open and provisional; the human answer then resolves and overrides", () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "verifier", question: "Ship r169?", issueKey: "ship", urgency: "deferred", recommendation: "Ship r169" });
    h.db.update(interactionRows).set({ createdAt: new Date(Date.now() - 20 * 60_000).toISOString() }).where(eq(interactionRows.id, a.id)).run();
    h.service.sweepStaleAsks({ deferredAutoProceedMs: 900_000, blockingAskEscalateMs: 900_000, autonomyOf: () => "standard", escalate: () => {} });

    const provisional = h.issues.get(h.userSessionId, a.issueId);
    expect(provisional.status).toBe("open");
    expect(provisional.provisional).toBe(true);
    expect(renderDecisionIssue(provisional)).toContain("NOT a human decision");

    h.service.resolveAndRoute(h.userSessionId, a.id, { answers: { "Ship r169?": ["No"] } });
    const resolved = h.issues.get(h.userSessionId, a.issueId);
    expect(resolved.status).toBe("resolved");
    expect(resolved.provisional).toBe(false);
    // The override reached the moved-on asker by mailbox.
    expect(h.delivered).toContain(a.id);
  });
});

describe("reversal keeps history and reaches affected work", () => {
  it("a later operator override supersedes: history retained, ledger announces, participating seats notified", () => {
    const h = harness();
    const a1 = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?", issueKey: "auth", requirementIds: [] });
    ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Enterprise identity?", issueKey: "auth" });
    h.service.resolveFromApi(h.userSessionId, a1.id, { freeText: { "Should auth use SSO?": "Yes, SSO" }, answers: {} });

    const bound = h.service.bindIssueResolution({
      userSessionId: h.userSessionId, issueId: a1.issueId, answer: "Actually no — local passwords, SSO later", via: "main",
    });

    expect(bound.outcome).toBe("superseded");
    const wire = h.issues.get(h.userSessionId, a1.issueId);
    expect(wire.resolutions).toHaveLength(2);
    expect(wire.resolutions[0]!.answer).toContain("Yes, SSO");
    expect(wire.resolution?.answer).toContain("local passwords");
    expect(wire.resolution?.supersedes).toBe(true);
    // The ledger gained a revision entry (the delta announces it to every seat).
    const decisions = h.ledger.list(h.userSessionId);
    expect(decisions).toHaveLength(2);
    expect(decisions[1]!.answer).toContain("supersedes the earlier answer");
    // Targeted fan-out: both participating seats got the notice.
    expect(h.issueUpdates.map((update) => update.to).sort()).toEqual(["api-dev", "auth-dev"]);
    // Idempotent: re-binding the unchanged answer stacks nothing.
    const again = h.service.bindIssueResolution({
      userSessionId: h.userSessionId, issueId: a1.issueId, answer: "Actually no — local passwords, SSO later", via: "main",
    });
    expect(again.outcome).toBe("unchanged");
    expect(h.issues.get(h.userSessionId, a1.issueId).resolutions).toHaveLength(2);
    expect(h.issueUpdates).toHaveLength(2);
  });

  it("a supersede ledger entry pins to the issue's requirement union", () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "SSO?", issueKey: "auth", requirementIds: ["r1"] });
    ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Identity?", issueKey: "auth", requirementIds: ["r2"] });
    h.service.resolveFromApi(h.userSessionId, a.id, { answers: { "SSO?": ["Yes"] } });
    h.service.bindIssueResolution({ userSessionId: h.userSessionId, issueId: a.issueId, answer: "changed", via: "main" });

    const revision = h.ledger.list(h.userSessionId).find((entry) => entry.answer.includes("supersedes"));
    expect(revision?.requirementIds.sort()).toEqual(["r1", "r2"]);
  });
});

describe("merge", () => {
  it("main merges duplicate open issues: asks move, source becomes a superseded pointer, one answer resolves all", async () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "Should auth use SSO?" });
    const b = ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Can flows assume enterprise identity?" });

    h.issues.merge({ userSessionId: h.userSessionId, fromIssueId: b.issueId, intoIssueId: a.issueId, why: "one identity-provider choice" });

    expect(h.issues.get(h.userSessionId, b.issueId)).toMatchObject({ status: "superseded", supersededById: a.issueId });
    expect(h.service.listAsksForIssue(a.issueId).map((row) => row.id).sort()).toEqual([a.id, b.id].sort());

    h.service.resolveFromApi(h.userSessionId, a.id, { answers: { "Should auth use SSO?": ["Yes"] } });
    const moved = await b.resolution;
    expect(moved).toMatchObject({ kind: "answers" });
    // Binding the merged-away id points at the survivor instead of resolving.
    expect(() => h.service.bindIssueResolution({ userSessionId: h.userSessionId, issueId: b.issueId, answer: "x", via: "main" }))
      .toThrow(/merged/);
  });
});

describe("registry ordering and events", () => {
  it("orders open before resolved, then by live blocking weight, requirement breadth, and age", () => {
    const h = harness();
    const light = ask(h, { agentSessionId: "as_1", agent: "a", question: "small?", issueKey: "small", urgency: "deferred" });
    const heavy1 = ask(h, { agentSessionId: "as_2", agent: "b", question: "big?", issueKey: "big", requirementIds: ["r1", "r2"] });
    ask(h, { agentSessionId: "as_3", agent: "c", question: "big too?", issueKey: "big" });
    const done = ask(h, { agentSessionId: "as_1", agent: "d", question: "done?", issueKey: "done" });
    h.service.resolveFromApi(h.userSessionId, done.id, { answers: { "done?": ["Yes"] } });

    const ordered = h.issues.listForProject(h.userSessionId).map((issue) => issue.id);
    expect(ordered).toEqual([heavy1.issueId, light.issueId, done.issueId]);
  });

  it("journals created/attached/resolved with the participating asks", () => {
    const h = harness();
    const a = ask(h, { agentSessionId: "as_1", agent: "auth-dev", question: "SSO?", issueKey: "auth" });
    const b = ask(h, { agentSessionId: "as_2", agent: "api-dev", question: "Identity?", issueKey: "auth" });
    h.service.resolveFromApi(h.userSessionId, a.id, { answers: { "SSO?": ["Yes"] } });

    const all = h.db.select().from(events).all();
    expect(all.some((row) => row.type === "decision_issue.created")).toBe(true);
    const attached = all.find((row) => row.type === "decision_issue.ask_attached");
    expect(attached?.payload).toMatchObject({ issueId: a.issueId, interactionId: b.id, askCount: 2 });
    const resolved = all.find((row) => row.type === "decision_issue.resolved");
    expect((resolved?.payload as { resolvedAskIds: string[] }).resolvedAskIds.sort()).toEqual([a.id, b.id].sort());
  });
});
