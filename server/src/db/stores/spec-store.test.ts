/**
 * The approve() transaction: supersede + approve are one unit. A failure
 * after the supersede statement must roll the supersede back — the run must
 * never be left with ZERO approved revisions, because digest() would render
 * empty and every prompt would silently lose the governing spec.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../client.ts";
import { projects, userSessions, workspaces } from "../schema.ts";
import { nowIso } from "../../ids.ts";
import { SpecStore } from "./spec-store.ts";

function makeStore() {
  const { db, sqlite } = openDb(":memory:");
  const now = nowIso();
  db.insert(workspaces).values({ id: "ws1", name: "w", rootPath: "/tmp/spec-store-test", createdAt: now, updatedAt: now }).run();
  db.insert(projects).values({ id: "proj1", workspaceId: "ws1", title: null, intentDocument: null, createdAt: now }).run();
  db.insert(userSessions).values({ id: "us1", workspaceId: "ws1", projectId: "proj1", mode: "execute", title: "t", createdAt: now, updatedAt: now } as typeof userSessions.$inferInsert).run();
  return new SpecStore(db, sqlite);
}

describe("SpecStore.approve", () => {
  it("supersedes the previous approved revision and approves the new one", () => {
    const store = makeStore();
    const first = store.insertDraft({ userSessionId: "us1", document: "v1" });
    store.approve(first.id, { document: "v1", edited: false });
    const second = store.insertDraft({ userSessionId: "us1", document: "v2", changeNote: "tighter scope" });
    store.approve(second.id, { document: "v2 final", edited: true });

    expect(store.get(first.id)?.status).toBe("superseded");
    const approved = store.latestApproved("us1");
    expect(approved).toMatchObject({ id: second.id, status: "approved", document: "v2 final", origin: "operator_edited" });
    expect(store.listForUserSession("us1").filter((row) => row.status === "approved")).toHaveLength(1);
  });

  it("rolls back the supersede when the approve statement fails", () => {
    const store = makeStore();
    const first = store.insertDraft({ userSessionId: "us1", document: "v1" });
    store.approve(first.id, { document: "v1", edited: false });
    const second = store.insertDraft({ userSessionId: "us1", document: "v2" });

    // NOT NULL on document makes the second statement throw AFTER the
    // supersede has run inside the same transaction.
    expect(() => store.approve(second.id, { document: null as unknown as string, edited: false })).toThrow();

    expect(store.get(first.id)?.status).toBe("approved");
    expect(store.get(second.id)?.status).toBe("draft");
    expect(store.latestApproved("us1")?.id).toBe(first.id);

    // The failed approval is retryable and lands cleanly.
    store.approve(second.id, { document: "v2", edited: false });
    expect(store.get(first.id)?.status).toBe("superseded");
    expect(store.latestApproved("us1")?.id).toBe(second.id);
  });
});
