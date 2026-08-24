/**
 * THE ownership rule (portfolio/ownership.ts), exercised through every real
 * path that adds write responsibility: top-level creation, child creation,
 * late add_agent, and map/reduce dispatch. One project-wide invariant —
 * write claims on one scope conflict wherever they enter, top-level sessions
 * and cousin branches included, unless EVERY claimant declared the scope
 * shared (with why). Read participation never conflicts; archival releases
 * claims; the rule survives restart because claims live on seat rows.
 *
 * Ownership is responsibility, never filesystem isolation: this harness runs
 * with worktrees: null — no file ever overlaps — and conflicts are still
 * detected, because scopes are labels for who answers for a responsibility,
 * not paths that happen to be written.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { makeDelegationHarness, restartHarness } from "../test-helpers.ts";

const writer = (name: string, scope: string) => ({ name, profileId: "implementer", owns: [scope] });
const sharer = (name: string, scope: string, why: string) =>
  ({ name, profileId: "implementer" as const, owns: [] as string[], sharedOwns: [{ scope, why }] });

function makeTree() {
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  });
  const userSessionId = h.addUserSession();
  const root = h.host.createSession({ userSessionId, title: "root", agents: [writer("w-root", "area/root")] });
  const childA = h.host.createSession({ userSessionId, title: "child-a",
    parent: { agentSessionId: root.agentSessionId, controllerAgent: root.entryAgent },
    agents: [writer("w-a", "area/a")] });
  const childB = h.host.createSession({ userSessionId, title: "child-b",
    parent: { agentSessionId: root.agentSessionId, controllerAgent: root.entryAgent },
    agents: [writer("w-b", "area/b")] });
  return { h, userSessionId, root, childA, childB };
}

describe("the one ownership rule (e2e, fake SDK)", () => {
  it("allows a depth-2 chain with disjoint scopes and records the depths", () => {
    const { h, userSessionId, root, childA } = makeTree();
    const grand = h.host.createSession({ userSessionId, title: "grand",
      parent: { agentSessionId: childA.agentSessionId, controllerAgent: childA.entryAgent },
      agents: [writer("w-ga", "area/ga")] });
    expect(h.repo.getAgentSession(root.agentSessionId)?.depth).toBe(0);
    expect(h.repo.getAgentSession(childA.agentSessionId)?.depth).toBe(1);
    expect(h.repo.getAgentSession(grand.agentSessionId)?.depth).toBe(2);
  });

  it("two non-overlapping TOP-LEVEL write sessions are allowed", () => {
    const { h, userSessionId } = makeTree();
    const second = h.host.createSession({ userSessionId, title: "second top-level",
      agents: [writer("w-2", "area/second")] });
    expect(second.agentSessionId).toBeTruthy();
  });

  it("two TOP-LEVEL sessions claiming one scope conflict — the check is project-wide, not lineage-scoped", () => {
    const { h, userSessionId } = makeTree();
    expect(() => h.host.createSession({ userSessionId, title: "second top-level",
      agents: [writer("w-2", "area/root")] })).toThrow(/already held by w-root/);
  });

  it("rejects a sibling claiming a sibling's scope", () => {
    const { h, userSessionId, root } = makeTree();
    expect(() => h.host.createSession({ userSessionId, title: "child-c",
      parent: { agentSessionId: root.agentSessionId, controllerAgent: root.entryAgent },
      agents: [writer("w-c", "area/a")] })).toThrow(/already held by w-a/);
  });

  it("rejects a grandchild claiming a ROOT seat's scope", () => {
    const { h, userSessionId, childA } = makeTree();
    expect(() => h.host.createSession({ userSessionId, title: "grand",
      parent: { agentSessionId: childA.agentSessionId, controllerAgent: childA.entryAgent },
      agents: [writer("w-ga", "area/root")] })).toThrow(/already held by w-root/);
  });

  it("rejects a grandchild claiming an UNCLE's scope — cousins are no longer exempt", () => {
    // The old lineage-scoped check deliberately exempted uncles and cousins,
    // leaving cross-branch coherence to main's memory — the exact P0 this
    // rule closes. Intentional overlap now has a structural spelling
    // (sharedOwns on every claimant) instead of a topological loophole.
    const { h, userSessionId, childA } = makeTree();
    expect(() => h.host.createSession({ userSessionId, title: "grand-a",
      parent: { agentSessionId: childA.agentSessionId, controllerAgent: childA.entryAgent },
      agents: [writer("w-ga", "area/b")] })).toThrow(/already held by w-b/);
  });

  it("two seats in ONE roster claiming one scope conflict like any two sessions", () => {
    const { h, userSessionId } = makeTree();
    expect(() => h.host.createSession({ userSessionId, title: "double",
      agents: [writer("d-1", "area/dup"), writer("d-2", "area/dup")] })).toThrow(/assigned to both d-1 and d-2/);
  });

  it("declared-shared ownership coexists deterministically — and only when EVERY claimant declares it", () => {
    const { h, userSessionId } = makeTree();
    // Both sides declared: allowed, and the why is durable on each seat row.
    const first = h.host.createSession({ userSessionId, title: "infra-a",
      agents: [sharer("s-1", "area/shared-infra", "co-evolves the build pipeline with infra-b")] });
    const second = h.host.createSession({ userSessionId, title: "infra-b",
      agents: [sharer("s-2", "area/shared-infra", "co-evolves the build pipeline with infra-a")] });
    expect(second.agentSessionId).toBeTruthy();
    expect(h.repo.getAgent(first.agentSessionId, "s-1")?.sharedOwnership).toMatchObject([
      { scope: "area/shared-infra", why: "co-evolves the build pipeline with infra-b" }]);
    // One-sided sharing is NOT enough: an exclusive claim on a shared scope
    // conflicts, and a shared claim on an exclusively-held scope conflicts.
    expect(() => h.host.createSession({ userSessionId, title: "infra-c",
      agents: [writer("s-3", "area/shared-infra")] })).toThrow(/already held by s-\d .* as a SHARED claim/);
    expect(() => h.host.createSession({ userSessionId, title: "root-sharer",
      agents: [sharer("s-4", "area/root", "wants in")] })).toThrow(/already held by w-root/);
    // A shared claim without a why is rejected — the reason IS the record.
    expect(() => h.host.createSession({ userSessionId, title: "no-why",
      agents: [{ name: "s-5", profileId: "implementer", owns: [], sharedOwns: [{ scope: "area/x", why: "  " }] }] }))
      .toThrow(/needs a why/);
  });

  it("read-only participation never conflicts: an explorer may declare a writer's scope as its boundary", () => {
    const { h, userSessionId } = makeTree();
    // Read seat over an owned scope: allowed (participation, not ownership).
    const survey = h.host.createSession({ userSessionId, title: "survey",
      agents: [{ name: "scout", profileId: "explorer", owns: ["area/root"] }] });
    expect(survey.agentSessionId).toBeTruthy();
    // And the read claim does not OCCUPY the scope against a later writer.
    const later = h.host.createSession({ userSessionId, title: "later-writer",
      agents: [writer("w-x", "area/x")] });
    expect(later.agentSessionId).toBeTruthy();
    const readClaimed = h.host.createSession({ userSessionId, title: "reader-first",
      agents: [{ name: "scout2", profileId: "explorer", owns: ["area/y"] }] });
    expect(readClaimed.agentSessionId).toBeTruthy();
    expect(h.host.createSession({ userSessionId, title: "writer-after-reader",
      agents: [writer("w-y", "area/y")] }).agentSessionId).toBeTruthy();
  });

  it("a writing seat with no scopes is rejected on every path, dispatch included", () => {
    const { h, userSessionId } = makeTree();
    expect(() => h.host.createSession({ userSessionId, title: "unowned",
      agents: [{ name: "w-none", profileId: "implementer", owns: [] }] }))
      .toThrow(/writes files, so it must declare what it owns/);
    const mapSession = h.host.createSession({ userSessionId, title: "fan",
      pattern: "map_reduce", agents: [{ name: "collect", profileId: "explorer" }] });
    expect(() => h.host.dispatchWorkItems("collect", {
      agentSessionId: mapSession.agentSessionId, profileId: "implementer",
      items: [{ assignment: "write the parser" }],
    })).toThrow(/writes files, so it must declare what it owns/);
  });

  it("map/reduce dispatch runs the SAME project-wide rule as creation", () => {
    const { h, userSessionId } = makeTree();
    const mapSession = h.host.createSession({ userSessionId, title: "fan",
      pattern: "map_reduce", agents: [{ name: "collect", profileId: "explorer" }] });
    // A mapper claiming a top-level session's scope: rejected.
    expect(() => h.host.dispatchWorkItems("collect", {
      agentSessionId: mapSession.agentSessionId, profileId: "implementer",
      items: [{ assignment: "rewrite the root", owns: ["area/root"] }],
    })).toThrow(/already held by w-root/);
    // Two items claiming one scope in one dispatch: rejected like a roster.
    expect(() => h.host.dispatchWorkItems("collect", {
      agentSessionId: mapSession.agentSessionId, profileId: "implementer",
      items: [{ assignment: "half one", owns: ["area/map"] }, { assignment: "half two", owns: ["area/map"] }],
    })).toThrow(/assigned to both/);
    // Disjoint write items pass, and their claims occupy project-wide.
    const dispatched = h.host.dispatchWorkItems("collect", {
      agentSessionId: mapSession.agentSessionId, profileId: "implementer",
      items: [{ assignment: "one", owns: ["area/map-1"] }, { assignment: "two", owns: ["area/map-2"] }],
    });
    expect(dispatched.agents).toHaveLength(2);
    expect(() => h.host.createSession({ userSessionId, title: "collides-with-mapper",
      agents: [writer("w-m", "area/map-1")] })).toThrow(/already held by map\.1\.1/);
  });

  it("add_agent runs the SAME rule: cross-branch and cross-top-level claims conflict", () => {
    const { h, userSessionId, childA } = makeTree();
    const grand = h.host.createSession({ userSessionId, title: "grand",
      parent: { agentSessionId: childA.agentSessionId, controllerAgent: childA.entryAgent },
      agents: [writer("w-ga", "area/ga")] });
    expect(() => h.host.addAgent(grand.agentSessionId, { name: "late-root", profileId: "implementer", owns: ["area/root"] }))
      .toThrow(/already held by w-root/);
    expect(() => h.host.addAgent(grand.agentSessionId, { name: "late-uncle", profileId: "implementer", owns: ["area/b"] }))
      .toThrow(/already held by w-b/);
    expect(h.host.addAgent(grand.agentSessionId, { name: "late-ok", profileId: "implementer", owns: ["area/late"] }))
      .toMatchObject({ agent: "late-ok" });
  });

  it("an archived branch releases its ACTIVE claims while its rows keep the history", () => {
    const { h, userSessionId, root, childB } = makeTree();
    h.repo.patchAgentSession(childB.agentSessionId, { lifecycle: "archived" });
    const replacement = h.host.createSession({ userSessionId, title: "child-b2",
      parent: { agentSessionId: root.agentSessionId, controllerAgent: root.entryAgent },
      agents: [writer("w-b2", "area/b")] });
    expect(replacement.agentSessionId).toBeTruthy();
    // Historical provenance survives release: the archived seat still says
    // what it owned.
    expect(h.repo.getAgent(childB.agentSessionId, "w-b")?.ownership).toEqual(["area/b"]);
  });

  it("restart preserves ownership truth: the same conflict rejects over a rebooted app", async () => {
    const { h, userSessionId } = makeTree();
    const restarted = await restartHarness(h);
    expect(() => restarted.host.createSession({ userSessionId, title: "after restart",
      agents: [writer("w-r", "area/root")] })).toThrow(/already held by w-root/);
    expect(restarted.host.createSession({ userSessionId, title: "fresh scope after restart",
      agents: [writer("w-f", "area/fresh")] }).agentSessionId).toBeTruthy();
  });
});
