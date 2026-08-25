/**
 * Human-in-the-loop interactions: every question anyone puts to the operator.
 *
 * Two askers, one table. The main lane's `AskUserQuestion`/`ExitPlanMode` park
 * inside `canUseTool`; an agent's `ask_operator` parks inside its MCP handler.
 * Rows are durable, the promise is not — so `detached` marks a row whose asker
 * has gone (park, rotation, watchdog, restart) but whose answer is still wanted
 * and is delivered by mailbox instead of by return.
 */
import type {
  Interaction,
  InteractionQuestion,
  InteractionSource,
  InteractionUrgency,
  ResolveInteractionBody,
} from "@agentique-console/shared";
import type { InteractionRow, InteractionStore } from "../db/stores/interaction-store.ts";
import type { DecisionIssueService } from "./decision-issues.ts";
import { planDecisionQuestion, planDecisionStrings, renderAnswer } from "./decisions.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import { ConflictError, NotFoundError, InvalidInputError } from "../errors.ts";

/** One pending decision the chat message was NOT applied to — main binds it explicitly. */
export interface HeldPendingQuestion {
  /** Null only for a legacy ask that predates the issue layer. */
  issueId: string | null;
  /** The oldest participating ask — the bind target for issueless legacy rows. */
  interactionId: string;
  subject: string;
  askers: string[];
}

export type InteractionResolution =
  | {
      kind: "answers";
      answers: Record<string, string[]>;
      freeText?: Record<string, string>;
      note?: string;
    }
  | { kind: "decision"; approved: boolean; note?: string; editedDocument?: string }
  | { kind: "dismissed"; reason: string };

/**
 * Where an answer goes when its asker's parked promise is gone. Narrow
 * callbacks (host/runner/user-session methods) wired once in `createApp`, so
 * this service routes without depending on any of them.
 */
export interface StaleAnswerRouting {
  /** A detached or stale AGENT question: the agent is woken by a mailbox delivery. */
  deliverToAgent(interaction: Interaction): void;
  /** A stale MAIN-LANE interaction: the answer becomes a fresh resumed turn. */
  reviveMain(userSessionId: string, prompt: string): void;
  /** An approved-but-stale plan still moves the session into execution. */
  beginExecuting(userSessionId: string): void;
  /**
   * A resolved issue's answer was SUPERSEDED after this asker already moved
   * on: the revision reaches it as a targeted mailbox note. Optional — narrow
   * unit harnesses may not wire it; the ledger's supersede entry still
   * reaches every seat through the bounded decision delta.
   */
  deliverIssueUpdate?(interaction: Interaction, text: string, dedupeKey: string): void;
}

