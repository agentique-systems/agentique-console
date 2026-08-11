/** Seat-count bounds on AgentSession creation. */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { makeDelegationHarness } from "../test-helpers.ts";

const agents = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `seat${i + 1}`, profileId: "explorer", owns: [`scope-${i + 1}`] }));

describe("createSession roster bounds", () => {
  it("seats up to 20 specialists and rejects 21", () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage("idle-1");
      yield successMessage({});
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "wide bench", agents: agents(20) });
    expect(created.agents).toHaveLength(20);
    expect(() => h.host.createSession({ userSessionId, title: "too wide", agents: agents(21) }))
      .toThrow(/1 to 20/);
  });
});

/**
 * The ownership invariant is capability-shaped: an agent that WRITES must
 * declare scopes; a read-only one is never forced to invent a non-path scope.
 */
describe("createSession ownership invariant", () => {
  const harness = () => makeDelegationHarness(async function* () {
    yield initMessage("idle-1");
    yield successMessage({});
  });

  it("requires a writing agent to declare what it owns", () => {
    const h = harness();
    const userSessionId = h.addUserSession();
    expect(() => h.host.createSession({
      userSessionId, title: "unbounded writer", agents: [{ name: "dev", profileId: "implementer", owns: [] }],
    })).toThrow(/writes files, so it must declare what it owns/);
  });

  it("lets a read-only agent own nothing at all", () => {
    const h = harness();
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "reviewer", agents: [
        { name: "dev", profileId: "implementer", owns: ["src/game.js"] },
        { name: "check", profileId: "visual-reviewer", owns: [] },
      ],
    });
    expect(created.agents).toContain("check");
  });

  it("still lets a read-only agent carry a review scope", () => {
    // `owns` doubles as the assignment boundary for agents that never write, so
    // forbidding it outright would break a legitimate use.
    const h = harness();
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "scoped reviewer", agents: [{ name: "scout", profileId: "explorer", owns: ["docs/"] }],
    });
    expect(created.agents).toContain("scout");
  });
});
