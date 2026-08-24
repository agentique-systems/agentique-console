/**
 * Workstream dependency links: the project-portfolio layer's second half
 * (the first is portfolio/ownership.ts). A link is main's durable claim that
 * one AgentSession (the consumer) depends on another (the producer) for a
 * named interface or artifact — the fact that used to live only in main's
 * conversational memory.
 *
 * Doctrine, matching the change-impact ledger:
 * - Links never schedule anything and never gate a transition mechanically —
 *   AgentSession-local task DAGs keep their scheduling semantics. A link is
 *   visibility: it renders in main's portfolio, in the participating seats'
 *   deliveries, and as a caveat on a consumer's final.
 * - Status is DERIVED from console-owned facts, never stored: producer open
 *   and unreported → pending; producer's final voice reported terminally →
 *   satisfied (a later non-terminal report regresses it — satisfaction is a
 *   projection, not a ratchet); producer archived without reporting →
 *   broken. Releasing a link records a judgment and keeps the row as
 *   history.
 * - Abandoning a producer therefore leaves its consumers VISIBLY broken,
 *   never silently satisfied: archival fires a broken event per live link
 *   and one wake note to main, and completion holds while a broken link's
 *   consumer is still open (completion/service.ts) — release with a why, or
 *   link the successor, is the judgment that clears it.
 * - Change impacts discover consumers through live links transitively
 *   (change-impact.ts), so a revision that touches a producer reaches the
 *   workstreams consuming its interface.
 */
import type { WorkstreamLinkStatus, WorkstreamLinkWire } from "@agentique-console/shared";
import type { AgentSessionRow } from "../db/repo.ts";
import type { WorkstreamLinkRow, WorkstreamStore } from "../db/stores/workstream-store.ts";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import type { EventBus } from "../events/bus.ts";

/** Narrow read closures over other aggregates' facts — wired once in createApp. */
export interface WorkstreamDeps {
  getAgentSession(agentSessionId: string): AgentSessionRow | undefined;
  /** THE "has this session reported?" predicate (OperatorSurface.reportedFinal). */
  reportedFinal(session: AgentSessionRow): boolean;
  userSessionOpen(userSessionId: string): boolean;
}

export class WorkstreamService {
  readonly #store: WorkstreamStore;
  readonly #bus: EventBus;
  readonly #resolveProject: (userSessionId: string) => string;
  #deps: WorkstreamDeps | null = null;
  #wakeNote: ((userSessionId: string, text: string) => void) | null = null;

  constructor(store: WorkstreamStore, bus: EventBus, resolveProject: (userSessionId: string) => string) {
    this.#store = store;
    this.#bus = bus;
    this.#resolveProject = resolveProject;
  }

  /** Wired once in createApp — the service reads other aggregates' facts. */
  setDeps(deps: WorkstreamDeps): void {
    this.#deps = deps;
  }

  /** Wired once in createApp: how a broken producer wakes main. */
  setWakeNote(wake: (userSessionId: string, text: string) => void): void {
    this.#wakeNote = wake;
  }

  #requireDeps(): WorkstreamDeps {
    if (this.#deps === null) throw new Error("WorkstreamService deps not wired — call setDeps in createApp");
    return this.#deps;
  }