function toWire(row: InteractionRow): Interaction {
  return {
    id: row.id,
    userSessionId: row.userSessionId,
    agentSessionId: row.agentSessionId,
    agent: row.participant,
    kind: row.kind,
    status: row.status,
    urgency: row.urgency,
    source: row.source,
    recommendation: row.recommendation,
    allowFreeText: row.allowFreeText,
    detached: row.detached,
    payload: row.payload as Interaction["payload"],
    response: row.response ?? null,
    issueId: row.issueId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

/** An ask the operator still owes an answer: pending/stale, or a provisional auto-proceed a human answer overrides. */
function awaitsHumanAnswer(row: InteractionRow): boolean {
  if (row.status === "pending" || row.status === "stale") return true;
  return row.status === "answered"
    && (row.response as { autoProceeded?: boolean } | null)?.autoProceeded === true;
}

/** The first question's text — the freeText key an issue answer is delivered under. */
function firstQuestionOf(row: InteractionRow): string {
  const questions = (row.payload as { questions?: InteractionQuestion[] }).questions ?? [];
  return questions[0]?.question ?? "";
}

/** Collapses whitespace and case so a re-asked question is recognisably the same one. */
export function dedupeKeyFor(asker: string, question: string): string {
  return `${asker}\n${question.trim().toLowerCase().replace(/\s+/g, " ")}`.slice(0, 400);
}

/**
 * The prompt for an answer-revival turn: the interaction's promise died with a
 * previous process, so the answer arrives as a fresh resumed turn instead.
 * Main lane only — an agent is revived by mailbox delivery, not by lane revival.
 */
export function revivalPrompt(
  interaction: Interaction,
  body: ResolveInteractionBody,
): string {
  const asked =
    interaction.kind === "question"
      ? `you asked the operator: ${JSON.stringify(
          (interaction.payload as { questions: InteractionQuestion[] }).questions.map(
            (q) => q.question,
          ),
        )}`
      : "you proposed a plan for approval";
  const answered =
    "answers" in body
      ? `They have now answered: ${JSON.stringify(body.answers)}.${
          body.freeText === undefined ? "" : ` In their own words: ${JSON.stringify(body.freeText)}.`
        }`
      : body.decision === "approve"
        ? `They have now approved it.${body.note === undefined ? "" : ` Note: ${body.note}`}`
        : `They asked for changes: ${body.note ?? "(no note)"}.`;
  return `[console] Earlier (before a server restart) ${asked}. ${answered} Continue from there.`;
}

export interface CreateOperatorQuestionInput {
  userSessionId: string;
  /** Null/absent = the main lane. */
  agentSessionId?: string | null;
  agent?: string | null;
  questions: InteractionQuestion[];
  urgency?: InteractionUrgency;
  source?: InteractionSource;
  recommendation?: string;
  allowFreeText?: boolean;
  dedupeKey?: string;
  toolUseId?: string;
  signal?: AbortSignal;
  /**
   * The requirement ids this question resolves or gates. Rides the payload;
   * the decision ledger pins the eventual answer to them.
   */
  requirementIds?: string[];
  /**
   * The decision issue this ask participates in (DecisionIssueService
   * `openForAsk` chose or minted it). `created` distinguishes the journal
   * entry: first ask of a fresh issue vs an attach to an existing one.
   */
  issue?: { id: string; created: boolean };
}

export class InteractionService {
  readonly #store: InteractionStore;
  readonly #bus: EventBus;
  /** The project decision-issue registry; absent only in narrow unit harnesses. */
  readonly #issues: DecisionIssueService | undefined;
  readonly #pending = new Map<string, (res: InteractionResolution) => void>();
  /** Fired when a session's last unresolved BLOCKING row resolves — see the final gate. */
  #onBlockingCleared: ((userSessionId: string, agentSessionId: string) => void) | undefined;
  /** Notified whenever any card resolves; the completion predicate re-evaluates. */
  #onResolved: ((userSessionId: string) => void) | undefined;
  #staleRouting: StaleAnswerRouting | undefined;

  constructor(store: InteractionStore, bus: EventBus, issues?: DecisionIssueService) {
    this.#store = store;
    this.#bus = bus;
    this.#issues = issues;
  }

  /**
   * The host registers this so a withheld `final` is not answered by silence:
   * when the last blocking question clears, the coordinator is told it may now
   * report.
   */
  onBlockingCleared(handler: (userSessionId: string, agentSessionId: string) => void): void {
    if (this.#onBlockingCleared) throw new Error("onBlockingCleared is already registered — wire callbacks once, in createApp");
    this.#onBlockingCleared = handler;
  }

  onResolved(handler: (userSessionId: string) => void): void {
    if (this.#onResolved) throw new Error("onResolved is already registered — wire callbacks once, in createApp");
    this.#onResolved = handler;
  }

  onStaleAnswerRouting(routing: StaleAnswerRouting): void {
    if (this.#staleRouting) throw new Error("onStaleAnswerRouting is already registered — wire callbacks once, in createApp");
    this.#staleRouting = routing;
  }

  /**
   * The REST answer endpoint's whole job: resolve the row, then route the
   * answer to wherever its asker now lives.
   *
   * An agent's answer cannot come back through a tool call that no longer
   * exists, and an agent is not revived by a lane — it is woken by a delivery.
   * So a detached or stale AGENT question is answered by mailbox. A stale
   * MAIN-LANE interaction's parked promise died with a previous process — its
   * answer becomes a fresh resumed turn instead.
   */
  resolveAndRoute(
    userSessionId: string,
    interactionId: string,
    body: ResolveInteractionBody,
  ): Interaction {
    if (!this.#staleRouting) throw new Error("onStaleAnswerRouting is not registered — wire callbacks once, in createApp");
    const before = this.get(interactionId);
    const beforeRow = this.#store.get(interactionId);
    const overridingAutoProceeded = beforeRow?.status === "answered"
      && (beforeRow.response as { autoProceeded?: boolean } | null)?.autoProceeded === true;
    const resolved = this.resolveFromApi(userSessionId, interactionId, body);
    // An auto-proceeded row's asker already moved on; the override reaches it
    // by mailbox exactly as a detached answer does.
    if (before.agent !== null && (before.detached || before.status === "stale" || overridingAutoProceeded)) {
      this.#staleRouting.deliverToAgent(before);
      return resolved;
    }
    if (before.agent === null && before.status === "stale") {
      if (
        before.kind === "plan_approval" &&
        "decision" in body &&
        body.decision === "approve"
      ) {
        this.#staleRouting.beginExecuting(userSessionId);
      }
      this.#staleRouting.reviveMain(userSessionId, revivalPrompt(before, body));
    }
    return resolved;
  }

  /** Creates a pending question card and parks its resolution promise. */
  createQuestion(
    userSessionId: string,
    questions: InteractionQuestion[],
    toolUseId: string | undefined,
    signal: AbortSignal | undefined,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    return this.createOperatorQuestion({
      userSessionId,
      questions,
      // Free text is first-class on MAIN's cards: the roguelike run's operator
      // disliked every offered option, had no way to say so, typed in chat —
      // and the answer was lost. Their words always outrank the options.
      allowFreeText: true,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  createOperatorQuestion(
    input: CreateOperatorQuestionInput,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    const urgency = input.urgency ?? "blocking";
    const source = input.source ?? "agent";
    const requirementIds = input.requirementIds ?? [];
    const pending = this.#create(
      input.userSessionId,
      "question",
      { questions: input.questions, ...(requirementIds.length === 0 ? {} : { requirementIds }) },
      input.toolUseId,
      input.signal,
      {
        agentSessionId: input.agentSessionId ?? null,
        participant: input.agent ?? null,
        urgency,
        source,
        recommendation: input.recommendation ?? null,
        dedupeKey: input.dedupeKey ?? null,
        allowFreeText: input.allowFreeText ?? false,
        issueId: input.issue?.id ?? null,
      },
      (id) => {
        this.#bus.append({
          type: "user_session.question.asked",
          userSessionId: input.userSessionId,
          ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
          payload: {
            userSessionId: input.userSessionId,
            interactionId: id,
            questions: input.questions,
            ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
            ...(input.agent ? { agent: input.agent } : {}),
            urgency,
            source,
            ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
            allowFreeText: input.allowFreeText ?? false,
            ...(input.issue === undefined ? {} : { issueId: input.issue.id }),
          },
        });
      },
    );
    if (input.issue !== undefined && this.#issues) {
      const row = this.#store.get(pending.id);
      if (row) this.#issues.recordAsk(input.issue.id, row, input.issue.created);
    }
    return pending;
  }

  /**
   * A REQUIREMENT revision rides the plan-approval machinery (the
   * interactions.kind CHECK cannot be widened on an existing SQLite
   * database): same card, same parked promise, same chat-dismissal
   * note-attachment — distinguished by the `requirements` payload marker.
   * The operator edits the canonical outline in place; the route validates
   * their edit with the shared parser BEFORE resolving, so a bad parse can
   * never eat an approval.
   */
  createRequirementsApproval(
    userSessionId: string,
    document: string,
    revision: number,
    changeNote: string | undefined,
    nodeCount: number,
    extras: {
      /** What the proposal patches; the card renders scope and diff context. */
      kind?: "full" | "intent" | "subtree";
      scope?: { scopeId: string; statement: string; ancestors: { id: string; statement: string }[] };
      summary?: { added: string[]; changed: { id: string; statement: string }[]; retired: { id: string; statement: string }[] };
    } = {},
  ): { id: string; resolution: Promise<InteractionResolution> } {
    const requirements = {
      revision,
      ...(changeNote === undefined || changeNote === "" ? {} : { changeNote }),
      nodeCount,
      ...(extras.kind === undefined ? {} : { kind: extras.kind }),
      ...(extras.scope === undefined ? {} : { scope: extras.scope }),
      ...(extras.summary === undefined ? {} : { summary: extras.summary }),
    };
    return this.#create(
      userSessionId,
      "plan_approval",
      { plan: document, requirements },
      undefined,
      undefined,
      {},
      (id) => {
        this.#bus.append({
          type: "user_session.plan.proposed",
          userSessionId,
          payload: { userSessionId, interactionId: id, plan: document, requirements },
        });
      },
    );
  }

  createPlanApproval(
    userSessionId: string,
    plan: string,
    toolUseId: string | undefined,
    signal: AbortSignal | undefined,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    return this.#create(
      userSessionId,
      "plan_approval",
      { plan },
      toolUseId,
      signal,
      {},
      (id) => {
        this.#bus.append({
          type: "user_session.plan.proposed",
          userSessionId,
          payload: { userSessionId, interactionId: id, plan },
        });
      },
    );
  }

  #create(
    userSessionId: string,
    kind: "question" | "plan_approval",
    payload: Record<string, unknown>,
    toolUseId: string | undefined,
    signal: AbortSignal | undefined,
    extra: Partial<InteractionRow>,
    emit: (id: string) => void,
  ): { id: string; resolution: Promise<InteractionResolution> } {
    const id = newId("int");
    const participant = extra.participant ?? null;
    this.#store.insert({
      id,
      userSessionId,
      kind,
      status: "pending",
      payload,
      response: null,
      toolUseId: toolUseId ?? null,
      createdAt: nowIso(),
      resolvedAt: null,
      ...extra,
    });
    emit(id);
    const resolution = new Promise<InteractionResolution>((resolve) => {
      this.#pending.set(id, resolve);
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.#pending.delete(id)) return;
          if (participant === null) {
            // Main lane: the turn is gone and the operator's answer will come
            // back as a resumed turn, so the card is done.
            this.#markResolved(id, "dismissed", { reason: "turn aborted" });
            resolve({ kind: "dismissed", reason: "the turn was interrupted" });
            return;
          }
          // An AGENT's question outlives its turn. Park, rotation and the
          // watchdog all tear the lane down; the operator has still been asked
          // and the answer still matters. Keep the row pending and mark it
          // detached so answering delivers by mailbox.
          this.#detachRow(id, "the asking turn ended before you answered");
          resolve({ kind: "dismissed", reason: "your turn ended before the operator answered; the question stays open and their answer will reach you as a delivery" });
        },
        { once: true },
      );
    });
    return { id, resolution };
  }

  /** REST answer endpoint. 409s when the interaction is already resolved. */
  resolveFromApi(
    userSessionId: string,
    interactionId: string,
    body: ResolveInteractionBody,
  ): Interaction {
    const row = this.#store.get(interactionId);
    if (!row || row.userSessionId !== userSessionId) {
      throw new NotFoundError(`no interaction ${interactionId}`);
    }
    // An auto-proceeded row stays overridable: the operator's real answer
    // supersedes the provisional one, enters the ledger, and reaches seats
    // through the ordinary decision delta.
    const autoProceeded = row.status === "answered"
      && (row.response as { autoProceeded?: boolean } | null)?.autoProceeded === true;
    if (row.status !== "pending" && row.status !== "stale" && !autoProceeded) {
      throw new ConflictError(`interaction ${interactionId} is already ${row.status}`);
    }

    if ("answers" in body) {
      if (row.kind !== "question") {
        throw new InvalidInputError("answers apply to question interactions");
      }
      if (body.freeText !== undefined && !row.allowFreeText) {
        throw new InvalidInputError("this question does not accept a free-text answer");
      }
      this.#markResolved(interactionId, "answered", {
        answers: body.answers,
        ...(body.freeText === undefined ? {} : { freeText: body.freeText }),
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      this.#bus.append({
        type: "user_session.question.answered",
        userSessionId,
        ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
        payload: {
          userSessionId,
          interactionId,
          answers: body.answers,
          ...(body.freeText === undefined ? {} : { freeText: body.freeText }),
          ...(body.note === undefined ? {} : { note: body.note }),
        },
      });
      this.#recordDecision(row, {
        answer: renderAnswer(body.answers, body.freeText),
        ...(body.note === undefined ? {} : { note: body.note }),
        source: "interaction",
      });
      this.#pending.get(interactionId)?.({
        kind: "answers",
        answers: body.answers,
        ...(body.freeText === undefined ? {} : { freeText: body.freeText }),
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      this.#pending.delete(interactionId);
      this.#notifyIfBlockingCleared(row);
      // One answer resolves the ISSUE — and with it every sibling ask, so no
      // other asker's card stays open for a question the human just settled.
      this.#completeIssueResolution(row, {
        answer: renderAnswer(body.answers, body.freeText),
        note: body.note,
        via: "card",
        interactionId: row.id,
      });
    } else {
      if (row.kind !== "plan_approval") {
        throw new InvalidInputError("decisions apply to plan_approval interactions");
      }
      const approved = body.decision === "approve";
      this.#markResolved(interactionId, approved ? "answered" : "rejected", {
        decision: body.decision,
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.editedDocument === undefined ? {} : { editedDocument: body.editedDocument }),
      });
      this.#bus.append({
        type: "user_session.plan.resolved",
        userSessionId,
        payload: {
          userSessionId,
          interactionId,
          approved,
          ...(body.note === undefined ? {} : { note: body.note }),
        },
      });
      // A plan approval IS an operator decision — the largest one they make.
      // Spec-marked cards record the revision they govern (the decision delta
      // is how running seats learn the spec moved).
      this.#recordDecision(row, {
        answer: planDecisionStrings(row.payload, approved, body.note).answer,
        source: "plan_approval",
      });
      this.#pending.get(interactionId)?.({
        kind: "decision",
        approved,
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.editedDocument === undefined ? {} : { editedDocument: body.editedDocument }),
      });
      this.#pending.delete(interactionId);
    }
    return this.get(interactionId);
  }

  /**
   * The entry ask was answered by its card: record the answer on the OPEN
   * issue and resolve every sibling ask (pending, stale, or provisionally
   * auto-proceeded) with the same human answer. Idempotent: once the issue is
   * resolved every participating ask is resolved with it, so a retried card
   * submit meets the ordinary 409 and never re-enters here.
   */
  #completeIssueResolution(
    entry: InteractionRow,
    res: { answer: string; note?: string | undefined; via: "card" | "chat" | "main"; interactionId?: string },
  ): void {
    if (!this.#issues || entry.issueId === null) return;
    let issue;
    try { issue = this.#issues.rowFor(entry.userSessionId, entry.issueId); } catch { return; }
    if (issue.status !== "open") return;
    const siblings = this.#store.listByIssue(issue.id)
      .filter((row) => row.id !== entry.id && awaitsHumanAnswer(row));
    this.#issues.resolve({
      userSessionId: entry.userSessionId,
      issueId: issue.id,
      answer: res.answer,
      note: res.note,
      via: res.via,
      interactionId: res.interactionId,
      resolvedAskIds: [entry.id, ...siblings.map((row) => row.id)],
    });
    for (const sibling of siblings) this.#resolveIssueSibling(sibling, res);
  }

  /**
   * One sibling ask of a resolved issue. The row records an ECHO — the answer
   * text plus the pointer to the card that carried it — so the asker's
   * delivery renders "its question → the operator's words" while the decision
   * ledger keeps ONE entry per issue (echoes are filtered there). Routing is
   * the same trio as everywhere else: parked promise, else mailbox for a
   * seat, else main-lane revival for a stale main row.
   */
  #resolveIssueSibling(
    row: InteractionRow,
    res: { answer: string; note?: string | undefined; via: "card" | "chat" | "main"; interactionId?: string },
  ): void {
    const wasStaleMain = row.participant === null && row.status === "stale";
    this.#markResolved(row.id, "answered", {
      issueEcho: true,
      issueId: row.issueId,
      ...(res.interactionId === undefined ? {} : { viaInteractionId: res.interactionId }),
      answer: res.answer,
      ...(res.note === undefined ? {} : { note: res.note }),
    });
    const freeText = { [firstQuestionOf(row)]: res.answer };
    this.#bus.append({
      type: "user_session.question.answered",
      userSessionId: row.userSessionId,
      ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
      payload: {
        userSessionId: row.userSessionId,
        interactionId: row.id,
        freeText,
        ...(res.note === undefined ? {} : { note: res.note }),
        issueId: row.issueId ?? "",
        ...(res.interactionId === undefined ? {} : { viaInteractionId: res.interactionId }),
      },
    });
    const parked = this.#pending.get(row.id);
    if (parked) {
      parked({ kind: "answers", answers: {}, freeText, ...(res.note === undefined ? {} : { note: res.note }) });
      this.#pending.delete(row.id);
    } else if (this.#staleRouting && row.participant !== null) {
      try { this.#staleRouting.deliverToAgent(this.get(row.id)); } catch { /* journaled above regardless */ }
    } else if (this.#staleRouting && wasStaleMain) {
      this.#staleRouting.reviveMain(
        row.userSessionId,
        revivalPrompt(toWire(row), { answers: {}, freeText }),
      );
    }
    this.#notifyIfBlockingCleared(row);
  }

  /**
   * Bind an answer to ONE issue explicitly — the chat path (exactly one open
   * issue pending) and main's `resolve_decision_issue` (the operator answered
   * in chat while several issues were open; main names which one the words
   * settle). On an OPEN issue: the oldest awaiting ask becomes the decision
   * row (chat-answer shape, so ledger rendering matches the clicked path) and
   * every other ask resolves as an echo. On a RESOLVED issue: the answer
   * SUPERSEDES — history retained, the ledger announces the revision, and
   * every participating seat gets a targeted mailbox note. Re-binding the
   * unchanged answer is a no-op.
   */
  bindIssueResolution(input: {
    userSessionId: string;
    issueId: string;
    answer: string;
    note?: string | undefined;
    via: "chat" | "main";
  }): { issueId: string; subject: string; outcome: "resolved" | "superseded" | "unchanged"; resolvedAskIds: string[] } {
    if (!this.#issues) throw new Error("decision issues are not wired — bindIssueResolution needs the DecisionIssueService");
    let issue;
    try {
      issue = this.#issues.rowFor(input.userSessionId, input.issueId);
    } catch (error) {
      // A held LEGACY ask (predates the issue layer) is addressed by its
      // interaction id — same tool, same semantics, no second bind path.
      const legacy = this.#store.get(input.issueId);
      if (legacy && legacy.userSessionId === input.userSessionId && legacy.kind === "question"
        && legacy.issueId === null && awaitsHumanAnswer(legacy)) {
        this.#resolveAskWithChatText(legacy, input.answer, input.via === "chat" ? "chat" : "main");
        return { issueId: legacy.id, subject: firstQuestionOf(legacy), outcome: "resolved", resolvedAskIds: [legacy.id] };
      }
      throw error;
    }
    if (issue.status === "superseded") {
      throw new ConflictError(
        `decision issue ${issue.id} was merged${issue.supersededById === null ? "" : ` into ${issue.supersededById}`} — bind the surviving issue`,
      );
    }
    if (issue.status === "resolved") {
      const { issue: updated, changed } = this.#issues.appendSupersede({
        userSessionId: input.userSessionId,
        issueId: issue.id,
        answer: input.answer,
        note: input.note,
        via: input.via === "chat" ? "main" : input.via,
      });
      if (!changed) return { issueId: issue.id, subject: issue.subject, outcome: "unchanged", resolvedAskIds: [] };
      const revision = updated.resolutions.length;
      const text =
        `The operator REVISED their decision on "${issue.subject}". The answer is now: ${JSON.stringify(input.answer)}. ` +
        "The earlier answer no longer stands — reconcile in-flight work with the new decision and report anything it invalidates.";
      for (const ask of this.#store.listByIssue(issue.id)) {
        if (ask.participant === null) continue;
        try {
          this.#staleRouting?.deliverIssueUpdate?.(this.get(ask.id), text, `issue-supersede:${issue.id}:${revision}`);
        } catch { /* the ledger's supersede entry still reaches every seat */ }
      }
      return { issueId: issue.id, subject: issue.subject, outcome: "superseded", resolvedAskIds: [] };
    }
    const awaiting = this.#store.listByIssue(issue.id).filter(awaitsHumanAnswer);
    if (awaiting.length === 0) {
      // An open issue with no awaiting ask (every asker withdrew): record the
      // answer directly so the choice still lands in the registry.
      this.#issues.resolve({
        userSessionId: input.userSessionId, issueId: issue.id, answer: input.answer,
        note: input.note, via: input.via, resolvedAskIds: [],
      });
      return { issueId: issue.id, subject: issue.subject, outcome: "resolved", resolvedAskIds: [] };
    }
    const [primary, ...rest] = awaiting;
    this.#resolveAskWithChatText(primary!, input.answer, input.via);
    this.#issues.resolve({
      userSessionId: input.userSessionId,
      issueId: issue.id,
      answer: input.answer,
      note: input.note,
      via: input.via,
      interactionId: primary!.id,
      resolvedAskIds: awaiting.map((row) => row.id),
    });
    for (const sibling of rest) {
      this.#resolveIssueSibling(sibling, { answer: input.answer, note: input.note, via: input.via, interactionId: primary!.id });
    }
    return { issueId: issue.id, subject: issue.subject, outcome: "resolved", resolvedAskIds: awaiting.map((row) => row.id) };
  }

  /**
   * One ask answered by the operator's CHAT words — the byte-shape the
   * pre-issue chat path established: a `dismissed` row whose stored
   * `chatText` IS the answer (`decisionOf` renders it "(in chat) …"), a
   * hedged release for a parked asker, and a mailbox delivery for a detached
   * one. `boundBy: "main"` marks provenance when main, not proximity, chose
   * the issue.
   */
  #resolveAskWithChatText(row: InteractionRow, chatText: string, via: "chat" | "main"): void {
    this.#markResolved(row.id, "dismissed", {
      reason: "chat",
      chatText,
      ...(via === "main" ? { boundBy: "main" } : {}),
      ...(row.issueId === null ? {} : { issueId: row.issueId }),
    });
    this.#bus.append({
      type: "user_session.question.answered",
      userSessionId: row.userSessionId,
      ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
      payload: {
        userSessionId: row.userSessionId, interactionId: row.id, dismissed: true, note: chatText,
        ...(row.issueId === null ? {} : { issueId: row.issueId }),
      },
    });
    this.#recordDecision(row, { answer: `(answered in chat) ${chatText}`, source: "interaction" });
    const hedge = via === "chat"
      ? `The operator typed in chat while your question card was open. Their words: ${JSON.stringify(chatText)}. ` +
        "Treat this as their answer if it addresses your question; if it clearly does not, proceed on your stated recommendation or re-ask once."
      : `The operator answered in chat and the orchestrator bound their words to your question: ${JSON.stringify(chatText)}. ` +
        "Act on this as their answer; if it clearly does not address your question, re-ask once.";
    const parked = this.#pending.get(row.id);
    if (parked) {
      parked({ kind: "dismissed", reason: hedge });
      this.#pending.delete(row.id);
    } else if (this.#staleRouting && row.participant !== null) {
      try { this.#staleRouting.deliverToAgent(this.get(row.id)); } catch { /* journaled above regardless */ }
    }
    this.#notifyIfBlockingCleared(row);
  }

  /**
   * Operator chatted while cards were pending.
   *
   * MAIN-LANE cards (native AskUserQuestion, plan approvals — no decision
   * issue) are dismissed/rejected with the words attached: the model about to
   * read the operator's actual message IS the asker, so nothing is misrouted.
   *
   * DECISION asks (anything carrying an issue, main-lane included, plus
   * legacy issueless agent cards) group BY ISSUE, and the words bind only
   * when exactly ONE issue is pending: a live run showed holding everything
   * loses answers (the operator typed answers in chat three times, was
   * refused three times, and four questions aged 5–7.5 hours), while the old
   * resolve-everything rule made the same words the recorded answer to every
   * unrelated question. With several distinct issues open, ambiguity HOLDS
   * them open — the returned descriptors let the runner tell main to bind the
   * words to the right issue explicitly (`resolve_decision_issue`) instead of
   * the console guessing.
   */
  dismissPendingForChat(userSessionId: string, chatText: string): { held: HeldPendingQuestion[] } {
    const rows = this.#listByStatus(userSessionId, "pending");
    let deliveredToAgents = 0;
    const decisionGroups = new Map<string, InteractionRow[]>();
    for (const row of rows) {
      if (row.kind === "question" && (row.issueId !== null || row.participant !== null)) {
        const key = row.issueId ?? `ask:${row.id}`;
        const group = decisionGroups.get(key) ?? [];
        group.push(row);
        decisionGroups.set(key, group);
        continue;
      }
      if (row.kind === "plan_approval") {
        this.#markResolved(row.id, "rejected", {
          decision: "reject",
          note: chatText,
        });
        this.#bus.append({
          type: "user_session.plan.resolved",
          userSessionId,
          payload: {
            userSessionId,
            interactionId: row.id,
            approved: false,
            note: chatText,
          },
        });
        // Event parity with the card path: the run summary reads
        // operator.decision.recorded, and a chat rejection is no less a
        // decision than a clicked one.
        this.#recordDecision(row, {
          answer: `${planDecisionStrings(row.payload, false).answer} (in chat): ${chatText}`,
          source: "plan_approval",
        });
        this.#pending.get(row.id)?.({
          kind: "decision",
          approved: false,
          note: chatText,
        });
      } else {
        this.#markResolved(row.id, "dismissed", { reason: "chat", chatText });
        this.#bus.append({
          type: "user_session.question.answered",
          userSessionId,
          payload: {
            userSessionId,
            interactionId: row.id,
            dismissed: true,
            note: chatText,
          },
        });
        // The words themselves enter the decision ledger — "use three.js"
        // typed in chat was lost by the old contentless dismissal, and the
        // orchestrator built on its own defaults.
        this.#recordDecision(row, {
          answer: `(answered in chat) ${chatText}`,
          source: "interaction",
        });
        // The deny result the model is LOOKING AT when it decides its next
        // action carries the answer itself; "read their next message" was a
        // forward reference to a message the model had not been given.
        this.#pending.get(row.id)?.({
          kind: "dismissed",
          reason:
            `The operator answered in chat instead of the card. Their words: ${JSON.stringify(chatText)}. ` +
            "Treat this as their answer to the question(s) above — do not proceed on defaults, and do not re-ask.",
        });
      }
      this.#pending.delete(row.id);
    }

    // The safety line: ONE pending issue means the words can only be meant for
    // it; several distinct issues mean guessing, and a wrong guess records the
    // operator's words as the answer to a question they never read. Ambiguity
    // holds every issue open.
    if (decisionGroups.size > 1) {
      const held = [...decisionGroups.values()].map((group) => this.#heldDescriptor(group));
      this.#bus.append({
        type: "user_session.runtime.noted",
        userSessionId,
        payload: {
          userSessionId,
          detail: `operator chatted while ${held.length} distinct decision issues were pending; nothing was auto-resolved — main binds the answer to the right issue`,
        },
      });
      return { held };
    }
    const only = [...decisionGroups.values()][0];
    if (only !== undefined) {
      const issueId = only[0]!.issueId;
      if (issueId !== null && this.#issues) {
        const bound = this.bindIssueResolution({ userSessionId, issueId, answer: chatText, via: "chat" });
        deliveredToAgents += bound.resolvedAskIds
          .filter((id) => this.#store.get(id)?.participant !== null).length;
      } else {
        // Legacy issueless agent ask (predates the issue layer): the original
        // single-card chat behavior, byte-identical shapes.
        for (const row of only) {
          this.#resolveAskWithChatText(row, chatText, "chat");
          if (row.participant !== null) deliveredToAgents += 1;
        }
      }
    }
    if (deliveredToAgents > 0) {
      this.#bus.append({
        type: "user_session.runtime.noted",
        userSessionId,
        payload: {
          userSessionId,
          detail: `chat answer delivered to ${deliveredToAgents} agent question(s) as their answer`,
        },
      });
    }
    return { held: [] };
  }

  /** The operator-legible shape of one held group, for main's binding turn. */
  #heldDescriptor(group: InteractionRow[]): HeldPendingQuestion {
    const oldest = group[0]!;
    let subject = firstQuestionOf(oldest);
    if (oldest.issueId !== null && this.#issues) {
      try { subject = this.#issues.rowFor(oldest.userSessionId, oldest.issueId).subject; } catch { /* the ask's own wording stands in */ }
    }
    return {
      issueId: oldest.issueId,
      interactionId: oldest.id,
      subject,
      askers: [...new Set(group.map((row) => row.participant ?? "main"))],
    };
  }

  /** Escalations already sent, so a blocking ask wakes main once, not per sweep. */
  readonly #escalated = new Set<string>();

  /**
   * The autonomy sweep. A live run held 5h23m (46% of wall clock) behind
   * four questions ALL filed `urgency: deferred` — the field said "you can
   * keep going" and nothing enforced it, while every ask carried a
   * `recommendation` nothing ever consumed. Two rules:
   *
   * - a pending DEFERRED question with a recommendation older than the
   *   deadline resolves as a PROVISIONAL decision — the recommendation,
   *   flagged as auto-proceeded, overridable by the operator retroactively
   *   (resolveFromApi accepts re-resolution of these rows);
   * - a pending BLOCKING question older than its deadline escalates ONCE:
   *   main is woken to re-route independent work and decide whether an
   *   investigation can answer it (a real defect report sat 83 minutes
   *   unanswered with no clock on it at all). In "away" autonomy a blocking
   *   ask WITH a recommendation auto-proceeds at the deadline instead.
   *
   * plan_approval cards never auto-proceed: a specification needs a human.
   */
  sweepStaleAsks(input: {
    deferredAutoProceedMs: number;
    blockingAskEscalateMs: number;
    autonomyOf: (userSessionId: string) => "standard" | "away";
    escalate: (row: Interaction) => void;
  }): void {
    if (input.deferredAutoProceedMs <= 0 && input.blockingAskEscalateMs <= 0) return;
    const now = Date.now();
    for (const row of this.#store.listPendingQuestions()) {
      const age = now - Date.parse(row.createdAt);
      const away = input.autonomyOf(row.userSessionId) === "away";
      const recommendation = row.recommendation?.trim() || null;
      const deferredDeadline = away ? Math.max(60_000, input.deferredAutoProceedMs / 3) : input.deferredAutoProceedMs;
      const canAutoProceed = recommendation !== null
        && (row.urgency === "deferred" ? input.deferredAutoProceedMs > 0 && age >= deferredDeadline
          : away && input.blockingAskEscalateMs > 0 && age >= input.blockingAskEscalateMs);
      if (canAutoProceed) {
        this.#autoProceed(row, recommendation as string, Math.round(age / 60_000));
        continue;
      }
      if (row.urgency === "blocking" && input.blockingAskEscalateMs > 0 && age >= input.blockingAskEscalateMs
        && row.participant !== null && !this.#escalated.has(row.id)) {
        this.#escalated.add(row.id);
        try { input.escalate(this.get(row.id)); } catch { /* re-escalated never; the card stays visible */ }
      }
    }
  }

  #autoProceed(row: InteractionRow, recommendation: string, ageMinutes: number): void {
    this.#markResolved(row.id, "answered", {
      autoProceeded: true, freeText: recommendation,
      note: "provisional — proceeded on the asker's recommendation; the operator may override",
    });
    this.#bus.append({
      type: "user_session.question.answered",
      userSessionId: row.userSessionId,
      ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
      payload: { userSessionId: row.userSessionId, interactionId: row.id, autoProceeded: true, recommendation },
    });
    this.#recordDecision(row, {
      answer: `(provisional — proceeded on the asker's recommendation after ${ageMinutes} min unanswered; you may override) ${recommendation}`,
      source: "interaction",
    });
    const reason =
      `No operator answer after ${ageMinutes} minutes. Proceed on your stated recommendation: ${JSON.stringify(recommendation)}. ` +
      "This is recorded as a provisional decision the operator may override later — note the assumption in your work and continue.";
    const parked = this.#pending.get(row.id);
    if (parked) {
      parked({ kind: "dismissed", reason });
      this.#pending.delete(row.id);
    } else if (this.#staleRouting && row.participant !== null) {
      try { this.#staleRouting.deliverToAgent(this.get(row.id)); } catch { /* journaled above regardless */ }
    }
    this.#notifyIfBlockingCleared(row);
  }

  listPending(userSessionId: string): Interaction[] {
    return [
      ...this.#listByStatus(userSessionId, "pending"),
      ...this.#listByStatus(userSessionId, "stale"),
    ].map(toWire);
  }

  /** Every ask participating in one decision issue, oldest first. */
  listAsksForIssue(issueId: string): Interaction[] {
    return this.#store.listByIssue(issueId).map(toWire);
  }

  /** An unresolved row with the same normalized question from the same asker. */
  findUnresolvedByDedupe(agentSessionId: string, dedupeKey: string): Interaction | undefined {
    const row = this.#store.findUnresolvedByDedupe(agentSessionId, dedupeKey);
    return row ? toWire(row) : undefined;
  }

  /** Every still-open question raised inside one AgentSession. Feeds the final gate. */
  listUnresolvedForAgentSession(agentSessionId: string): Interaction[] {
    return this.#store.listUnresolvedForAgentSession(agentSessionId).map(toWire);
  }

  /**
   * Answered questions the ASKING AGENT has not been told about yet — durable
   * and guaranteed to reach the asker at its next delivery.
   */
  listAnsweredUnflushed(agentSessionId: string, agent?: string): Interaction[] {
    return this.#store.listAnsweredUnflushed(agentSessionId, agent)
      .filter((row) => row.status === "answered" || row.status === "rejected")
      .map(toWire);
  }

  markFlushed(ids: readonly string[]): void {
    this.#store.markFlushed(ids);
  }

  /**
   * The asker is gone but the question is not. Keeps the row `pending` and
   * answerable; the answer will be delivered rather than returned.
   */
  detach(id: string, reason: string): void {
    // Unpark the asker first so its tool call returns, then mark the row. The
    // order matters: the resolver must see a still-`pending` row.
    const resolve = this.#pending.get(id);
    this.#pending.delete(id);
    this.#detachRow(id, reason);
    resolve?.({ kind: "dismissed", reason });
  }


  get(id: string): Interaction {
    const row = this.#store.get(id);
    if (!row) throw new NotFoundError(`no interaction ${id}`);
    return toWire(row);
  }

  /**
   * Boot pass, split by asker.
   *
   * Main-lane rows go `stale`: their promise died with the process, and the
   * revival path replays the answer as a resumed turn.
   *
   * Agent rows stay `pending` and become `detached`: an agent is not revived
   * by a lane, it is woken by a delivery — so its question is still genuinely
   * open and answering it still reaches somebody.
   */
  expirePendingOnBoot(): void {
    this.#store.markPendingMainStale();
    this.#store.markPendingSeatsDetached();
  }

  /**
   * A resolved interaction IS the decision record — the `DecisionLedger` is a
   * read-model over these rows, so there is nothing to write and keep in sync.
   * What remains here is the timeline event (the Run Summary reads decisions
   * from the event window; a live UI can, too).
   */
  #recordDecision(
    row: InteractionRow,
    input: { answer: string; note?: string; source: "interaction" | "plan_approval" },
  ): void {
    const question = row.kind === "plan_approval"
      ? planDecisionQuestion(row.payload)
      : ((row.payload as { questions?: InteractionQuestion[] }).questions ?? []).map((q) => q.question).join(" | ");
    if (question === "" && input.answer === "") return;
    this.#bus.append({
      type: "operator.decision.recorded",
      userSessionId: row.userSessionId,
      ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
      payload: {
        userSessionId: row.userSessionId,
        decisionId: row.id,
        ...(row.agentSessionId ? { agentSessionId: row.agentSessionId } : {}),
        interactionId: row.id,
        // Attribution matters: "renderer asked this" reads very differently
        // from "the console asked this" when the operator reviews the run.
        askedBy: row.participant ?? "main",
        source: input.source,
        question,
        answer: input.answer,
      },
    });
  }

  #detachRow(id: string, reason: string): void {
    const row = this.#store.get(id);
    if (!row || row.status !== "pending") return;
    this.#store.setDetached(id);
    if (row.agentSessionId === null || row.participant === null) return;
    this.#bus.append({
      type: "agent_session.runtime.noted",
      userSessionId: row.userSessionId,
      agentSessionId: row.agentSessionId,
      payload: {
        agentSessionId: row.agentSessionId,
        agent: row.participant,
        detail: `question ${row.id} detached (${reason}); it stays open and the answer will arrive as a delivery`,
      },
    });
  }

  /** Fires the host's hook when a session's LAST blocking question clears. */
  #notifyIfBlockingCleared(row: InteractionRow): void {
    if (row.agentSessionId === null || row.urgency !== "blocking") return;
    if (this.#store.listPendingBlocking(row.agentSessionId).length === 0) {
      this.#onBlockingCleared?.(row.userSessionId, row.agentSessionId);
    }
  }

  #listByStatus(
    userSessionId: string,
    status: InteractionRow["status"],
  ): InteractionRow[] {
    return this.#store.listByStatus(userSessionId, status);
  }

  #markResolved(
    id: string,
    status: "answered" | "rejected" | "dismissed",
    response: Record<string, unknown>,
  ): void {
    this.#store.markResolved(id, status, response);
    const row = this.#store.get(id);
    // A pending question is a completion blocker, so resolving one may be the
    // last thing standing between this run and its sign-off card.
    if (row) this.#onResolved?.(row.userSessionId);
  }
}
