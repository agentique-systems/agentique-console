/**
 * The change-impact ledger: durable reconciliation for meaning-changing
 * events. When an approved amendment, a falsified assumption, or a withdrawn
 * terminal claim can make prior evidence or active work stale, the
 * requirement graph computes the transitive closure (requirements.ts) and
 * this service persists it — affected requirements, suspect terminal claims,
 * open sessions, requirement-linked tasks, live scheduled assignments — as
 * one row keyed by the source event, idempotently.
 *
 * The division of labor is the run's doctrine applied to revisions: the
 * CONSOLE computes consequences (what is affected, what has since cleared);
 * MAIN and the operator judge meaning (reopen, re-verify, steer, waive) and
 * record that judgment as dispositions. Open/reconciled is DERIVED at read
 * time, never stored: a later claim on a suspect requirement or an archived
 * session clears its item mechanically, so acting through the normal tools is
 * itself reconciliation. An open impact holds the completion proposal
 * (completion/service.ts) — affected work cannot silently drop out of
 * attention, across restarts included, because the rows are the attention.
 */
import type {
  ChangeImpactAffected,
  ChangeImpactDispositionEntry,
  ChangeImpactWire,
  Task,
} from "@agentique-console/shared";
import type { ChangeImpactRow, ChangeImpactStore } from "../db/stores/change-impact-store.ts";
import type { RequirementStatusChangeRow } from "../db/stores/requirement-store.ts";
import type { EventBus } from "../events/bus.ts";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import { nowIso } from "../ids.ts";
import type { ImpactRecordInput } from "./requirements.ts";

const TERMINAL_STATUSES = new Set(["satisfied", "violated", "infeasible"]);
const CLAIM_DISPOSITIONS = new Set(["stands", "superseded"]);
const SESSION_DISPOSITIONS = new Set(["unaffected", "steered", "interrupted", "superseded"]);

/** Narrow read closures over other aggregates' facts — wired once in createApp. */
export interface ChangeImpactDeps {
  openAgentSessionIds(userSessionId: string): Set<string>;
  sessionTitle(agentSessionId: string): string | null;
  listTasks(userSessionId: string): Task[];
  /** Latest status change per requirement — the mechanical-clearance read. */
  latestChanges(userSessionId: string): Map<string, RequirementStatusChangeRow>;
}

export class ChangeImpactService {
  readonly #store: ChangeImpactStore;
  readonly #bus: EventBus;
  readonly #resolveProject: (userSessionId: string) => string;
  #deps: ChangeImpactDeps | null = null;

  constructor(store: ChangeImpactStore, bus: EventBus, resolveProject: (userSessionId: string) => string) {
    this.#store = store;
    this.#bus = bus;
    this.#resolveProject = resolveProject;
  }

  /** Wired once in createApp — the ledger reads other aggregates' facts. */
  setDeps(deps: ChangeImpactDeps): void {
    this.#deps = deps;
  }

  #requireDeps(): ChangeImpactDeps {
    if (this.#deps === null) throw new Error("ChangeImpactService deps not wired — call setDeps in createApp");
    return this.#deps;
  }

  /**
   * Persist one computed impact. Declines (returns null) when the judgment
   * set is empty: no suspect terminal claim and — for amendments and
   * falsifications — no affected open session either. A claim withdrawal
   * records ONLY when downstream terminal claims exist; the status change
   * itself is already visible structurally (frontier, delegated blocks).
   * Idempotent twice over: the (project, sourceKind, sourceRef) unique index
   * absorbs re-processing of the same source event, and a same-kind impact
   * with the same seeds that is STILL OPEN is reused rather than stacked.
   */
  record(input: ImpactRecordInput): ChangeImpactWire | null {
    const deps = this.#requireDeps();
    const projectId = this.#resolveProject(input.userSessionId);
    const affectedIds = new Set(input.closure.requirements.map((entry) => entry.id));
    const openSessions = deps.openAgentSessionIds(input.userSessionId);
    const tasks = deps.listTasks(input.userSessionId).filter((task) =>
      task.requirementId !== null && affectedIds.has(task.requirementId)
      && (task.status === "pending" || task.status === "in_progress")
      && (task.agentSessionId === null || openSessions.has(task.agentSessionId)));
    // Sessions: the closure's delegation matches, plus sessions whose ledger
    // holds an incomplete task discharging an affected requirement — a
    // requirement-linked task is work against the changed meaning whether or
    // not its session was delegated the node.
    const sessionIds = new Set(input.closure.sessionIds.filter((id) => openSessions.has(id)));
    for (const task of tasks) {
      if (task.agentSessionId !== null) sessionIds.add(task.agentSessionId);
    }
    const suspects = input.closure.suspectClaims;
    if (suspects.length === 0 && (input.sourceKind === "claim_withdrawn" || sessionIds.size === 0)) return null;

