/**
 * Decision issues: the project-level registry of unresolved human choices.
 *
 * An ASK (an `interactions` row) is one agent's attempt to get an answer; the
 * ISSUE is the durable shared question one or more asks refer to. Identity is
 * EXPLICIT — an asker attaches by `issueKey`, or main merges duplicates it
 * discovers — never inferred from wording: a false split costs a merge, a
 * false merge silently conflates two different human choices.
 *
 * The division of labor with InteractionService mirrors the store/service
 * split everywhere else: THIS service owns issue rows, attachment, the
 * resolution history, merging, and the derived wire model; the
 * InteractionService owns everything that touches an ask's parked promise or
 * delivery routing (resolving participating asks lives there). Blocking
 * weight and provisional state are DERIVED from the participating asks at
 * read time, so a terminated asker never leaves a zombie "blocking" issue and
 * a provisional auto-proceed never masquerades as a human answer.
 */
import type {
  DecisionIssueAskWire,
  DecisionIssueResolution,
  DecisionIssueWire,
  InteractionQuestion,
} from "@agentique-console/shared";
import type { DecisionIssueRow, DecisionIssueStore } from "../db/stores/decision-issue-store.ts";
import type { InteractionRow, InteractionStore } from "../db/stores/interaction-store.ts";
import type { EventBus } from "../events/bus.ts";
import { ConflictError, InvalidInputError, NotFoundError } from "../errors.ts";
import { nowIso } from "../ids.ts";

/**
 * The explicit attach key, normalized so "Auth SSO?" and "auth-sso" agree:
 * lowercase, non-alphanumerics collapsed to single dashes, bounded. Purely
 * lexical — no similarity, no inference; two askers attach to one issue by
 * SAYING the same key, not by wording their questions alike.
 */
export function normalizeIssueKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function questionTextOfRow(row: InteractionRow): string {
  const questions = (row.payload as { questions?: InteractionQuestion[] }).questions ?? [];
  return questions.map((question) => question.question).join(" | ");
}

/**
 * One canonical line per issue, for tool reads and main's briefings. Every
 * asker's recommendation is preserved side by side — competing
 * recommendations are information for the human, and neither the first nor
 * the newest is silently authoritative.
 */
export function renderDecisionIssue(issue: DecisionIssueWire): string {
  const key = issue.issueKey === null ? "" : ` key=${issue.issueKey}`;
  const state = issue.status === "open"
    ? issue.provisional
      ? `open, proceeding provisionally (NOT a human decision); ${issue.blockingAsksActive} blocking ask(s) active`
      : `open; ${issue.blockingAsksActive} blocking ask(s) active`
    : issue.status === "resolved"
      ? `resolved${issue.resolutions.length > 1 ? ", revised" : ""}: ${issue.resolution?.answer ?? ""}`
      : `merged into ${issue.supersededById ?? "?"}`;
  const askers = issue.asks.map((ask) =>
    ask.recommendation === null ? ask.asker : `${ask.asker} (recommends: ${ask.recommendation})`).join("; ");
  const requirements = issue.requirementIds.length === 0 ? "" : ` [${issue.requirementIds.join(", ")}]`;
  return `- ${issue.id}${key} (${state}) ${issue.subject}${requirements} — asked by: ${askers || issue.createdBy}`;
}

export interface DecisionIssueDeps {
  /** Whether an ask's AgentSession is still open — the live-blocking derivation. */
  isAgentSessionOpen(agentSessionId: string): boolean;
}

export class DecisionIssueService {
  readonly #store: DecisionIssueStore;
  readonly #interactions: InteractionStore;
  readonly #bus: EventBus;
  readonly #resolveProject: (userSessionId: string) => string;
  #deps: DecisionIssueDeps | null = null;

  constructor(
    store: DecisionIssueStore,
    interactions: InteractionStore,
    bus: EventBus,
    resolveProject: (userSessionId: string) => string,
  ) {
    this.#store = store;
    this.#interactions = interactions;
    this.#bus = bus;
    this.#resolveProject = resolveProject;
  }

  /** Wired once in createApp — the derivation reads session facts. */
  setDeps(deps: DecisionIssueDeps): void {
    this.#deps = deps;
  }

