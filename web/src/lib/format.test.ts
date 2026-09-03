import { describe, expect, it } from "vitest";
import { RUN_PHASES } from "@agentique-console/core";
import { PHASE_LABELS, phaseTone, shortId, statusTone, timeAgo } from "./format";

describe("formatting", () => {
  it("labels every Run phase distinctly", () => {
    const labels = RUN_PHASES.map((phase) => PHASE_LABELS[phase]);
    expect(new Set(labels).size).toBe(RUN_PHASES.length);
    for (const phase of RUN_PHASES) expect(phaseTone(phase)).toBeDefined();
  });

  it("formats times, ids, and status tones", () => {
    const now = Date.parse("2026-01-01T01:00:00.000Z");
    expect(timeAgo("2026-01-01T00:59:30.000Z", now)).toBe("30s ago");
    expect(timeAgo("2026-01-01T00:30:00.000Z", now)).toBe("30m ago");
    expect(shortId("run_0123456789abcdef01234567")).toBe("run_012345");
    expect(statusTone("succeeded")).toBe("completed");
    expect(statusTone("interrupted")).toBe("cancelled");
  });
});
