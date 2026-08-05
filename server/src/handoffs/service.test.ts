import { describe, expect, it } from "vitest";
import type { HandoffDraft } from "@agentique-console/shared";
import { HandoffService } from "./service.ts";
import { makeHarness } from "../test-helpers.ts";

function draft(overrides: Partial<HandoffDraft["core"]> = {}): HandoffDraft {
  return { core: { schemaVersion: 1, taskId: "task_1", status: "in_progress", risk: "low", action: "Implement typed handoffs",
    state: { summary: "Schema is wired", evidence: [{ kind: "file", ref: "missing.ts" }] },
    result: { summary: null, artifacts: [] }, uncertainty: [], nextAction: "Run tests", requestExpandedContext: false, ...overrides },
    extension: { kind: "generic", data: { changedPaths: ["server/src/handoffs/service.ts"] } } };
}

describe("HandoffService", () => {
  it("elevates risk for unresolved references and enforces the profile extension kind", () => {
    const h = makeHarness(async function* () {});
    const userSessionId = h.addUserSession();
    const service = new HandoffService({ repo: h.repo, bus: h.bus, getWorkspaceRoot: () => "/tmp/test-workspace" });
    const prepared = service.prepare({ draft: draft(), userSessionId, agentSessionId: null, sender: "coder", recipient: "main",
      profileId: "implementer", generation: 2, trigger: "milestone" });
    expect(prepared.record.core.risk).toBe("medium");
    expect(prepared.record.extension.kind).toBe("implementation");
    expect(prepared.record.metadata.referenceWarnings[0]).toContain("does not exist");
  });

  it("persists overflow losslessly and pages retrieval at a bounded cursor", () => {
    const h = makeHarness(async function* () {});
    const userSessionId = h.addUserSession();
    const service = new HandoffService({ repo: h.repo, bus: h.bus, getWorkspaceRoot: () => "/tmp/test-workspace" });
    const large = "verified-state ".repeat(800);
    const prepared = service.prepare({ draft: draft({ state: { summary: large, evidence: [] } }), userSessionId, agentSessionId: null,
      sender: "orchestrator", recipient: "orchestrator", profileId: "main", generation: 0, trigger: "rotation", checkpoint: false });
    h.repo.insertCheckpointHandoff(prepared.row);
    expect(prepared.row.overflow).toBe(true);
    const first = service.read(prepared.row.id, "core", undefined, 512);
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(512);
    expect(first.nextCursor).not.toBeNull();
    let joined = first.content;
    let cursor = first.nextCursor;
    while (cursor) {
      const page = service.read(prepared.row.id, "core", cursor, 512);
      joined += page.content;
      cursor = page.nextCursor;
    }
    expect(JSON.parse(joined).state.summary).toBe(large);
  });

  it("keeps root lineage through child handoffs", () => {
    const h = makeHarness(async function* () {});
    const userSessionId = h.addUserSession();
    const service = new HandoffService({ repo: h.repo, bus: h.bus, getWorkspaceRoot: () => "/tmp/test-workspace" });
    const root = service.prepare({ draft: draft(), userSessionId, agentSessionId: null, sender: "main", recipient: "orchestrator", profileId: "main", generation: 0, trigger: "assignment" });
    h.repo.insertCheckpointHandoff(root.row);
    const child = service.prepare({ draft: draft(), userSessionId, agentSessionId: null, sender: "orchestrator", recipient: "main", profileId: "coordinator", generation: 0,
      trigger: "update", parentHandoffId: root.row.id });
    expect(child.record.metadata.parentHandoffId).toBe(root.row.id);
    expect(child.record.metadata.rootHandoffId).toBe(root.row.id);
  });
});