  /**
   * The issue an incoming ask participates in: the open issue with the same
   * explicit key when one exists, a fresh issue otherwise (unkeyed asks are
   * always fresh — main can merge later). The caller creates the interaction
   * row with the returned id, then calls `recordAsk` so the journal names the
   * ask.
   */
  openForAsk(input: {
    userSessionId: string;
    issueKey?: string | undefined;
    subject: string;
    requirementIds: string[];
    createdBy: string;
  }): { issue: DecisionIssueRow; attachedToExisting: boolean } {
    const projectId = this.#resolveProject(input.userSessionId);
    const issueKey = input.issueKey === undefined ? null : normalizeIssueKey(input.issueKey);
    if (issueKey !== null && issueKey === "") {
      throw new InvalidInputError("issueKey must contain at least one letter or digit");
    }
    if (issueKey !== null) {
      const existing = this.#store.findOpenByKey(projectId, issueKey);
      if (existing) return { issue: existing, attachedToExisting: true };
    }
    const issue = this.#store.insert({
      projectId,
      userSessionId: input.userSessionId,
      issueKey,
      subject: input.subject,
      requirementIds: [...new Set(input.requirementIds)],
      createdBy: input.createdBy,
    });
    return { issue, attachedToExisting: false };
  }

  /**
   * Journal one ask's participation (after its interaction row exists) and
   * fold its requirement ids into the issue's union. First ask emits
   * `created`; later asks emit `ask_attached` so the operator surface can say
   * "one answer resolves N asks".
   */
  recordAsk(issueId: string, ask: InteractionRow, created: boolean): void {
    const issue = this.#store.get(issueId);
    if (!issue) return;
    const askIds = (ask.payload as { requirementIds?: string[] }).requirementIds ?? [];
    const union = [...new Set([...issue.requirementIds, ...askIds])];
    if (union.length !== issue.requirementIds.length) {
      this.#store.setRequirementIds(issue.id, union);
    }
    if (created) {
      this.#bus.append({
        type: "decision_issue.created",
        userSessionId: ask.userSessionId,
        payload: {
          userSessionId: ask.userSessionId,
          issueId: issue.id,
          issueKey: issue.issueKey,
          subject: issue.subject,
          createdBy: issue.createdBy,
          interactionId: ask.id,
          requirementIds: union,
        },
      });
      return;
    }
    this.#bus.append({
      type: "decision_issue.ask_attached",
      userSessionId: ask.userSessionId,
      payload: {
        userSessionId: ask.userSessionId,
        issueId: issue.id,
        interactionId: ask.id,
        asker: ask.participant ?? "main",
        agentSessionId: ask.agentSessionId,
        askCount: this.#interactions.listByIssue(issue.id).length,
      },
    });
  }

  /**
   * Record the human answer on an OPEN issue. Called by InteractionService,
   * which has already resolved (or is about to resolve) the participating
   * asks — this is the row update and journal entry only. Idempotent at the
   * caller: a resolved issue never re-enters here except through
   * `appendSupersede`.
   */
  resolve(input: {
    userSessionId: string;
    issueId: string;
    answer: string;
    note?: string | undefined;
    via: "card" | "chat" | "main";
    interactionId?: string | undefined;
    resolvedAskIds: string[];
  }): DecisionIssueRow {
    const issue = this.#requireInProject(input.userSessionId, input.issueId);
    if (issue.status !== "open") {
      throw new ConflictError(`decision issue ${issue.id} is already ${issue.status}`);
    }
    const entry: DecisionIssueResolution = {
      answer: input.answer,
      ...(input.note === undefined || input.note === "" ? {} : { note: input.note }),
      via: input.via,
      ...(input.interactionId === undefined ? {} : { interactionId: input.interactionId }),
      at: nowIso(),
    };
    this.#store.setResolutions(issue.id, [...issue.resolutions, entry], "resolved");
    this.#bus.append({
      type: "decision_issue.resolved",
      userSessionId: input.userSessionId,
      payload: {
        userSessionId: input.userSessionId,
        issueId: issue.id,
        subject: issue.subject,
        answer: input.answer,
        via: input.via,
        resolvedAskIds: input.resolvedAskIds,
        supersedes: false,
      },
    });
    return this.#store.get(issue.id)!;
  }

  /**
   * The operator changed their mind after resolution: append a SUPERSEDING
   * entry — the earlier answer stays in the history, the new one becomes
   * current, and the decision ledger (which folds these entries in) announces
   * it to every seat through the ordinary bounded delta. Re-binding the
   * unchanged current answer is a no-op, so retried binds cannot stack
   * duplicate reversals.
   */
  appendSupersede(input: {
    userSessionId: string;
    issueId: string;
    answer: string;
    note?: string | undefined;
    via: "main" | "card";
  }): { issue: DecisionIssueRow; changed: boolean } {
    const issue = this.#requireInProject(input.userSessionId, input.issueId);
    if (issue.status !== "resolved") {
      throw new ConflictError(`decision issue ${issue.id} is ${issue.status}, not resolved — only a resolved issue can be superseded`);
    }
    const current = issue.resolutions[issue.resolutions.length - 1];
    if (current !== undefined && current.answer === input.answer) {
      return { issue, changed: false };
    }
    const entry: DecisionIssueResolution = {
      answer: input.answer,
      ...(input.note === undefined || input.note === "" ? {} : { note: input.note }),
      via: input.via,
      supersedes: true,
      at: nowIso(),
    };
    this.#store.setResolutions(issue.id, [...issue.resolutions, entry], "resolved");
    this.#bus.append({
      type: "decision_issue.resolved",
      userSessionId: input.userSessionId,
      payload: {
        userSessionId: input.userSessionId,
        issueId: issue.id,
        subject: issue.subject,
        answer: input.answer,
        via: input.via,
        resolvedAskIds: [],
        supersedes: true,
      },
    });
    return { issue: this.#store.get(issue.id)!, changed: true };
  }

  /**
   * Main discovered two open issues are one human choice. The source's asks
   * move to the target, requirement unions merge, and the source becomes a
   * `superseded` pointer — history, not a deletion. Prefer-false-split's other
   * half: splitting is never automatic, and neither is merging.
   */
  merge(input: {
    userSessionId: string;
    fromIssueId: string;
    intoIssueId: string;
    why: string;
  }): DecisionIssueRow {
    if (input.fromIssueId === input.intoIssueId) {
      throw new InvalidInputError("an issue cannot be merged into itself");
    }
    const from = this.#requireInProject(input.userSessionId, input.fromIssueId);
    const into = this.#requireInProject(input.userSessionId, input.intoIssueId);
    if (from.status !== "open") throw new ConflictError(`decision issue ${from.id} is already ${from.status}`);
    if (into.status !== "open") throw new ConflictError(`decision issue ${into.id} is already ${into.status} — merge into an open issue`);
    const movedAskIds = this.#interactions.reassignIssue(from.id, into.id);
    const union = [...new Set([...into.requirementIds, ...from.requirementIds])];
    if (union.length !== into.requirementIds.length) this.#store.setRequirementIds(into.id, union);
    this.#store.markSuperseded(from.id, into.id);
    this.#bus.append({
      type: "decision_issue.merged",
      userSessionId: input.userSessionId,
      payload: {
        userSessionId: input.userSessionId,
        fromIssueId: from.id,
        intoIssueId: into.id,
        movedAskIds,
        why: input.why,
      },
    });
    return this.#store.get(into.id)!;
  }

  get(userSessionId: string, issueId: string): DecisionIssueWire {
    return this.#toWire(this.#requireInProject(userSessionId, issueId));
  }

  /**
   * The project registry, deterministically ordered by structural
   * consequence, not model urgency: open before resolved/superseded; open
   * issues by live blocking weight, then requirement breadth, then age
   * (oldest first — the longest-standing unanswered choice is the one most
   * likely already baked into work).
   */
  listForProject(userSessionId: string): DecisionIssueWire[] {
    const wires = this.#store
      .listByProject(this.#resolveProject(userSessionId))
      .map((row) => this.#toWire(row));
    const rank = (wire: DecisionIssueWire): number => (wire.status === "open" ? 0 : 1);
    return wires.sort((a, b) =>
      rank(a) - rank(b)
      || b.blockingAsksActive - a.blockingAsksActive
      || b.requirementIds.length - a.requirementIds.length
      || a.createdAt.localeCompare(b.createdAt));
  }

  listOpenForProject(userSessionId: string): DecisionIssueWire[] {
    return this.listForProject(userSessionId).filter((wire) => wire.status === "open");
  }

  /** The row an InteractionService resolution path needs, project-checked. */
  rowFor(userSessionId: string, issueId: string): DecisionIssueRow {
    return this.#requireInProject(userSessionId, issueId);
  }

  #requireInProject(userSessionId: string, issueId: string): DecisionIssueRow {
    const row = this.#store.get(issueId);
    if (!row || row.projectId !== this.#resolveProject(userSessionId)) {
      throw new NotFoundError(`no decision issue ${issueId} in this project`);
    }
    return row;
  }

  #toWire(row: DecisionIssueRow): DecisionIssueWire {
    const asks = this.#interactions.listByIssue(row.id);
    const askWires: DecisionIssueAskWire[] = asks.map((ask) => ({
      interactionId: ask.id,
      agentSessionId: ask.agentSessionId,
      asker: ask.participant ?? "main",
      question: questionTextOfRow(ask),
      status: ask.status,
      urgency: ask.urgency,
      autoProceeded: (ask.response as { autoProceeded?: boolean } | null)?.autoProceeded === true,
      recommendation: ask.recommendation,
      createdAt: ask.createdAt,
    }));
    // Live weight counts only asks whose asker can still act on the answer:
    // main-lane asks always, seat asks only while their session is open.
    const active = asks.filter((ask) =>
      (ask.status === "pending" || ask.status === "stale")
      && (ask.agentSessionId === null || (this.#deps?.isAgentSessionOpen(ask.agentSessionId) ?? true)));
    const resolution = row.resolutions.length === 0 ? null : row.resolutions[row.resolutions.length - 1]!;
    return {
      id: row.id,
      issueKey: row.issueKey,
      subject: row.subject,
      status: row.status,
      provisional: row.status === "open" && askWires.some((ask) => ask.autoProceeded),
      requirementIds: row.requirementIds,
      asks: askWires,
      blockingAsksActive: active.filter((ask) => ask.urgency === "blocking").length,
      pendingAsksActive: active.length,
      resolutions: row.resolutions,
      resolution,
      supersededById: row.supersededById,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    };
  }
}
