/**
 * Assumptions and requirement links: minting and lifecycle with provenance,
 * link validity (normalization, cycle rejection, idempotence), the
 * deterministic invalidation flags on the shared ordinal clock, and the
 * frontier's requirement-level blocking. Everything records and displays;
 * nothing here ever rewrites a requirement status.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { createStores } from "../db/stores/index.ts";
import { projects, userSessions, workspaces } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { nowIso } from "../ids.ts";
import { RequirementService } from "./requirements.ts";
import { AssumptionService } from "./assumptions.ts";

const DOC = `## Requirements
- Combat feels responsive
- The world persists between sessions
- Characters level up
`;

function makeHarness() {
  const { db, sqlite } = openDb(":memory:");
  const stores = createStores(db, sqlite);
  const bus = new EventBus(db, stores.artifacts);
  const now = nowIso();
  db.insert(workspaces).values({ id: "ws1", name: "w", rootPath: "/tmp/assumption-test", createdAt: now, updatedAt: now }).run();
  db.insert(projects).values({ id: "proj1", workspaceId: "ws1", title: null, intentDocument: null, createdAt: now }).run();
  db.insert(userSessions).values({ id: "us1", workspaceId: "ws1", projectId: "proj1", mode: "execute", title: "t", createdAt: now, updatedAt: now } as typeof userSessions.$inferInsert).run();
  const requirements = new RequirementService(stores.requirements, stores.projects, stores.assumptions, bus, () => "proj1");
  const assumptions = new AssumptionService(stores.assumptions, requirements, bus, () => "proj1");
  const draft = requirements.propose("us1", DOC, "initial");
  requirements.approve(draft.id, { document: DOC, edited: false });
  const wakes: string[] = [];
  requirements.setWakeNote((_id, text) => wakes.push(text));
  assumptions.setWakeNote((_id, text) => wakes.push(text));
  return { requirements, assumptions, wakes };
}

describe("assumption lifecycle and provenance", () => {
  it("mints project-lifetime ids, links rests_on, and refuses ungrounded resolutions", () => {
    const { assumptions } = makeHarness();
    const first = assumptions.record({ userSessionId: "us1", text: "WoW-like means real-time combat", source: "main", actor: "main", requirementIds: ["r1"] });
    expect(first.id).toBe("a1");
    expect(first.requirementIds).toEqual(["r1"]);

    // Falsified/confirmed need provenance; retired does not.
    expect(() => assumptions.resolve({ userSessionId: "us1", assumptionId: "a1", outcome: "falsified", actor: "main" }))
      .toThrow(/needs provenance/);
    assumptions.resolve({ userSessionId: "us1", assumptionId: "a1", outcome: "falsified", actor: "main",
      evidence: [{ kind: "url", ref: "https://example.com/design-notes" }] });
    // A resolved assumption stays resolved; ids never reuse.
    expect(() => assumptions.resolve({ userSessionId: "us1", assumptionId: "a1", outcome: "retired", actor: "main" }))
      .toThrow(/already resolved/);
    const second = assumptions.record({ userSessionId: "us1", text: "Persistence means a server, not a save file", source: "agent", actor: "scout" });
    expect(second.id).toBe("a2");
    // The operator's word is its own provenance.
    const resolved = assumptions.resolve({ userSessionId: "us1", assumptionId: "a2", outcome: "confirmed", actor: "operator" });
    expect(resolved.status).toBe("confirmed");
  });

  it("a falsification flags dependent terminal claims (ordinal clock) and wakes main; reopening clears the flag", () => {
    const { requirements, assumptions, wakes } = makeHarness();
    const premise = assumptions.record({ userSessionId: "us1", text: "Real-time combat", source: "main", actor: "main", requirementIds: ["r1"] });
    requirements.reportStatus({ userSessionId: "us1", requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm test" }], claimant: { kind: "seat", agentSessionId: "as1", agent: "checker", profileRole: "reviewer", profileTools: ["Read", "Glob", "Grep"] } });

    assumptions.resolve({ userSessionId: "us1", assumptionId: premise.id, outcome: "falsified", actor: "main",
      evidence: [{ kind: "journal", ref: "handoff_x" }] });
    const r1 = requirements.derive("us1").find((node) => node.id === "r1")!;
    expect(r1.flags).toContain("rests_on_falsified");
    expect(r1.restsOn).toEqual([{ id: "a1", status: "falsified" }]);
    expect(wakes.join(" ")).toContain("a1");
    expect(wakes.join(" ")).toContain("r1 (satisfied)");
    // The Console changed nothing — the claim still stands until someone acts.
    expect(r1.status).toBe("satisfied");

    // A NEW claim on the node clears the flag: its ord passes the resolution's.
    requirements.reportStatus({ userSessionId: "us1", requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm test -- --grep realtime" }], claimant: { kind: "seat", agentSessionId: "as1", agent: "checker", profileRole: "reviewer", profileTools: ["Read", "Glob", "Grep"] } });
    expect(requirements.derive("us1").find((node) => node.id === "r1")!.flags).toEqual([]);
  });

  it("a falsification recorded BEFORE any claim never flags it", () => {
    const { requirements, assumptions } = makeHarness();
    const premise = assumptions.record({ userSessionId: "us1", text: "SQLite suffices", source: "main", actor: "main", requirementIds: ["r2"] });
    assumptions.resolve({ userSessionId: "us1", assumptionId: premise.id, outcome: "falsified", actor: "operator" });
    requirements.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "file", ref: "src/persistence.ts" }], claimant: { kind: "main" } });
    // The claim postdates the falsification — whoever claimed knew.
    expect(requirements.derive("us1").find((node) => node.id === "r2")!.flags).toEqual([]);
  });
});

describe("requirement links", () => {
  it("depends_on is acyclic and idempotent; a dependency moving later flags dependents and wakes main", () => {
    const { requirements, wakes } = makeHarness();
    expect(requirements.link({ userSessionId: "us1", fromId: "r3", kind: "depends_on", toId: "r2", actor: "main" }))
      .toEqual({ recorded: true });
    expect(requirements.link({ userSessionId: "us1", fromId: "r3", kind: "depends_on", toId: "r2", actor: "main" }))
      .toEqual({ recorded: false });
    expect(() => requirements.link({ userSessionId: "us1", fromId: "r2", kind: "depends_on", toId: "r3", actor: "main" }))
      .toThrow(/cycle/);
    expect(() => requirements.link({ userSessionId: "us1", fromId: "r2", kind: "depends_on", toId: "r2", actor: "main" }))
      .toThrow(/itself/);

    // r3's claim, then r2 (its dependency) is reported violated afterwards.
    requirements.reportStatus({ userSessionId: "us1", requirementId: "r3", to: "satisfied",
      evidence: [{ kind: "command", ref: "npm test" }], claimant: { kind: "main" } });
    requirements.reportStatus({ userSessionId: "us1", requirementId: "r2", to: "violated",
      evidence: [{ kind: "journal", ref: "handoff_y" }], claimant: { kind: "seat", agentSessionId: "as1", agent: "checker", profileRole: "reviewer", profileTools: ["Read", "Glob", "Grep"] } });
    const r3 = requirements.derive("us1").find((node) => node.id === "r3")!;
    expect(r3.flags).toContain("depends_changed");
    expect(r3.dependsOn).toEqual(["r2"]);
    expect(wakes.join(" ")).toContain("r3");
  });

  it("conflicts_with is symmetric: normalized storage, inverse duplicate blocked, both directions render", () => {
    const { requirements } = makeHarness();
    // Recorded high→low; stored low→high, so the inverse insert collides.
    expect(requirements.link({ userSessionId: "us1", fromId: "r3", kind: "conflicts_with", toId: "r1", actor: "main" }))
      .toEqual({ recorded: true });
    expect(requirements.link({ userSessionId: "us1", fromId: "r1", kind: "conflicts_with", toId: "r3", actor: "main" }))
      .toEqual({ recorded: false });
    const nodes = requirements.derive("us1");
    expect(nodes.find((node) => node.id === "r1")!.conflictsWith).toEqual(["r3"]);
    expect(nodes.find((node) => node.id === "r3")!.conflictsWith).toEqual(["r1"]);
  });

  it("an open leaf whose depends_on target is unsatisfied is BLOCKED on the frontier; retirement cascades links", () => {
    const { requirements } = makeHarness();
    requirements.link({ userSessionId: "us1", fromId: "r3", kind: "depends_on", toId: "r1", actor: "main" });
    const entry = requirements.frontier("us1").find((row) => row.requirementId === "r3");
    expect(entry?.annotations).toContain("blocked");

    // Retiring r1 takes its links with it — r3 unblocks.
    const amended = `## Requirements
- r2: The world persists between sessions
- r3: Characters level up
`;
    const draft = requirements.propose("us1", amended, "drop combat");
    requirements.approve(draft.id, { document: amended, edited: false });
    const after = requirements.frontier("us1").find((row) => row.requirementId === "r3");
    expect(after?.annotations).not.toContain("blocked");
    expect(requirements.liveLinks("us1")).toEqual([]);
  });
});
