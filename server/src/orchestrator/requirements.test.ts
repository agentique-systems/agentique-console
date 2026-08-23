/**
 * RequirementService: the approval diff (mint / retire-cascade / promote /
 * statement-reset), console-owned derivation, leaf-only reporting with
 * evidence, delegated-subtree enforcement, the frontier, and the digest and
 * pointer contracts with their legacy-spec fallback.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../db/client.ts";
import { createStores } from "../db/stores/index.ts";
import { events as eventsTable, projects, userSessions, workspaces } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { nowIso } from "../ids.ts";
import { SpecService } from "./spec.ts";
import { RequirementParseFailure, RequirementService } from "./requirements.ts";

const DOC = `## Requirements
- Auth works end to end
  - Login issues a session token
  - (any of) A config source loads
    - TOML config parses
    - JSON config parses
- \`npm run verify\` passes
`;

function makeHarness() {
  const { db, sqlite } = openDb(":memory:");
  const stores = createStores(db, sqlite);
  const bus = new EventBus(db, stores.artifacts);
  const now = nowIso();
  db.insert(workspaces).values({ id: "ws1", name: "w", rootPath: "/tmp/req-service-test", createdAt: now, updatedAt: now }).run();
  db.insert(projects).values({ id: "proj1", workspaceId: "ws1", title: null, intentDocument: null, createdAt: now }).run();
  db.insert(userSessions).values({ id: "us1", workspaceId: "ws1", projectId: "proj1", mode: "execute", title: "t", createdAt: now, updatedAt: now } as typeof userSessions.$inferInsert).run();
  const specs = new SpecService(stores.specs, bus);
  const service = new RequirementService(stores.requirements, stores.projects, specs, bus, () => "proj1");
  const eventsOf = (type: string) =>
    db.select().from(eventsTable).where(eq(eventsTable.type, type)).all();
  return { service, specs, eventsOf, stores };
}

/** Propose + approve the fixture; ids come back minted r1..r6 in outline order. */
function approveFixture(service: RequirementService) {
  const draft = service.propose("us1", DOC, "initial");
  return service.approve(draft.id, { document: DOC, edited: false });
}

