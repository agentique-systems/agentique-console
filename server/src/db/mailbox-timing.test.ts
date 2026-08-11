/**
 * `deliveredAt` means "when the recipient got it", not "when its turn ended".
 * Callers hold stale row snapshots (read while `queued`, so `deliveredAt` is
 * NULL in the objects they hold); the write-once invariant lives in the store,
 * so no caller can overwrite the real timestamp at settle.
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
    speaker: { kind: "orchestrator", name: "coordinator" }, to: "page",
    kind: "message", text: "assignment",
  });
  const id = newId("delivery");
  db.insert(mailboxDeliveries).values({
    id, messageId: message.id, userSessionId: "us_1", agentSessionId: "as_1",
    sender: "coordinator", recipient: "page", category: "assignment",
    status: "queued", dedupeKey: null,
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
    // The agent works for a while, then its turn settles and acks.
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
