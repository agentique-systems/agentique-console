import { IllegalTransitionError, ValidationError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedRun } from "./test-support.ts";

describe("event journal", () => {
  it("refuses to append outside a write transaction", () => {
    const h = openHarness();
    try {
      expect(() =>
        h.ctx.journal.append({
          type: "workspace.created",
          scope: { workspaceId: "ws_000000000000000000000000", conversationId: null, runId: null, planNodeId: null, invocationId: null, attemptId: null },
          actor: { kind: "runtime" },
          subjectType: "workspace",
          subjectId: "ws_000000000000000000000000",
          payload: {} as never,
          correlationId: null,
          causationSeq: null,
        }),
      ).toThrow(/inside the transaction/);
      expect(h.ctx.journal.lastSeq()).toBe(0);
    } finally {
      h.close();
    }
  });

  it("validates payloads before writing and assigns a monotonic sequence", () => {
    const h = openHarness();
    try {
      const workspace = h.stores.workspaces.create({ name: "w", rootPath: "/w", kind: "git" });
      const events = h.ctx.journal.read({ workspaceId: workspace.id });
      expect(events.map((e) => e.type)).toEqual(["workspace.created"]);
      expect(events[0]?.seq).toBe(1);
      expect(events[0]?.payload).toEqual(workspace);
      expect(() =>
        h.ctx.tx.write(() =>
          h.ctx.journal.append({
            type: "workspace.updated",
            scope: { workspaceId: workspace.id, conversationId: null, runId: null, planNodeId: null, invocationId: null, attemptId: null },
            actor: { kind: "operator" },
            subjectType: "workspace",
            subjectId: workspace.id,
            payload: { nonsense: true } as never,
            correlationId: null,
            causationSeq: null,
          }),
        ),
      ).toThrow(ValidationError);
      expect(h.ctx.journal.lastSeq()).toBe(1);
    } finally {
      h.close();
    }
  });

  it("commits the Event and the projection together, or neither", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const before = h.ctx.journal.lastSeq();
      // Illegal transition: validated before any write, nothing appended.
      expect(() => h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: "snap_000000000000000000000000" })).toThrow(IllegalTransitionError);
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.runs.get(s.run.id).status).toBe("running");
      // A failure after the Event is appended rolls the Event back too: a
      // completed transition whose final Snapshot does not exist.
      h.stores.runs.transition(s.run.id, { to: "verifying" });
      h.stores.runs.transition(s.run.id, { to: "awaiting_signoff" });
      const mid = h.ctx.journal.lastSeq();
      expect(() => h.stores.runs.transition(s.run.id, { to: "completed", finalSnapshotId: "snap_000000000000000000000000" })).toThrow(/Snapshot .* not found/);
      expect(h.ctx.journal.lastSeq()).toBe(mid);
      expect(h.stores.runs.get(s.run.id).status).toBe("awaiting_signoff");
    } finally {
      h.close();
    }
  });

  it("rolls back every write of a nested transaction when the outer one fails", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const before = h.ctx.journal.lastSeq();
      expect(() =>
        h.ctx.tx.write(() => {
          h.stores.conversations.postMessage({ conversationId: s.conversation.id, author: "operator", content: "hi", runId: s.run.id, invocationId: null });
          h.stores.runs.transition(s.run.id, { to: "waiting", waitReason: "operator" });
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(h.ctx.journal.lastSeq()).toBe(before);
      expect(h.stores.conversations.listMessages(s.conversation.id)).toEqual([]);
      expect(h.stores.runs.get(s.run.id).status).toBe("running");
      expect(h.ctx.tx.inTransaction).toBe(false);
    } finally {
      h.close();
    }
  });

  it("reads by Run scope with causation and correlation references", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const created = h.ctx.journal.read({ runId: s.run.id, type: "run.created" })[0]!;
      h.stores.runs.transition(s.run.id, { to: "waiting", waitReason: "budget" }, { correlationId: "req-1", causationSeq: created.seq });
      const waiting = h.ctx.journal.read({ runId: s.run.id, type: "run.waiting" })[0]!;
      expect(waiting.correlationId).toBe("req-1");
      expect(waiting.causationSeq).toBe(created.seq);
      expect(waiting.scope.conversationId).toBe(s.conversation.id);
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: waiting.seq })).toEqual([]);
    } finally {
      h.close();
    }
  });
});
