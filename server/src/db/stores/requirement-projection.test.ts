/**
 * The latest-claim projection's contract: `requirement_nodes.latest_change_id/
 * latest_change_ord` (and `status`) are DERIVED state the journal can always
 * rebuild — under randomized histories, corruption, and restart, the
 * incremental projection must equal the full authoritative derivation, and the
 * hot reads must stay proportional to the graph, never to journal length.
 * A fast wrong projection is worse than the slow correct fold it replaced, so
 * consistency is asserted against reference folds of the raw journal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../client.ts";
import { projects, requirementNodes, userSessions, workspaces } from "../schema.ts";
import { nowIso } from "../../ids.ts";
import { RequirementStore, type RequirementNodeStatus, type RequirementStatusChangeRow } from "./requirement-store.ts";

const TERMINAL = new Set(["satisfied", "violated", "infeasible"]);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function makeHarness(dbFile = ":memory:") {
  const { db, sqlite } = openDb(dbFile);
  const now = nowIso();
  db.insert(workspaces).values({ id: "ws1", name: "w", rootPath: `/tmp/req-projection-${Math.abs(hashOf(dbFile))}`, createdAt: now, updatedAt: now }).run();
  db.insert(projects).values({ id: "proj1", workspaceId: "ws1", title: null, intentDocument: null, createdAt: now }).run();
  db.insert(userSessions).values({ id: "us1", workspaceId: "ws1", projectId: "proj1", mode: "execute", title: "t", createdAt: now, updatedAt: now } as typeof userSessions.$inferInsert).run();
  return { db, sqlite, store: new RequirementStore(db, sqlite) };
}

function hashOf(text: string): number {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return hash;
}

/** Wrap the driver so every executed statement logs its SQL and row count. */
function instrument(sqlite: { prepare(sql: string): unknown }): { sql: string; rows: number }[] {
  const log: { sql: string; rows: number }[] = [];
  const orig = sqlite.prepare.bind(sqlite) as (sql: string) => Record<string, (...args: unknown[]) => unknown>;
  sqlite.prepare = ((sql: string) => {
    const stmt = orig(sql);
    for (const method of ["all", "get"] as const) {
      const original = (stmt[method] as (...args: unknown[]) => unknown).bind(stmt);
      stmt[method] = (...args: unknown[]) => {
        const out = original(...args);
        log.push({ sql, rows: method === "all" ? (out as unknown[]).length : out === undefined ? 0 : 1 });
        return out;
      };
    }
    return stmt;
  }) as typeof sqlite.prepare;
  return log;
}

/** Approve an initial graph: one root with `leaves` children r2..rN. */
function approveGraph(store: RequirementStore, leaves: number): string[] {
  const draft = store.insertDraft({ projectId: "proj1", userSessionId: "us1", document: "doc", graph: {}, baseRevision: 0 });
  const inserts = [
    { id: "r1", parentId: null, ord: 0, statement: "Root", composition: "all" as const, verifyExpectation: null },
    ...Array.from({ length: leaves }, (_, index) => ({
      id: `r${index + 2}`, parentId: "r1", ord: index, statement: `Leaf ${index + 2}`,
      composition: "all" as const, verifyExpectation: null,
    })),
  ];
  store.applyApproval({ revisionId: draft.id, document: "doc", graph: {}, edited: false, ops: { inserts, updates: [], retires: [] } });
  return inserts.map((insert) => insert.id);
}

/** Deterministic PRNG — the property sequences must replay identically. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pre-projection algorithm, kept as the oracle: fold the whole journal in clock order. */
function referenceLatest(store: RequirementStore, projectId: string): Map<string, RequirementStatusChangeRow> {
  const latest = new Map<string, RequirementStatusChangeRow>();
  for (const change of store.listStatusChanges(projectId)) latest.set(change.requirementId, change);
  return latest;
}

/** The pre-projection reversal fold — change id plus the withdrawn claim's id. */
function referenceReversals(store: RequirementStore, projectId: string): { id: string; originalId: string | null }[] {
  const out: { id: string; originalId: string | null }[] = [];
  const lastTerminal = new Map<string, string>();
  for (const change of store.listStatusChanges(projectId)) {
    if (TERMINAL.has(change.fromStatus) && change.toStatus !== change.fromStatus && change.actor !== "console") {
      out.push({ id: change.id, originalId: lastTerminal.get(change.requirementId) ?? null });
    }
    if (TERMINAL.has(change.toStatus)) lastTerminal.set(change.requirementId, change.id);
    else lastTerminal.delete(change.requirementId);
  }
  return out;
}

