/**
 * The landing-boundary half of the ownership rule (portfolio/ownership.ts):
 * path-like scopes meeting a seat's ACTUAL changed paths. Pure-function
 * tests — the claim-time rule and its four entry paths are pinned by
 * ownership-tree.e2e; the full landing flow by landing-truth.e2e.
 */
import { describe, expect, it } from "vitest";
import { findCrossScopeWrites, scopeCoversPath, type ActiveScopeClaim } from "./ownership.ts";

const holder = (agent: string, over: Partial<ActiveScopeClaim> = {}): ActiveScopeClaim =>
  ({ agent, agentSessionId: "as_other", sessionTitle: "other stream", shared: false, ...over });

describe("scopeCoversPath", () => {
  it("covers exact files and directory prefixes, after normalization", () => {
    expect(scopeCoversPath("xtask/src/pacing.rs", "xtask/src/pacing.rs")).toBe(true);
    expect(scopeCoversPath("platform/latency", "platform/latency/probe.rs")).toBe(true);
    expect(scopeCoversPath("./docs/", "docs/responsiveness.md")).toBe(true);
    expect(scopeCoversPath("docs", "docs/responsiveness.md")).toBe(true);
  });

  it("never covers by substring, sibling, or empty scope", () => {
    // Directory semantics, not string-prefix: "xtask/src/pacing.rs2" is a sibling.
    expect(scopeCoversPath("xtask/src/pacing.rs", "xtask/src/pacing.rs2")).toBe(false);
    expect(scopeCoversPath("platform/latency", "platform/latency-tools/a.rs")).toBe(false);
    expect(scopeCoversPath("", "anything")).toBe(false);
    expect(scopeCoversPath("   ", "anything")).toBe(false);
  });

  it("a semantic label scope simply never matches a path — no landing false positives", () => {
    expect(scopeCoversPath("latency accounting semantics", "platform/latency/probe.rs")).toBe(false);
  });
});

describe("findCrossScopeWrites", () => {
  const claims = (entries: [string, ActiveScopeClaim[]][]) => new Map(entries);

  it("flags the live latency/pacing shape: a write inside another seat's scope, outside its own", () => {
    const violations = findCrossScopeWrites({
      changedPaths: ["platform/latency/probe.rs", "xtask/src/pacing.rs"],
      seat: { agentSessionId: "as_resp", agent: "latency", scopes: ["platform/latency"] },
      claims: claims([["xtask/src/pacing.rs", [holder("pacing", { agentSessionId: "as_resp" })]]]),
    });
    expect(violations).toMatchObject([{ path: "xtask/src/pacing.rs", scope: "xtask/src/pacing.rs", holder: { agent: "pacing" } }]);
  });

  it("own-scope coverage wins, unclaimed paths pass, and the seat's own claim rows are never violations", () => {
    const violations = findCrossScopeWrites({
      changedPaths: ["platform/latency/probe.rs", "README.md", "docs/notes.md"],
      seat: { agentSessionId: "as_resp", agent: "latency", scopes: ["platform/latency", "docs/notes.md"] },
      claims: claims([
        // A broader claim overlapping the seat's own declared responsibility:
        // the overlapping DECLARATIONS were accepted at commission; landing
        // does not relitigate them.
        ["platform", [holder("infra")]],
        ["docs/notes.md", [holder("latency", { agentSessionId: "as_resp" })]],
      ]),
    });
    expect(violations).toEqual([]);
  });

  it("an identical scope held by the landing seat passes — shared claims coexist only by construction", () => {
    // Creation-time rule: both seats hold "crates/sim" only because EVERY
    // claimant declared it shared. The landing seat's own scope covers the
    // path, so authorized overlap lands (git still decides mergeability).
    const violations = findCrossScopeWrites({
      changedPaths: ["crates/sim/src/step.rs"],
      seat: { agentSessionId: "as_a", agent: "substep", scopes: ["crates/sim"] },
      claims: claims([["crates/sim", [holder("lab", { shared: true })]]]),
    });
    expect(violations).toEqual([]);
  });

  it("a shared claim the landing seat does NOT hold is still a violation — sharing is per-claimant, never ambient", () => {
    const violations = findCrossScopeWrites({
      changedPaths: ["crates/sim/src/step.rs"],
      seat: { agentSessionId: "as_b", agent: "outsider", scopes: ["docs"] },
      claims: claims([["crates/sim", [holder("lab", { shared: true })]]]),
    });
    expect(violations).toMatchObject([{ path: "crates/sim/src/step.rs", holder: { agent: "lab", shared: true } }]);
  });
});
