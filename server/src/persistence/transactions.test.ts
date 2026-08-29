import { describe, expect, it } from "vitest";
import { openHarness, seedRun } from "./test-support.ts";

const encode = (text: string) => new TextEncoder().encode(text);

describe("Transactor", () => {
  it("commits a successful root transaction and runs no rollback hook", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const calls: string[] = [];
      const before = h.ctx.journal.lastSeq();
      const message = h.ctx.tx.write(() => {
        h.ctx.tx.afterRollback(() => calls.push("outer"));
        return h.ctx.tx.write(() => {
          h.ctx.tx.afterRollback(() => calls.push("inner"));
          return h.stores.conversations.postMessage({ conversationId: s.conversation.id, author: "operator", content: "hi", runId: s.run.id, invocationId: null });
        });
      });
      expect(h.stores.conversations.listMessages(s.conversation.id)).toEqual([message]);
      expect(h.ctx.journal.lastSeq()).toBe(before + 1);
      expect(calls).toEqual([]);
      expect(h.ctx.tx.inTransaction).toBe(false);
      expect(h.ctx.tx.isRollbackOnly).toBe(false);
    } finally {
      h.close();
    }
  });

  it("an uncaught nested error rolls back the entire root transaction", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const before = h.ctx.journal.lastSeq();
      expect(() =>
        h.ctx.tx.write(() => {
          h.stores.conversations.postMessage({ conversationId: s.conversation.id, author: "operator", content: "first", runId: s.run.id, invocationId: null });
          h.ctx.tx.write(() => {
            h.stores.runs.transition(s.run.id, { to: "waiting", waitReason: "operator" });
            throw new Error("nested failure");
          });
        }),
      ).toThrow("nested failure");
      expect(h.stores.conversations.listMessages(s.conversation.id)).toEqual([]);
      expect(h.stores.runs.get(s.run.id).status).toBe("running");
      expect(h.ctx.journal.lastSeq()).toBe(before);
    } finally {
      h.close();
    }
  });

  it("a nested error swallowed by the outer callback still prevents commit and rethrows the nested error", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const before = h.ctx.journal.lastSeq();
      const original = new Error("original nested failure");
      let continued = false;
      expect(() =>
        h.ctx.tx.write(() => {
          h.stores.conversations.postMessage({ conversationId: s.conversation.id, author: "operator", content: "before", runId: s.run.id, invocationId: null });
          try {
            h.ctx.tx.write(() => {
              h.stores.runs.transition(s.run.id, { to: "waiting", waitReason: "operator" });
              throw original;
            });
          } catch {
            // deliberately swallowed
          }
          expect(h.ctx.tx.isRollbackOnly).toBe(true);
          h.stores.conversations.postMessage({ conversationId: s.conversation.id, author: "operator", content: "after", runId: s.run.id, invocationId: null });
          continued = true;
          return "would have committed";
        }),
      ).toThrow(original);
      expect(continued).toBe(true);
      expect(h.stores.conversations.listMessages(s.conversation.id)).toEqual([]);
      expect(h.stores.runs.get(s.run.id).status).toBe("running");
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.ctx.tx.inTransaction).toBe(false);
    } finally {
      h.close();
    }
  });

  it("the first nested failure is the canonical cause even when the outer callback throws its own error later", () => {
    const h = openHarness();
    try {
      const first = new Error("first");
      expect(() =>
        h.ctx.tx.write(() => {
          try {
            h.ctx.tx.write(() => {
              throw first;
            });
          } catch {
            // swallowed
          }
          throw new Error("second");
        }),
      ).toThrow(first);
    } finally {
      h.close();
    }
  });

  it("runs rollback hooks from every nesting depth exactly once, most recently registered first", () => {
    const h = openHarness();
    try {
      const calls: string[] = [];
      const causes: unknown[] = [];
      const failure = new Error("boom");
      expect(() =>
        h.ctx.tx.write(() => {
          h.ctx.tx.afterRollback((cause) => {
            calls.push("root-1");
            causes.push(cause);
          });
          h.ctx.tx.write(() => {
            h.ctx.tx.afterRollback(() => calls.push("nested-1"));
            h.ctx.tx.write(() => h.ctx.tx.afterRollback(() => calls.push("nested-2")));
          });
          h.ctx.tx.afterRollback(() => calls.push("root-2"));
          throw failure;
        }),
      ).toThrow(failure);
      expect(calls).toEqual(["root-2", "nested-2", "nested-1", "root-1"]);
      expect(causes).toEqual([failure]);
      // Hooks are cleared: a later rollback runs only its own hooks.
      expect(() =>
        h.ctx.tx.write(() => {
          h.ctx.tx.afterRollback(() => calls.push("second-tx"));
          throw new Error("again");
        }),
      ).toThrow("again");
      expect(calls).toEqual(["root-2", "nested-2", "nested-1", "root-1", "second-tx"]);
      // And a successful transaction after that runs none.
      h.ctx.tx.write(() => h.ctx.tx.afterRollback(() => calls.push("never")));
      expect(calls).toHaveLength(5);
    } finally {
      h.close();
    }
  });

  it("runs hooks for a rollback-only failure whose nested error was swallowed", () => {
    const h = openHarness();
    try {
      const calls: string[] = [];
      expect(() =>
        h.ctx.tx.write(() => {
          h.ctx.tx.afterRollback(() => calls.push("compensated"));
          try {
            h.ctx.tx.write(() => {
              throw new Error("swallowed");
            });
          } catch {
            // swallowed
          }
        }),
      ).toThrow("swallowed");
      expect(calls).toEqual(["compensated"]);
    } finally {
      h.close();
    }
  });

  it("rejects hook registration outside a transaction", () => {
    const h = openHarness();
    try {
      expect(() => h.ctx.tx.afterRollback(() => {})).toThrow(/requires an active write transaction/);
    } finally {
      h.close();
    }
  });

  it("a failing hook does not replace the canonical error; it is reported and attached", () => {
    const h = openHarness();
    try {
      const failure = new Error("canonical");
      const calls: string[] = [];
      let caught: unknown;
      try {
        h.ctx.tx.write(() => {
          h.ctx.tx.afterRollback(() => calls.push("first-registered"));
          h.ctx.tx.afterRollback(() => {
            throw new Error("hook exploded");
          });
          throw failure;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(calls).toEqual(["first-registered"]);
      expect((caught as { rollbackHookFailures?: unknown }).rollbackHookFailures).toEqual([{ index: 0, message: "hook exploded" }]);
      expect(h.diagnostics).toEqual([{ kind: "rollback_hook_failed", index: 0, message: "hook exploded" }]);
      expect(h.ctx.tx.inTransaction).toBe(false);
    } finally {
      h.close();
    }
  });

  it("rolls back on a commit failure and runs hooks", () => {
    const h = openHarness();
    try {
      const calls: string[] = [];
      // A deferred foreign-key violation surfaces at COMMIT, not at the statement.
      h.database.sqlite.pragma("defer_foreign_keys = ON");
      expect(() =>
        h.ctx.tx.write(() => {
          h.ctx.tx.afterRollback(() => calls.push("compensated"));
          h.database.sqlite
            .prepare("INSERT INTO conversations (id, workspace_id, title, active_run_id, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)")
            .run("cv_000000000000000000000000", "ws_000000000000000000000000", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
        }),
      ).toThrow(/FOREIGN KEY/);
      expect(calls).toEqual(["compensated"]);
      expect(h.database.sqlite.prepare("SELECT count(*) AS n FROM conversations").get()).toEqual({ n: 0 });
      expect(h.ctx.tx.inTransaction).toBe(false);
    } finally {
      h.close();
    }
  });

  it("remains usable for an independent write after a failed transaction with compensation", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      expect(() =>
        h.ctx.tx.write(() => {
          h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: null }, encode("doomed"));
          throw new Error("later failure");
        }),
      ).toThrow("later failure");
      expect(h.blobs.size).toBe(0);
      const artifact = h.stores.artifacts.create({ runId: s.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: null }, encode("kept"));
      expect(h.stores.artifacts.read(artifact.id).bytes).toEqual(encode("kept"));
      expect(h.blobs.size).toBe(1);
    } finally {
      h.close();
    }
  });
});
