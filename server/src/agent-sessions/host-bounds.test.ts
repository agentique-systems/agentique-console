/** Seat-count bounds on AgentSession creation, and the facade import law. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * The facade law: service.ts imports the modules, never the reverse. A module
 * that needs a facade capability takes a typed callback (seams.ts) instead.
 */
describe("facade import discipline", () => {
  it("no agent-sessions module imports service.ts", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const facade = path.join(dir, "service.ts");
    const modules: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && full !== facade) modules.push(full);
      }
    };
    walk(dir);
    expect(modules.length).toBeGreaterThan(10);
    const offenders = modules.filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return [...source.matchAll(/from\s+"(\.[^"]+)"/g)]
        .some((match) => path.resolve(path.dirname(file), match[1]!) === facade);
    });
    expect(offenders).toEqual([]);
  });
});
