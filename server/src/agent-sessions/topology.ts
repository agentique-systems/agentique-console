/**
 * Contract compilation, seat→role derivation, and the hub-and-spoke default
 * that every pre-contract session row reads as.
 *
 * A compiled contract is the host's execution surface: route legality is an
 * edge lookup, tool grants and prompts are role lookups. Contracts are
 * immutable once snapshotted — replicable roles grow the ROSTER
 * (participants.pattern_role), never the contract.
 */
import type {
  EdgeSpec,
  RolePrompt,
  RoleSpec,
  TopologyContract,
} from "@agentique-console/shared";
import type { AgentSessionRow, ParticipantRow } from "../db/repo.ts";
import { CONSOLE_SENDER, MAIN_RECIPIENT, ORCHESTRATOR_SEAT } from "./peer-names.ts";
import { SESSION_PROTOCOL } from "./presets.ts";

export const SEAT_NAME_RE = /^[A-Za-z0-9_.:-]+$/;
export const RESERVED_NAMES = new Set([ORCHESTRATOR_SEAT, "operator", "system", MAIN_RECIPIENT, "coordinator", CONSOLE_SENDER]);

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

/** A seat's contract role; NULL (pre-contract rows) derives from the frozen `role` column. */
export function roleOfSeat(seat: Pick<ParticipantRow, "role" | "patternRole">): string {
  return seat.patternRole ?? (seat.role === "orchestrator" ? "coordinator" : "specialist");
}

/** Pinned by native-flow.e2e — the route-denial text existing operators know. */
export const HUB_ROUTE_SUMMARY = "main ↔ coordinator ↔ specialist";

/**
 * Today's star as a contract. Prompt strings must stay byte-identical to the
 * pre-contract literals (prompt caching + the snapshot tests pin them): the
 * addressing sentences reproduce `seatMessagingBrief`'s, and the protocol is
 * the whole SESSION_PROTOCOL block.
 */
const HUB_CONTRACT: TopologyContract = {
  schemaVersion: 1,
  pattern: "hub_and_spoke",
  roles: {
    coordinator: {
      replicable: false, min: 1, max: 1,
      grants: ["tasks_write", "forward_message", "child_sessions"],
      escalateTo: "main",
    },
    specialist: { replicable: false, min: 1, max: 20, grants: [], escalateTo: "coordinator" },
  },
  edges: [
    { from: "main", to: "coordinator", advance: "router" },
    { from: "coordinator", to: "main", advance: "router" },
    { from: "coordinator", to: "specialist", advance: "router" },
    { from: "specialist", to: "coordinator", advance: "router" },
  ],
  joins: [],
  entry: { role: "coordinator", broadcast: false },
  termination: {},
  completion: { finalFrom: "coordinator", voice: "coordinator" },
  promptPack: {
    coordinator: {
      addressing: `Address participants by bare name (e.g. "orchestrator"); "main" reaches the Orchestrator. You may address your specialists and main.`,
      protocol: SESSION_PROTOCOL,
    },
    specialist: {
      addressing: `Address participants by bare name (e.g. "orchestrator"); "main" reaches the Orchestrator. You may address only orchestrator.`,
      protocol: SESSION_PROTOCOL,
    },
  },
  routeSummary: HUB_ROUTE_SUMMARY,
  limits: { minSeats: 1, maxSeats: 20 },
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
