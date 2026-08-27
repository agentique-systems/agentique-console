/**
 * The sole-coordination-authority invariant at the builder level: an
 * auto-coordinated contract (the hub) seats exactly one console-supplied
 * coordinator, and a caller-chosen orchestrator-archetype profile cannot be
 * commissioned beside it — under ANY seat name. The check is structural
 * (profile archetype), never nominal, because the live failure was exactly a
 * rename: the reserved name "coordinator" was rejected, so main reseated the
 * same coordinator profile as "movelead" and again as "perflead", and each
 * hub ran two management layers.
 */
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../../agent-profiles/registry.ts";
import { buildContract, type BuildInput } from "./catalog.ts";

const PROFILES: Record<string, AgentProfile> = Object.fromEntries((
  [
    { id: "coordinator", role: "orchestrator" },
    { id: "movelead-variant", role: "orchestrator" }, // a mint keeps its base's archetype
    { id: "planner", role: "planner" },
    { id: "explorer", role: "explorer" },
    { id: "implementer", role: "implementer" },
    { id: "reviewer", role: "reviewer" },
    { id: "unarchetyped" }, // pre-archetype workspace manifests parse without a role
  ] as const
).map((p) => [p.id, {
  id: p.id, title: p.id, purpose: p.id, instructions: `You are ${p.id}.`,
  ...("role" in p && p.role !== undefined ? { role: p.role } : {}),
  permissionMode: "default" as const, exemptFromOwnership: false, maxTurns: 30, mcpServers: {},
}]));

const input = (agents: BuildInput["agents"], config?: Record<string, unknown>): BuildInput => ({
  agents, config,
  resolveProfile: (id) => {
    const profile = PROFILES[id];
    if (!profile) throw new Error(`unknown agent profile "${id}"`);
    return profile;
  },
});

describe("sole coordination authority in auto-coordinated patterns", () => {
  it("a hub with productive specialists builds, with exactly one console-seated coordinator", () => {
    const built = buildContract("hub_and_spoke", input([
      { name: "impl", profileId: "implementer" },
      { name: "scout", profileId: "explorer" },
    ]));
    expect(built.coordinatorName).toBe("coordinator");
    expect(built.contract.autoCoordinatorRole).toBe("coordinator");
    const coordinators = built.agents.filter((plan) => plan.role === "coordinator");
    expect(coordinators).toHaveLength(1);
    expect(coordinators[0]).toMatchObject({ name: "coordinator", profileId: "coordinator" });
    expect(built.contract.roles["coordinator"]).toMatchObject({ min: 1, max: 1 });
  });

  it("rejects a coordinator-profile specialist with the semantic error, not a naming one", () => {
    expect(() => buildContract("hub_and_spoke", input([
      { name: "lead", profileId: "coordinator" },
      { name: "impl", profileId: "implementer" },
    ]))).toThrow(/seats its coordinator automatically.*second coordination authority/s);
  });

  it("the live-run fixture: renaming the coordinator profile to 'movelead' does not bypass the invariant", () => {
    // The exact mistake: the name "coordinator" was refused, so the SAME
    // orchestrator-archetype profile came back as "movelead".
    expect(() => buildContract("hub_and_spoke", input([
      { name: "movelead", profileId: "coordinator" },
    ]))).toThrow(/second coordination authority/);
    // A minted variant keeps the base's archetype, so the mint path cannot
    // launder the profile either.
    expect(() => buildContract("hub_and_spoke", input([
      { name: "perflead", profileId: "movelead-variant" },
    ]))).toThrow(/second coordination authority/);
    // An independent reviewer named "movelead" is a legitimate broad-scope
    // specialist: intellectual scope is not dispatch authority.
    const reviewed = buildContract("hub_and_spoke", input([
      { name: "movelead", profileId: "reviewer" },
    ]));
    expect(reviewed.agents.map((plan) => `${plan.name}:${plan.role}`))
      .toEqual(["coordinator:coordinator", "movelead:specialist"]);
  });

  it("broad-scope planner and pre-archetype profiles remain commissionable specialists", () => {
    const built = buildContract("hub_and_spoke", input([
      { name: "canon", profileId: "planner" },
      { name: "legacy", profileId: "unarchetyped" },
    ]));
    expect(built.agents.filter((plan) => plan.role === "specialist")).toHaveLength(2);
  });

  it("patterns with a caller-supplied or absent controller keep their staffing semantics", () => {
    // plan_execute EXPECTS an explicit controller: an orchestrator-archetype
    // planner is the intended use, not a duplicate.
    const planned = buildContract("plan_execute", input([
      { name: "boss", profileId: "coordinator" },
      { name: "impl", profileId: "implementer" },
    ]));
    expect(planned.contract.autoCoordinatorRole).toBeUndefined();
    expect(planned.agents.find((plan) => plan.name === "boss")?.role).toBe("planner");
    // Peer meshes and debates have no coordination authority to duplicate.
    expect(buildContract("peer_to_peer", input([
      { name: "a", profileId: "explorer" }, { name: "b", profileId: "explorer" },
    ])).contract.autoCoordinatorRole).toBeUndefined();
    expect(buildContract("debate", input([
      { name: "pro", profileId: "explorer" }, { name: "con", profileId: "explorer" },
    ])).contract.autoCoordinatorRole).toBeUndefined();
    expect(buildContract("map_reduce", input([
      { name: "reducer", profileId: "explorer" },
    ])).contract.autoCoordinatorRole).toBeUndefined();
  });

  it("the hub's sizing error states that the coordinator is already supplied", () => {
    expect(() => buildContract("hub_and_spoke", input([])))
      .toThrow(/the Console seats the coordinator itself/);
  });
});
