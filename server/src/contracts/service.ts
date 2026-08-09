/**
 * Shared interfaces two or more seats must agree before any of them writes.
 *
 * The operator's instruction in db-live-2 was unambiguous: "renderer and page
 * must agree the exact module interface BEFORE either writes code — that
 * contract is the handoff, and neither should guess the other's shape."
 *
 * What happened instead: the two seats exchanged zero messages all run (the
 * star topology makes specialist↔specialist impossible), the coordinator
 * authored the interface alone and told both to "proceed straight to
 * implementation once they confirm", `renderer` wrote `src/game.js` 61 seconds
 * after receiving it without confirming anything, and `page` confirmed 5m50s
 * AFTER writing all three of its own files — having verified the contract by
 * grepping renderer's file off disk. It worked only because they happened to
 * share a directory and the dictated contract happened to be unambiguous.
 *
 * The fix is not to open the mesh. It is to give the parties something to agree
 * ON: a shared, versioned object whose acceptance gates writes. Notifications
 * still travel the star through `post()`; `#assertRoute` does not change.
 */
import { and, eq } from "drizzle-orm";
import path from "node:path";
import type { Db } from "../db/client.ts";
import { contractParties, contracts } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import { badRequest, conflict, notFound } from "../api/errors.ts";

export type ContractStatus = "proposed" | "accepted" | "superseded" | "abandoned";
export type ContractPartyState = "pending" | "accepted" | "objected";

export interface ContractView {
  id: string;
  agentSessionId: string;
  userSessionId: string;
  name: string;
  declaredBy: string;
  status: ContractStatus;
  revision: number;
  body: string;
  scopes: string[];
  parties: { participant: string; state: ContractPartyState; revision: number; comment: string | null }[];
  createdAt: string;
  updatedAt: string;
}

export class ContractService {
  readonly #db: Db;
  readonly #bus: EventBus;
  /** Notified when a contract reaches `accepted`, so the Console can say so. */
  #onAccepted: ((contract: ContractView) => void) | undefined;

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  onAccepted(handler: (contract: ContractView) => void): void {
    this.#onAccepted = handler;
  }

