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
import { events as eventsTable, userSessions, workspaces } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { nowIso } from "../ids.ts";
import { SpecService } from "./spec.ts";
import { RequirementParseFailure, RequirementService, deriveVerifiedBy } from "./requirements.ts";

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
  db.insert(userSessions).values({ id: "us1", workspaceId: "ws1", mode: "execute", title: "t", createdAt: now, updatedAt: now } as typeof userSessions.$inferInsert).run();
  const specs = new SpecService(stores.specs, bus);
  const service = new RequirementService(stores.requirements, specs, bus);
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
      evidence: [{ kind: "command", ref: "curl /login" }], claimant: { kind: "main" } });

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
      evidence: [{ kind: "command", ref: "npm run verify" }], claimant: { kind: "main" } });
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
      evidence: [], claimant: { kind: "main" } })).toThrow(/requires at least one evidence ref/);
    expect(() => service.reportStatus({ userSessionId: "us1", requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "file", ref: "x" }], claimant: { kind: "main" } })).toThrow(/report on the leaves instead: r2, r3/);
    // The operator's word is the gate — no evidence required.
    const wire = service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [], claimant: { kind: "operator" } });
    expect(wire.latestChange).toMatchObject({ verifiedBy: "operator", evidenceCount: 0 });
  });

  it("derives parents mechanically: any-of closes on one alternative, all-of needs every child", () => {
    const { service, eventsOf } = makeHarness();
    approveFixture(service);
    const report = (id: string) => service.reportStatus({ userSessionId: "us1", requirementId: id, to: "satisfied",
      evidence: [{ kind: "command", ref: "check" }], claimant: { kind: "seat", agentSessionId: "as1", agent: "reviewer", profileRole: "reviewer", profileTools: ["Read", "Glob", "Grep"] } });
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
      evidence: [{ kind: "artifact", ref: "artifact_probe" }], claimant: { kind: "main" }, note: "provider API retired" });
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
      evidence: [{ kind: "command", ref: "parse" }], claimant: { kind: "seat", agentSessionId: "as1", agent: "worker", profileRole: "implementer", profileTools: ["Read", "Edit", "Write"] } });
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
        evidence: [{ kind: "command", ref: "check" }], claimant: { kind: "seat", agentSessionId: "as1", agent: "reviewer", profileRole: "reviewer", profileTools: ["Read", "Glob", "Grep"] } });
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
      evidence: [{ kind: "command", ref: "npm test" }], claimant: { kind: "main" } });
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

describe("verification tier derivation", () => {
  it("derives the tier from the claimant, never from the reporting model", () => {
    expect(deriveVerifiedBy({ kind: "operator" })).toBe("operator");
    expect(deriveVerifiedBy({ kind: "main" })).toBe("self");
    // A write-isolated reviewer is the one seat whose claim is independent.
    expect(deriveVerifiedBy({ kind: "seat", agentSessionId: "as1", agent: "checker",
      profileRole: "reviewer", profileTools: ["Read", "Glob", "Grep", "Bash"] })).toBe("independent");
    // A reviewer profile holding an editing tool is not write-isolated.
    expect(deriveVerifiedBy({ kind: "seat", agentSessionId: "as1", agent: "checker",
      profileRole: "reviewer", profileTools: ["Read", "Edit"] })).toBe("self");
    // A write-capable implementer, a read-only coordinator relaying a claim,
    // and a legacy `{}` snapshot (undefined tools) all record self.
    expect(deriveVerifiedBy({ kind: "seat", agentSessionId: "as1", agent: "builder",
      profileRole: "implementer", profileTools: ["Read", "Edit", "Write"] })).toBe("self");
    expect(deriveVerifiedBy({ kind: "seat", agentSessionId: "as1", agent: "coordinator",
      profileRole: "orchestrator", profileTools: ["Read"] })).toBe("self");
    expect(deriveVerifiedBy({ kind: "seat", agentSessionId: "as1", agent: "ghost",
      profileRole: "reviewer", profileTools: undefined })).toBe("self");
  });

  it("records the derived tier and claimant attribution on the journal and event", () => {
    const { service, eventsOf } = makeHarness();
    approveFixture(service);
    const wire = service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "command", ref: "curl /login" }],
      claimant: { kind: "seat", agentSessionId: "as9", agent: "checker",
        profileRole: "reviewer", profileTools: ["Read"] } });
    expect(wire.latestChange).toMatchObject({ verifiedBy: "independent", actor: "checker", evidenceCount: 1 });
    const event = eventsOf("requirement.status.changed")
      .map((row) => row.payload as Record<string, unknown>)
      .find((payload) => payload.requirementId === "r2");
    expect(event).toMatchObject({ verifiedBy: "independent", actor: "checker", agentSessionId: "as9" });
  });

  it("the operator's verdict stays evidence-exempt; seat and main claims are not", () => {
    const { service } = makeHarness();
    approveFixture(service);
    expect(() => service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [], claimant: { kind: "seat", agentSessionId: "as1", agent: "checker",
        profileRole: "reviewer", profileTools: ["Read"] } })).toThrow(/requires at least one evidence ref/);
    const wire = service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [], claimant: { kind: "operator" } });
    expect(wire.latestChange).toMatchObject({ verifiedBy: "operator", actor: "operator", evidenceCount: 0 });
  });
});

