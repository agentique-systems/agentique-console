/**
 * The requirement store's transactional guarantees: applyApproval is one unit
 * (supersede + approve + node diff + journaled resets), status changes journal
 * atomically with the node update, delegations are idempotent per pair, and
 * minted id numbers never reuse a retired node's number. Query key is the
 * PROJECT; user session ids ride along as attribution only.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../client.ts";
import { projects, userSessions, workspaces } from "../schema.ts";
import { nowIso } from "../../ids.ts";
import { RequirementStore } from "./requirement-store.ts";

function makeStore() {
  const { db, sqlite } = openDb(":memory:");
  const now = nowIso();
  db.insert(workspaces).values({ id: "ws1", name: "w", rootPath: "/tmp/requirement-store-test", createdAt: now, updatedAt: now }).run();
  db.insert(projects).values({ id: "proj1", workspaceId: "ws1", title: null, intentDocument: null, createdAt: now }).run();
  db.insert(userSessions).values({ id: "us1", workspaceId: "ws1", projectId: "proj1", mode: "execute", title: "t", createdAt: now, updatedAt: now } as typeof userSessions.$inferInsert).run();
  return new RequirementStore(db, sqlite);
}

function approveInitial(store: RequirementStore) {
  const draft = store.insertDraft({ projectId: "proj1", userSessionId: "us1", document: "doc v1", graph: {}, baseRevision: 0 });
  return store.applyApproval({
    revisionId: draft.id, document: "doc v1", graph: {}, edited: false,
    ops: {
      inserts: [
        { id: "r1", parentId: null, ord: 0, statement: "Parent", composition: "all", verifyExpectation: null },
        { id: "r2", parentId: "r1", ord: 0, statement: "Child A", composition: "all", verifyExpectation: null },
        { id: "r3", parentId: "r1", ord: 1, statement: "Child B", composition: "all", verifyExpectation: null },
      ],
      updates: [], retires: [],
    },
  });
}

describe("RequirementStore.applyApproval", () => {
  it("approves, inserts committed nodes, and revisions monotonically", () => {
    const store = makeStore();
    const approved = approveInitial(store);
    expect(approved.status).toBe("approved");
    expect(approved.revision).toBe(1);
    expect(store.liveNodes("proj1").map((node) => node.id)).toEqual(["r1", "r2", "r3"]);
    expect(store.nextRevision("proj1")).toBe(2);
  });

  it("amendment: statement change resets status with a journaled console change; dropped id retires", () => {
    const store = makeStore();
    approveInitial(store);
    store.applyStatusChange({
      projectId: "proj1", userSessionId: "us1", requirementId: "r2", toStatus: "satisfied",
      evidence: [{ kind: "command", ref: "npm test" }], verifiedBy: "self", actor: "worker", atRevision: 1,
    });
    store.applyStatusChange({
      projectId: "proj1", userSessionId: "us1", requirementId: "r3", toStatus: "satisfied",
      evidence: [{ kind: "file", ref: "src/x.ts" }], verifiedBy: "independent", actor: "reviewer", atRevision: 1,
    });

    const second = store.insertDraft({ projectId: "proj1", userSessionId: "us1", document: "doc v2", graph: {}, changeNote: "tighten", baseRevision: 1 });
    store.applyApproval({
      revisionId: second.id, document: "doc v2", graph: {}, edited: true,
      ops: {
        inserts: [{ id: "r4", parentId: null, ord: 1, statement: "New obligation", composition: "all", verifyExpectation: null }],
        updates: [
          { id: "r2", patch: { statement: "Child A, stricter" }, resetStatus: true },
          { id: "r1", patch: { ord: 0 }, resetStatus: false },
        ],
        retires: ["r3"],
      },
    });

    // r2's satisfied claim is stale against the new statement → open, journaled.
    expect(store.getNode("proj1", "r2")).toMatchObject({ statement: "Child A, stricter", status: "open" });
    const r2History = store.listStatusChanges("proj1", "r2");
    expect(r2History.at(-1)).toMatchObject({ toStatus: "open", verifiedBy: "console", note: "statement amended in rev 2" });
    // r3 retired with provenance; r1 untouched status-wise; r4 fresh and open.
    expect(store.getNode("proj1", "r3")).toMatchObject({ status: "retired", retiredInRevision: 2 });
    expect(store.listStatusChanges("proj1", "r3").at(-1)).toMatchObject({ toStatus: "retired", actor: "console" });
    expect(store.getNode("proj1", "r4")).toMatchObject({ status: "open", introducedInRevision: 2 });
    expect(store.getRevision(store.listRevisions("proj1")[0]!.id)?.status).toBe("superseded");
  });

  it("rolls the whole approval back when a node operation fails", () => {
    const store = makeStore();
    approveInitial(store);
    const second = store.insertDraft({ projectId: "proj1", userSessionId: "us1", document: "doc v2", graph: {}, baseRevision: 1 });
    expect(() => store.applyApproval({
      revisionId: second.id, document: "doc v2", graph: {}, edited: false,
      ops: { inserts: [], updates: [{ id: "r99", patch: { statement: "ghost" }, resetStatus: false }], retires: [] },
    })).toThrow(/unknown requirement/);
    // Nothing moved: first revision still approved, no half-applied nodes.
    expect(store.latestApproved("proj1")?.revision).toBe(1);
    expect(store.getRevision(second.id)?.status).toBe("draft");
    expect(store.liveNodes("proj1")).toHaveLength(3);
  });
});

describe("RequirementStore.applyStatusChange", () => {
  it("journals the prior status and updates the node atomically", () => {
    const store = makeStore();
    approveInitial(store);
    const { change, node } = store.applyStatusChange({
      projectId: "proj1", userSessionId: "us1", requirementId: "r2", toStatus: "infeasible",
      evidence: [{ kind: "artifact", ref: "artifact_x", label: "probe log" }],
      verifiedBy: "self", actor: "worker", agentSessionId: "as1", atRevision: 1, note: "API gone",
    });
    expect(change).toMatchObject({ fromStatus: "open", toStatus: "infeasible", actor: "worker", agentSessionId: "as1" });
    expect(node.status).toBe("infeasible");
    expect(store.latestChanges("proj1").get("r2")?.toStatus).toBe("infeasible");
  });

  it("throws on an unknown requirement", () => {
    const store = makeStore();
    approveInitial(store);
    expect(() => store.applyStatusChange({
      projectId: "proj1", userSessionId: "us1", requirementId: "nope", toStatus: "satisfied",
      evidence: [], verifiedBy: "self", actor: "worker", atRevision: 1,
    })).toThrow(/no requirement/);
  });
});

describe("RequirementStore refinement + delegations + minting", () => {
  it("inserts refinement nodes with provenance and revision 0", () => {
    const store = makeStore();
    approveInitial(store);
    const rows = store.insertRefinementNodes({
      projectId: "proj1", parentId: "r2", agentSessionId: "as1",
      children: [{ id: "r4", ord: 0, statement: "Sub-check", composition: "all" }],
    });
    expect(rows[0]).toMatchObject({ origin: "refinement", introducedInRevision: 0, refinedByAgentSessionId: "as1" });
    expect(store.liveNodes("proj1").map((node) => node.id)).toContain("r4");
  });

  it("delegations are idempotent per (session, requirement) pair", () => {
    const store = makeStore();
    approveInitial(store);
    const first = store.insertDelegations({ userSessionId: "us1", agentSessionId: "as1", requirementIds: ["r2", "r3"], source: "commission" });
    expect(first).toHaveLength(2);
    const again = store.insertDelegations({ userSessionId: "us1", agentSessionId: "as1", requirementIds: ["r2"], source: "assignment" });
    expect(again).toHaveLength(0);
    expect(store.delegationsFor("as1")).toHaveLength(2);
    expect(store.delegationsForUserSession("us1")).toHaveLength(2);
  });

  it("maxNodeNumber counts retired nodes so ids are never reused", () => {
    const store = makeStore();
    approveInitial(store);
    const second = store.insertDraft({ projectId: "proj1", userSessionId: "us1", document: "v2", graph: {}, baseRevision: 1 });
    store.applyApproval({
      revisionId: second.id, document: "v2", graph: {}, edited: false,
      ops: { inserts: [], updates: [], retires: ["r3"] },
    });
    expect(store.maxNodeNumber("proj1")).toBe(3);
  });
});
