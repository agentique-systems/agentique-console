/**
 * Contract compilation, agent→role derivation, and the hub-and-spoke default
 * that every pre-contract session row reads as.
 *
 * A compiled contract is the service's execution surface: route legality is an
 * edge lookup, tool grants and prompts are role lookups. Contracts are
 * immutable once snapshotted — replicable roles grow the ROSTER
 * (`agents.role`), never the contract.
 */
import type { EdgeSpec, RolePrompt, RoleSpec, TopologyContract } from "./topology-contract.ts";
import type { AgentSessionRow, AgentRow } from "../db/repo.ts";
import { CONSOLE_SENDER, MAIN_RECIPIENT, COORDINATOR_AGENT } from "./names.ts";
import { SESSION_PROTOCOL } from "./presets.ts";

export const AGENT_NAME_RE = /^[A-Za-z0-9_.:-]+$/;
export const RESERVED_NAMES = new Set([COORDINATOR_AGENT, "operator", "system", MAIN_RECIPIENT, CONSOLE_SENDER]);

export interface CompiledContract {
  contract: TopologyContract;
  /** Role-level edge lookup; "main" is the pseudo-role of the user-session lane. */
  edge(fromRole: string, toRole: string): EdgeSpec | undefined;
  role(name: string): RoleSpec | undefined;
  prompt(roleName: string): RolePrompt | undefined;
}

export function compileContract(contract: TopologyContract): CompiledContract {
  const edges = new Map<string, Map<string, EdgeSpec>>();
  for (const edge of contract.edges) {
    let from = edges.get(edge.from);
    if (!from) { from = new Map(); edges.set(edge.from, from); }
    from.set(edge.to, edge);
  }
  return {
    contract,
    edge: (fromRole, toRole) => edges.get(fromRole)?.get(toRole),
    role: (name) => contract.roles[name],
    prompt: (roleName) => contract.promptPack[roleName],
  };
}

/** An agent's contract role — the `agents.role` column IS the binding. */
export function roleOfAgent(agent: Pick<AgentRow, "role">): string {
  return agent.role;
}

/** An agent row's transcript speaker kind; an absent row speaks as an agent. */
export function speakerKindOf(agent: Pick<AgentRow, "role"> | undefined | null): "orchestrator" | "agent" {
  return agent?.role === "coordinator" ? "orchestrator" : "agent";
}

/** Pinned by native-flow.e2e — the route-denial text existing operators know. */
export const HUB_ROUTE_SUMMARY = "main ↔ coordinator ↔ specialist";

/**
 * Today's star as a contract. Prompt strings must stay byte-identical to the
 * builder's literals (prompt caching + the snapshot tests pin them): the
 * addressing sentences reproduce the messaging brief's, and the protocol is
 * the whole SESSION_PROTOCOL block.
 */
const HUB_CONTRACT: TopologyContract = {
  schemaVersion: 1,
  pattern: "hub_and_spoke",
  roles: {
    coordinator: {
      replicable: false, min: 1, max: 1,
      grants: ["tasks_write", "forward_message", "child_sessions", "requirements_report"],
      escalateTo: "main",
    },
    specialist: { replicable: false, min: 1, max: 20, grants: [], escalateTo: "coordinator" },
  },
  edges: [
    { from: "main", to: "coordinator", advance: "immediate" },
    // Update-only: main can steer a specialist directly (a correction, a
    // discovery) without deposing the coordinator — assignments still enter
    // through the coordinator alone.
    { from: "main", to: "specialist", advance: "immediate", categories: ["update"] },
    { from: "coordinator", to: "main", advance: "immediate" },
    { from: "coordinator", to: "specialist", advance: "immediate" },
    { from: "specialist", to: "coordinator", advance: "immediate" },
  ],
  joins: [],
  entry: { role: "coordinator", broadcast: false },
  termination: {},
  completion: { finalFrom: "coordinator", voice: "coordinator" },
  promptPack: {
    coordinator: {
      addressing: `Address participants by bare name (e.g. "coordinator"); "main" reaches the Orchestrator.`,
      protocol: SESSION_PROTOCOL,
    },
    specialist: {
      addressing: `Address participants by bare name (e.g. "coordinator"); "main" reaches the Orchestrator.`,
      protocol: SESSION_PROTOCOL,
    },
  },
  routeSummary: HUB_ROUTE_SUMMARY,
  limits: { minAgents: 1, maxAgents: 20 },
  config: {},
};

export function hubContract(): TopologyContract {
  return HUB_CONTRACT;
}

/**
 * The contract a session row executes. '{}' — every row created before
 * contracts existed, and every hub row until the builder writes real
 * snapshots — reads as the hub default, so old sessions are valid instances
 * with zero data rewrite. Snapshots are server-authored (the profileSnapshot
 * precedent): parsed by cast, not by schema.
 */
export function contractOfSession(row: Pick<AgentSessionRow, "topology">): TopologyContract {
  const snapshot = row.topology;
  if (snapshot !== null && typeof snapshot === "object" && Object.keys(snapshot).length > 0) {
    return snapshot as unknown as TopologyContract;
  }
  return HUB_CONTRACT;
}