describe("propose / approve", () => {
  it("mints ids in outline order and stores the canonical fully-tagged document", () => {
    const { service } = makeHarness();
    const { revision, added } = approveFixture(service);
    expect(added).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(revision.document).toContain("- r1: Auth works end to end");
    expect(revision.document).toContain("  - r3 (any of): A config source loads");
    expect(service.derive("us1").map((node) => node.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
  });

  it("rejects a document with parse errors or unknown ids, with line numbers", () => {
    const { service } = makeHarness();
    expect(() => service.propose("us1", "just prose\n")).toThrow(RequirementParseFailure);
    expect(() => service.propose("us1", "## Requirements\n- r9: never minted\n"))
      .toThrow(/unknown requirement id "r9"/);
    approveFixture(service);
    expect(service.validateDocument("us1", "## Requirements\n- r1: Auth works end to end\n")).toEqual({ ok: true });
    const bad = service.validateDocument("us1", "## Requirements\n- r77: ghost\n");
    expect(bad.ok).toBe(false);
  });

  it("amendment: dropped id retires (cascading over refinement children), edited statement resets status", () => {
    const { service, eventsOf } = makeHarness();
    approveFixture(service);
    service.decompose({ userSessionId: "us1", parentId: "r6", children: [{ statement: "Server tests pass" }], actor: "main" });
    service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "command", ref: "curl /login" }], verifiedBy: "self", actor: "main" });

    const amended = `## Requirements
- r1: Auth works end to end, including logout
  - r2: Login issues a session token
  - r3 (any of): A config source loads
    - r4: TOML config parses
    - r5: JSON config parses
`;
    const draft = service.propose("us1", amended, "drop verify, extend auth");
    const { retired } = service.approve(draft.id, { document: amended, edited: true });
    // r6 dropped → retired, and its refinement child r7 cascades with it.
    expect(retired.sort()).toEqual(["r6", "r7"]);
    const nodes = service.derive("us1");
    expect(nodes.map((node) => node.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    // r1's statement changed → status reset path (was open anyway); r2's did
    // not → its satisfied claim SURVIVES the amendment.
    expect(nodes.find((node) => node.id === "r2")?.status).toBe("satisfied");
    expect(eventsOf("user_session.requirements.updated")).toHaveLength(2);
  });

  it("amendment resets a satisfied status when its statement text changes", () => {
    const { service } = makeHarness();
    approveFixture(service);
    service.reportStatus({ userSessionId: "us1", requirementId: "r6", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm run verify" }], verifiedBy: "self", actor: "main" });
    const amended = DOC.replace("`npm run verify` passes", "`npm run verify` passes from a clean checkout")
      .replace("- `npm", "- r6: `npm")
      .replace("- Auth works end to end", "- r1: Auth works end to end")
      .replace("  - Login issues a session token", "  - r2: Login issues a session token")
      .replace("  - (any of) A config source loads", "  - r3 (any of): A config source loads")
      .replace("    - TOML config parses", "    - r4: TOML config parses")
      .replace("    - JSON config parses", "    - r5: JSON config parses");
    const draft = service.propose("us1", amended);
    service.approve(draft.id, { document: amended, edited: false });
    expect(service.derive("us1").find((node) => node.id === "r6")?.status).toBe("open");
  });

  it("promotes a refinement node named in an approved document to committed", () => {
    const { service } = makeHarness();
    approveFixture(service);
    const [refined] = service.decompose({ userSessionId: "us1", parentId: "r1", children: [{ statement: "Sessions expire" }], actor: "main" });
    const amended = `## Requirements
- r1: Auth works end to end
  - r2: Login issues a session token
  - r3 (any of): A config source loads
    - r4: TOML config parses
    - r5: JSON config parses
  - ${refined}: Sessions expire
- r6: \`npm run verify\` passes
`;
    const draft = service.propose("us1", amended);
    service.approve(draft.id, { document: amended, edited: false });
    expect(service.derive("us1").find((node) => node.id === refined)).toMatchObject({ origin: "committed", introducedInRevision: 2 });
  });
});

describe("reportStatus", () => {
  it("requires evidence for terminal statuses (operator exempt) and rejects parents", () => {
    const { service } = makeHarness();
    approveFixture(service);
    expect(() => service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [], verifiedBy: "self", actor: "main" })).toThrow(/requires at least one evidence ref/);
    expect(() => service.reportStatus({ userSessionId: "us1", requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "file", ref: "x" }], verifiedBy: "self", actor: "main" })).toThrow(/report on the leaves instead: r2, r3/);
    // The operator's word is the gate — no evidence required.
    const wire = service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [], verifiedBy: "operator", actor: "operator" });
    expect(wire.latestChange).toMatchObject({ verifiedBy: "operator", evidenceCount: 0 });
  });

  it("derives parents mechanically: any-of closes on one alternative, all-of needs every child", () => {
    const { service, eventsOf } = makeHarness();
    approveFixture(service);
    const report = (id: string) => service.reportStatus({ userSessionId: "us1", requirementId: id, to: "satisfied",
      evidence: [{ kind: "command", ref: "check" }], verifiedBy: "independent", actor: "reviewer", agentSessionId: "as1" });
    report("r4");
    let nodes = new Map(service.derive("us1").map((node) => [node.id, node]));
    expect(nodes.get("r3")?.derivedStatus).toBe("satisfied"); // any-of: one branch suffices
    expect(nodes.get("r1")?.derivedStatus).toBe("open");      // r2 still open
    report("r2");
    report("r6");
    nodes = new Map(service.derive("us1").map((node) => [node.id, node]));
    expect(nodes.get("r1")?.derivedStatus).toBe("satisfied");
    expect(service.rootStatus("us1")).toBe("satisfied");
    expect(eventsOf("requirement.status.changed")).toHaveLength(3);
  });

  it("infeasible propagates: an all-of parent with an infeasible child is infeasible", () => {
    const { service } = makeHarness();
    approveFixture(service);
    service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "infeasible",
      evidence: [{ kind: "artifact", ref: "artifact_probe" }], verifiedBy: "self", actor: "main", note: "provider API retired" });
    expect(service.derive("us1").find((node) => node.id === "r1")?.derivedStatus).toBe("infeasible");
    expect(service.rootStatus("us1")).toBe("infeasible");
  });
});

