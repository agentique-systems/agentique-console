/**
 * Ownership disjointness must hold across the WHOLE true-root session tree —
 * every open session merges worktrees into one workspace, so a scope owned
 * anywhere in the tree is owned against everyone: siblings, grandchildren,
 * uncles, and cousins. These are the first tests to exercise either
 * "assigned to both" throw, and the first to build a real depth-2 tree.
 */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { makeDelegationHarness } from "../test-helpers.ts";

const writer = (name: string, scope: string) => ({ name, profileId: "implementer", owns: [scope] });

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

describe("ownership across the session tree (e2e, fake SDK)", () => {
  it("allows a depth-2 chain with disjoint scopes and records the depths", () => {
    const { h, userSessionId, root, childA } = makeTree();
    const grand = h.host.createSession({ userSessionId, title: "grand",
      parent: { agentSessionId: childA.agentSessionId, controllerAgent: childA.entryAgent },
      agents: [writer("w-ga", "area/ga")] });
    expect(h.repo.getAgentSession(root.agentSessionId)?.depth).toBe(0);
    expect(h.repo.getAgentSession(childA.agentSessionId)?.depth).toBe(1);
    expect(h.repo.getAgentSession(grand.agentSessionId)?.depth).toBe(2);
  });

  it("rejects a sibling claiming a sibling's scope", () => {
    const { h, userSessionId, root } = makeTree();
    expect(() => h.host.createSession({ userSessionId, title: "child-c",
      parent: { agentSessionId: root.agentSessionId, controllerAgent: root.entryAgent },
      agents: [writer("w-c", "area/a")] })).toThrow(/assigned to both/);
  });

  it("rejects a grandchild claiming a ROOT seat's scope", () => {
    const { h, userSessionId, childA } = makeTree();
    expect(() => h.host.createSession({ userSessionId, title: "grand",
      parent: { agentSessionId: childA.agentSessionId, controllerAgent: childA.entryAgent },
      agents: [writer("w-ga", "area/root")] })).toThrow(/assigned to both/);
  });

  it("allows a grandchild to claim an UNCLE's scope — disjointness is lineage-scoped", () => {
    // Deliberately allowed since the lineage change: the old whole-tree scan
    // made a child session strictly harder to create than the flat session
    // it replaced (flat siblings never checked each other), and was one of
    // five structural reasons a 12-hour live run created zero child
    // sessions. Ancestors and siblings still collide (tests above/below);
    // cousins and uncles are the orchestrator's coordination problem, as
    // they always were for flat sessions.
    const { h, userSessionId, childA, childB } = makeTree();
    const grand = h.host.createSession({ userSessionId, title: "grand-a",
      parent: { agentSessionId: childA.agentSessionId, controllerAgent: childA.entryAgent },
      agents: [writer("w-ga", "area/b")] });
    expect(grand.agentSessionId).toBeTruthy();
    // Cousin vs cousin across separate depth-2 branches: also lineage-exempt.
    const grandB = h.host.createSession({ userSessionId, title: "grand-b",
      parent: { agentSessionId: childB.agentSessionId, controllerAgent: childB.entryAgent },
      agents: [writer("w-gb", "area/b2")] });
    expect(grandB.agentSessionId).toBeTruthy();
  });

  it("rejects a SIBLING claiming a sibling's scope", () => {
    const { h, userSessionId, childA, root } = makeTree();
    void childA;
    expect(() => h.host.createSession({ userSessionId, title: "child-c",
      parent: { agentSessionId: root.agentSessionId, controllerAgent: root.entryAgent },
      agents: [writer("w-c2", "area/a")] })).toThrow(/assigned to both/);
  });

  it("add_agent on a grandchild checks the whole tree, not its local branch", () => {
    const { h, userSessionId, childA } = makeTree();
    const grand = h.host.createSession({ userSessionId, title: "grand",
      parent: { agentSessionId: childA.agentSessionId, controllerAgent: childA.entryAgent },
      agents: [writer("w-ga", "area/ga")] });
    expect(() => h.host.addAgent(grand.agentSessionId, { name: "late-root", profileId: "implementer", owns: ["area/root"] }))
      .toThrow(/assigned to both/);
    expect(() => h.host.addAgent(grand.agentSessionId, { name: "late-uncle", profileId: "implementer", owns: ["area/b"] }))
      .toThrow(/assigned to both/);
    expect(h.host.addAgent(grand.agentSessionId, { name: "late-ok", profileId: "implementer", owns: ["area/late"] }))
      .toMatchObject({ agent: "late-ok" });
  });

  it("an archived branch releases its scopes", () => {
    const { h, userSessionId, root, childB } = makeTree();
    h.repo.patchAgentSession(childB.agentSessionId, { lifecycle: "archived" });
    const replacement = h.host.createSession({ userSessionId, title: "child-b2",
      parent: { agentSessionId: root.agentSessionId, controllerAgent: root.entryAgent },
      agents: [writer("w-b2", "area/b")] });
    expect(replacement.agentSessionId).toBeTruthy();
  });
});
