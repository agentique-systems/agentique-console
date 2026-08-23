/**
 * Project continuity: the requirement graph, its ids, and its revision
 * counter belong to the PROJECT, so a later session opened onto the same
 * project reads and extends the same graph — and the single-writer guards
 * (one pending proposal, base-revision assertion) keep that continuation
 * sequentialized rather than merged.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { createStores } from "../db/stores/index.ts";
import { projects, userSessions, workspaces } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { nowIso } from "../ids.ts";
import { SpecService } from "./spec.ts";
import { RequirementService } from "./requirements.ts";

const DOC = `# Reading tracker

## Context
A reading tracker for one operator; privacy over sharing.

## Requirements
- Books can be recorded
- Progress is visible
`;

/** Two sessions on proj1 (sequential continuation), one on proj2 (fresh). */
function makeHarness() {
  const { db, sqlite } = openDb(":memory:");
  const stores = createStores(db, sqlite);
  const bus = new EventBus(db, stores.artifacts);
  const now = nowIso();
  db.insert(workspaces).values({ id: "ws1", name: "w", rootPath: "/tmp/req-continuity-test", createdAt: now, updatedAt: now }).run();
  for (const id of ["proj1", "proj2"]) {
    db.insert(projects).values({ id, workspaceId: "ws1", title: null, intentDocument: null, createdAt: now }).run();
  }
  const projectOf: Record<string, string> = { us1: "proj1", us2: "proj1", us3: "proj2" };
  for (const [id, projectId] of Object.entries(projectOf)) {
    db.insert(userSessions).values({
      id, workspaceId: "ws1", projectId, mode: "execute", title: "t", createdAt: now, updatedAt: now,
    } as typeof userSessions.$inferInsert).run();
  }
  const service = new RequirementService(
    stores.requirements, stores.projects, stores.assumptions, new SpecService(stores.specs, bus), bus,
    (userSessionId) => projectOf[userSessionId]!,
  );
  return { service, stores };
}

describe("project continuity", () => {
  it("a continued session reads and extends the prior session's graph, ids, and revisions", () => {
    const { service } = makeHarness();
    const draft = service.propose("us1", DOC, "initial");
    service.approve(draft.id, { document: DOC, edited: false });

    // Session B on the same project sees session A's committed graph.
    expect(service.governingRevision("us2")).toBe(1);
    expect(service.derive("us2").map((node) => node.id)).toEqual(["r1", "r2"]);
    // A fresh project sees nothing — no inheritance without continuation.
    expect(service.governingRevision("us3")).toBe(0);
    expect(service.derive("us3")).toEqual([]);

    // Session B amends: revision numbering and id minting CONTINUE.
    const amendment = `## Requirements
- r1: Books can be recorded
- r2: Progress is visible
- Books can be rated
`;
    const second = service.propose("us2", amendment, "add rating");
    expect(second.revision).toBe(2);
    const approved = service.approve(second.id, { document: amendment, edited: false });
    expect(approved.added).toEqual(["r3"]);
    expect(service.derive("us1").map((node) => node.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("rejects a stale draft at approval and marks its revision rejected", () => {
    const { service } = makeHarness();
    // Two drafts against revision 0 (the pending-proposal check is not wired
    // here, exactly to reach the assertion). Approving the second moves the
    // graph; the first is then stale and must be refused, not merged.
    const a = service.propose("us1", DOC);
    const b = service.propose("us1", DOC);
    service.approve(b.id, { document: DOC, edited: false });
    expect(() => service.approve(a.id, { document: DOC, edited: false })).toThrow(/stale proposal/);
    expect(service.getRevision(a.id)?.status).toBe("rejected");
  });

  it("refuses a new proposal while one is pending, once the check is wired", () => {
    const { service } = makeHarness();
    service.setPendingProposalCheck(() => true);
    expect(() => service.propose("us1", DOC)).toThrow(/already awaiting the operator/);
  });

  it("intentDocument: stored project prose wins; the approved document's prose is the fallback", () => {
    const { service, stores } = makeHarness();
    const draft = service.propose("us1", DOC);
    service.approve(draft.id, { document: DOC, edited: false });
    // No projects.intent_document written yet (that lands with vision
    // propagation) — the fallback reads the approved revision's stored graph.
    const fallback = service.intentDocument("us2");
    expect(fallback).toContain("# Reading tracker");
    expect(fallback).toContain("privacy over sharing");
    // A stored value outranks the fallback.
    stores.projects.setIntentDocument("proj1", "# Reading tracker\n\n## Context\nRevised prose.");
    expect(service.intentDocument("us1")).toContain("Revised prose.");
  });
});
