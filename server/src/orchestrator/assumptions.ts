/**
 * Recorded premises: the durable, id-bearing alternative to silently
 * invented defaults. Recording is deliberately un-gated — an assumption is
 * provisional by definition, and writing it down is what makes it
 * falsifiable-with-consequence: `rests_on` links tie it to the requirements
 * built on it, and a falsification decorates those nodes (via the shared
 * ordinal clock) and wakes main. The Console never rewrites requirement
 * status from a falsification — reopening stays a model or operator act,
 * exactly like every other record-and-display signal.
 *
 * Becoming SCOPE is a different act: a confirmed assumption that now governs
 * success goes through propose_requirements (operator approval), never an
 * automatic promotion — the legacy-spec no-auto-conversion stance.
 */
import type { AssumptionWire, EvidenceRef } from "@agentique-console/shared";
import type { AssumptionRow, AssumptionStore } from "../db/stores/assumption-store.ts";
import type { EventBus } from "../events/bus.ts";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import type { RequirementService } from "./requirements.ts";

export class AssumptionService {
  readonly #store: AssumptionStore;
  readonly #requirements: RequirementService;
  readonly #bus: EventBus;
  readonly #resolveProject: (userSessionId: string) => string;
  #wakeNote: ((userSessionId: string, text: string) => void) | null = null;

  constructor(
    store: AssumptionStore,
    requirements: RequirementService,
    bus: EventBus,
    resolveProject: (userSessionId: string) => string,
  ) {
    this.#store = store;
    this.#requirements = requirements;
    this.#bus = bus;
    this.#resolveProject = resolveProject;
  }

  /** Wired once in createApp — how a falsification wakes main. */
  setWakeNote(wake: (userSessionId: string, text: string) => void): void {
    this.#wakeNote = wake;
  }

