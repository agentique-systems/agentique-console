import { describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { SqliteSessionStore } from "./session-store.ts";

function makeStore(): SqliteSessionStore {
  const { db } = openDb(":memory:");
  return new SqliteSessionStore(db);
}

const KEY = { projectKey: "proj", sessionId: "sess-1" };

describe("SqliteSessionStore", () => {
  it("round-trips entries in append order", async () => {
    const store = makeStore();
    await store.append(KEY, [
      { type: "user", uuid: "u1", text: "hi" },
      { type: "assistant", uuid: "a1", text: "hello" },
    ]);
    await store.append(KEY, [{ type: "user", uuid: "u2", text: "more" }]);
    const loaded = await store.load(KEY);
    expect(loaded?.map((e) => e.uuid)).toEqual(["u1", "a1", "u2"]);
  });

  it("returns null for a never-written key", async () => {
    const store = makeStore();
    expect(await store.load(KEY)).toBeNull();
  });

  it("dedupes uuid-bearing entries on re-append; uuid-less rows always insert", async () => {
    const store = makeStore();
    await store.append(KEY, [{ type: "user", uuid: "u1", text: "hi" }]);
    await store.append(KEY, [
      { type: "user", uuid: "u1", text: "hi" }, // crash-retry duplicate
      { type: "title" }, // uuid-less
      { type: "title" }, // uuid-less again
    ]);
    const loaded = await store.load(KEY);
    expect(loaded).toHaveLength(3);
    expect(loaded?.filter((e) => e.type === "title")).toHaveLength(2);
  });

  it("separates subpaths and lists them", async () => {
    const store = makeStore();
    await store.append(KEY, [{ type: "user", uuid: "u1" }]);
    await store.append({ ...KEY, subpath: "agent-a" }, [
      { type: "user", uuid: "s1" },
    ]);
    expect((await store.load(KEY))?.length).toBe(1);
    expect((await store.load({ ...KEY, subpath: "agent-a" }))?.length).toBe(1);
    expect(await store.listSubkeys(KEY)).toEqual(["agent-a"]);
  });

  it("lists sessions by project", async () => {
    const store = makeStore();
    await store.append(KEY, [{ type: "user", uuid: "u1" }]);
    await store.append({ projectKey: "proj", sessionId: "sess-2" }, [
      { type: "user", uuid: "u2" },
    ]);
    const sessions = await store.listSessions("proj");
    expect(sessions.map((s) => s.sessionId).toSorted()).toEqual([
      "sess-1",
      "sess-2",
    ]);
  });

  it("deletes a session", async () => {
    const store = makeStore();
    await store.append(KEY, [{ type: "user", uuid: "u1" }]);
    await store.delete(KEY);
    expect(await store.load(KEY)).toBeNull();
  });
});
