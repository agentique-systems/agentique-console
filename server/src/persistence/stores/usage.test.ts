import { describe, expect, it } from "vitest";
import { extendPlan, nodeInput, openHarness, patternDefinition, seedInvocation, seedManifest, seedRun } from "../test-support.ts";

describe("usage", () => {
  it("records per Attempt with Run, Plan Node, and Invocation attribution and rolls up by sum", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const node = nodeInput(h, patternDefinition(s.definition.id, { sourcePath: "e1" }));
      extendPlan(h, s, [node]);
      const rootInvocation = seedInvocation(h, s);
      seedManifest(h, s, rootInvocation);
      const workerInvocation = seedInvocation(h, s, { planNodeId: node.id, role: "worker", purpose: "step" });
      seedManifest(h, s, workerInvocation);
      const a1 = h.stores.invocations.createAttempt({ invocationId: rootInvocation.id, startMode: "fresh", resumedFromAttemptId: null });
      const b1 = h.stores.invocations.createAttempt({ invocationId: workerInvocation.id, startMode: "fresh", resumedFromAttemptId: null });
      const record = (attemptId: string, cost: number, output: number, cached: number) =>
        h.stores.usage.record({ attemptId: attemptId as never, model: "claude-fable-5", effort: "medium", inputTokensUncached: 100, cacheCreationTokens: 10, cacheReadTokens: cached, outputTokens: output, costUsd: cost, wallClockMs: 1000, providerMs: 900 });
      const row = record(a1.id, 0.5, 50, 300);
      expect(row.runId).toBe(s.run.id);
      expect(row.planNodeId).toBe(s.root.id);
      expect(row.invocationId).toBe(rootInvocation.id);
      record(a1.id, 0.25, 25, 0);
      record(b1.id, 1, 100, 500);

      expect(h.stores.usage.totalsForAttempt(a1.id)).toMatchObject({ rows: 2, costUsd: 0.75, outputTokens: 75, cacheReadTokens: 300, inputTokensUncached: 200, cacheCreationTokens: 20, wallClockMs: 2000, providerMs: 1800 });
      expect(h.stores.usage.totalsForInvocation(rootInvocation.id)).toEqual(h.stores.usage.totalsForAttempt(a1.id));
      expect(h.stores.usage.totalsForPlanNode(s.root.id).costUsd).toBe(0.75);
      expect(h.stores.usage.totalsForPlanNode(node.id).costUsd).toBe(1);
      const run = h.stores.usage.totalsForRun(s.run.id);
      expect(run.rows).toBe(3);
      expect(run.costUsd).toBe(1.75);
      expect(run.cacheReadTokens).toBe(800);
      expect(run.inputTokensUncached).toBe(300);
      expect(h.stores.usage.consumedByInvocation(workerInvocation.id)).toEqual({ costUsd: 1, tokens: 710, attempts: 1 });
      expect(() => h.database.sqlite.prepare("UPDATE usage SET cost_usd = 0").run()).toThrow(/append-only/);
      expect(() => h.stores.usage.record({ attemptId: "att_000000000000000000000000", model: "m", effort: null, inputTokensUncached: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, wallClockMs: 0, providerMs: null })).toThrow(/not found/);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "usage.recorded" })).toHaveLength(3);
    } finally {
      h.close();
    }
  });
});
