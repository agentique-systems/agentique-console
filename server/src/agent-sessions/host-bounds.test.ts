/** Seat-count bounds on AgentSession creation. */
import { describe, expect, it } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { makeDelegationHarness } from "../test-helpers.ts";

const agents = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `seat${i + 1}`, profileId: "explorer", owns: [`scope-${i + 1}`] }));

describe("createSession seat bounds", () => {
  it("seats up to 20 specialists and rejects 21", () => {
    const h = makeDelegationHarness(async function* () {
      yield initMessage("idle-1");
      yield successMessage({});
    });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "wide bench", mode: "execute", agents: agents(20) });
    expect(created.participants).toHaveLength(20);
    expect(() => h.host.createSession({ userSessionId, title: "too wide", mode: "execute", agents: agents(21) }))
      .toThrow(/1 to 20/);
  });
});
