/**
 * The orchestrator's working state: the model-authored layer of the loop
 * state → calculus → move → evidence → state. Everything else the console
 * captures is what IT can know (spec, decisions, ledger, handoffs); this is
 * what only the model knows — strategy and why, open uncertainties, standing
 * assumptions, live risks — kept durable across rotations and injected into
 * main's own next generation, so junk here poisons the writer first.
 *
 * Section-replace semantics, no id-addressed patch grammar (models neglect id
 * collections — a live run's task ledger proved it). Updated on MATERIAL
 * events only; the cadence doctrine lives in the brief, and no hook enforces
 * it — a nag would produce exactly the ceremony this design avoids.
 */
import type { ObjectiveAssessment, ObjectiveGap, ObjectiveStopReason } from "@agentique-console/shared";
import type { EventBus } from "../events/bus.ts";
import type { OrchestrationStateRow, OrchestrationStateStore } from "../db/stores/state-store.ts";
import { InvalidInputError } from "../errors.ts";
import type { ProjectObjectiveService } from "./objective.ts";

const DIGEST_MAX_BYTES = 2 * 1024;
const ASSESSMENT_DIGEST_MAX_BYTES = 4 * 1024;

export interface CompletionRecord {
  criteria: {
    /** Requirement id + its statement as verified (requirement-graph runs). */
    requirement?: string;
    statement?: string;
    /** Freeform criterion text (legacy-spec runs and old persisted rows). */
    criterion?: string;
    met: boolean;
    evidence: { kind: string; ref: string }[];
  }[];
  knownGaps: string[];
  nonGoals: string[];
  /**
   * The approved revision these criteria were verified against — the
   * requirement revision when a graph governs, the legacy spec revision
   * otherwise. The completion predicate requires the governing one to match
   * the CURRENT approved revision — a record against a superseded document is
   * a stale claim, and a run with no record at all must not propose done (a
   * live run proposed completion of a game with no window because the
   * heuristic was "current ledger clean").
   */
  requirementsRevision?: number;
  specRevision?: number;
}

export interface OrchestrationStateDeps {
  resolveProject(userSessionId: string): string;
  listUserSessionIdsForProject(projectId: string): string[];
  materialHeadSeq(userSessionIds: readonly string[]): number;
  openDecisionIssueIds(userSessionId: string): string[];
}

export class OrchestrationStateService {
  readonly #store: OrchestrationStateStore;
  readonly #bus: EventBus;
  readonly #objective: ProjectObjectiveService;
  #deps: OrchestrationStateDeps | null = null;

  constructor(store: OrchestrationStateStore, bus: EventBus, objective: ProjectObjectiveService) {
    this.#store = store;
    this.#bus = bus;
    this.#objective = objective;
  }