describe("verification expectations and gaps", () => {
  const VDOC = `## Requirements
- (verify: independent) Auth works end to end
  - Login issues a session token
- \`npm run verify\` passes
`;
  /** r1 (verify: independent) with leaf r2 under it; r3 a bare top leaf. */
  function approveVerifyFixture(service: RequirementService) {
    const draft = service.propose("us1", VDOC, "initial");
    return service.approve(draft.id, { document: VDOC, edited: false });
  }
  const seatClaim = (agent: string, role: string, tools: string[]) =>
    ({ kind: "seat", agentSessionId: "as1", agent, profileRole: role, profileTools: tools }) as const;

  it("persists the marker through approval and re-renders it in the canonical document", () => {
    const { service } = makeHarness();
    const { revision } = approveVerifyFixture(service);
    expect(revision.document).toContain("- r1 (verify: independent): Auth works end to end");
    expect(service.derive("us1").find((node) => node.id === "r1")?.verifyExpectation).toBe("independent");
    expect(service.derive("us1").find((node) => node.id === "r2")?.verifyExpectation).toBeNull();
  });

  it("an expectation-only amendment updates the node WITHOUT resetting its status", () => {
    const { service, eventsOf } = makeHarness();
    approveVerifyFixture(service);
    service.reportStatus({ userSessionId: "us1", requirementId: "r3", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm run verify" }], claimant: { kind: "main" } });
    const v2 = `## Requirements
- r1 (verify: independent): Auth works end to end
  - r2: Login issues a session token
- r3 (verify: independent): \`npm run verify\` passes
`;
    const draft = service.propose("us1", v2, "declare verification for r3");
    service.approve(draft.id, { document: v2, edited: false });
    const r3 = service.derive("us1").find((node) => node.id === "r3");
    expect(r3).toMatchObject({ status: "satisfied", verifyExpectation: "independent" });
    const resets = eventsOf("requirement.status.changed")
      .map((row) => row.payload as { requirementId?: string; verifiedBy?: string; to?: string })
      .filter((payload) => payload.requirementId === "r3" && payload.verifiedBy === "console");
    expect(resets).toEqual([]);
    // The gap now derives from the standing self-tier claim — no reset needed.
    expect(service.verificationGaps("us1").map((gap) => gap.requirementId)).toContain("r3");
    // Dropping the marker clears the expectation (the document is truth).
    const v3 = v2.replace("- r3 (verify: independent):", "- r3:");
    const draft3 = service.propose("us1", v3, "drop it");
    service.approve(draft3.id, { document: v3, edited: false });
    expect(service.derive("us1").find((node) => node.id === "r3")?.verifyExpectation).toBeNull();
    expect(service.verificationGaps("us1").map((gap) => gap.requirementId)).not.toContain("r3");
  });

  it("gaps inherit the strongest ancestor declaration and rank operator above independent", () => {
    const { service } = makeHarness();
    approveVerifyFixture(service);
    // r2 sits under r1 (verify: independent). A self claim gaps; an
    // independent claim clears; an operator verdict also clears (≥ rank).
    service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "command", ref: "curl /login" }], claimant: { kind: "main" } });
    expect(service.verificationGaps("us1")).toMatchObject([
      { requirementId: "r2", expected: "independent", recorded: { verifiedBy: "self", actor: "main" } },
    ]);
    service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "journal", ref: "handoff_1" }], claimant: seatClaim("checker", "reviewer", ["Read"]) });
    expect(service.verificationGaps("us1")).toEqual([]);
    service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [], claimant: { kind: "operator" } });
    expect(service.verificationGaps("us1")).toEqual([]);
    // Reopening removes the gap subject entirely (nothing satisfied).
    service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "open",
      evidence: [], claimant: { kind: "main" } });
    expect(service.verificationGaps("us1")).toEqual([]);
  });

  it("an operator expectation is NOT satisfied by an independent claim", () => {
    const { service } = makeHarness();
    const doc = "## Requirements\n- (verify: operator) Release is signed off\n";
    const draft = service.propose("us1", doc);
    service.approve(draft.id, { document: doc, edited: false });
    service.reportStatus({ userSessionId: "us1", requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "journal", ref: "handoff_9" }], claimant: seatClaim("checker", "reviewer", ["Read"]) });
    expect(service.verificationGaps("us1")).toMatchObject([
      { requirementId: "r1", expected: "operator", recorded: { verifiedBy: "independent" } },
    ]);
  });

  it("decomposed children carry no expectation of their own but inherit the ancestor's", () => {
    const { service } = makeHarness();
    approveVerifyFixture(service);
    const [child] = service.decompose({ userSessionId: "us1", parentId: "r2",
      children: [{ statement: "Token refresh rotates" }], actor: "main" });
    service.reportStatus({ userSessionId: "us1", requirementId: child!, to: "satisfied",
      evidence: [{ kind: "command", ref: "check" }], claimant: { kind: "main" } });
    expect(service.derive("us1").find((node) => node.id === child)?.verifyExpectation).toBeNull();
    expect(service.verificationGaps("us1").map((gap) => gap.requirementId)).toContain(child);
  });

  it("the digest names gaps outside the collapsed body, bounded", () => {
    const { service } = makeHarness();
    // A graph big enough to trip the collapse-satisfied fallback (>8KiB).
    const lines = ["## Requirements", "- (verify: independent) Everything holds"];
    for (let i = 0; i < 120; i += 1) lines.push(`  - Leaf ${i} ${"x".repeat(60)}`);
    const doc = `${lines.join("\n")}\n`;
    const draft = service.propose("us1", doc);
    service.approve(draft.id, { document: doc, edited: false });
    const leaves = service.derive("us1").filter((node) => node.parentId !== null);
    for (const leaf of leaves) {
      service.reportStatus({ userSessionId: "us1", requirementId: leaf.id, to: "satisfied",
        evidence: [{ kind: "command", ref: "check" }], claimant: { kind: "main" } });
    }
    const digest = service.digest("us1");
    // The body collapsed the satisfied subtree, yet the gaps are named.
    expect(digest).toContain("Verification gaps (satisfied below their declared tier):");
    expect(digest).toContain("needs independent verification (claimed self by main)");
    // Bounded: at most 6 entries plus the overflow line.
    expect(digest).toContain("…and");
    expect(service.verificationGaps("us1")).toHaveLength(leaves.length);
  });

  it("the status outline renders the marker and the needs-verification chip", () => {
    const { service } = makeHarness();
    approveVerifyFixture(service);
    service.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "command", ref: "curl" }], claimant: { kind: "main" } });
    const digest = service.digest("us1");
    // r1 derives satisfied from its only child; the marker renders either way.
    expect(digest).toContain("- [✓] r1 (verify: independent): Auth works end to end");
    expect(digest).toContain("needs independent verification");
  });
});