function assertProjectionConsistent(store: RequirementStore): void {
  expect(store.verifyCurrentState("proj1")).toEqual([]);
  const oracle = referenceLatest(store, "proj1");
  const projected = store.latestChanges("proj1");
  expect(new Map([...projected].map(([id, change]) => [id, change.id])))
    .toEqual(new Map([...oracle].map(([id, change]) => [id, change.id])));
  for (const node of store.listNodes("proj1")) {
    const latest = oracle.get(node.id);
    expect(node.status).toBe(latest === undefined ? "open" : latest.toStatus);
    expect(node.latestChangeId).toBe(latest?.id ?? null);
    expect(node.latestChangeOrd).toBe(latest?.ord ?? null);
  }
  const reversalRows = store.listReversalChanges("proj1").map((change) => {
    const prior = store.changeBefore("proj1", change.requirementId, change.ord);
    return { id: change.id, originalId: prior !== undefined && TERMINAL.has(prior.toStatus) ? prior.id : null };
  });
  expect(reversalRows).toEqual(referenceReversals(store, "proj1"));
}

describe("latest-claim projection consistency (incremental == full derivation)", () => {
  const STATUSES = ["open", "satisfied", "violated", "infeasible"] as const;
  const ACTORS = [
    { actor: "worker", verifiedBy: "self" as const },
    { actor: "checker", verifiedBy: "independent" as const },
    { actor: "operator", verifiedBy: "operator" as const },
  ];

  for (const seed of [7, 41, 1337]) {
    it(`randomized claim/amendment/retire/refine sequence stays consistent (seed ${seed})`, () => {
      const { store } = makeHarness();
      approveGraph(store, 10);
      const random = mulberry32(seed);
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
      let revision = 1;
      for (let step = 0; step < 120; step += 1) {
        const live = store.liveNodes("proj1");
        const roll = random();
        if (roll < 0.7) {
          // A claim on a live node — terminal statuses carry evidence, and a
          // same-status re-claim (tier upgrade) is a legal non-reversal.
          const node = pick(live);
          const to = pick(STATUSES);
          const { actor, verifiedBy } = pick(ACTORS);
          store.applyStatusChange({
            projectId: "proj1", userSessionId: "us1", requirementId: node.id, toStatus: to,
            evidence: to === "open" ? [] : [{ kind: "command", ref: `check-${step}` }],
            verifiedBy, actor, atRevision: revision,
          });
        } else if (roll < 0.85) {
          // An amendment statement-reset: journals a console change atomically
          // with the node update inside applyApproval's transaction.
          const node = pick(live);
          const draft = store.insertDraft({ projectId: "proj1", userSessionId: "us1", document: "doc", graph: {}, baseRevision: revision });
          store.applyApproval({
            revisionId: draft.id, document: "doc", graph: {}, edited: false,
            ops: { inserts: [], updates: [{ id: node.id, patch: { statement: `Amended ${step}` }, resetStatus: true }], retires: [] },
          });
          revision += 1;
        } else if (roll < 0.93) {
          // Retire a live leaf (journaled console transition + link cascade).
          const parents = new Set(live.map((node) => node.parentId).filter((id) => id !== null));
          const leaves = live.filter((node) => !parents.has(node.id) && node.parentId !== null);
          if (leaves.length <= 1) continue;
          const node = pick(leaves);
          const draft = store.insertDraft({ projectId: "proj1", userSessionId: "us1", document: "doc", graph: {}, baseRevision: revision });
          store.applyApproval({
            revisionId: draft.id, document: "doc", graph: {}, edited: false,
            ops: { inserts: [], updates: [], retires: [node.id] },
          });
          revision += 1;
        } else {
          // Refinement decomposition — fresh nodes start with a NULL pointer.
          const parent = pick(live);
          const next = store.maxNodeNumber("proj1") + 1;
          store.insertRefinementNodes({
            projectId: "proj1", parentId: parent.id, agentSessionId: null,
            children: [{ id: `r${next}`, ord: 99 + step, statement: `Refined ${step}`, composition: "all" }],
          });
        }
        if (step % 30 === 29) assertProjectionConsistent(store);
      }
      assertProjectionConsistent(store);
    });
  }

  it("survives restart: pointers are durable rows, not process state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-projection-"));
    dirs.push(dir);
    const dbFile = path.join(dir, "console.db");
    const first = makeHarness(dbFile);
    approveGraph(first.store, 3);
    first.store.applyStatusChange({
      projectId: "proj1", userSessionId: "us1", requirementId: "r2", toStatus: "satisfied",
      evidence: [{ kind: "command", ref: "npm test" }], verifiedBy: "self", actor: "worker", atRevision: 1,
    });
    first.sqlite.close();

    const { db, sqlite } = openDb(dbFile);
    const store = new RequirementStore(db, sqlite);
    expect(store.verifyCurrentState("proj1")).toEqual([]);
    const latest = store.latestChanges("proj1");
    expect(latest.get("r2")?.toStatus).toBe("satisfied");
    expect(latest.get("r2")?.actor).toBe("worker");
    sqlite.close();
  });
});