describe("delegation", () => {
  it("journals delegations once per pair and scopes the subtree walk", () => {
    const { service, eventsOf } = makeHarness();
    approveFixture(service);
    service.delegate("us1", "as1", ["r1"], "commission");
    service.delegate("us1", "as1", ["r1"], "assignment"); // idempotent, no second event
    expect(service.delegationSet("as1")).toEqual(["r1"]);
    // r4 sits under r3 under r1 → within; r6 is outside.
    service.assertWithinDelegation("us1", "as1", "r4");
    expect(() => service.assertWithinDelegation("us1", "as1", "r6")).toThrow(/outside this session's delegated requirements \(r1\)/);
    expect(() => service.assertWithinDelegation("us1", "as2", "r4")).toThrow(/no delegated requirements/);
    expect(eventsOf("requirement.delegated")).toHaveLength(1);
    expect(() => service.delegate("us1", "as3", ["r99"], "commission")).toThrow(/no live requirement r99/);
  });

  it("decompose below a delegated node is visible and covered by the same subtree", () => {
    const { service } = makeHarness();
    approveFixture(service);
    service.delegate("us1", "as1", ["r3"], "commission");
    const added = service.decompose({ userSessionId: "us1", parentId: "r4",
      children: [{ statement: "Handles missing file" }], actor: "worker", agentSessionId: "as1" });
    expect(added).toEqual(["r7"]);
    service.assertWithinDelegation("us1", "as1", "r7");
    expect(service.derive("us1").find((node) => node.id === "r7")).toMatchObject({
      origin: "refinement", refinedByAgentSessionId: "as1", parentId: "r4",
    });
  });
});

describe("frontier", () => {
  it("lists open leaves with console-derived annotations; a satisfied any-of branch drops its siblings", () => {
    const { service } = makeHarness();
    approveFixture(service);
    service.setFrontierDeps({
      openAgentSessionIds: () => new Set(["as1"]),
      blockedRequirementIds: () => new Set(["r6"]),
      awaitingOperatorAgentSessionIds: () => new Set(["as1"]),
    });
    service.delegate("us1", "as1", ["r1"], "commission");
    service.reportStatus({ userSessionId: "us1", requirementId: "r4", to: "satisfied",
      evidence: [{ kind: "command", ref: "parse" }], verifiedBy: "self", actor: "worker", agentSessionId: "as1" });
    const frontier = service.frontier("us1");
    // r4 satisfied closes the any-of r3 — r5 can no longer affect the root.
    expect(frontier.map((entry) => entry.requirementId)).toEqual(["r2", "r6"]);
    expect(frontier[0]).toMatchObject({ requirementId: "r2", annotations: ["in_progress", "awaiting_operator"] });
    expect(frontier[1]).toMatchObject({ requirementId: "r6", annotations: ["blocked"] });
  });
});

describe("digest / pointer (the GoverningDigest contract)", () => {
  it("renders empty with nothing governing, falls back to the legacy spec, and prefers the graph", () => {
    const { service, specs } = makeHarness();
    expect(service.digest("us1")).toBe("");
    expect(service.pointer("us1")).toBeNull();

    const legacy = specs.propose("us1", "# Legacy spec\nacceptance prose");
    specs.approve(legacy.id, { document: "# Legacy spec\nacceptance prose", edited: false });
    expect(service.digest("us1")).toContain("Approved specification (rev 1");
    expect(service.pointer("us1")).toContain("spec rev 1");

    approveFixture(service);
    const digest = service.digest("us1");
    expect(digest).toContain("## Requirements (rev 1, authoritative");
    expect(digest).toContain("- [·] r1: Auth works end to end");
    expect(service.pointer("us1")).toBe("requirements rev 1 — 0/6 satisfied, 6 open");
  });

  it("shows statuses, keeps within the byte cap by collapsing satisfied subtrees, and snapshots for summaries", () => {
    const { service } = makeHarness();
    approveFixture(service);
    for (const id of ["r2", "r4", "r6"]) {
      service.reportStatus({ userSessionId: "us1", requirementId: id, to: "satisfied",
        evidence: [{ kind: "command", ref: "check" }], verifiedBy: "independent", actor: "reviewer" });
    }
    const digest = service.digest("us1");
    expect(digest).toContain("[✓] r2: Login issues a session token — satisfied, independent, 1 evidence");
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThan(8 * 1024 + 200);
    const snapshot = service.summarySnapshot("us1");
    expect(snapshot).toMatchObject({ revision: 1, counts: { satisfied: 5, open: 1 } });
    expect(snapshot?.outline).toContain("r1");
    const pointer = service.pointer("us1");
    expect(pointer).toBe("requirements rev 1 — 5/6 satisfied, 1 open");
  });

  it("stays under the cap on a very large graph", () => {
    const { service } = makeHarness();
    let doc = "## Requirements\n";
    for (let index = 0; index < 190; index += 1) {
      doc += `- Requirement number ${index} with a reasonably long statement that repeats itself for byte volume\n`;
    }
    const draft = service.propose("us1", doc);
    service.approve(draft.id, { document: doc, edited: false });
    const digest = service.digest("us1");
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(8 * 1024 + 300);
    expect(digest).toContain("…(truncated — read_requirements returns the full outline)");
  });
});

// Regressions from the pre-merge adversarial review.
describe("review regressions", () => {
  it("a retired id in a proposed document fails validation with a line error, never a constraint crash", () => {
    const { service } = makeHarness();
    approveFixture(service);
    const v2 = "## Requirements\n- r1: Auth works end to end\n  - r2: Login issues a session token\n  - r3 (any of): A config source loads\n    - r4: TOML config parses\n    - r5: JSON config parses\n";
    const draft2 = service.propose("us1", v2, "drop verify");
    service.approve(draft2.id, { document: v2, edited: false });
    const restore = `${v2}- r6: \`npm run verify\` passes\n`;
    const invalid = service.validateDocument("us1", restore);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors[0]?.message).toMatch(/retired in rev 2 — omit the id tag/);
    expect(() => service.propose("us1", restore)).toThrow(/retired in rev 2/);
  });

  it("the digest byte cap holds for multibyte outlines (bytes, not UTF-16 code units)", () => {
    const { service } = makeHarness();
    const doc = `## Requirements\n${Array.from({ length: 40 }, () => `- ${"要件は満たされる".repeat(30)}`).join("\n")}\n`;
    const draft = service.propose("us1", doc);
    service.approve(draft.id, { document: doc, edited: false });
    const digest = service.digest("us1");
    expect(digest).toContain("truncated");
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(8 * 1024 + 300);
  });

  it("a console statement-reset reaches the event bus, not just the table journal", () => {
    const { service, eventsOf } = makeHarness();
    approveFixture(service);
    service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm test" }], verifiedBy: "self", actor: "main" });
    const v2 = "## Requirements\n- r1: Auth works end to end\n  - r2: Login issues a SIGNED session token\n  - r3 (any of): A config source loads\n    - r4: TOML config parses\n    - r5: JSON config parses\n- r6: `npm run verify` passes\n";
    const draft = service.propose("us1", v2, "sharpen r2");
    service.approve(draft.id, { document: v2, edited: false });
    const reset = eventsOf("requirement.status.changed")
      .map((row) => row.payload as { requirementId?: string; from?: string; to?: string; verifiedBy?: string })
      .find((payload) => payload.requirementId === "r2" && payload.to === "open");
    expect(reset).toMatchObject({ from: "satisfied", verifiedBy: "console" });
  });

  it("sibling order stays deterministic when a refinement child ties a later committed sibling on ord", () => {
    const { service } = makeHarness();
    const doc = "## Requirements\n- Parent holds\n  - Child A\n";
    const draft = service.propose("us1", doc);
    service.approve(draft.id, { document: doc, edited: false }); // r1 + r2
    service.decompose({ userSessionId: "us1", parentId: "r1", children: [{ statement: "Refined child" }], actor: "main" }); // r3, ord 1
    const v2 = "## Requirements\n- r1: Parent holds\n  - r2: Child A\n  - Child B\n";
    const draft2 = service.propose("us1", v2, "add B");
    service.approve(draft2.id, { document: v2, edited: false }); // r4, document ord 1
    // Ord tie between committed r4 and refinement r3: committed wins, always.
    expect(service.derive("us1").map((node) => node.id)).toEqual(["r1", "r2", "r4", "r3"]);
  });
});

describe("decompose depth guard", () => {
  it("refuses children that would exceed the parser's maximum outline depth", () => {
    const { service } = makeHarness();
    approveFixture(service);
    // r6 sits at depth 0; refine a chain one level at a time. The parser
    // allows depths 0..7, so the child that would land at depth 8 is refused
    // with the amendment alternative — otherwise the next canonical render
    // would no longer round-trip through the shared grammar.
    let parentId = "r6";
    for (let depth = 1; depth <= 7; depth += 1) {
      const [added] = service.decompose({
        userSessionId: "us1", parentId, children: [{ statement: `Level ${depth} check` }], actor: "main",
      });
      parentId = added!;
    }
    expect(() => service.decompose({
      userSessionId: "us1", parentId, children: [{ statement: "Too deep" }], actor: "main",
    })).toThrow(/maximum outline depth/);
  });
});