    const affected: ChangeImpactAffected = {
      seedIds: [...input.seedIds],
      requirements: input.closure.requirements,
      suspectClaims: suspects,
      sessions: [...sessionIds].sort().map((agentSessionId) => ({
        agentSessionId,
        title: deps.sessionTitle(agentSessionId) ?? "",
      })),
      tasks: tasks.map((task) => ({
        taskId: task.id, subject: task.subject, status: task.status, agentSessionId: task.agentSessionId,
      })),
      scheduledAssignments: tasks
        .filter((task) => task.scheduledAssignment !== null)
        .map((task) => ({
          id: task.scheduledAssignment!.id,
          taskId: task.id,
          agentSessionId: task.agentSessionId ?? "",
          recipient: task.scheduledAssignment!.recipient,
        })),
    };

    const duplicate = this.#store.listByProject(projectId).find((row) =>
      row.sourceKind === input.sourceKind
      && sameIds(row.affected.seedIds, affected.seedIds)
      && this.#status(input.userSessionId, row) === "open");
    if (duplicate !== undefined) return this.#toWire(input.userSessionId, duplicate);

    const { row, inserted } = this.#store.insert({
      projectId,
      userSessionId: input.userSessionId,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      atRevision: input.atRevision,
      computedAtOrd: input.computedAtOrd,
      note: input.note,
      affected,
    });
    if (inserted) {
      this.#bus.append({
        type: "change_impact.recorded",
        userSessionId: input.userSessionId,
        payload: {
          userSessionId: input.userSessionId,
          impactId: row.id,
          sourceKind: row.sourceKind,
          sourceRef: row.sourceRef,
          atRevision: row.atRevision,
          seedIds: affected.seedIds,
          suspectClaims: suspects.map((claim) => ({ requirementId: claim.requirementId, status: claim.status })),
          sessionIds: affected.sessions.map((session) => session.agentSessionId),
          taskIds: affected.tasks.map((task) => task.taskId),
        },
      });
    }
    return this.#toWire(input.userSessionId, row);
  }

  /**
   * Record main/operator judgment on affected items. Every item must belong
   * to the impact's judgment set and carry a why; the vocabulary teaches the
   * boundary — a claim is `stands` or `superseded` here because reopening and
   * re-verifying happen through report_requirement and clear mechanically; a
   * session is `unaffected` / `steered` / `interrupted` / `superseded`
   * because archiving clears mechanically. Validation precedes any write, so
   * a bad batch changes nothing. Last-wins per item, journaled.
   */
  reconcile(input: {
    userSessionId: string;
    impactId: string;
    actor: string;
    items: { kind: "claim" | "session"; id: string; disposition: string; note: string }[];
  }): ChangeImpactWire {
    this.#requireDeps();
    const row = this.#store.get(input.impactId);
    if (!row || row.projectId !== this.#resolveProject(input.userSessionId)) {
      throw new NotFoundError(`no change impact ${input.impactId} in this project`);
    }
    const now = nowIso();
    const next = [...row.dispositions];
    for (const item of input.items) {
      const note = item.note.trim();
      if (note === "") {
        throw new InvalidInputError(`the ${item.kind} ${item.id} disposition needs a note — the judgment's why IS the record`);
      }
      if (item.kind === "claim") {
        if (!row.affected.suspectClaims.some((claim) => claim.requirementId === item.id)) {
          throw new InvalidInputError(
            `${item.id} is not a suspect claim of ${row.id} — its suspect claims: ${row.affected.suspectClaims.map((claim) => claim.requirementId).join(", ") || "none"}`,
          );
        }
        if (!CLAIM_DISPOSITIONS.has(item.disposition)) {
          throw new InvalidInputError(
            `a claim disposition is "stands" or "superseded" — reopening or re-verifying happens through report_requirement and clears the item mechanically`,
          );
        }
      } else {
        if (!row.affected.sessions.some((session) => session.agentSessionId === item.id)) {
          throw new InvalidInputError(
            `${item.id} is not an affected session of ${row.id} — its sessions: ${row.affected.sessions.map((session) => session.agentSessionId).join(", ") || "none"}`,
          );
        }
        if (!SESSION_DISPOSITIONS.has(item.disposition)) {
          throw new InvalidInputError(
            `a session disposition is "unaffected", "steered", "interrupted" or "superseded" — archiving a session clears the item mechanically`,
          );
        }
      }
      const entry: ChangeImpactDispositionEntry = {
        kind: item.kind, id: item.id,
        disposition: item.disposition as ChangeImpactDispositionEntry["disposition"],
        note, actor: input.actor, at: now,
      };
      const existing = next.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id);
      if (existing >= 0) next[existing] = entry;
      else next.push(entry);
    }
    this.#store.setDispositions(row.id, next);
    const wire = this.#toWire(input.userSessionId, this.#store.get(row.id)!);
    this.#bus.append({
      type: "change_impact.reconciled",
      userSessionId: input.userSessionId,
      payload: {
        userSessionId: input.userSessionId,
        impactId: row.id,
        actor: input.actor,
        items: input.items.map((item) => ({ kind: item.kind, id: item.id, disposition: item.disposition, note: item.note.trim() })),
        status: wire.status,
      },
    });
    return wire;
  }

  list(userSessionId: string): ChangeImpactWire[] {
    return this.#store.listByProject(this.#resolveProject(userSessionId))
      .map((row) => this.#toWire(userSessionId, row));
  }

  listOpen(userSessionId: string): ChangeImpactWire[] {
    return this.list(userSessionId).filter((wire) => wire.status === "open");
  }

  get(userSessionId: string, impactId: string): ChangeImpactWire {
    const row = this.#store.get(impactId);
    if (!row || row.projectId !== this.#resolveProject(userSessionId)) {
      throw new NotFoundError(`no change impact ${impactId} in this project`);
    }
    return this.#toWire(userSessionId, row);
  }

  /**
   * The derived judgment frontier of one impact. A suspect claim is
   * outstanding while it still STANDS — its requirement's latest change is
   * terminal and predates the impact's clock — and carries no disposition;
   * any later claim (reopen, re-verify, retirement) postdates the change by
   * construction and clears it. A session is outstanding while it is still
   * open without a disposition; archival clears it.
   */
  #outstanding(userSessionId: string, row: ChangeImpactRow): { claims: string[]; sessions: string[] } {
    const deps = this.#requireDeps();
    const latest = deps.latestChanges(userSessionId);
    const open = deps.openAgentSessionIds(userSessionId);
    const disposed = new Set(row.dispositions.map((entry) => `${entry.kind}:${entry.id}`));
    const claims = row.affected.suspectClaims
      .filter((claim) => {
        if (disposed.has(`claim:${claim.requirementId}`)) return false;
        const change = latest.get(claim.requirementId);
        // Cleared only by a STRICTLY later change: an amendment may allocate
        // no ords at all, leaving the newest pre-change claim exactly at the
        // impact's clock — that claim is the suspect, not its clearance.
        return change !== undefined && TERMINAL_STATUSES.has(change.toStatus) && change.ord <= row.computedAtOrd;
      })
      .map((claim) => claim.requirementId);
    const sessions = row.affected.sessions
      .filter((session) => open.has(session.agentSessionId) && !disposed.has(`session:${session.agentSessionId}`))
      .map((session) => session.agentSessionId);
    return { claims, sessions };
  }

  #status(userSessionId: string, row: ChangeImpactRow): "open" | "reconciled" {
    const outstanding = this.#outstanding(userSessionId, row);
    return outstanding.claims.length + outstanding.sessions.length > 0 ? "open" : "reconciled";
  }

  #toWire(userSessionId: string, row: ChangeImpactRow): ChangeImpactWire {
    const outstanding = this.#outstanding(userSessionId, row);
    return {
      id: row.id,
      sourceKind: row.sourceKind,
      sourceRef: row.sourceRef,
      atRevision: row.atRevision,
      computedAtOrd: row.computedAtOrd,
      note: row.note,
      affected: row.affected,
      dispositions: row.dispositions,
      outstanding,
      status: outstanding.claims.length + outstanding.sessions.length > 0 ? "open" : "reconciled",
      createdAt: row.createdAt,
    };
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((id, index) => id === sortedB[index]);
}