  /**
   * Declare one dependency. Idempotent on the live (consumer, producer,
   * subject) triple. A producer that already reported yields a link born
   * satisfied — recording that a workstream consumes an already-produced
   * artifact is legitimate; a producer already abandoned is rejected (link
   * the successor instead).
   */
  link(input: {
    userSessionId: string;
    consumerAgentSessionId: string;
    producerAgentSessionId: string;
    subject: string;
    createdBy: string;
    note?: string;
  }): WorkstreamLinkWire {
    const deps = this.#requireDeps();
    const subject = input.subject.trim();
    if (subject === "") throw new InvalidInputError("a workstream link needs a subject — the interface or artifact that crosses the boundary");
    if (input.consumerAgentSessionId === input.producerAgentSessionId) {
      throw new InvalidInputError("a workstream cannot depend on itself — in-session sequencing belongs to the task ledger");
    }
    const consumer = this.#session(input.userSessionId, input.consumerAgentSessionId);
    const producer = this.#session(input.userSessionId, input.producerAgentSessionId);
    if (consumer.lifecycle !== "open") {
      throw new InvalidInputError(`consumer session ${consumer.id} is archived — only an open workstream can take on a dependency`);
    }
    if (producer.lifecycle !== "open" && !deps.reportedFinal(producer)) {
      throw new InvalidInputError(
        `producer session ${producer.id} ("${producer.title}") was archived without reporting — it will never produce. Link the successor session instead.`,
      );
    }
    const { row, inserted } = this.#store.insert({
      projectId: this.#resolveProject(input.userSessionId),
      userSessionId: input.userSessionId,
      consumerAgentSessionId: consumer.id,
      producerAgentSessionId: producer.id,
      subject,
      createdBy: input.createdBy,
      note: input.note?.trim() || null,
    });
    if (inserted) {
      this.#bus.append({
        type: "workstream.link.created",
        userSessionId: input.userSessionId,
        payload: {
          userSessionId: input.userSessionId, linkId: row.id,
          consumerAgentSessionId: consumer.id, producerAgentSessionId: producer.id,
          subject, createdBy: input.createdBy,
          ...(row.note === null ? {} : { note: row.note }),
          status: this.#statusOf(row) as "pending" | "satisfied",
        },
      });
    }
    return this.#toWire(row);
  }

  /**
   * Release one link with a judgment note — superseded, re-pointed at a
   * successor, or no longer holds. The row stays as history. Releasing an
   * already-released link is a no-op returning current state (retried
   * deliveries must not error or overwrite the recorded judgment).
   */
  release(input: { userSessionId: string; linkId: string; by: string; note: string }): WorkstreamLinkWire {
    const row = this.#owned(input.userSessionId, input.linkId);
    if (row.releasedAt !== null) return this.#toWire(row);
    const note = input.note.trim();
    if (note === "") throw new InvalidInputError("releasing a workstream link needs a note — the judgment's why IS the record");
    this.#store.release(row.id, input.by, note);
    this.#bus.append({
      type: "workstream.link.released",
      userSessionId: input.userSessionId,
      payload: { userSessionId: input.userSessionId, linkId: row.id, by: input.by, note },
    });
    return this.#toWire(this.#store.get(row.id)!);
  }

  list(userSessionId: string): WorkstreamLinkWire[] {
    return this.#store.listByProject(this.#resolveProject(userSessionId)).map((row) => this.#toWire(row));
  }

  /** Live links touching one session, both directions — the portfolio row's detail. */
  listForAgentSession(agentSessionId: string): { asConsumer: WorkstreamLinkWire[]; asProducer: WorkstreamLinkWire[] } {
    const session = this.#requireDeps().getAgentSession(agentSessionId);
    if (!session) return { asConsumer: [], asProducer: [] };
    const live = this.#store.listByProject(this.#resolveProject(session.userSessionId))
      .filter((row) => row.releasedAt === null);
    return {
      asConsumer: live.filter((row) => row.consumerAgentSessionId === agentSessionId).map((row) => this.#toWire(row)),
      asProducer: live.filter((row) => row.producerAgentSessionId === agentSessionId).map((row) => this.#toWire(row)),
    };
  }

  /** Live edges for the change-impact consumer expansion — raw endpoints only. */
  liveEdges(userSessionId: string): { consumerAgentSessionId: string; producerAgentSessionId: string; subject: string }[] {
    return this.#store.listByProject(this.#resolveProject(userSessionId))
      .filter((row) => row.releasedAt === null)
      .map((row) => ({
        consumerAgentSessionId: row.consumerAgentSessionId,
        producerAgentSessionId: row.producerAgentSessionId,
        subject: row.subject,
      }));
  }

  /**
   * Live broken links whose consumer is still open — the completion hold.
   * Archiving the consumer clears mechanically (nobody is consuming any
   * more); releasing the link records the judgment.
   */
  brokenOpen(userSessionId: string): WorkstreamLinkWire[] {
    const deps = this.#requireDeps();
    return this.list(userSessionId).filter((wire) => {
      if (wire.status !== "broken") return false;
      const consumer = deps.getAgentSession(wire.consumerAgentSessionId);
      return consumer !== undefined && consumer.lifecycle === "open";
    });
  }

  /**
   * The archive-time hook (SessionLifecycle.archiveOne): a producer archived
   * without reporting leaves each of its live links visibly broken — one
   * event per link, one wake note to main. A producer that reported leaves
   * satisfied links; nothing to say.
   */
  noteSessionArchived(session: AgentSessionRow): void {
    const deps = this.#requireDeps();
    const live = this.#store.listLiveByProducer(session.id);
    if (live.length === 0 || deps.reportedFinal(session)) return;
    const consumers: string[] = [];
    for (const row of live) {
      this.#bus.append({
        type: "workstream.link.broken",
        userSessionId: session.userSessionId,
        payload: {
          userSessionId: session.userSessionId, linkId: row.id,
          producerAgentSessionId: session.id, consumerAgentSessionId: row.consumerAgentSessionId,
          subject: row.subject,
        },
      });
      const consumer = deps.getAgentSession(row.consumerAgentSessionId);
      if (consumer !== undefined && consumer.lifecycle === "open") {
        consumers.push(`${row.consumerAgentSessionId} ("${consumer.title}") awaiting: ${row.subject}`);
      }
    }
    if (consumers.length === 0 || !deps.userSessionOpen(session.userSessionId)) return;
    this.#wakeNote?.(session.userSessionId,
      `Workstream dependency producer abandoned: session ${session.id} ("${session.title}") was archived without reporting. ` +
      `Consumers left without their producer — ${consumers.join("; ")}. ` +
      `Link each consumer to a successor with link_workstreams, or release the stale link with unlink_workstreams (with why). ` +
      `Completion holds while a broken link's consumer stays open.`);
  }

  /**
   * Compact per-delivery lines for the participating seats: a consumer's
   * seats see what their session awaits and its current status; a producer's
   * seats see which workstreams consume their output — the interface is an
   * external contract, not an implementation detail.
   */
  promptLines(agentSessionId: string): string[] {
    const links = this.listForAgentSession(agentSessionId);
    const lines: string[] = [];
    for (const wire of links.asConsumer) {
      const status = wire.status === "pending" ? "pending — not yet delivered"
        : wire.status === "satisfied" ? "satisfied — producer reported"
        : "BROKEN — producer abandoned; do not assume it will arrive";
      lines.push(`This session depends on "${wire.producerTitle}" (${wire.producerAgentSessionId}) for: ${wire.subject} [${status}]`);
    }
    for (const wire of links.asProducer) {
      lines.push(`Workstream "${wire.consumerTitle}" (${wire.consumerAgentSessionId}) consumes from this session: ${wire.subject}`);
    }
    if (lines.length > 4) return [...lines.slice(0, 4), `…and ${lines.length - 4} more declared workstream link(s)`];
    return lines;
  }

  /** Caveats a consumer's final carries: declared dependencies not yet satisfied. */
  finalCaveats(agentSessionId: string): string[] {
    return this.listForAgentSession(agentSessionId).asConsumer
      .filter((wire) => wire.status === "pending" || wire.status === "broken")
      .map((wire) => `declared dependency on "${wire.producerTitle}" (${wire.producerAgentSessionId}) is ${wire.status}: ${wire.subject}`);
  }

  #session(userSessionId: string, agentSessionId: string): AgentSessionRow {
    const session = this.#requireDeps().getAgentSession(agentSessionId);
    if (!session || session.userSessionId !== userSessionId) {
      throw new NotFoundError(`no agent session ${agentSessionId} in this conversation`);
    }
    return session;
  }

  #owned(userSessionId: string, linkId: string): WorkstreamLinkRow {
    const row = this.#store.get(linkId);
    if (!row || row.projectId !== this.#resolveProject(userSessionId)) {
      throw new NotFoundError(`no workstream link ${linkId} in this project`);
    }
    return row;
  }

  #statusOf(row: WorkstreamLinkRow): WorkstreamLinkStatus {
    if (row.releasedAt !== null) return "released";
    const deps = this.#requireDeps();
    const producer = deps.getAgentSession(row.producerAgentSessionId);
    if (producer === undefined) return "broken";
    if (deps.reportedFinal(producer)) return "satisfied";
    return producer.lifecycle === "open" ? "pending" : "broken";
  }

  #toWire(row: WorkstreamLinkRow): WorkstreamLinkWire {
    const deps = this.#requireDeps();
    return {
      id: row.id,
      consumerAgentSessionId: row.consumerAgentSessionId,
      consumerTitle: deps.getAgentSession(row.consumerAgentSessionId)?.title ?? "",
      producerAgentSessionId: row.producerAgentSessionId,
      producerTitle: deps.getAgentSession(row.producerAgentSessionId)?.title ?? "",
      subject: row.subject,
      status: this.#statusOf(row),
      createdBy: row.createdBy,
      note: row.note,
      createdAt: row.createdAt,
      releasedAt: row.releasedAt,
      releasedBy: row.releasedBy,
      releaseNote: row.releaseNote,
    };
  }
}
