import { orchestratorDefinitionDefects } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness } from "../persistence/test-support.ts";
import { BUILTIN_DEFINITION_NAMES, builtinDefinitionContents, ensureBuiltinDefinitions } from "./builtins.ts";

const DEFAULTS = { model: "claude-fable-5", effort: "high" as const, maxContextOccupancy: 0.8, allocation: { costUsd: 2, tokens: 20_000, attempts: 2 }, orchestratorAllocation: { costUsd: 10, tokens: 100_000, attempts: 5 }, maxWallClockMs: 600_000 };

describe("built-in Agent Definitions", () => {
  it("ensures orchestrator, worker, and reviewer as builtin revisions, idempotently, with the reviewer read-only and the orchestrator holding its required capabilities", () => {
    const h = openHarness();
    try {
      const first = ensureBuiltinDefinitions(h.stores, DEFAULTS);
      expect(Object.keys(first).sort()).toEqual([...BUILTIN_DEFINITION_NAMES].sort());
      for (const name of BUILTIN_DEFINITION_NAMES) expect(first[name].provenance).toEqual({ kind: "builtin" });
      expect(orchestratorDefinitionDefects("orchestrator", first.orchestrator)).toEqual([]);
      expect(first.reviewer.capabilities.tools).toEqual(["read", "search"]);
      expect(first.worker.capabilities.tools).toEqual(["read", "search", "write", "shell"]);
      expect(first.orchestrator.defaultLimits.allocation).toEqual(DEFAULTS.orchestratorAllocation);
      expect(first.worker.defaultLimits.allocation).toEqual(DEFAULTS.allocation);
      for (const name of BUILTIN_DEFINITION_NAMES) expect(first[name].instructions).toMatch(/return_result exactly once/);
      const second = ensureBuiltinDefinitions(h.stores, DEFAULTS);
      for (const name of BUILTIN_DEFINITION_NAMES) expect(second[name].id).toBe(first[name].id);
      // Changed defaults produce a new revision of the same definition; the earlier revision stays.
      const third = ensureBuiltinDefinitions(h.stores, { ...DEFAULTS, model: "claude-opus-5" });
      expect(third.worker.definitionId).toBe(first.worker.definitionId);
      expect(third.worker.id).not.toBe(first.worker.id);
      expect(h.stores.agents.listRevisions(first.worker.definitionId)).toHaveLength(2);
      expect(builtinDefinitionContents(DEFAULTS).orchestrator.instructions).toMatch(/propose_requirements|revise_execution_plan|create_tasks|record_decision|request_completion/);
    } finally {
      h.close();
    }
  });
});