  record(input: {
    userSessionId: string;
    text: string;
    source: "operator" | "main" | "agent";
    actor: string;
    agentSessionId?: string;
    interactionId?: string;
    requirementIds?: string[];
  }): AssumptionWire {
    const text = input.text.replaceAll(/\s*\n\s*/g, " ").trim();
    if (text === "") throw new InvalidInputError("an assumption needs a statement");
    const projectId = this.#resolveProject(input.userSessionId);
    const id = `a${this.#store.maxAssumptionNumber(projectId) + 1}`;
    const row = this.#store.insert({
      projectId, id, text, source: input.source, actor: input.actor,
      agentSessionId: input.agentSessionId ?? null,
      interactionId: input.interactionId ?? null,
    });
    const requirementIds = [...new Set(input.requirementIds ?? [])];
    for (const requirementId of requirementIds) {
      this.#requirements.link({
        userSessionId: input.userSessionId, fromId: requirementId, kind: "rests_on", toId: id,
        actor: input.actor,
        ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      });
    }
    this.#bus.append({
      type: "assumption.recorded",
      userSessionId: input.userSessionId,
      ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      payload: {
        userSessionId: input.userSessionId, id, text, source: input.source, actor: input.actor,
        ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
        requirementIds,
      },
    });
    return this.#toWire(input.userSessionId, row);
  }

  /**
   * Resolution provenance (never a machine gate, but a claim needs a
   * ground): confirmed/falsified require evidence, an interaction (the
   * operator's answer IS provenance), or the operator as actor. Retirement
   * — "this stopped mattering" — needs none.
   */
  resolve(input: {
    userSessionId: string;
    assumptionId: string;
    outcome: "confirmed" | "falsified" | "retired";
    actor: string;
    agentSessionId?: string;
    note?: string;
    evidence?: EvidenceRef[];
    interactionId?: string;
  }): AssumptionWire {
    const projectId = this.#resolveProject(input.userSessionId);
    const row = this.#store.get(projectId, input.assumptionId);
    if (!row) throw new NotFoundError(`no assumption ${input.assumptionId}`);
    if (row.status !== "open") {
      throw new InvalidInputError(`${row.id} already resolved (${row.status}) — record a new assumption if the premise returned`);
    }
    const evidence = input.evidence ?? [];
    const grounded = evidence.length > 0 || input.interactionId !== undefined
      || row.interactionId !== null || input.actor === "operator";
    if (input.outcome !== "retired" && !grounded) {
      throw new InvalidInputError(
        `marking ${row.id} ${input.outcome} needs provenance: evidence refs, the interactionId of the operator answer that settled it, or the operator's own verdict`,
      );
    }
    const resolved = this.#store.resolve({
      projectId, id: row.id, status: input.outcome, actor: input.actor,
      note: input.note ?? null, evidence,
      interactionId: input.interactionId ?? null,
      resolvedOrd: this.#requirements.allocateChangeOrd(input.userSessionId),
    });
    const linked = this.#linkedRequirementIds(input.userSessionId, row.id);
    const statuses = new Map(this.#requirements.derive(input.userSessionId)
      .map((node) => [node.id, node.status]));
    const affected = linked.map((requirementId) => ({
      requirementId, status: statuses.get(requirementId) ?? "open",
    }));
    this.#bus.append({
      type: "assumption.resolved",
      userSessionId: input.userSessionId,
      ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      payload: {
        userSessionId: input.userSessionId, id: row.id, outcome: input.outcome, actor: input.actor,
        ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
        ...(input.note === undefined ? {} : { note: input.note }),
        evidenceCount: evidence.length,
        affected,
      },
    });
    if (input.outcome === "falsified") {
      const terminal = affected.filter((entry) => ["satisfied", "violated", "infeasible"].includes(entry.status));
      if (terminal.length > 0) {
        this.#wakeNote?.(input.userSessionId,
          `[Console: assumption ${row.id} ("${row.text}") was FALSIFIED by ${input.actor}. ` +
          `These requirements rest on it and hold terminal claims recorded before the falsification: ` +
          `${terminal.map((entry) => `${entry.requirementId} (${entry.status})`).join(", ")}. ` +
          `Judge whether their claims still stand — reopen with report_requirement, re-verify, or amend. The Console changed nothing.]`);
      }
    }
    return this.#toWire(input.userSessionId, resolved);
  }

  list(userSessionId: string): AssumptionWire[] {
    return this.#store.list(this.#resolveProject(userSessionId))
      .map((row) => this.#toWire(userSessionId, row));
  }

  /** OPEN assumptions rests_on-linked to any of the given requirement ids. */
  forRequirements(userSessionId: string, requirementIds: ReadonlySet<string>): AssumptionWire[] {
    const linkedIds = new Set(
      this.#requirements.liveLinks(userSessionId)
        .filter((row) => row.kind === "rests_on" && requirementIds.has(row.fromId))
        .map((row) => row.toId),
    );
    return this.list(userSessionId).filter((wire) => wire.status === "open" && linkedIds.has(wire.id));
  }

  /** One line per open assumption for prompt blocks; "" when none. */
  openLines(userSessionId: string, scope?: ReadonlySet<string>): string[] {
    const wires = scope === undefined
      ? this.list(userSessionId).filter((wire) => wire.status === "open")
      : this.forRequirements(userSessionId, scope);
    return wires.map((wire) =>
      `- ${wire.id}: ${wire.text}${wire.requirementIds.length === 0 ? "" : ` [${wire.requirementIds.join(", ")}]`}`);
  }

  #linkedRequirementIds(userSessionId: string, assumptionId: string): string[] {
    return this.#requirements.liveLinks(userSessionId)
      .filter((row) => row.kind === "rests_on" && row.toId === assumptionId)
      .map((row) => row.fromId);
  }

  #toWire(userSessionId: string, row: AssumptionRow): AssumptionWire {
    return {
      id: row.id,
      text: row.text,
      status: row.status,
      source: row.source,
      actor: row.actor,
      agentSessionId: row.agentSessionId,
      interactionId: row.interactionId,
      resolutionNote: row.resolutionNote,
      resolutionEvidenceCount: row.resolutionEvidence?.length ?? 0,
      requirementIds: this.#linkedRequirementIds(userSessionId, row.id),
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    };
  }
}