describe("reversals", () => {
  const claim = (service: RequirementService, id: string, to: "open" | "satisfied" | "violated" | "infeasible",
    claimant: Parameters<RequirementService["reportStatus"]>[0]["claimant"] = { kind: "main" }) =>
    service.reportStatus({ userSessionId: "us1", requirementId: id, to,
      evidence: to === "open" ? [] : [{ kind: "command", ref: "check" }], claimant });

  it("records terminal claims the run later withdrew, attributed both ways", () => {
    const { service } = makeHarness();
    approveFixture(service);
    claim(service, "r2", "satisfied");
    claim(service, "r2", "open",
      { kind: "seat", agentSessionId: "as1", agent: "checker", profileRole: "reviewer", profileTools: ["Read"] });
    claim(service, "r6", "satisfied");
    claim(service, "r6", "violated");
    const reversals = service.reversals("us1");
    expect(reversals).toMatchObject([
      { requirementId: "r2", from: "satisfied", to: "open",
        reversedBy: { actor: "checker", verifiedBy: "independent" },
        original: { actor: "main", verifiedBy: "self", evidenceCount: 1 } },
      { requirementId: "r6", from: "satisfied", to: "violated",
        reversedBy: { actor: "main" }, original: { actor: "main", verifiedBy: "self" } },
    ]);
    // The summary snapshot carries them for the sign-off card.
    expect(service.summarySnapshot("us1")?.reversals).toHaveLength(2);
  });

  it("excludes console resets, retirements, and same-status re-claims", () => {
    const { service } = makeHarness();
    approveFixture(service);
    claim(service, "r2", "satisfied");
    // A reviewer re-claims satisfied (tier upgrade) — withdraws nothing.
    claim(service, "r2", "satisfied",
      { kind: "seat", agentSessionId: "as1", agent: "checker", profileRole: "reviewer", profileTools: ["Read"] });
    claim(service, "r6", "satisfied");
    // Amend r6's statement (console reset) and retire r4/r5 via an amendment.
    const amended = `## Requirements
- r1: Auth works end to end
  - r2: Login issues a session token
  - r3 (any of): A config source loads
    - r4: TOML config parses
    - r5: JSON config parses
- r6: \`npm run verify\` passes from a clean checkout
`;
    const draft = service.propose("us1", amended, "tighten r6");
    service.approve(draft.id, { document: amended, edited: false });
    expect(service.reversals("us1")).toEqual([]);
    // The operator's own reopen IS a reversal, attributed to them.
    claim(service, "r2", "open", { kind: "operator" });
    expect(service.reversals("us1")).toMatchObject([
      { requirementId: "r2", from: "satisfied", to: "open", reversedBy: { actor: "operator", verifiedBy: "operator" },
        original: { actor: "checker", verifiedBy: "independent" } },
    ]);
  });
});
