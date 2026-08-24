/**
 * THE ownership rule — the single project-wide check every path that can add
 * write responsibility runs: top-level session creation, child creation,
 * mid-run add_agent, and map/reduce work-item dispatch. It used to be four
 * subtly different rules (top-level checked only its own roster, children
 * checked lineage+siblings but not cousins, late adds scanned the true-root
 * tree, dispatch checked nothing), which left main responsible for noticing
 * overlapping responsibility across top-level sessions and cousin branches
 * from memory.
 *
 * The rule, in full:
 * - Ownership describes WRITE RESPONSIBILITY, never filesystem isolation:
 *   scopes are responsibility labels compared as trimmed strings; worktree
 *   paths and file overlap play no part (two workstreams can conflict
 *   semantically in disjoint files).
 * - A writing, non-exempt seat must claim at least one scope.
 * - Read participation is free: a non-writing seat may declare scopes as its
 *   assignment/review boundary; those claims never conflict and never block
 *   a writer. Exempt profiles (reviewers) are skipped entirely.
 * - Write claims on one scope conflict UNLESS every claimant — existing and
 *   new — declared the scope shared, each with a why (`sharedOwns`). An
 *   intentional overlap is therefore always structurally visible; an
 *   accidental one is always an error naming the holder.
 * - Claims are ACTIVE while their session is open, project-wide (every open
 *   session of every open UserSession on the project). Archival releases
 *   them; history stays on the rows.
 */
import type { AgentProfile } from "../agent-profiles/registry.ts";
import { profileWritesFiles } from "../agent-profiles/registry.ts";
import type { AgentRow, AgentSessionRow, UserSessionRow } from "../db/repo.ts";
import { InvalidInputError } from "../errors.ts";

/** The repo slice the rule reads — no store of its own; claims live on seat rows. */
export interface OwnershipReadSource {
  getUserSession(id: string): UserSessionRow | undefined;
  listOpenUserSessionsForProject(projectId: string): UserSessionRow[];
  listAgentSessions(userSessionId: string): AgentSessionRow[];
  listAgents(agentSessionId: string): AgentRow[];
}

/** One seat's proposed claims, profile facts already resolved by the caller. */
export interface SeatClaimInput {
  agent: string;
  profileId: string;
  writes: boolean;
  exempt: boolean;
  owns: string[];
  sharedOwns: { scope: string; why: string }[];
}

/** The validated, normalized claims to persist on the seat row. */
export interface NormalizedSeatClaims {
  /** Every claimed scope — exclusive and shared — trimmed and deduplicated. */
  ownership: string[];
  /** The shared subset with its whys, trimmed. */
  sharedOwnership: { scope: string; why: string }[];
}

interface ActiveClaim {
  agent: string;
  agentSessionId: string;
  sessionTitle: string;
  shared: boolean;
}

/**
 * Validate a batch of new seat claims against every active claim in the
 * project. Throws InvalidInputError on the first violation; returns the
 * normalized claims per seat (what the caller persists) on success. The whole
 * batch is validated before anything is written, so a bad roster changes
 * nothing.
 */
export function assertOwnershipClaims(
  repo: OwnershipReadSource,
  userSessionId: string,
  seats: SeatClaimInput[],
): Map<string, NormalizedSeatClaims> {
  const normalized = new Map<string, NormalizedSeatClaims>();
  // Per-seat normalization first: trims, dedupe, the write-requires-scope
  // rule, and the contradiction of one seat claiming a scope both ways.
  for (const seat of seats) {
    const owns = [...new Set(seat.owns.map((scope) => scope.trim()).filter((scope) => scope !== ""))];
    const shared = new Map<string, string>();
    for (const entry of seat.sharedOwns) {
      const scope = entry.scope.trim();
      if (scope === "") continue;
      const why = entry.why.trim();
      if (why === "") {
        throw new InvalidInputError(`agent "${seat.agent}": shared scope "${scope}" needs a why — the reason for co-ownership IS the record`);
      }
      if (owns.includes(scope)) {
        throw new InvalidInputError(`agent "${seat.agent}" claims scope "${scope}" both exclusively (owns) and shared (sharedOwns) — pick one`);
      }
      shared.set(scope, why);
    }
    if (seat.writes && !seat.exempt && owns.length + shared.size === 0) {
      throw new InvalidInputError(`agent "${seat.agent}" (${seat.profileId}) writes files, so it must declare what it owns`);
    }
    normalized.set(seat.agent, {
      ownership: [...owns, ...shared.keys()],
      sharedOwnership: [...shared.entries()].map(([scope, why]) => ({ scope, why })),
    });
  }

  // Active write claims, project-wide: every non-exempt writing seat of every
  // open session of every open UserSession on this project. Read-only seats
  // never occupy a scope; exempt seats are skipped on both sides.
  const active = new Map<string, ActiveClaim[]>();
  const user = repo.getUserSession(userSessionId);
  const userSessions = user === undefined ? [] : repo.listOpenUserSessionsForProject(user.projectId);
  for (const openUser of userSessions) {
    for (const session of repo.listAgentSessions(openUser.id)) {
      if (session.lifecycle !== "open") continue;
      for (const holder of repo.listAgents(session.id)) {
        const snapshot = holder.profileSnapshot as AgentProfile | undefined;
        if (snapshot?.exemptFromOwnership === true) continue;
        if (!profileWritesFiles(snapshot?.tools)) continue;
        const sharedScopes = new Set(holder.sharedOwnership.map((entry) => entry.scope));
        for (const scope of holder.ownership) {
          const trimmed = scope.trim();
          if (trimmed === "") continue;
          const list = active.get(trimmed) ?? [];
          list.push({ agent: holder.name, agentSessionId: session.id, sessionTitle: session.title, shared: sharedScopes.has(trimmed) });
          active.set(trimmed, list);
        }
      }
    }
  }

  // The conflict rule. Batch claims also check each other — two seats in one
  // roster follow exactly the rule two top-level sessions do.
  const batch = new Map<string, { agent: string; shared: boolean }[]>();
  for (const seat of seats) {
    if (!seat.writes || seat.exempt) continue;
    const claims = normalized.get(seat.agent)!;
    const sharedScopes = new Set(claims.sharedOwnership.map((entry) => entry.scope));
    for (const scope of claims.ownership) {
      const isShared = sharedScopes.has(scope);
      for (const holder of active.get(scope) ?? []) {
        if (!isShared || !holder.shared) {
          throw new InvalidInputError(
            `ownership scope "${scope}" is already held by ${holder.agent} in ${holder.agentSessionId} ("${holder.sessionTitle}")` +
            `${holder.shared ? " as a SHARED claim" : ""} — write responsibility for one scope has one owner unless EVERY claimant declares it shared. ` +
            `Pick a disjoint scope, route the work through the owning session, or declare the scope in sharedOwns (with why) on every claimant.`,
          );
        }
      }
      for (const peer of batch.get(scope) ?? []) {
        if (!isShared || !peer.shared) {
          throw new InvalidInputError(
            `ownership scope "${scope}" is assigned to both ${peer.agent} and ${seat.agent} — split the scope, or declare it in sharedOwns (with why) on both`,
          );
        }
      }
      const list = batch.get(scope) ?? [];
      list.push({ agent: seat.agent, shared: isShared });
      batch.set(scope, list);
    }
  }
  return normalized;
}