describe("corruption repair (verify + rebuild restore the journal's truth)", () => {
  it("detects nulled, stale, and status-flipped projection rows and rebuilds exactly them", () => {
    const { db, store } = makeHarness();
    approveGraph(store, 4);
    const claim = (id: string, to: "open" | "satisfied" | "violated" | "infeasible") =>
      store.applyStatusChange({
        projectId: "proj1", userSessionId: "us1", requirementId: id, toStatus: to,
        evidence: to === "open" ? [] : [{ kind: "command", ref: "check" }],
        verifiedBy: "self", actor: "worker", atRevision: 1,
      });
    claim("r2", "satisfied");
    claim("r2", "open");
    claim("r2", "satisfied");
    claim("r3", "violated");
    claim("r4", "satisfied");

    // Corrupt three nodes three different ways; r5 (never claimed) stays sound.
    const history = store.listStatusChanges("proj1", "r2");
    db.update(requirementNodes).set({ latestChangeId: null, latestChangeOrd: null }).where(nodeKey("r2")).run();
    db.update(requirementNodes).set({ latestChangeId: history[0]!.id, latestChangeOrd: history[0]!.ord }).where(nodeKey("r3")).run();
    db.update(requirementNodes).set({ status: "open" }).where(nodeKey("r4")).run();

    const mismatches = store.verifyCurrentState("proj1");
    expect(mismatches.map((entry) => entry.requirementId).sort()).toEqual(["r2", "r3", "r4"]);
    // Repair invents nothing: derived state is the journal's max-ord row.
    expect(mismatches.find((entry) => entry.requirementId === "r2")?.derived.changeId).toBe(history.at(-1)!.id);

    const repaired = store.rebuildCurrentState("proj1");
    expect(repaired.sort()).toEqual(["r2", "r3", "r4"]);
    expect(store.verifyCurrentState("proj1")).toEqual([]);
    expect(store.getNode("proj1", "r2")!.latestChangeId).toBe(history.at(-1)!.id);
    expect(store.getNode("proj1", "r3")!.latestChangeId).toBe(store.listStatusChanges("proj1", "r3").at(-1)!.id);
    expect(store.getNode("proj1", "r4")!.status).toBe("satisfied");
    expect(store.rebuildCurrentState("proj1")).toEqual([]);
  });
});