  setDeps(deps: OrchestrationStateDeps): void { this.#deps = deps; }

  #requireDeps(): OrchestrationStateDeps {
    if (this.#deps === null) throw new Error("OrchestrationStateService deps not wired — call setDeps in createApp");
    return this.#deps;
  }

  current(userSessionId: string): OrchestrationStateRow | undefined {
    return this.#store.current(userSessionId);
  }

  history(userSessionId: string): OrchestrationStateRow[] {
    return this.#store.listForUserSession(userSessionId);
  }

  update(userSessionId: string, patch: {
    trigger: OrchestrationStateRow["trigger"];
    strategy?: string;
    strategyWhy?: string;
    uncertainties?: string[];
    assumptions?: string[];
    risks?: string[];
    note?: string;
    /** Evidence refs this update incorporates — journaled, never stored. */
    incorporating?: string[];
  }): OrchestrationStateRow {
    const { incorporating, ...sections } = patch;
    const row = this.#store.append({ userSessionId, ...sections });
    this.#emit(row, patch, incorporating);
    return row;
  }

  /** The criteria→evidence record main writes when it believes the run is done. */
  recordCompletion(userSessionId: string, completion: CompletionRecord, note?: string): OrchestrationStateRow {
    const row = this.#store.append({ userSessionId, trigger: "completion",
      completion: completion as unknown as Record<string, unknown>, note: note ?? null });
    this.#emit(row, { trigger: "completion" });
    return row;
  }

  /**
   * Dedicated goal-level decision boundary. The Console stamps objective
   * identity and material-event currency; main supplies only semantic judgment.
   * Exact duplicate retries at the same watermark are idempotent.
   */
  assessObjective(userSessionId: string, input: Omit<ObjectiveAssessment, "objectiveDigest" | "assessedAtSeq">): {
    row: OrchestrationStateRow; assessment: ObjectiveAssessment; inserted: boolean;
  } {
    const objective = this.#objective.document(userSessionId);
    if (objective === null || objective.trim() === "") {
      throw new InvalidInputError("this project has no governing objective; an assessment cannot invent operator authority");
    }
    this.#validateAssessment(userSessionId, input);
    const deps = this.#requireDeps();
    const sessionIds = deps.listUserSessionIdsForProject(deps.resolveProject(userSessionId));
    const assessment: ObjectiveAssessment = {
      ...input,
      objectiveDigest: this.#objective.digestOf(objective),
      assessedAtSeq: deps.materialHeadSeq(sessionIds),
    };
    const latest = this.latestObjectiveAssessment(userSessionId);
    if (latest !== null && latest.assessment.assessedAtSeq === assessment.assessedAtSeq
      && JSON.stringify(latest.assessment) === JSON.stringify(assessment)) {
      return { row: latest.row, assessment: latest.assessment, inserted: false };
    }
    const row = this.#store.append({ userSessionId, trigger: "objective_assessment", objectiveAssessment: assessment });
    this.#emit(row, { trigger: "objective_assessment" });
    return { row, assessment, inserted: true };
  }

  latestObjectiveAssessment(userSessionId: string): {
    row: OrchestrationStateRow;
    assessment: ObjectiveAssessment;
    currentMaterialSeq: number;
    stale: boolean;
  } | null {
    const deps = this.#requireDeps();
    const sessionIds = deps.listUserSessionIdsForProject(deps.resolveProject(userSessionId));
    let found: OrchestrationStateRow | null = null;
    for (const id of sessionIds) {
      for (const row of this.#store.listForUserSession(id)) {
        if (row.objectiveAssessment !== null) found = row;
      }
    }
    if (found === null || found.objectiveAssessment === null) return null;
    const currentMaterialSeq = deps.materialHeadSeq(sessionIds);
    return { row: found, assessment: found.objectiveAssessment, currentMaterialSeq,
      stale: currentMaterialSeq > found.objectiveAssessment.assessedAtSeq };
  }

  objectiveAssessmentDigest(userSessionId: string): string {
    const latest = this.latestObjectiveAssessment(userSessionId);
    if (latest === null) return "";
    const a = latest.assessment;
    const gaps = a.remainingGaps.slice(0, 6).map((gap) => `- [${gap.executability}] ${gap.description}`).join("\n");
    const body = `## Latest objective-progress assessment (main-authored judgment, ${latest.stale ? "STALE" : "current"})\n` +
      `Objective sha256: ${a.objectiveDigest}\nDecision: ${a.decision}${a.stopReason === null ? "" : ` (${a.stopReason})`}\n` +
      `Current state: ${a.currentState}\nProgress: ${a.progress.join("; ") || "(none recorded)"}\n` +
      `Remaining gaps:\n${gaps || "- none"}${a.remainingGaps.length > 6 ? `\n- …and ${a.remainingGaps.length - 6} more` : ""}\n` +
      `Next action: ${a.nextAction ?? "(none)"}\nRationale: ${a.rationale}\n` +
      `Assessed through material event seq ${a.assessedAtSeq}; current material seq ${latest.currentMaterialSeq}.`;
    if (Buffer.byteLength(body, "utf8") <= ASSESSMENT_DIGEST_MAX_BYTES) return body;
    const suffix = "\n...(truncated; inspection API has the full assessment)";
    const keep = Math.max(0, ASSESSMENT_DIGEST_MAX_BYTES - Buffer.byteLength(suffix, "utf8"));
    return `${Buffer.from(body, "utf8").subarray(0, keep).toString("utf8").replace(/\uFFFD+$/u, "")}${suffix}`;
  }

  latestCompletion(userSessionId: string): { revision: number; completion: CompletionRecord; createdAt: string } | null {
    const rows = this.#store.listForUserSession(userSessionId);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!;
      if (row.trigger === "completion" && row.completion) {
        return { revision: row.revision, completion: row.completion as unknown as CompletionRecord, createdAt: row.createdAt };
      }
    }
    return null;
  }

  /** Injected into MAIN's prompt each generation. Empty when never written (cache rule). */
  digest(userSessionId: string): string {
    const current = this.#store.current(userSessionId);
    if (!current) return "";
    const list = (title: string, items: string[]): string =>
      items.length === 0 ? "" : `\n${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
    const body =
      `Strategy: ${current.strategy || "(none recorded)"}${current.strategyWhy ? ` — ${current.strategyWhy}` : ""}` +
      list("Open uncertainties", current.uncertainties) +
      list("Assumptions", current.assumptions) +
      list("Risks", current.risks) +
      `\n(rev ${current.revision}, ${current.trigger}${current.note ? `: ${current.note}` : ""})`;
    const capped = Buffer.byteLength(body, "utf8") > DIGEST_MAX_BYTES
      ? `${body.slice(0, DIGEST_MAX_BYTES)}\n…(truncated)` : body;
    return `## Your working state (as you last recorded it — amend on material change, never as ceremony)\n${capped}`;
  }

  /** Checkpoint lines: the state a successor generation must inherit. */
  lines(userSessionId: string): string[] {
    const current = this.#store.current(userSessionId);
    if (!current) return [];
    return [
      ...(current.strategy ? [`Strategy: ${current.strategy}${current.strategyWhy ? ` — ${current.strategyWhy}` : ""}`] : []),
      ...current.uncertainties.map((item) => `Uncertain: ${item}`),
      ...current.assumptions.map((item) => `Assumes: ${item}`),
      ...current.risks.map((item) => `Risk: ${item}`),
    ];
  }

  #validateAssessment(userSessionId: string, input: Omit<ObjectiveAssessment, "objectiveDigest" | "assessedAtSeq">): void {
    const gaps = input.remainingGaps;
    const executable = gaps.filter((gap) => gap.executability === "executable");
    const clean = (value: string | null): string => value?.trim() ?? "";
    if (clean(input.currentState) === "" || clean(input.rationale) === "") {
      throw new InvalidInputError("objective assessment requires currentState and rationale");
    }
    const openIssues = new Set(this.#requireDeps().openDecisionIssueIds(userSessionId));
    for (const gap of gaps.filter((entry) => entry.executability === "operator_owned")) {
      if (!gap.refs.some((ref) => openIssues.has(ref))) {
        throw new InvalidInputError("operator_owned gaps must reference an open decision issue rather than duplicate operator-question truth");
      }
    }
    if (input.decision === "continue") {
      if (gaps.length === 0) throw new InvalidInputError("continue requires at least one meaningful remaining gap");
      if (clean(input.nextAction) === "") throw new InvalidInputError("continue requires a concrete next action or decision boundary");
      if (input.stopReason !== null) throw new InvalidInputError("continue cannot carry a stopReason");
      return;
    }
    if (input.stopReason === null) throw new InvalidInputError("stop requires a normalized stopReason");
    if (clean(input.nextAction) !== "") throw new InvalidInputError("stop cannot carry a nextAction");
    const operationalOnly = /^(there (are|is) )?(no active (agents|workers)|all (agents|workers) (are )?archived|the current wave is (done|complete)|tasks are quiet|context is (large|full)|quota (warning|is low))[.!]?$/i;
    if (operationalOnly.test(input.rationale.trim())) {
      throw new InvalidInputError("worker quietness, wave completion, context pressure, or quota is not a semantic objective stop reason");
    }
    this.#validateStopReason(userSessionId, input.stopReason, gaps, executable, input.stopEvidence,
      input.valueCostRationale);
  }

  #validateStopReason(userSessionId: string, reason: ObjectiveStopReason, gaps: ObjectiveGap[], executable: ObjectiveGap[],
    evidence: string[], valueCostRationale: string | null): void {
    if ((reason === "substantially_achieved" || reason === "genuinely_blocked" || reason === "needs_operator_judgment")
      && executable.length > 0) {
      throw new InvalidInputError(`${reason} cannot ignore ${executable.length} executable objective gap(s)`);
    }
    if (reason === "genuinely_blocked") {
      if (!gaps.some((gap) => gap.executability === "blocked")) throw new InvalidInputError("genuinely_blocked requires a blocked remaining gap");
      if (evidence.length === 0) throw new InvalidInputError("genuinely_blocked requires concrete blocker evidence/reference");
    }
    if (reason === "needs_operator_judgment") {
      const openIssues = new Set(this.#requireDeps().openDecisionIssueIds(userSessionId));
      const linked = gaps.some((gap) => gap.executability === "operator_owned" && gap.refs.some((ref) => openIssues.has(ref)));
      if (!linked) throw new InvalidInputError("needs_operator_judgment requires an operator-owned gap linked to an open decision issue");
    }
    if (reason === "diminishing_returns" && (valueCostRationale === null || valueCostRationale.trim().length < 20)) {
      throw new InvalidInputError("diminishing_returns requires a concrete value/cost rationale");
    }
  }

  #emit(row: OrchestrationStateRow, patch: { trigger: OrchestrationStateRow["trigger"]; strategy?: string;
    uncertainties?: string[]; assumptions?: string[]; risks?: string[] }, incorporating?: string[]): void {
    const sections = (["strategy", "uncertainties", "assumptions", "risks"] as const)
      .filter((section) => patch[section] !== undefined);
    this.#bus.append({
      type: "user_session.state.updated",
      userSessionId: row.userSessionId,
      payload: { userSessionId: row.userSessionId, revision: row.revision, trigger: row.trigger,
        sections: row.trigger === "completion" ? ["completion"] : row.trigger === "objective_assessment" ? ["objectiveAssessment"] : sections,
        ...(row.strategy === "" ? {} : { strategy: row.strategy.slice(0, 200) }),
        counts: { uncertainties: row.uncertainties.length, assumptions: row.assumptions.length, risks: row.risks.length },
        ...(incorporating === undefined || incorporating.length === 0 ? {} : { incorporating }) },
    });
  }
}
