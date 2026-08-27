/**
 * The picker's status words against the server's facts: labels derive
 * deterministically, an actively running open session is never a
 * continuation candidate, and a paused one is offered as a handoff.
 */
import { describe, expect, it } from "vitest";
import type { ProjectContinuationItem } from "@agentique-console/shared";

import {
  continuationRequiresHandoff,
  isContinuationCandidate,
  projectStatusLabel,
} from "./project-status";

function item(overrides: Partial<ProjectContinuationItem>): ProjectContinuationItem {
  return {
    id: "proj_1", name: "p", intentPreview: null, openSession: null,
    lastSession: {
      id: "us_1", title: "p", lifecycle: "archived", runState: "active",
      pauseReason: null, updatedAt: "2026-08-26T19:09:38Z",
    },
    sessionCount: 1, hasCheckpoint: false, openRequirements: 0,
    createdAt: "2026-08-26T17:33:39Z",
    ...overrides,
  };
}

const last = (patch: Partial<NonNullable<ProjectContinuationItem["lastSession"]>>) =>
  item({ lastSession: { ...item({}).lastSession!, ...patch } });

describe("projectStatusLabel", () => {
  it("names the pause holding an open session", () => {
    expect(projectStatusLabel(item({ openSession: { id: "us", title: null, pauseReason: "capacity" } })))
      .toBe("paused — provider capacity");
    expect(projectStatusLabel(item({ openSession: { id: "us", title: null, pauseReason: "budget" } })))
      .toBe("paused — budget ceiling");
    expect(projectStatusLabel(item({ openSession: { id: "us", title: null, pauseReason: null } })))
      .toBe("session open");
  });

  it("names how an archived run ended — quota stops stay visible, never 'completed'", () => {
    expect(projectStatusLabel(last({ pauseReason: "capacity" }))).toBe("stopped by provider quota");
    expect(projectStatusLabel(last({ pauseReason: null }))).toBe("stopped before completion");
    expect(projectStatusLabel(last({ runState: "completed" }))).toBe("completed");
    expect(projectStatusLabel(last({ runState: "awaiting_signoff" }))).toBe("ended awaiting sign-off");
  });
});

describe("candidacy", () => {
  it("no open session → candidate, no handoff", () => {
    const row = item({});
    expect(isContinuationCandidate(row)).toBe(true);
    expect(continuationRequiresHandoff(row)).toBe(false);
  });

  it("paused open session → candidate WITH handoff", () => {
    const row = item({ openSession: { id: "us", title: null, pauseReason: "capacity" } });
    expect(isContinuationCandidate(row)).toBe(true);
    expect(continuationRequiresHandoff(row)).toBe(true);
  });

  it("actively running open session → not offered", () => {
    const row = item({ openSession: { id: "us", title: null, pauseReason: null } });
    expect(isContinuationCandidate(row)).toBe(false);
  });
});