describe("query scope (reads scale with the graph, not with journal length)", () => {
  it("latest status is a keyed graph-sized read; the clock allocator is a LIMIT-1 seek", () => {
    const { sqlite, store } = makeHarness();
    const ids = approveGraph(store, 29);
    const leaves = ids.slice(1);
    // A deep history: 40 claims per leaf — 1160 journal rows for 30 nodes.
    for (let round = 0; round < 40; round += 1) {
      for (const id of leaves) {
        store.applyStatusChange({
          projectId: "proj1", userSessionId: "us1", requirementId: id,
          toStatus: round % 2 === 0 ? "satisfied" : "open",
          evidence: round % 2 === 0 ? [{ kind: "command", ref: `run-${round}` }] : [],
          verifiedBy: "self", actor: "worker", atRevision: 1,
        });
      }
    }
    expect(store.listStatusChanges("proj1").length).toBe(29 * 40);

    const log = instrument(sqlite);
    const latest = store.latestChanges("proj1");
    expect(latest.size).toBe(29);
    const journalReads = log.filter((entry) => entry.sql.includes("requirement_status_changes"));
    expect(journalReads.length).toBeGreaterThan(0);
    // Every statement touching the journal materializes at most one row per
    // graph node — never the 1160-row history.
    for (const entry of journalReads) expect(entry.rows).toBeLessThanOrEqual(30);

    log.length = 0;
    store.nextChangeOrd("proj1");
    for (const entry of log) expect(entry.rows).toBeLessThanOrEqual(1);
  });

  it("reversal listing rides its partial index, not a journal scan", () => {
    const { sqlite, store } = makeHarness();
    approveGraph(store, 2);
    store.applyStatusChange({
      projectId: "proj1", userSessionId: "us1", requirementId: "r2", toStatus: "satisfied",
      evidence: [{ kind: "command", ref: "check" }], verifiedBy: "self", actor: "worker", atRevision: 1,
    });
    store.applyStatusChange({
      projectId: "proj1", userSessionId: "us1", requirementId: "r2", toStatus: "open",
      evidence: [], verifiedBy: "self", actor: "worker", atRevision: 1,
    });
    const log = instrument(sqlite);
    expect(store.listReversalChanges("proj1")).toHaveLength(1);
    const query = log.find((entry) => entry.sql.includes("from_status IN"));
    expect(query).toBeDefined();
    // The literal predicate must keep implying the partial index's WHERE —
    // this pins the plan so a rephrasing cannot silently regress to a scan.
    const plan = (sqlite as unknown as { prepare(sql: string): { all(...args: unknown[]): { detail: string }[] } })
      .prepare(`EXPLAIN QUERY PLAN ${query!.sql}`).all("proj1");
    expect(plan.some((row) => row.detail.includes("requirement_status_changes_reversals"))).toBe(true);
  });
});

describe("service hot paths consume the projection", () => {
  it("one digest = one graph-sized latest-claim read, shared across the whole degradation ladder", async () => {
    const { EventBus } = await import("../../events/bus.ts");
    const { RequirementService } = await import("../../orchestrator/requirements.ts");
    const { createStores } = await import("./index.ts");
    const { db, sqlite } = openDb(":memory:");
    const stores = createStores(db, sqlite);
    const now = nowIso();
    db.insert(workspaces).values({ id: "ws1", name: "w", rootPath: "/tmp/req-projection-service", createdAt: now, updatedAt: now }).run();
    db.insert(projects).values({ id: "proj1", workspaceId: "ws1", title: null, intentDocument: null, createdAt: now }).run();
    db.insert(userSessions).values({ id: "us1", workspaceId: "ws1", projectId: "proj1", mode: "execute", title: "t", createdAt: now, updatedAt: now } as typeof userSessions.$inferInsert).run();
    const service = new RequirementService(stores.requirements, stores.projects, stores.assumptions, new EventBus(db, stores.artifacts), () => "proj1");

    const doc = `## Requirements\n${Array.from({ length: 24 }, (_, index) => `- Requirement number ${index + 1} holds`).join("\n")}\n`;
    const draft = service.propose("us1", doc, "initial");
    service.approve(draft.id, { document: doc, edited: false });
    // A deep claim history: 10 satisfy/reopen rounds per leaf → 480 journal rows.
    for (let round = 0; round < 10; round += 1) {
      for (let index = 1; index <= 24; index += 1) {
        service.reportStatus({ userSessionId: "us1", requirementId: `r${index}`, to: "satisfied",
          evidence: [{ kind: "command", ref: `run-${round}` }], claimant: { kind: "main" } });
        service.reportStatus({ userSessionId: "us1", requirementId: `r${index}`, to: "open",
          evidence: [], claimant: { kind: "main" } });
      }
    }

    const log = instrument(sqlite);
    expect(service.digest("us1")).toContain("rev 1");
    const digestJournalReads = log.filter((entry) => entry.sql.includes("requirement_status_changes"));
    // Exactly ONE journal-touching read for the whole digest — the ladder
    // shares it — and it materializes graph-many rows, not the 480-row history.
    expect(digestJournalReads).toHaveLength(1);
    expect(digestJournalReads[0]!.rows).toBeLessThanOrEqual(24);

    log.length = 0;
    expect(service.completionObligations("us1")).toHaveLength(24);
    for (const entry of log.filter((row) => row.sql.includes("requirement_status_changes"))) {
      expect(entry.rows).toBeLessThanOrEqual(24);
    }
    sqlite.close();
  });
});

function nodeKey(id: string) {
  return and(eq(requirementNodes.projectId, "proj1"), eq(requirementNodes.id, id));
}
