/** Structural checkpoint gate: pure matrix, no length scoring. */
import { describe, expect, it } from "vitest";
import type { HandoffDraft } from "@agentique-console/shared";
import { evaluateCheckpointDraft } from "./checkpoint-gate.ts";

const draft = (over: Partial<HandoffDraft["core"]>): HandoffDraft => ({ core: { schemaVersion: 1, taskId: null, status: "in_progress", risk: "low",
  action: "continue the work", state: { summary: "half done", evidence: [{ kind: "file", ref: "src/a.ts" }] },
  result: { summary: null, artifacts: [] }, uncertainty: [], nextAction: "finish src/a.ts", requestExpandedContext: false, ...over },
  extension: { kind: "generic", data: {} } });

describe("evaluateCheckpointDraft", () => {
  it("passes a complete in-progress draft with a resolving ref", () => {
    expect(evaluateCheckpointDraft({ draft: draft({}), referenceWarnings: [], taskResolves: null })).toEqual([]);
  });

  it("passes an honest empty-work completed draft with no nextAction and no evidence", () => {
    const d = draft({ status: "completed", nextAction: null, state: { summary: "nothing was pending", evidence: [] } });
    expect(evaluateCheckpointDraft({ draft: d, referenceWarnings: [], taskResolves: null })).toEqual([]);
  });

  it("fails on a blank summary", () => {
    const d = draft({ state: { summary: "  ", evidence: [{ kind: "file", ref: "src/a.ts" }] } });
    expect(evaluateCheckpointDraft({ draft: d, referenceWarnings: [], taskResolves: null })).toContain("state.summary is empty");
  });

  it("fails on empty nextAction for non-completed work", () => {
    const d = draft({ nextAction: null });
    expect(evaluateCheckpointDraft({ draft: d, referenceWarnings: [], taskResolves: null }))
      .toContain("nextAction is empty for a non-completed checkpoint");
  });

  it("fails on zero evidence refs for non-completed work", () => {
    const d = draft({ state: { summary: "half done", evidence: [] } });
    expect(evaluateCheckpointDraft({ draft: d, referenceWarnings: [], taskResolves: null }))
      .toContain("no evidence refs on a non-completed checkpoint");
  });

  it("fails when every ref has a warning", () => {
    const failures = evaluateCheckpointDraft({ draft: draft({}), referenceWarnings: ["file reference does not exist: src/a.ts"], taskResolves: null });
    expect(failures.some((f) => f.startsWith("no evidence ref resolves"))).toBe(true);
  });

  it("passes when at least one of several refs resolves", () => {
    const d = draft({ state: { summary: "half done", evidence: [{ kind: "file", ref: "src/a.ts" }, { kind: "file", ref: "src/gone.ts" }] } });
    expect(evaluateCheckpointDraft({ draft: d, referenceWarnings: ["file reference does not exist: src/gone.ts"], taskResolves: null })).toEqual([]);
  });

  it("fails on an unresolvable taskId and accumulates multiple failures", () => {
    const d = draft({ taskId: "task_missing", nextAction: null, state: { summary: "", evidence: [] } });
    const failures = evaluateCheckpointDraft({ draft: d, referenceWarnings: [], taskResolves: false });
    expect(failures).toHaveLength(4);
    expect(failures).toContain("taskId does not resolve: task_missing");
  });
});
