/**
 * `deliveredAt` means "when the recipient got it", not "when its turn ended".
 *
 * db-live-2 reported these created→delivered latencies:
 *
 *     orchestrator→page   assignment   403.5s     (page's first entry: +1s)
 *     orchestrator→renderer assignment 417.7s
 *     orchestrator→check  assignment   417.6s
 *
 * All three are turn DURATIONS mislabelled as delivery latency — 6 of 12 rows.
 * The mechanism is a stale snapshot: `#deliverConsole` reads rows while they
 * are still `queued` (so `deliveredAt` is NULL in the objects it holds),
 * patches them to `delivered` in the DB without refreshing them, and hands the
 * same stale objects to `#mintTurn`. At settle, `delivery.deliveredAt ?? now`
 * saw the stale NULL and overwrote the correct earlier timestamp.
 *
 * The invariant now lives in the store, so no caller can reintroduce it.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "./client.ts";
import { Repo } from "./repo.ts";
import { mailboxDeliveries } from "./schema.ts";
import { newId, nowIso } from "../ids.ts";

function seedDelivery(repo: Repo, db: ReturnType<typeof openDb>["db"]): string {
  // The delivery row FKs to a real message, so mint one through the repo.
  const message = repo.appendMessage({
    sessionKind: "agent", sessionId: "as_1",
    speaker: { kind: "orchestrator", name: "orchestrator" }, to: "page",
    kind: "message", text: "assignment",
  });
  const id = newId("delivery");
  db.insert(mailboxDeliveries).values({
    id, messageId: message.id, userSessionId: "us_1", agentSessionId: "as_1",
    sender: "orchestrator", recipient: "page", category: "assignment",
    status: "queued", transport: "console", dedupeKey: null,
    deliveredAt: null, acknowledgedAt: null, createdAt: nowIso(),
  }).run();
  return id;
}

describe("mailbox delivery timestamps", () => {
  it("keeps the first deliveredAt when a later ack tries to restamp it", () => {
    const { db, sqlite } = openDb(":memory:");
    const repo = new Repo(db, sqlite);
    const id = seedDelivery(repo, db);

    const deliveredAt = "2026-08-09T10:00:00.000Z";
    repo.patchDelivery(id, { status: "delivered", deliveredAt });
    // The seat works for a while, then its turn settles and acks.
    const ackAt = "2026-08-09T10:06:43.500Z";
    repo.patchDelivery(id, { status: "acknowledged", acknowledgedAt: ackAt, deliveredAt: ackAt });

    const row = repo.getDeliveryById(id);
    expect(row?.deliveredAt).toBe(deliveredAt);   // NOT ackAt
    expect(row?.acknowledgedAt).toBe(ackAt);
    expect(row?.status).toBe("acknowledged");
  });

  it("fills deliveredAt in from the ack when delivery never stamped it", () => {
    const { db, sqlite } = openDb(":memory:");
    const repo = new Repo(db, sqlite);
    const id = seedDelivery(repo, db);

    const ackAt = "2026-08-09T10:06:43.500Z";
    repo.patchDelivery(id, { status: "acknowledged", acknowledgedAt: ackAt, deliveredAt: ackAt });

    expect(repo.getDeliveryById(id)?.deliveredAt).toBe(ackAt);
  });

  it("still honours the deliberate reset when rotation requeues a delivery", () => {
    const { db, sqlite } = openDb(":memory:");
    const repo = new Repo(db, sqlite);
    const id = seedDelivery(repo, db);
    repo.patchDelivery(id, { status: "delivered", deliveredAt: "2026-08-09T10:00:00.000Z" });

    // #maybeRotate requeues everything unacknowledged; that row must go back to
    // genuinely undelivered, or the next delivery's latency is measured from a
    // process that no longer exists.
    repo.patchDelivery(id, { status: "queued", deliveredAt: null });

    const row = repo.getDeliveryById(id);
    expect(row?.deliveredAt).toBeNull();
    expect(row?.status).toBe("queued");
  });
});
