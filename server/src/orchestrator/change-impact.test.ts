/**
 * The change-impact ledger's architectural invariant: a meaning-changing
 * event (amendment, falsified assumption, withdrawn claim) computes a REAL
 * transitive closure — dependency chains, dependencies on ancestors,
 * descendants, dependents of retired nodes — persists it durably, and holds
 * it open until every judgment-bearing item is dispositioned or mechanically
 * cleared. Stale evidence cannot silently remain current; unrelated work is
 * untouched; duplicate processing is idempotent; restart preserves the
 * ledger; an incorrect reconcile call cannot bypass the rule.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Task } from "@agentique-console/shared";
import { openDb } from "../db/client.ts";
import { createStores } from "../db/stores/index.ts";
import { changeImpacts as changeImpactsTable, events as eventsTable, projects, userSessions, workspaces } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { nowIso } from "../ids.ts";
import { AssumptionService } from "./assumptions.ts";
import { ChangeImpactService } from "./change-impact.ts";
import { RequirementService } from "./requirements.ts";

const DOC = `## Requirements
- Auth works end to end
  - Login issues a session token
  - (any of) A config source loads
    - TOML config parses
    - JSON config parses
- \`npm run verify\` passes
`;
// Minted in outline order: r1 auth, r2 login, r3 config, r4 toml, r5 json, r6 verify.

function makeHarness() {
  const { db, sqlite } = openDb(":memory:");
  const stores = createStores(db, sqlite);
  const bus = new EventBus(db, stores.artifacts);
  const now = nowIso();
  db.insert(workspaces).values({ id: "ws1", name: "w", rootPath: "/tmp/change-impact-test", createdAt: now, updatedAt: now }).run();
  db.insert(projects).values({ id: "proj1", workspaceId: "ws1", title: null, intentDocument: null, createdAt: now }).run();
  db.insert(userSessions).values({ id: "us1", workspaceId: "ws1", projectId: "proj1", mode: "execute", title: "t", createdAt: now, updatedAt: now } as typeof userSessions.$inferInsert).run();

  const requirements = new RequirementService(stores.requirements, stores.projects, stores.assumptions, bus, () => "proj1");
  const assumptions = new AssumptionService(stores.assumptions, requirements, bus, () => "proj1");
  const impacts = new ChangeImpactService(stores.changeImpacts, bus, () => "proj1");
  const open = new Set<string>();
  const tasks: Task[] = [];
  const edges: { consumerAgentSessionId: string; producerAgentSessionId: string; subject: string }[] = [];
  const wireImpacts = (service: ChangeImpactService) => service.setDeps({
    openAgentSessionIds: () => new Set(open),
    sessionTitle: (id) => `title of ${id}`,
    listTasks: () => [...tasks],
    latestChanges: () => stores.requirements.latestChanges("proj1"),
    liveWorkstreamEdges: () => [...edges],
  });
  wireImpacts(impacts);
  requirements.setImpactRecorder((input) => impacts.record(input));
  requirements.setFrontierDeps({
    openAgentSessionIds: () => new Set(open),
    blockedRequirementIds: () => new Set(),
    awaitingOperatorAgentSessionIds: () => new Set(),
  });
  const wakes: string[] = [];
  requirements.setWakeNote((_id, text) => wakes.push(text));
  assumptions.setWakeNote((_id, text) => wakes.push(text));
  const eventsOf = (type: string) =>
    db.select().from(eventsTable).where(eq(eventsTable.type, type)).all();
  const impactRows = () => db.select().from(changeImpactsTable).all();
  return { db, sqlite, stores, bus, requirements, assumptions, impacts, open, tasks, edges, wakes, eventsOf, impactRows, wireImpacts };
}

type Harness = ReturnType<typeof makeHarness>;

function approveFixture(h: Harness) {
  const draft = h.requirements.propose("us1", DOC, "initial");
  return h.requirements.approve(draft.id, { document: DOC, edited: false });
}

function satisfy(h: Harness, id: string, ref = `checked ${id}`) {
  h.requirements.reportStatus({ userSessionId: "us1", requirementId: id, to: "satisfied",
    evidence: [{ kind: "command", ref }], claimant: { kind: "main" } });
}

function task(over: Partial<Task> & { id: string; requirementId: string; agentSessionId: string }): Task {
  return {
    sdkSessionId: "console:as:orchestrator", sdkTaskId: over.id, workspaceId: "ws1", userSessionId: "us1",
    agent: null, subject: `unit ${over.id}`, description: "", activeForm: null, status: "pending",
    owner: null, blocks: [], blockedBy: [], dependencyIds: [], dependentIds: [], ready: true,
    scheduledAssignment: null, metadata: {}, createdAt: nowIso(), updatedAt: nowIso(), ...over,
  };
}

describe("transitive impact closure", () => {
  it("an amendment's impact closes over dependency CHAINS, not one link pass", () => {
    const h = makeHarness();
    approveFixture(h);
    // r6 depends_on r2 depends_on r4: changing r4 must reach r6 transitively.
    h.requirements.link({ userSessionId: "us1", fromId: "r6", kind: "depends_on", toId: "r2", actor: "main" });
    h.requirements.link({ userSessionId: "us1", fromId: "r2", kind: "depends_on", toId: "r4", actor: "main" });
    satisfy(h, "r2");
    satisfy(h, "r6");
    const amended = "## Requirements\n- r4: TOML config parses strictly\n- r5: JSON config parses\n";
    const draft = h.requirements.propose("us1", amended, "strict toml", { scopeId: "r3" });
    const { impact } = h.requirements.approve(draft.id, { document: amended, edited: false });

    expect(impact).not.toBeNull();
    expect(impact!.sourceKind).toBe("amendment");
    expect(impact!.sourceRef).toBe("rev:2");
    // Both the direct dependent (r2) and the transitive one (r6) are suspect.
    expect(impact!.affected.suspectClaims.map((claim) => claim.requirementId)).toEqual(["r2", "r6"]);
    expect(impact!.affected.requirements.map((entry) => entry.id)).toContain("r6");
    expect(impact!.status).toBe("open");
    expect(h.eventsOf("change_impact.recorded")).toHaveLength(1);
  });

  it("a dependency on an ANCESTOR of the changed node is affected", () => {
    const h = makeHarness();
    approveFixture(h);
    // r6 depends on r1 (the whole auth subtree); changing r2 inside it must reach r6.
    h.requirements.link({ userSessionId: "us1", fromId: "r6", kind: "depends_on", toId: "r1", actor: "main" });
    satisfy(h, "r6");
    const amended = `## Requirements
- r2: Login issues a rotating session token
- r3 (any of): A config source loads
  - r4: TOML config parses
  - r5: JSON config parses
`;
    const draft = h.requirements.propose("us1", amended, "rotate tokens", { scopeId: "r1" });
    const { impact } = h.requirements.approve(draft.id, { document: amended, edited: false });
    expect(impact).not.toBeNull();
    expect(impact!.affected.suspectClaims.map((claim) => claim.requirementId)).toEqual(["r6"]);
  });

  it("descendants of a changed node are affected; unrelated subtrees are not", () => {
    const h = makeHarness();
    approveFixture(h);
    h.open.add("as-auth").add("as-verify");
    h.requirements.delegate("us1", "as-auth", ["r1"], "commission");
    h.requirements.delegate("us1", "as-verify", ["r6"], "commission");
    satisfy(h, "r4");
    satisfy(h, "r6");
    const amended = DOC.replace("- Auth works end to end", "- r1: Auth works end to end, hardened")
      .replace("  - Login issues a session token", "  - r2: Login issues a session token")
      .replace("  - (any of) A config source loads", "  - r3 (any of): A config source loads")
      .replace("    - TOML config parses", "    - r4: TOML config parses")
      .replace("    - JSON config parses", "    - r5: JSON config parses")
      .replace("- `npm run verify` passes", "- r6: `npm run verify` passes");
    const draft = h.requirements.propose("us1", amended, "harden auth");
    const { impact } = h.requirements.approve(draft.id, { document: amended, edited: false });

    expect(impact).not.toBeNull();
    // r4 (a descendant's untouched claim) is suspect; r6 is outside the change.
    expect(impact!.affected.suspectClaims.map((claim) => claim.requirementId)).toEqual(["r4"]);
    expect(impact!.affected.requirements.map((entry) => entry.id)).not.toContain("r6");
    expect(impact!.affected.sessions.map((entry) => entry.agentSessionId)).toEqual(["as-auth"]);
  });

  it("workstream links extend the affected sessions to open consumers, transitively, with a via note", () => {
    const h = makeHarness();
    approveFixture(h);
    // as-auth is delegated the changed subtree; as-ui consumes as-auth's
    // interface and as-e2e consumes as-ui's — both must be discoverable
    // through the portfolio layer, not main's memory. The archived consumer
    // and the unrelated session stay out.
    h.open.add("as-auth").add("as-ui").add("as-e2e").add("as-unrelated");
    h.requirements.delegate("us1", "as-auth", ["r1"], "commission");
    h.edges.push(
      { consumerAgentSessionId: "as-ui", producerAgentSessionId: "as-auth", subject: "token API" },
      { consumerAgentSessionId: "as-e2e", producerAgentSessionId: "as-ui", subject: "rendered login flow" },
      { consumerAgentSessionId: "as-archived", producerAgentSessionId: "as-auth", subject: "old copy" },
    );
    satisfy(h, "r2");
    const amended = "## Requirements\n- r2: Login issues a ROTATING session token\n- r3 (any of): A config source loads\n  - r4: TOML config parses\n  - r5: JSON config parses\n";
    const draft = h.requirements.propose("us1", amended, "rotate tokens", { scopeId: "r1" });
    const { impact } = h.requirements.approve(draft.id, { document: amended, edited: false });
    expect(impact).not.toBeNull();
    expect(impact!.affected.sessions.map((entry) => entry.agentSessionId)).toEqual(["as-auth", "as-e2e", "as-ui"]);
    const via = new Map(impact!.affected.sessions.map((entry) => [entry.agentSessionId, entry.via]));
    expect(via.get("as-auth")).toBeUndefined();
    expect(via.get("as-ui")).toBe("consumes from as-auth: token API");
    expect(via.get("as-e2e")).toBe("consumes from as-ui: rendered login flow");
  });

  it("dependents of a RETIRED node are captured — the closure runs pre-approval", () => {
    const h = makeHarness();
    approveFixture(h);
    h.requirements.link({ userSessionId: "us1", fromId: "r6", kind: "depends_on", toId: "r2", actor: "main" });
    satisfy(h, "r6");
    const amended = "## Requirements\n- r3 (any of): A config source loads\n  - r4: TOML config parses\n  - r5: JSON config parses\n";
    const draft = h.requirements.propose("us1", amended, "drop login", { scopeId: "r1" });
    const { retired, impact } = h.requirements.approve(draft.id, { document: amended, edited: false });

    expect(retired).toEqual(["r2"]);
    // The approval retired r2's links in its transaction — only a pre-approval
    // closure could still see who depended on it.
    expect(h.requirements.liveLinks("us1").filter((row) => row.kind === "depends_on")).toHaveLength(0);
    expect(impact).not.toBeNull();
    expect(impact!.affected.suspectClaims.map((claim) => claim.requirementId)).toEqual(["r6"]);
  });

  it("an assumption falsification's impact closes transitively over rests_on and depends_on", () => {
    const h = makeHarness();
    approveFixture(h);
    const wire = h.assumptions.record({ userSessionId: "us1", text: "TOML stays the config format",
      source: "main", actor: "main", requirementIds: ["r4"] });
    h.requirements.link({ userSessionId: "us1", fromId: "r2", kind: "depends_on", toId: "r4", actor: "main" });
    satisfy(h, "r4");
    satisfy(h, "r2");
    h.assumptions.resolve({ userSessionId: "us1", assumptionId: wire.id, outcome: "falsified",
      actor: "main", evidence: [{ kind: "file", ref: "config.yaml" }] });

    const [impact] = h.impacts.listOpen("us1");
    expect(impact).toBeDefined();
    expect(impact!.sourceKind).toBe("assumption_falsified");
    expect(impact!.sourceRef).toBe(wire.id);
    expect(impact!.affected.suspectClaims.map((claim) => claim.requirementId)).toEqual(["r2", "r4"]);
    const wake = h.wakes.find((text) => text.includes("FALSIFIED"))!;
    expect(wake).toContain(impact!.id);
    expect(wake).toContain("reconcile_change_impact");
  });

  it("nothing stale or active touched → no impact recorded, no wake", () => {
    const h = makeHarness();
    approveFixture(h);
    // Statement change with no claims, no delegations, no tasks anywhere.
    const amended = DOC.replace("- `npm run verify` passes", "- r6: `npm run verify` passes from clean")
      .replace("- Auth works end to end", "- r1: Auth works end to end")
      .replace("  - Login issues a session token", "  - r2: Login issues a session token")
      .replace("  - (any of) A config source loads", "  - r3 (any of): A config source loads")
      .replace("    - TOML config parses", "    - r4: TOML config parses")
      .replace("    - JSON config parses", "    - r5: JSON config parses");
    const draft = h.requirements.propose("us1", amended, "clean verify");
    const { impact } = h.requirements.approve(draft.id, { document: amended, edited: false });
    expect(impact).toBeNull();
    expect(h.impactRows()).toHaveLength(0);
    // A reopen with no terminal dependents records nothing and wakes nobody.
    satisfy(h, "r2");
    h.requirements.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "open",
      evidence: [], claimant: { kind: "main" } });
    expect(h.impactRows()).toHaveLength(0);
    expect(h.wakes).toHaveLength(0);
  });

  it("requirement-linked tasks pull their session and scheduled assignment into the affected set", () => {
    const h = makeHarness();
    approveFixture(h);
    h.open.add("as-tasks");
    h.tasks.push(task({ id: "task_1", requirementId: "r2", agentSessionId: "as-tasks",
      scheduledAssignment: { id: "sched_1", sender: "coordinator", recipient: "builder", createdAt: nowIso() } }));
    const amended = `## Requirements
- r2: Login issues a rotating session token
- r3 (any of): A config source loads
  - r4: TOML config parses
  - r5: JSON config parses
`;
    const draft = h.requirements.propose("us1", amended, "rotate tokens", { scopeId: "r1" });
    const { impact } = h.requirements.approve(draft.id, { document: amended, edited: false });
    expect(impact).not.toBeNull();
    expect(impact!.affected.sessions.map((entry) => entry.agentSessionId)).toEqual(["as-tasks"]);
    expect(impact!.affected.tasks).toEqual([{ taskId: "task_1", subject: "unit task_1", status: "pending", agentSessionId: "as-tasks" }]);
    expect(impact!.affected.scheduledAssignments).toEqual([{ id: "sched_1", taskId: "task_1", agentSessionId: "as-tasks", recipient: "builder" }]);
  });
});

describe("durable reconciliation lifecycle", () => {
  /** r6 depends_on r2 depends_on r4, r2+r6 satisfied, r4 amended → suspects r2, r6. */
  function amendedWithSuspects(h: Harness) {
    approveFixture(h);
    h.requirements.link({ userSessionId: "us1", fromId: "r6", kind: "depends_on", toId: "r2", actor: "main" });
    h.requirements.link({ userSessionId: "us1", fromId: "r2", kind: "depends_on", toId: "r4", actor: "main" });
    satisfy(h, "r2");
    satisfy(h, "r6");
    const amended = "## Requirements\n- r4: TOML config parses strictly\n- r5: JSON config parses\n";
    const draft = h.requirements.propose("us1", amended, "strict toml", { scopeId: "r3" });
    return h.requirements.approve(draft.id, { document: amended, edited: false }).impact!;
  }

  it("a later claim clears its suspect mechanically; dispositions close the rest; stale state cannot remain silently current", () => {
    const h = makeHarness();
    const impact = amendedWithSuspects(h);
    expect(h.impacts.listOpen("us1").map((wire) => wire.id)).toEqual([impact.id]);
    expect(h.impacts.get("us1", impact.id).outstanding.claims).toEqual(["r2", "r6"]);

    // Re-verifying r2 under the new revision IS reconciliation — no bookkeeping call needed.
    satisfy(h, "r2", "re-checked under rev 2");
    expect(h.impacts.get("us1", impact.id).outstanding.claims).toEqual(["r6"]);
    expect(h.impacts.get("us1", impact.id).status).toBe("open");

    // r6's claim stands by judgment — recorded, journaled, closing the impact.
    const wire = h.impacts.reconcile({ userSessionId: "us1", impactId: impact.id, actor: "main",
      items: [{ kind: "claim", id: "r6", disposition: "stands", note: "verify does not read config strictness" }] });
    expect(wire.status).toBe("reconciled");
    expect(h.impacts.listOpen("us1")).toEqual([]);
    const reconciled = h.eventsOf("change_impact.reconciled");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.payload).toMatchObject({ impactId: impact.id, actor: "main", status: "reconciled" });
  });

  it("an affected session clears on archive, or by disposition — never silently", () => {
    const h = makeHarness();
    approveFixture(h);
    h.open.add("as-auth");
    h.requirements.delegate("us1", "as-auth", ["r1"], "commission");
    const amended = `## Requirements
- r2: Login issues a rotating session token
- r3 (any of): A config source loads
  - r4: TOML config parses
  - r5: JSON config parses
`;
    const draft = h.requirements.propose("us1", amended, "rotate tokens", { scopeId: "r1" });
    const { impact } = h.requirements.approve(draft.id, { document: amended, edited: false });
    expect(impact!.outstanding.sessions).toEqual(["as-auth"]);
    expect(h.impacts.listOpen("us1")).toHaveLength(1);

    // Archival is mechanical clearance; before it, only a disposition closes.
    h.open.delete("as-auth");
    expect(h.impacts.listOpen("us1")).toEqual([]);
    h.open.add("as-auth");
    expect(h.impacts.listOpen("us1")).toHaveLength(1);
    const wire = h.impacts.reconcile({ userSessionId: "us1", impactId: impact!.id, actor: "main",
      items: [{ kind: "session", id: "as-auth", disposition: "steered", note: "sent the token-rotation update" }] });
    expect(wire.status).toBe("reconciled");
  });

  it("duplicate processing is idempotent: same source and same open seeds mint one row", () => {
    const h = makeHarness();
    approveFixture(h);
    h.requirements.link({ userSessionId: "us1", fromId: "r6", kind: "depends_on", toId: "r2", actor: "main" });
    satisfy(h, "r2");
    satisfy(h, "r6");
    // Withdraw r2 twice (re-satisfying between): the first impact is still
    // open, so the second withdrawal reuses it instead of stacking a twin.
    h.requirements.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "open", evidence: [], claimant: { kind: "main" } });
    satisfy(h, "r2");
    h.requirements.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "open", evidence: [], claimant: { kind: "main" } });
    const withdrawn = h.impactRows().filter((row) => row.sourceKind === "claim_withdrawn");
    expect(withdrawn).toHaveLength(1);

    // The same SOURCE event re-processed verbatim lands on the unique index.
    const input = {
      userSessionId: "us1", sourceKind: "assumption_falsified" as const, sourceRef: "a99", note: null,
      seedIds: ["r6"],
      closure: {
        requirements: [{ id: "r6", basis: "falsified" as const, via: "r6" }],
        suspectClaims: [{ requirementId: "r6", status: "satisfied" as const, verifiedBy: "self" as const, actor: "main", ord: 2, at: nowIso() }],
        sessionIds: [],
      },
      atRevision: 1, computedAtOrd: 99,
    };
    const first = h.impacts.record(input)!;
    // Disposition it closed so the open-seed dedupe cannot mask the index test.
    h.impacts.reconcile({ userSessionId: "us1", impactId: first.id, actor: "main",
      items: [{ kind: "claim", id: "r6", disposition: "superseded", note: "test" }] });
    const second = h.impacts.record(input)!;
    expect(second.id).toBe(first.id);
    expect(h.impactRows().filter((row) => row.sourceKind === "assumption_falsified")).toHaveLength(1);
  });

  it("restart preserves the ledger: fresh services over the same database derive the same open state", () => {
    const h = makeHarness();
    const impact = amendedWithSuspects(h);
    const reopened = new ChangeImpactService(h.stores.changeImpacts, h.bus, () => "proj1");
    h.wireImpacts(reopened);
    const [restored] = reopened.listOpen("us1");
    expect(restored!.id).toBe(impact.id);
    expect(restored!.outstanding.claims).toEqual(["r2", "r6"]);
    expect(restored!.affected.seedIds).toEqual(impact.affected.seedIds);
  });

  it("the wake note names the impact and the reconcile tool", () => {
    const h = makeHarness();
    approveFixture(h);
    h.requirements.link({ userSessionId: "us1", fromId: "r6", kind: "depends_on", toId: "r2", actor: "main" });
    satisfy(h, "r2");
    satisfy(h, "r6");
    h.requirements.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "violated",
      evidence: [{ kind: "command", ref: "login 500s" }], claimant: { kind: "main" } });
    const [impact] = h.impacts.listOpen("us1");
    const wake = h.wakes.at(-1)!;
    expect(wake).toContain("r6");
    expect(wake).toContain(impact!.id);
    expect(wake).toContain("reconcile_change_impact");
  });

  it("an incorrect reconcile call cannot bypass the durable rule", () => {
    const h = makeHarness();
    const impact = amendedWithSuspects(h);
    // Not a member of the judgment set.
    expect(() => h.impacts.reconcile({ userSessionId: "us1", impactId: impact.id, actor: "main",
      items: [{ kind: "claim", id: "r5", disposition: "stands", note: "x" }] })).toThrow(/not a suspect claim/);
    // A claim cannot be waved off with a session verb — reopening is an act.
    expect(() => h.impacts.reconcile({ userSessionId: "us1", impactId: impact.id, actor: "main",
      items: [{ kind: "claim", id: "r2", disposition: "steered", note: "x" }] })).toThrow(/stands.*superseded/);
    // No judgment without a why.
    expect(() => h.impacts.reconcile({ userSessionId: "us1", impactId: impact.id, actor: "main",
      items: [{ kind: "claim", id: "r2", disposition: "stands", note: "  " }] })).toThrow(/needs a note/);
    // A failed batch changes nothing.
    expect(h.impacts.get("us1", impact.id).outstanding.claims).toEqual(["r2", "r6"]);
    expect(h.impacts.get("us1", impact.id).dispositions).toEqual([]);
  });
});
