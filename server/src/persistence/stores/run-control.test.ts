/**
 * The Run store's operator pause and resume (execution-model §3, §14): one
 * durable write each, the closed change outcomes, the Events, the
 * precedence of the pause over every automatic transition, and the schema
 * invariants that make the pause a fact of the row.
 */
import { ConflictError, RunControlRefusedError } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, DEFAULT_FINAL_RESERVE, openHarness, seedRun, seedSignoffBoundary } from "../test-support.ts";

const NO_EVALUATOR = { evaluatorAgentDefinitionRevisionId: null, maxNodeGateCycles: 3, maxRunCompletionCycles: 3, runCompletionAcceptanceCriterionIds: [] };

describe("RunStore pause and resume", () => {
  it("pauses a running Run into waiting on operator, escalates soft to hard, never weakens hard, refuses automatic transitions meanwhile, and resumes to running", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const seq = h.ctx.journal.lastSeq();
      const paused = h.stores.runs.pause(s.run.id, "soft");
      expect(paused).toMatchObject({ change: "paused", run: { status: "waiting", waitReason: "operator", operatorPause: "soft" } });
      expect(h.stores.runs.get(s.run.id)).toEqual(paused.run);
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: seq }).map((e) => [e.type, e.payload])).toEqual([
        ["run.paused", { runId: s.run.id, mode: "soft", status: "waiting", previousWaitReason: null, escalated: false }],
        ["run.waiting", { from: "running", to: "waiting", waitReason: "operator" }],
      ]);
      // A repeated soft pause changes nothing and journals nothing.
      const afterPause = h.ctx.journal.lastSeq();
      expect(h.stores.runs.pause(s.run.id, "soft")).toMatchObject({ change: "unchanged", run: { operatorPause: "soft" } });
      expect(h.ctx.journal.lastSeq()).toBe(afterPause);
      // A hard pause escalates the soft one; a soft pause never weakens the hard one.
      expect(h.stores.runs.pause(s.run.id, "hard")).toMatchObject({ change: "escalated", run: { status: "waiting", waitReason: "operator", operatorPause: "hard" } });
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: afterPause }).map((e) => [e.type, e.payload])).toEqual([["run.paused", { runId: s.run.id, mode: "hard", status: "waiting", previousWaitReason: null, escalated: true }]]);
      const afterEscalation = h.ctx.journal.lastSeq();
      expect(h.stores.runs.pause(s.run.id, "soft")).toMatchObject({ change: "unchanged", run: { operatorPause: "hard" } });
      expect(h.stores.runs.pause(s.run.id, "hard")).toMatchObject({ change: "unchanged", run: { operatorPause: "hard" } });
      expect(h.ctx.journal.lastSeq()).toBe(afterEscalation);
      // The pause has precedence: no automatic transition moves a paused Run, and the operator wait is never cleared by a running transition.
      expect(() => h.stores.runs.transition(s.run.id, { to: "running", clearedWaitReason: "operator" })).toThrow(ConflictError);
      expect(() => h.stores.runs.transition(s.run.id, { to: "running", clearedWaitReason: "budget" })).toThrow(ConflictError);
      expect(h.stores.runs.get(s.run.id)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "hard" });
      // Resume clears the pause and nothing else; the Run returns to running with the exact clearing Event.
      const resumed = h.stores.runs.resume(s.run.id);
      expect(resumed).toMatchObject({ change: "resumed", cleared: "hard", run: { status: "running", waitReason: null, operatorPause: null } });
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: afterEscalation }).map((e) => [e.type, e.payload])).toEqual([
        ["run.resumed", { runId: s.run.id, mode: "hard", status: "running" }],
        ["run.wait_cleared", { from: "waiting", to: "running", clearedWaitReason: "operator" }],
      ]);
      const afterResume = h.ctx.journal.lastSeq();
      expect(h.stores.runs.resume(s.run.id)).toMatchObject({ change: "not_paused", cleared: null, run: { status: "running", operatorPause: null } });
      expect(h.ctx.journal.lastSeq()).toBe(afterResume);
      // Ordinary transitions work again once resumed.
      expect(h.stores.runs.transition(s.run.id, { to: "waiting", waitReason: "budget" }).waitReason).toBe("budget");
    } finally {
      h.close();
    }
  });

  it("supersedes an automatic wait without restoring it, holds the pause beside verifying and awaiting_signoff, refuses created and ended Runs, and lets cancellation clear it", () => {
    const h = openHarness();
    try {
      // A waiting Run: the operator's reason supersedes the automatic one; a resume returns to running, never to the old reason.
      const s = seedRun(h);
      h.stores.runs.transition(s.run.id, { to: "waiting", waitReason: "budget" });
      const seq = h.ctx.journal.lastSeq();
      expect(h.stores.runs.pause(s.run.id, "soft")).toMatchObject({ change: "paused", run: { status: "waiting", waitReason: "operator", operatorPause: "soft" } });
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: seq }).map((e) => [e.type, e.payload])).toEqual([["run.paused", { runId: s.run.id, mode: "soft", status: "waiting", previousWaitReason: "budget", escalated: false }]]);
      expect(h.stores.runs.resume(s.run.id)).toMatchObject({ change: "resumed", cleared: "soft", run: { status: "running", waitReason: null, operatorPause: null } });
      // A verifying Run keeps its status; the completion engine's transitions are refused until resumed.
      h.stores.runs.transition(s.run.id, { to: "verifying" });
      expect(h.stores.runs.pause(s.run.id, "hard")).toMatchObject({ change: "paused", run: { status: "verifying", waitReason: null, operatorPause: "hard" } });
      expect(() => h.stores.runs.transition(s.run.id, { to: "awaiting_signoff" })).toThrow(ConflictError);
      expect(() => h.stores.runs.transition(s.run.id, { to: "running" })).toThrow(ConflictError);
      const beforeResume = h.ctx.journal.lastSeq();
      expect(h.stores.runs.resume(s.run.id)).toMatchObject({ change: "resumed", cleared: "hard", run: { status: "verifying", operatorPause: null } });
      expect(h.ctx.journal.read({ runId: s.run.id, afterSeq: beforeResume }).map((e) => [e.type, e.payload])).toEqual([["run.resumed", { runId: s.run.id, mode: "hard", status: "verifying" }]]);
      // A Run awaiting signoff keeps its status too, and its cancellation clears the pause with the Run.
      const s2 = seedRun(h);
      seedSignoffBoundary(h, s2);
      expect(h.stores.runs.pause(s2.run.id, "soft")).toMatchObject({ change: "paused", run: { status: "awaiting_signoff", waitReason: null, operatorPause: "soft" } });
      expect(() => h.stores.runs.transition(s2.run.id, { to: "completed", finalSnapshotId: s2.run.id as never, finalChangesetId: s2.run.id as never })).toThrow(ConflictError);
      const cancelled = h.stores.runs.transition(s2.run.id, { to: "cancelled" });
      expect(cancelled).toMatchObject({ status: "cancelled", waitReason: null, operatorPause: null });
      expect(cancelled.endedAt).not.toBeNull();
      // Ended Runs are neither paused nor resumed; a created Run has nothing to withhold.
      expect(() => h.stores.runs.pause(s2.run.id, "soft")).toThrow(RunControlRefusedError);
      expect(() => h.stores.runs.pause(s2.run.id, "soft")).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
      expect(() => h.stores.runs.resume(s2.run.id)).toThrow(expect.objectContaining({ refusal: "run_terminal" }));
      const created = h.stores.runs.create({ conversationId: s2.conversation.id, kind: "code", target: { kind: "branch", branch: "main" }, budget: DEFAULT_BUDGET, finalReserve: DEFAULT_FINAL_RESERVE, verificationPolicy: NO_EVALUATOR });
      expect(() => h.stores.runs.pause(created.id, "hard")).toThrow(expect.objectContaining({ refusal: "not_started" }));
      expect(h.stores.runs.resume(created.id)).toMatchObject({ change: "not_paused", run: { status: "created", operatorPause: null } });
      expect(h.stores.runs.get(created.id)).toMatchObject({ status: "created", operatorPause: null });
    } finally {
      h.close();
    }
  });

  it("the schema refuses an operator wait without a pause, a pause on a running or ended Run, and a mode outside the closed set", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const update = (sql: string) => h.database.sqlite.prepare(`UPDATE runs SET ${sql} WHERE id = ?`).run(s.run.id);
      expect(() => update("status = 'waiting', wait_reason = 'operator'")).toThrow(/CHECK/);
      expect(() => update("operator_pause = 'soft'")).toThrow(/CHECK/);
      expect(() => update("status = 'waiting', wait_reason = 'budget', operator_pause = 'soft'")).toThrow(/CHECK/);
      h.stores.runs.pause(s.run.id, "soft");
      expect(() => update("operator_pause = 'medium'")).toThrow(/CHECK/);
      expect(() => update("wait_reason = 'budget'")).toThrow(/CHECK/);
      expect(() => update("status = 'cancelled', wait_reason = NULL, ended_at = '2026-01-01T00:00:00.000Z'")).toThrow(/CHECK/);
      expect(h.stores.runs.get(s.run.id)).toMatchObject({ status: "waiting", waitReason: "operator", operatorPause: "soft" });
    } finally {
      h.close();
    }
  });
});