  declare(input: {
    agentSessionId: string; userSessionId: string; declaredBy: string;
    name: string; body: string; parties: string[]; scopes: string[];
  }): ContractView {
    const parties = [...new Set(input.parties)].filter((party) => party.trim() !== "");
    if (parties.length < 2) throw badRequest("a contract needs at least two parties — it is an agreement, not a note");
    const open = this.#db.select().from(contracts)
      .where(and(eq(contracts.agentSessionId, input.agentSessionId), eq(contracts.name, input.name)))
      .all()
      .find((row) => row.status === "proposed" || row.status === "accepted");
    if (open) throw conflict(`contract "${input.name}" already exists (${open.id}, ${open.status}); amend it rather than declaring a second one`);

    const now = nowIso();
    const id = newId("handoff").replace("handoff_", "contract_");
    this.#db.insert(contracts).values({
      id, agentSessionId: input.agentSessionId, userSessionId: input.userSessionId,
      name: input.name, declaredBy: input.declaredBy, status: "proposed", revision: 1,
      body: input.body, scopes: input.scopes, supersedes: null, createdAt: now, updatedAt: now,
    }).run();
    for (const participant of parties) {
      this.#db.insert(contractParties).values({
        contractId: id, participant, state: "pending", revision: 0, comment: null, updatedAt: now,
      }).run();
    }
    const view = this.get(id);
    this.#emit("contract.declared", view);
    return view;
  }

  /**
   * A new revision, with EVERY acceptance reset.
   *
   * This is why `amended` is not a status. If it were, an amendment could leave
   * prior acceptances standing and the contract would read "accepted" while
   * describing something nobody agreed to. Modelling it as a revision bump makes
   * that impossible rather than merely discouraged.
   */
  amend(id: string, by: string, body: string, rationale: string): ContractView {
    const row = this.#row(id);
    if (row.status !== "proposed" && row.status !== "accepted") {
      throw conflict(`contract ${id} is ${row.status}`);
    }
    this.#assertParty(id, by);
    const now = nowIso();
    const revision = row.revision + 1;
    this.#db.update(contracts)
      .set({ body, revision, status: "proposed", updatedAt: now })
      .where(eq(contracts.id, id)).run();
    this.#db.update(contractParties)
      .set({ state: "pending", updatedAt: now })
      .where(eq(contractParties.contractId, id)).run();
    const view = this.get(id);
    this.#emit("contract.amended", view, { by, rationale, revision });
    return view;
  }

  accept(id: string, participant: string, revision: number): ContractView {
    const row = this.#row(id);
    this.#assertParty(id, participant);
    if (revision !== row.revision) {
      throw conflict(`you accepted revision ${revision}; the current revision is ${row.revision} — read it with read_contract and accept again`);
    }
    const now = nowIso();
    this.#db.update(contractParties)
      .set({ state: "accepted", revision, updatedAt: now })
      .where(and(eq(contractParties.contractId, id), eq(contractParties.participant, participant))).run();

    const parties = this.#parties(id);
    const allAccepted = parties.every((party) => party.state === "accepted" && party.revision === row.revision);
    if (allAccepted && row.status !== "accepted") {
      this.#db.update(contracts).set({ status: "accepted", updatedAt: now }).where(eq(contracts.id, id)).run();
      const view = this.get(id);
      this.#emit("contract.accepted", view);
      this.#onAccepted?.(view);
      return view;
    }
    const view = this.get(id);
    this.#emit("contract.party_accepted", view, { participant, revision });
    return view;
  }

  object(id: string, participant: string, reason: string): ContractView {
    this.#row(id);
    this.#assertParty(id, participant);
    const now = nowIso();
    this.#db.update(contractParties)
      .set({ state: "objected", comment: reason, updatedAt: now })
      .where(and(eq(contractParties.contractId, id), eq(contractParties.participant, participant))).run();
    this.#db.update(contracts).set({ status: "proposed", updatedAt: now }).where(eq(contracts.id, id)).run();
    const view = this.get(id);
    this.#emit("contract.objected", view, { participant, reason });
    return view;
  }

  supersede(id: string, reason: string): ContractView {
    this.#row(id);
    this.#db.update(contracts).set({ status: "superseded", updatedAt: nowIso() }).where(eq(contracts.id, id)).run();
    const view = this.get(id);
    this.#emit("contract.superseded", view, { reason });
    return view;
  }

  get(id: string): ContractView {
    const row = this.#row(id);
    return {
      id: row.id, agentSessionId: row.agentSessionId, userSessionId: row.userSessionId, name: row.name, declaredBy: row.declaredBy,
      status: row.status, revision: row.revision, body: row.body, scopes: row.scopes,
      parties: this.#parties(id).map((party) => ({
        participant: party.participant, state: party.state, revision: party.revision, comment: party.comment,
      })),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  listForSession(agentSessionId: string): ContractView[] {
    return this.#db.select().from(contracts)
      .where(eq(contracts.agentSessionId, agentSessionId)).all()
      .map((row) => this.get(row.id));
  }

  findByName(agentSessionId: string, name: string): ContractView | undefined {
    const row = this.#db.select().from(contracts)
      .where(and(eq(contracts.agentSessionId, agentSessionId), eq(contracts.name, name))).all()
      .find((candidate) => candidate.status === "proposed" || candidate.status === "accepted");
    return row ? this.get(row.id) : undefined;
  }

  /**
   * The contract, if any, that forbids this seat writing this path right now.
   *
   * Returns undefined when nothing governs the path, when the contract is fully
   * accepted, or when this seat is not a party — a non-party is not bound by an
   * agreement it was never asked to make.
   */
  blockingFor(agentSessionId: string, participant: string, absolutePath: string, workspaceRoot: string): ContractView | undefined {
    for (const contract of this.listForSession(agentSessionId)) {
      if (contract.status !== "proposed") continue;
      if (!contract.parties.some((party) => party.participant === participant)) continue;
      if (!contract.scopes.some((scope) => pathWithin(absolutePath, scope, workspaceRoot))) continue;
      const mine = contract.parties.find((party) => party.participant === participant);
      // Already accepted the CURRENT revision: this seat is clear even while
      // others deliberate. Waiting on somebody else is not the same as
      // disagreeing.
      if (mine?.state === "accepted" && mine.revision === contract.revision) continue;
      return contract;
    }
    return undefined;
  }

  pendingParties(id: string): string[] {
    const contract = this.get(id);
    return contract.parties
      .filter((party) => !(party.state === "accepted" && party.revision === contract.revision))
      .map((party) => party.participant);
  }

  #assertParty(id: string, participant: string): void {
    const party = this.#parties(id).find((candidate) => candidate.participant === participant);
    // Checked in the handler, not by tool registration: a non-party gets a
    // useful message instead of a mysteriously missing tool.
    if (!party) throw badRequest(`${participant} is not a party to contract ${id}`);
  }

  #row(id: string) {
    const row = this.#db.select().from(contracts).where(eq(contracts.id, id)).get();
    if (!row) throw notFound(`no contract ${id}`);
    return row;
  }

  #parties(id: string) {
    return this.#db.select().from(contractParties).where(eq(contractParties.contractId, id)).all();
  }

  #emit(type: string, contract: ContractView, extra: Record<string, unknown> = {}): void {
    this.#bus.append({
      type: "agent_session.contract",
      userSessionId: contract.userSessionId,
      agentSessionId: contract.agentSessionId,
      payload: {
        agentSessionId: contract.agentSessionId,
        contractId: contract.id,
        name: contract.name,
        event: type,
        status: contract.status,
        revision: contract.revision,
        parties: contract.parties.map((party) => ({ participant: party.participant, state: party.state })),
        ...extra,
      },
    } as never);
  }
}

/** Whether a write target falls inside a declared scope (file or directory). */
export function pathWithin(absolutePath: string, scope: string, workspaceRoot: string): boolean {
  const target = path.resolve(absolutePath);
  const governed = path.resolve(workspaceRoot, scope);
  return target === governed || target.startsWith(`${governed}${path.sep}`);
}
