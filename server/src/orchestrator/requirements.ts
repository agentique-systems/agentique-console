/**
 * The requirement graph service: the run's committed specification and its
 * live state, replacing SpecService as the governing document (SpecService
 * stays as the read-only legacy store; every read path here falls back to it
 * for pre-graph runs).
 *
 * Two change regimes, deliberately separated:
 * - COMMITTED STRUCTURE (statements, composition, which nodes exist) moves
 *   only through propose → operator approval, revisioned append-only. The
 *   orchestrator may refine its representation of scope; it may not silently
 *   redefine its committed success condition.
 * - LIVE STATE (statuses, evidence, refinement decomposition, delegations)
 *   moves continuously, journaled on the event bus, evidence-required for
 *   terminal statuses.
 *
 * Derivation is console-owned and mechanical: models claim LEAF statuses with
 * evidence; parents and the root compose (all/any) at read time and are never
 * stored — like pattern contracts, the console executes the composition and
 * never takes a model's word for a roll-up.
 */
import type {
  EvidenceRef,
  RequirementComposition,
  RequirementFrontierEntry,
  RequirementGraph,
  RequirementGraphNode,
  RequirementNodeWire,
  RequirementParseError,
  RequirementStatus,
} from "@agentique-console/shared";
import {
  REQUIREMENT_MAX_DEPTH,
  deriveComposedStatus,
  flattenRequirementGraph,
  parseRequirementsDocument,
  renderCommitted,
  renderStatusOutline,
  requirementStatusCounts,
} from "@agentique-console/shared";
import type { EventBus } from "../events/bus.ts";
import type {
  ApprovalNodeOps,
  RequirementLinkRow,
  RequirementNodeRow,
  RequirementRevisionRow,
  RequirementStore,
} from "../db/stores/requirement-store.ts";
import type { AssumptionStore } from "../db/stores/assumption-store.ts";
import type { ProjectStore } from "../db/stores/project-store.ts";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import type { SpecService } from "./spec.ts";

const TERMINAL_STATUSES = new Set(["satisfied", "violated", "infeasible"]);

/** Bound on the injected digest; the full outline stays a tool call away. */
const DIGEST_MAX_BYTES = 8 * 1024;

/**
 * The two prompt-injection contracts the composer, runner, and checkpoints
 * consume. RequirementService implements them with a legacy-spec fallback, so
 * call sites keep one dependency and pre-graph runs keep their digest.
 */
export interface GoverningDigest {
  digest(userSessionId: string): string;
  pointer(userSessionId: string): string | null;
}

export interface RequirementFrontierDeps {
  /** Open (non-archived) agent session ids for a run. */
  openAgentSessionIds(userSessionId: string): Set<string>;
  /** requirementId → a linked task is waiting on incomplete dependencies. */
  blockedRequirementIds(userSessionId: string): Set<string>;
  /** Agent sessions with a pending operator interaction. */
  awaitingOperatorAgentSessionIds(userSessionId: string): Set<string>;
}

export class RequirementParseFailure extends InvalidInputError {
  readonly errors: RequirementParseError[];
  constructor(errors: RequirementParseError[]) {
    super(
      "the document does not parse as a requirement outline: " +
        errors.map((error) => `line ${error.line}: ${error.message}`).join("; "),
    );
    this.errors = errors;
  }
}

export class RequirementService implements GoverningDigest {
  readonly #store: RequirementStore;
  readonly #projects: ProjectStore;
  readonly #assumptions: AssumptionStore;
  readonly #legacy: SpecService;
  readonly #bus: EventBus;
  readonly #resolveProject: (userSessionId: string) => string;
  #frontierDeps: RequirementFrontierDeps | null = null;
  #pendingProposalCheck: ((userSessionId: string) => boolean) | null = null;
  #wakeNote: ((userSessionId: string, text: string) => void) | null = null;

  constructor(
    store: RequirementStore,
    projects: ProjectStore,
    assumptions: AssumptionStore,
    legacy: SpecService,
    bus: EventBus,
    resolveProject: (userSessionId: string) => string,
  ) {
    this.#store = store;
    this.#projects = projects;
    this.#assumptions = assumptions;
    this.#legacy = legacy;
    this.#bus = bus;
    this.#resolveProject = resolveProject;
  }

  /**
   * Wired once in createApp: how a console-established fact (a dependency
   * that moved under satisfied work) wakes main. Record-and-display doctrine:
   * the wake carries the fact; reopening stays a model or operator act.
   */
  setWakeNote(wake: (userSessionId: string, text: string) => void): void {
    this.#wakeNote = wake;
  }

  /** Wired once in createApp — the frontier reads other aggregates' facts. */
  setFrontierDeps(deps: RequirementFrontierDeps): void {
    this.#frontierDeps = deps;
  }

  /**
   * Wired once in createApp: is a requirements-proposal card already pending
   * for this session? One pending proposal at a time is the concurrency
   * model — with sequential continuation it makes a stale base revision
   * impossible, so the approve-time assertion is enforcement, not a merge.
   */
  setPendingProposalCheck(check: (userSessionId: string) => boolean): void {
    this.#pendingProposalCheck = check;
  }

  /** The project a session's graph lives in — the store's query key. */
  #project(userSessionId: string): string {
    return this.#resolveProject(userSessionId);
  }

  // ── committed structure ──────────────────────────────────────────────────

  latestApproved(userSessionId: string): RequirementRevisionRow | undefined {
    return this.#store.latestApproved(this.#project(userSessionId));
  }

  /** The completion-currency token: the approved revision number (0 = none). */
  governingRevision(userSessionId: string): number {
    return this.latestApproved(userSessionId)?.revision ?? 0;
  }

  /**
   * The operator-approved intent prose (title + preamble). Falls back to the
   * latest approved revision's stored graph for projects from before the
   * column existed. Null when nothing governs or the document had no prose.
   */
  intentDocument(userSessionId: string): string | null {
    const stored = this.#projects.get(this.#project(userSessionId))?.intentDocument ?? null;
    if (stored !== null) return stored === "" ? null : stored;
    const approved = this.#store.latestApproved(this.#project(userSessionId));
    if (!approved) return null;
    const graph = approved.graph as unknown as RequirementGraph;
    return renderIntentDocument(graph);
  }

  listRevisions(userSessionId: string): RequirementRevisionRow[] {
    return this.#store.listRevisions(this.#project(userSessionId));
  }

  getRevision(id: string): RequirementRevisionRow | undefined {
    return this.#store.getRevision(id);
  }

  /** The route's soft-fail hook: structural errors, or id problems, or ok. */
  validateDocument(userSessionId: string, text: string): { ok: true } | { ok: false; errors: RequirementParseError[] } {
    const parsed = parseRequirementsDocument(text);
    if (!parsed.ok) return parsed;
    const idErrors = this.#unknownIdErrors(userSessionId, parsed.graph, text);
    if (idErrors.length > 0) return { ok: false, errors: idErrors };
    return { ok: true };
  }

  /**
   * Draft a revision. Throws RequirementParseFailure (with line errors) when
   * the outline does not parse or names an id this session never minted — the
   * tool result carries the lines so main can fix and re-propose.
   */
  propose(userSessionId: string, document: string, changeNote?: string): RequirementRevisionRow {
    if (this.#pendingProposalCheck?.(userSessionId)) {
      throw new InvalidInputError(
        "a requirements proposal is already awaiting the operator — resolve that card before proposing again",
      );
    }
    const parsed = parseRequirementsDocument(document);
    if (!parsed.ok) throw new RequirementParseFailure(parsed.errors);
    if (parsed.graph.nodes.length === 0) {
      throw new RequirementParseFailure([{ line: 1, message: "the ## Requirements section has no requirements" }]);
    }
    const idErrors = this.#unknownIdErrors(userSessionId, parsed.graph, document);
    if (idErrors.length > 0) throw new RequirementParseFailure(idErrors);
    const projectId = this.#project(userSessionId);
    return this.#store.insertDraft({
      projectId,
      userSessionId,
      document,
      graph: parsed.graph as unknown as Record<string, unknown>,
      changeNote: changeNote ?? null,
      baseRevision: this.#store.latestApproved(projectId)?.revision ?? 0,
    });
  }

  /**
   * Approve with the operator's final text: re-parse, mint ids for new lines,
   * diff against the live registry, apply in one store transaction, and
   * re-store the CANONICAL render (every node carrying its id) so the next
   * amendment starts from a fully-tagged document.
   */
  approve(
    revisionId: string,
    input: { document: string; edited: boolean; interactionId?: string | null },
  ): { revision: RequirementRevisionRow; added: string[]; retired: string[] } {
    const draft = this.#store.getRevision(revisionId);
    if (!draft) throw new NotFoundError(`no requirement revision ${revisionId}`);
    // The single-writer invariant's enforcement: under sequential continuation
    // and one-pending-proposal this cannot fire; if it does, the graph moved
    // after drafting and the old evidence attests against different words.
    const governing = this.#store.latestApproved(draft.projectId)?.revision ?? 0;
    if (draft.baseRevision !== governing) {
      this.#store.reject(revisionId);
      throw new InvalidInputError(
        `stale proposal — the requirements moved to revision ${governing} after this proposal was drafted against revision ${draft.baseRevision}; re-propose from the current graph`,
      );
    }
    const parsed = parseRequirementsDocument(input.document);
    if (!parsed.ok) throw new RequirementParseFailure(parsed.errors);
    const idErrors = this.#unknownIdErrors(draft.userSessionId, parsed.graph, input.document);
    if (idErrors.length > 0) throw new RequirementParseFailure(idErrors);

    const { graph, ops, resets } = this.#computeApproval(draft.userSessionId, parsed.graph, draft.revision);
    const canonical = renderCommitted(graph);
    const approved = this.#store.applyApproval({
      revisionId,
      document: canonical,
      graph: graph as unknown as Record<string, unknown>,
      edited: input.edited,
      interactionId: input.interactionId ?? null,
      ops,
    });
    // The intent prose (title + preamble) is the project's durable vision:
    // stored on the project so it outlives sessions and later scoped patches.
    // A whole-document approval with no prose CLEARS it ("" reads as null,
    // and the pre-column fallback is skipped) — the operator removed it.
    this.#projects.setIntentDocument(approved.projectId, renderIntentDocument(graph) ?? "");
    const added = ops.inserts.map((insert) => insert.id);
    this.#bus.append({
      type: "user_session.requirements.updated",
      userSessionId: approved.userSessionId,
      payload: {
        userSessionId: approved.userSessionId,
        revision: approved.revision,
        ...(approved.changeNote === null ? {} : { changeNote: approved.changeNote }),
        edited: input.edited,
        nodeCount: flattenRequirementGraph(graph).length,
        added,
        retired: ops.retires,
      },
    });
    // Console statement-resets reach the BUS, not just the table journal: the
    // event stream must replay to the statuses the store holds (journal-as-
    // truth — the eval checkers and any live consumer replay exactly this).
    for (const reset of resets) {
      this.#bus.append({
        type: "requirement.status.changed",
        userSessionId: approved.userSessionId,
        payload: {
          userSessionId: approved.userSessionId,
          requirementId: reset.id,
          from: reset.from,
          to: "open",
          verifiedBy: "console",
          actor: "console",
          evidenceCount: 0,
          note: `statement amended in rev ${approved.revision}`,
        },
      });
    }
    return { revision: approved, added, retired: ops.retires };
  }

  reject(revisionId: string): void {
    this.#store.reject(revisionId);
  }

  // ── live state ───────────────────────────────────────────────────────────

  /**
   * A leaf status claim. Terminal statuses require evidence (the operator's
   * own verdicts are exempt — their word IS the gate, recorded as such).
   * Reports land on LEAVES only: a parent's status is derived, never asserted.
   */
  reportStatus(input: {
    userSessionId: string;
    requirementId: string;
    to: "open" | "satisfied" | "violated" | "infeasible";
    evidence: EvidenceRef[];
    verifiedBy: "self" | "independent" | "operator";
    actor: string;
    agentSessionId?: string;
    note?: string;
  }): RequirementNodeWire {
    const projectId = this.#project(input.userSessionId);
    const node = this.#liveNode(input.userSessionId, input.requirementId);
    const children = this.#store.liveNodes(projectId).filter((row) => row.parentId === node.id);
    if (children.length > 0) {
      throw new InvalidInputError(
        `${node.id} has children — its status derives from them; report on the leaves instead: ${children.map((child) => child.id).join(", ")}`,
      );
    }
    if (input.to !== "open" && input.evidence.length === 0 && input.verifiedBy !== "operator") {
      throw new InvalidInputError(`marking ${node.id} ${input.to} requires at least one evidence ref`);
    }
    const atRevision = this.#store.latestApproved(projectId)?.revision ?? 0;
    const { change, node: updated } = this.#store.applyStatusChange({
      projectId,
      userSessionId: input.userSessionId,
      requirementId: input.requirementId,
      toStatus: input.to,
      evidence: input.evidence,
      verifiedBy: input.verifiedBy,
      actor: input.actor,
      agentSessionId: input.agentSessionId ?? null,
      atRevision,
      note: input.note ?? null,
    });
    this.#bus.append({
      type: "requirement.status.changed",
      userSessionId: input.userSessionId,
      ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      payload: {
        userSessionId: input.userSessionId,
        requirementId: input.requirementId,
        from: change.fromStatus,
        to: change.toStatus,
        verifiedBy: input.verifiedBy,
        actor: input.actor,
        ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
        evidenceCount: input.evidence.length,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });
    // A dependency moving out from under terminal claims is a fact main must
    // judge: wake it naming the suspect dependents. Record-and-display — no
    // status is rewritten here.
    if (input.to === "open" || input.to === "violated") {
      const latest = this.#store.latestChanges(projectId);
      const suspects = this.#store.liveLinks(projectId)
        .filter((row) => row.kind === "depends_on" && row.toId === node.id)
        .map((row) => row.fromId)
        .filter((id) => TERMINAL_STATUSES.has(latest.get(id)?.toStatus ?? ""));
      if (suspects.length > 0) {
        this.#wakeNote?.(input.userSessionId,
          `[Console: ${node.id} was ${input.to === "open" ? "reopened" : "reported violated"} by ${input.actor}. ` +
          `These requirements depend on it and hold terminal claims recorded BEFORE this change: ${suspects.join(", ")}. ` +
          `Judge whether their claims still stand — reopen with report_requirement, re-verify, or amend. The Console changed nothing.]`);
      }
    }
    return this.derive(input.userSessionId).find((wire) => wire.id === updated.id)!;
  }

  /**
   * Refinement: add children BELOW an existing node without operator
   * approval — it refines how a committed requirement is discharged, never
   * what counts as success. Journaled and attributed; rendered as
   * session-authored in the graph.
   */
  decompose(input: {
    userSessionId: string;
    parentId: string;
    children: { statement: string; composition?: RequirementComposition }[];
    actor: string;
    agentSessionId?: string;
  }): string[] {
    const projectId = this.#project(input.userSessionId);
    const parent = this.#liveNode(input.userSessionId, input.parentId);
    if (input.children.length === 0) throw new InvalidInputError("decompose needs at least one child statement");
    // The parser caps outline depth (top level = 0, deepest legal = MAX-1);
    // refinement must respect the same bound or the next canonical render
    // would no longer round-trip through the shared grammar.
    const byId = new Map(this.#store.liveNodes(projectId).map((row) => [row.id, row]));
    let parentDepth = 0;
    for (let cursor = parent.parentId; cursor !== null; cursor = byId.get(cursor)?.parentId ?? null) parentDepth += 1;
    if (parentDepth + 1 >= REQUIREMENT_MAX_DEPTH) {
      throw new InvalidInputError(
        `children of ${parent.id} would exceed the maximum outline depth of ${REQUIREMENT_MAX_DEPTH} — restructure via a requirement amendment instead of refining deeper`,
      );
    }
    const existing = this.#store.liveNodes(projectId).filter((row) => row.parentId === parent.id);
    // Past the LAST existing sibling ord, not sibling count: an amendment
    // renumbers committed children by document position, so count-based ords
    // would collide with a later-approved committed sibling.
    const baseOrd = existing.reduce((max, row) => Math.max(max, row.ord + 1), 0);
    let nextNumber = this.#store.maxNodeNumber(projectId) + 1;
    const children = input.children.map((child, index) => ({
      id: `r${nextNumber++}`,
      ord: baseOrd + index,
      statement: child.statement.replaceAll(/\s*\n\s*/g, " ").trim(),
      composition: child.composition ?? ("all" as const),
    }));
    for (const child of children) {
      if (child.statement === "") throw new InvalidInputError("a child statement is empty");
    }
    this.#store.insertRefinementNodes({
      projectId,
      parentId: parent.id,
      agentSessionId: input.agentSessionId ?? null,
      children,
    });
    const addedIds = children.map((child) => child.id);
    this.#bus.append({
      type: "requirement.decomposed",
      userSessionId: input.userSessionId,
      ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      payload: {
        userSessionId: input.userSessionId,
        parentId: parent.id,
        addedIds,
        actor: input.actor,
        ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      },
    });
    return addedIds;
  }

  // ── links ────────────────────────────────────────────────────────────────

  /**
   * Record one relationship. Never part of derivation — links feed the
   * frontier's blocked annotation, delegation context, and the invalidation
   * flags. depends_on is acyclic (checked here); conflicts_with is symmetric
   * and normalizes to the numerically smaller id first, so the unique pair
   * index also blocks inverse duplicates; rests_on targets an assumption.
   * Idempotent: recording an existing link is a no-op, reported as such.
   */
  link(input: {
    userSessionId: string;
    fromId: string;
    kind: "depends_on" | "conflicts_with" | "rests_on";
    toId: string;
    actor: string;
    agentSessionId?: string;
    note?: string;
  }): { recorded: boolean } {
    const projectId = this.#project(input.userSessionId);
    const from = this.#liveNode(input.userSessionId, input.fromId);
    let fromId = from.id;
    let toId = input.toId;
    let toKind: "requirement" | "assumption" = "requirement";
    if (input.kind === "rests_on") {
      toKind = "assumption";
      if (!this.#assumptions.get(projectId, input.toId)) {
        throw new NotFoundError(`no assumption ${input.toId} — record_assumption mints one`);
      }
    } else {
      const to = this.#liveNode(input.userSessionId, input.toId);
      if (from.id === to.id) throw new InvalidInputError("a requirement cannot link to itself");
      if (input.kind === "conflicts_with" && mintNumberOf(to.id) < mintNumberOf(from.id)) {
        fromId = to.id;
        toId = from.id;
      }
      if (input.kind === "depends_on") this.#assertAcyclicDependsOn(projectId, from.id, to.id);
    }
    const row = this.#store.insertLink({
      projectId, fromId, toKind, toId, kind: input.kind,
      createdByActor: input.actor, agentSessionId: input.agentSessionId ?? null,
      note: input.note ?? null,
    });
    if (row === null) return { recorded: false };
    this.#bus.append({
      type: "requirement.link.changed",
      userSessionId: input.userSessionId,
      ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      payload: {
        userSessionId: input.userSessionId, action: "recorded", linkKind: input.kind,
        fromId, toKind, toId, actor: input.actor,
        ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      },
    });
    return { recorded: true };
  }

  unlink(input: {
    userSessionId: string;
    fromId: string;
    kind: "depends_on" | "conflicts_with" | "rests_on";
    toId: string;
    actor: string;
    agentSessionId?: string;
  }): void {
    const projectId = this.#project(input.userSessionId);
    const match = this.#store.liveLinks(projectId).find((row) =>
      row.kind === input.kind
      && ((row.fromId === input.fromId && row.toId === input.toId)
        || (input.kind === "conflicts_with" && row.fromId === input.toId && row.toId === input.fromId)));
    if (!match) throw new NotFoundError(`no live ${input.kind} link ${input.fromId} → ${input.toId}`);
    this.#store.retireLink(projectId, match.id);
    this.#bus.append({
      type: "requirement.link.changed",
      userSessionId: input.userSessionId,
      ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      payload: {
        userSessionId: input.userSessionId, action: "retired", linkKind: match.kind,
        fromId: match.fromId, toKind: match.toKind, toId: match.toId, actor: input.actor,
        ...(input.agentSessionId === undefined ? {} : { agentSessionId: input.agentSessionId }),
      },
    });
  }

  /** Live links for a project's session — read surface for composer and API. */
  liveLinks(userSessionId: string): RequirementLinkRow[] {
    return this.#store.liveLinks(this.#project(userSessionId));
  }

  /** One tick of the shared invalidation clock (status changes ∪ assumption resolutions). */
  allocateChangeOrd(userSessionId: string): number {
    return this.#store.nextChangeOrd(this.#project(userSessionId));
  }

  /** Adding from→to must not close a cycle: reject if `from` is reachable FROM `to`. */
  #assertAcyclicDependsOn(projectId: string, fromId: string, toId: string): void {
    const edges = new Map<string, string[]>();
    for (const row of this.#store.liveLinks(projectId)) {
      if (row.kind !== "depends_on") continue;
      const list = edges.get(row.fromId) ?? [];
      list.push(row.toId);
      edges.set(row.fromId, list);
    }
    const seen = new Set<string>([toId]);
    const queue = [toId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === fromId) {
        throw new InvalidInputError(`${fromId} depends_on ${toId} would create a dependency cycle`);
      }
      for (const next of edges.get(current) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
  }

  // ── delegation ───────────────────────────────────────────────────────────

  /**
   * Record that a session was commissioned against requirement ids — the
   * delegation-traceability join, and the scope of the session's requirement
   * tools. Validates the ids exist and are live; idempotent per pair.
   */
  delegate(
    userSessionId: string,
    agentSessionId: string,
    requirementIds: string[],
    source: "commission" | "assignment" | "child",
    handoffId?: string,
  ): void {
    const unique = [...new Set(requirementIds)];
    for (const id of unique) this.#liveNode(userSessionId, id);
    const inserted = this.#store.insertDelegations({
      userSessionId,
      agentSessionId,
      requirementIds: unique,
      source,
      handoffId: handoffId ?? null,
    });
    if (inserted.length === 0) return;
    this.#bus.append({
      type: "requirement.delegated",
      userSessionId,
      agentSessionId,
      payload: { userSessionId, agentSessionId, requirementIds: inserted.map((row) => row.requirementId), source },
    });
  }

  /** The requirement ids delegated to a session (its sub-scope roots). */
  delegationSet(agentSessionId: string): string[] {
    return this.#store.delegationsFor(agentSessionId).map((row) => row.requirementId);
  }

  /**
   * Subtree enforcement: a session may act on a requirement iff the node or
   * one of its ancestors was delegated to it. Anything else is main's.
   */
  assertWithinDelegation(userSessionId: string, agentSessionId: string, requirementId: string): void {
    const roots = new Set(this.delegationSet(agentSessionId));
    if (roots.size === 0) {
      throw new InvalidInputError("this session holds no delegated requirements");
    }
    const byId = new Map(this.#store.liveNodes(this.#project(userSessionId)).map((row) => [row.id, row]));
    let cursor: RequirementNodeRow | undefined = byId.get(requirementId);
    if (!cursor) throw new NotFoundError(`no live requirement ${requirementId}`);
    while (cursor) {
      if (roots.has(cursor.id)) return;
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    throw new InvalidInputError(
      `${requirementId} is outside this session's delegated requirements (${[...roots].join(", ")}) — route it to main`,
    );
  }

  // ── read models ──────────────────────────────────────────────────────────

  /**
   * Live nodes in depth-first document order, with recorded AND derived
   * statuses, delegation joins, and verification chips.
   */
  derive(userSessionId: string): RequirementNodeWire[] {
    const projectId = this.#project(userSessionId);
    const nodes = this.#depthFirst(this.#store.liveNodes(projectId));
    const derived = this.#derivedStatuses(nodes);
    const latest = this.#store.latestChanges(projectId);
    const openSessions = this.#frontierDeps?.openAgentSessionIds(userSessionId) ?? new Set<string>();
    const delegatedTo = new Map<string, string[]>();
    for (const delegation of this.#store.delegationsForUserSession(userSessionId)) {
      if (!openSessions.has(delegation.agentSessionId)) continue;
      const list = delegatedTo.get(delegation.requirementId) ?? [];
      list.push(delegation.agentSessionId);
      delegatedTo.set(delegation.requirementId, list);
    }
    const links = this.#linkViews(projectId);
    return nodes.map((node) => {
      const change = latest.get(node.id);
      const dependsOn = links.dependsOn.get(node.id) ?? [];
      const restsOn = links.restsOn.get(node.id) ?? [];
      // The invalidation flags: deterministic ordinal comparisons on the
      // shared clock — a terminal claim is suspect when something under it
      // carries a LATER ord. Self-clearing: any new claim on the node.
      const flags: RequirementNodeWire["flags"] = [];
      if (change !== undefined && TERMINAL_STATUSES.has(change.toStatus)) {
        if (dependsOn.some((target) => (latest.get(target)?.ord ?? 0) > change.ord)) {
          flags.push("depends_changed");
        }
        if (restsOn.some((entry) => entry.status === "falsified" && (entry.resolvedOrd ?? 0) > change.ord)) {
          flags.push("rests_on_falsified");
        }
      }
      return {
        id: node.id,
        parentId: node.parentId,
        ord: node.ord,
        statement: node.statement,
        composition: node.composition,
        status: node.status,
        derivedStatus: derived.get(node.id) ?? node.status,
        origin: node.origin,
        introducedInRevision: node.introducedInRevision,
        retiredInRevision: node.retiredInRevision,
        refinedByAgentSessionId: node.refinedByAgentSessionId,
        delegatedTo: delegatedTo.get(node.id) ?? [],
        latestChange: change === undefined ? null : {
          status: change.toStatus as RequirementStatus,
          verifiedBy: change.verifiedBy,
          actor: change.actor,
          evidenceCount: change.evidence.length,
          at: change.createdAt,
        },
        dependsOn,
        dependents: links.dependents.get(node.id) ?? [],
        conflictsWith: links.conflictsWith.get(node.id) ?? [],
        restsOn: restsOn.map((entry) => ({ id: entry.id, status: entry.status })),
        flags,
      };
    });
  }

  /** Live links folded into per-node views (conflicts merged symmetric). */
  #linkViews(projectId: string): {
    dependsOn: Map<string, string[]>;
    dependents: Map<string, string[]>;
    conflictsWith: Map<string, string[]>;
    restsOn: Map<string, { id: string; status: "open" | "confirmed" | "falsified" | "retired"; resolvedOrd: number | null }[]>;
  } {
    const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
      const list = map.get(key) ?? [];
      list.push(value);
      map.set(key, list);
    };
    const views = {
      dependsOn: new Map<string, string[]>(),
      dependents: new Map<string, string[]>(),
      conflictsWith: new Map<string, string[]>(),
      restsOn: new Map<string, { id: string; status: "open" | "confirmed" | "falsified" | "retired"; resolvedOrd: number | null }[]>(),
    };
    const assumptionById = new Map(this.#assumptions.list(projectId).map((row) => [row.id, row]));
    for (const row of this.#store.liveLinks(projectId)) {
      if (row.kind === "depends_on") {
        push(views.dependsOn, row.fromId, row.toId);
        push(views.dependents, row.toId, row.fromId);
      } else if (row.kind === "conflicts_with") {
        push(views.conflictsWith, row.fromId, row.toId);
        push(views.conflictsWith, row.toId, row.fromId);
      } else {
        const assumption = assumptionById.get(row.toId);
        if (assumption) push(views.restsOn, row.fromId, { id: assumption.id, status: assumption.status, resolvedOrd: assumption.resolvedOrd });
      }
    }
    return views;
  }

  /** The run root's derived status: every top-level requirement, composed "all". */
  rootStatus(userSessionId: string): RequirementStatus {
    const nodes = this.#store.liveNodes(this.#project(userSessionId));
    if (nodes.length === 0) return "open";
    const derived = this.#derivedStatuses(nodes);
    return deriveComposedStatus(
      "all",
      nodes.filter((node) => node.parentId === null).map((node) => derived.get(node.id) ?? node.status),
    );
  }

  /**
   * Open requirements — every LEAF whose resolution can still affect the
   * root — annotated from console-owned facts only: a live delegation, a
   * dependency-blocked task, a pending operator interaction, or nothing yet.
   */
  frontier(userSessionId: string): RequirementFrontierEntry[] {
    const nodes = this.#store.liveNodes(this.#project(userSessionId));
    if (nodes.length === 0) return [];
    const derived = this.#derivedStatuses(nodes);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map<string, RequirementNodeRow[]>();
    for (const node of nodes) {
      if (node.parentId === null) continue;
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    }
    const openSessions = this.#frontierDeps?.openAgentSessionIds(userSessionId) ?? new Set<string>();
    const blockedIds = this.#frontierDeps?.blockedRequirementIds(userSessionId) ?? new Set<string>();
    const awaitingSessions = this.#frontierDeps?.awaitingOperatorAgentSessionIds(userSessionId) ?? new Set<string>();
    const delegations = this.#store.delegationsForUserSession(userSessionId)
      .filter((row) => openSessions.has(row.agentSessionId));
    const delegatedIds = new Map<string, string[]>();
    for (const row of delegations) {
      const list = delegatedIds.get(row.requirementId) ?? [];
      list.push(row.agentSessionId);
      delegatedIds.set(row.requirementId, list);
    }

    /** Delegations apply to whole subtrees: check self and ancestors. */
    const sessionsFor = (id: string): string[] => {
      const out: string[] = [];
      let cursor = byId.get(id);
      while (cursor) {
        out.push(...(delegatedIds.get(cursor.id) ?? []));
        cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
      }
      return out;
    };

    // Requirement-level dependency blocking: an open leaf whose depends_on
    // target is not yet satisfied is blocked, whatever the task ledger says.
    const dependsOn = new Map<string, string[]>();
    for (const row of this.#store.liveLinks(this.#project(userSessionId))) {
      if (row.kind !== "depends_on") continue;
      const list = dependsOn.get(row.fromId) ?? [];
      list.push(row.toId);
      dependsOn.set(row.fromId, list);
    }

    return nodes
      .filter((node) => (children.get(node.id) ?? []).length === 0)
      .filter((node) => (derived.get(node.id) ?? node.status) === "open")
      .filter((node) => this.#affectsRoot(node, byId, children, derived))
      .map((node) => {
        const sessions = sessionsFor(node.id);
        const linkBlocked = (dependsOn.get(node.id) ?? [])
          .some((target) => (derived.get(target) ?? byId.get(target)?.status ?? "open") !== "satisfied");
        const annotations: RequirementFrontierEntry["annotations"] = [];
        if (sessions.length > 0) annotations.push("in_progress");
        if (blockedIds.has(node.id) || linkBlocked) annotations.push("blocked");
        if (sessions.some((sessionId) => awaitingSessions.has(sessionId))) annotations.push("awaiting_operator");
        if (annotations.length === 0) annotations.push("unassigned");
        return { requirementId: node.id, statement: node.statement, annotations };
      });
  }

  // ── prompt surfaces (the GoverningDigest contract) ───────────────────────

  /**
   * The prompt injection. Requirement outline with live statuses when a
   * revision governs; the legacy spec digest for pre-graph runs; EMPTY when
   * nothing governs (prompt-cache byte-stability rule). Over the byte cap it
   * first collapses fully-satisfied subtrees, then truncates with a marker.
   */
  digest(userSessionId: string): string {
    const projectId = this.#project(userSessionId);
    const approved = this.#store.latestApproved(projectId);
    if (!approved) return this.#legacy.digest(userSessionId);
    const nodes = this.#store.liveNodes(projectId);
    const header = `## Requirements (rev ${approved.revision}, authoritative — statuses are console-derived; claim leaves with evidence via report_requirement)`;
    // The operator's intent prose travels with the outline: the vision is
    // what keeps distributed work aligned, so it degrades LAST. A prose-less
    // run renders byte-identically to before (cache stability).
    const intent = this.intentDocument(userSessionId);
    const prose = intent === null ? "" : `${intent}\n\n`;
    const trail = this.#store.listRevisions(projectId)
      .filter((row) => row.changeNote !== null && (row.status === "approved" || row.status === "superseded"))
      .slice(-5)
      .map((row) => `- rev ${row.revision}: ${row.changeNote}`);
    const trailBlock = trail.length > 0 ? `\n\nAmendment trail:\n${trail.join("\n")}` : "";
    const assemble = (body: string) => `${header}\n${prose}${body}${trailBlock}`;

    // Structural degradation before any truncation: full outline → collapse
    // satisfied subtrees → collapse subtrees delegated to OPEN sessions
    // (their seats carry the detail already) → shed depth from the bottom,
    // leaving per-subtree counts. Every step deterministic.
    const delegated = this.#openDelegationRoots(userSessionId);
    const depthOf = new Map<string, number>();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let treeDepth = 0;
    for (const node of nodes) {
      let depth = 0;
      for (let cursor = node.parentId; cursor !== null; cursor = byId.get(cursor)?.parentId ?? null) depth += 1;
      depthOf.set(node.id, depth);
      treeDepth = Math.max(treeDepth, depth);
    }
    const ladder: { collapseSatisfied: boolean; collapseSubtreesOf?: ReadonlySet<string>; maxDepth?: number }[] = [
      { collapseSatisfied: false },
      { collapseSatisfied: true },
      ...(delegated.size > 0 ? [{ collapseSatisfied: true, collapseSubtreesOf: delegated }] : []),
    ];
    for (let depth = treeDepth; depth >= 1; depth -= 1) {
      ladder.push({ collapseSatisfied: true, collapseSubtreesOf: delegated, maxDepth: depth });
    }
    for (const step of ladder) {
      const body = this.#statusOutline(userSessionId, nodes, step);
      if (Buffer.byteLength(assemble(body), "utf8") <= DIGEST_MAX_BYTES) return assemble(body);
    }
    // Last resorts. BYTE-accurate truncation: String.slice counts UTF-16 code
    // units, so a multibyte outline (CJK, emoji) would blow past the cap by
    // up to 3x and could cut a surrogate pair in half. The outline truncates
    // first; the prose only when even that cannot fit.
    const marker = "\n…(truncated — read_requirements returns the full outline)";
    const shallow = this.#statusOutline(userSessionId, nodes, ladder.at(-1) ?? { collapseSatisfied: true });
    const fixed = Buffer.byteLength(`${header}\n${prose}${marker}${trailBlock}`, "utf8");
    if (DIGEST_MAX_BYTES - fixed > 0) {
      return assemble(`${truncateUtf8(shallow, DIGEST_MAX_BYTES - fixed)}${marker}`);
    }
    const proseBudget = Math.max(0, DIGEST_MAX_BYTES - Buffer.byteLength(`${header}\n${marker}${trailBlock}`, "utf8"));
    return `${header}\n${truncateUtf8(prose, proseBudget)}${marker}${trailBlock}`;
  }

  /**
   * The full status outline, unbudgeted — the read_requirements surface
   * (paging happens at the tool). `scopeId` narrows to one subtree, rendered
   * with the scope node at the top level.
   */
  statusOutlineFor(userSessionId: string, scopeId?: string): string {
    const projectId = this.#project(userSessionId);
    let nodes = this.#store.liveNodes(projectId);
    if (scopeId !== undefined) {
      const scope = this.#liveNode(userSessionId, scopeId);
      const byParent = new Map<string | null, RequirementNodeRow[]>();
      for (const node of nodes) {
        const list = byParent.get(node.parentId) ?? [];
        list.push(node);
        byParent.set(node.parentId, list);
      }
      const keep = new Set<string>([scope.id]);
      const walk = (id: string) => {
        for (const child of byParent.get(id) ?? []) { keep.add(child.id); walk(child.id); }
      };
      walk(scope.id);
      nodes = nodes.filter((node) => keep.has(node.id))
        .map((node) => (node.id === scope.id ? { ...node, parentId: null } : node));
    }
    return this.#statusOutline(userSessionId, nodes, { collapseSatisfied: false });
  }

  /** Root→node ancestor statements (excluding the node) — vision continuity at depth. */
  ancestorPath(userSessionId: string, id: string): { id: string; statement: string }[] {
    const byId = new Map(this.#store.liveNodes(this.#project(userSessionId)).map((row) => [row.id, row]));
    const out: { id: string; statement: string }[] = [];
    for (let cursor = byId.get(id)?.parentId ?? null; cursor !== null;) {
      const row = byId.get(cursor);
      if (!row) break;
      out.unshift({ id: row.id, statement: row.statement });
      cursor = row.parentId;
    }
    return out;
  }

  /** Requirement ids delegated to OPEN agent sessions — the digest's collapse set. */
  #openDelegationRoots(userSessionId: string): Set<string> {
    const openSessions = this.#frontierDeps?.openAgentSessionIds(userSessionId) ?? new Set<string>();
    const roots = new Set<string>();
    for (const row of this.#store.delegationsForUserSession(userSessionId)) {
      if (openSessions.has(row.agentSessionId)) roots.add(row.requirementId);
    }
    return roots;
  }

  /** One line for checkpoints and deliveries; legacy fallback; null = nothing governs. */
  pointer(userSessionId: string): string | null {
    const projectId = this.#project(userSessionId);
    const approved = this.#store.latestApproved(projectId);
    if (!approved) {
      const legacy = this.#legacy.pointer(userSessionId);
      return legacy === null ? null : `spec ${legacy}`;
    }
    const nodes = this.#store.liveNodes(projectId);
    const derived = this.#derivedStatuses(nodes);
    const counts = requirementStatusCounts(nodes.map((node) => derived.get(node.id) ?? node.status));
    const total = nodes.length;
    const parts = [`${counts.satisfied}/${total} satisfied`, `${counts.open} open`];
    if (counts.violated > 0) parts.push(`${counts.violated} violated`);
    if (counts.infeasible > 0) parts.push(`${counts.infeasible} infeasible`);
    return `requirements rev ${approved.revision} — ${parts.join(", ")}`;
  }

  /** The status outline + counts a run summary snapshots at proposal time. */
  summarySnapshot(userSessionId: string): { revision: number; counts: Record<RequirementStatus, number>; outline: string } | null {
    const approved = this.#store.latestApproved(this.#project(userSessionId));
    if (!approved) return null;
    const nodes = this.#store.liveNodes(this.#project(userSessionId));
    const derived = this.#derivedStatuses(nodes);
    return {
      revision: approved.revision,
      counts: requirementStatusCounts(nodes.map((node) => derived.get(node.id) ?? node.status)),
      outline: this.#statusOutline(userSessionId, nodes, { collapseSatisfied: false }),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  #liveNode(userSessionId: string, requirementId: string): RequirementNodeRow {
    const node = this.#store.getNode(this.#project(userSessionId), requirementId);
    if (!node || node.retiredInRevision !== null) {
      throw new NotFoundError(`no live requirement ${requirementId} — read_requirements lists the current graph`);
    }
    return node;
  }

  /** Ids present in a document must be ones this session minted and kept live. */
  #unknownIdErrors(userSessionId: string, graph: RequirementGraph, text: string): RequirementParseError[] {
    const all = this.#store.listNodes(this.#project(userSessionId));
    const known = new Set(all.map((node) => node.id));
    const retired = new Map(all.filter((node) => node.retiredInRevision !== null)
      .map((node) => [node.id, node.retiredInRevision!]));
    const lines = text.split(/\r\n|\r|\n/);
    const errors: RequirementParseError[] = [];
    for (const row of flattenRequirementGraph(graph)) {
      if (row.id === null) continue;
      // Case-insensitive: the parser lowercases a typed "R2", and the error
      // must still point at the line the operator actually wrote.
      const line = lines.findIndex((candidate) => candidate.toLowerCase().includes(`${row.id}`)) + 1;
      if (!known.has(row.id)) {
        errors.push({ line: line > 0 ? line : 1, message: `unknown requirement id "${row.id}" — omit the id tag on a new requirement; ids are minted on approval` });
        continue;
      }
      // A retired id can never come back: its row still holds the (session,
      // id) primary key, and ids are minted once. Rejecting HERE keeps the
      // failure at propose/validate time with a line error, instead of a
      // constraint violation inside the approval transaction.
      const retiredIn = retired.get(row.id);
      if (retiredIn !== undefined) {
        errors.push({ line: line > 0 ? line : 1, message: `requirement id "${row.id}" was retired in rev ${retiredIn} — omit the id tag to reintroduce it as a new requirement` });
      }
    }
    return errors;
  }

  /**
   * The approval diff: parse result → minted ids + node operations. Retiring
   * a committed node retires its refinement descendants with it; a refinement
   * node named in the document is PROMOTED to committed.
   */
  #computeApproval(userSessionId: string, parsed: RequirementGraph, revision: number): { graph: RequirementGraph; ops: ApprovalNodeOps; resets: { id: string; from: RequirementStatus }[] } {
    let nextNumber = this.#store.maxNodeNumber(this.#project(userSessionId)) + 1;
    const mint = (node: RequirementGraphNode): RequirementGraphNode => ({
      ...node,
      id: node.id ?? `r${nextNumber++}`,
      statement: node.statement.trim(),
      children: node.children.map(mint),
    });
    const graph: RequirementGraph = { ...parsed, nodes: parsed.nodes.map(mint) };

    const live = this.#store.liveNodes(this.#project(userSessionId));
    const liveById = new Map(live.map((node) => [node.id, node]));
    const flat = flattenRequirementGraph(graph);
    const present = new Set(flat.map((row) => row.id as string));

    const ops: ApprovalNodeOps = { inserts: [], updates: [], retires: [] };
    const resets: { id: string; from: RequirementStatus }[] = [];
    for (const row of flat) {
      const id = row.id as string;
      const existing = liveById.get(id);
      if (!existing) {
        ops.inserts.push({ id, parentId: row.parentId, ord: row.ord, statement: row.statement, composition: row.composition });
        continue;
      }
      const statementChanged = existing.statement !== row.statement;
      if (statementChanged && existing.status !== "open") resets.push({ id, from: existing.status });
      const moved = existing.parentId !== row.parentId || existing.ord !== row.ord
        || existing.composition !== row.composition;
      const promote = existing.origin === "refinement";
      if (statementChanged || moved || promote) {
        ops.updates.push({
          id,
          patch: {
            parentId: row.parentId,
            ord: row.ord,
            statement: row.statement,
            composition: row.composition,
            ...(promote ? { origin: "committed" as const, introducedInRevision: revision } : {}),
          },
          resetStatus: statementChanged,
        });
      }
    }
    // Committed nodes absent from the document retire; refinement nodes only
    // retire when a retired ancestor takes them down.
    const retiredCommitted = live.filter((node) => node.origin === "committed" && !present.has(node.id));
    const retiredIds = new Set(retiredCommitted.map((node) => node.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of live) {
        if (retiredIds.has(node.id) || present.has(node.id)) continue;
        if (node.parentId !== null && retiredIds.has(node.parentId)) {
          retiredIds.add(node.id);
          grew = true;
        }
      }
    }
    ops.retires = [...retiredIds];
    return { graph, ops, resets };
  }

  /** Rows in document order: depth-first over (parentId, ord). */
  #depthFirst(nodes: RequirementNodeRow[]): RequirementNodeRow[] {
    const byParent = new Map<string | null, RequirementNodeRow[]>();
    for (const node of nodes) {
      const list = byParent.get(node.parentId) ?? [];
      list.push(node);
      byParent.set(node.parentId, list);
    }
    const out: RequirementNodeRow[] = [];
    const walk = (parentId: string | null) => {
      for (const node of (byParent.get(parentId) ?? []).slice().sort(siblingOrder)) {
        out.push(node);
        walk(node.id);
      }
    };
    walk(null);
    return out;
  }

  /** Bottom-up derived statuses over the live rows. */
  #derivedStatuses(nodes: RequirementNodeRow[]): Map<string, RequirementStatus> {
    const children = new Map<string, RequirementNodeRow[]>();
    for (const node of nodes) {
      if (node.parentId === null) continue;
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    }
    const derived = new Map<string, RequirementStatus>();
    const visit = (node: RequirementNodeRow): RequirementStatus => {
      const cached = derived.get(node.id);
      if (cached !== undefined) return cached;
      const kids = children.get(node.id) ?? [];
      const status = kids.length === 0
        ? node.status
        : deriveComposedStatus(node.composition, kids.map((kid) => visit(kid)));
      derived.set(node.id, status);
      return status;
    };
    for (const node of nodes) visit(node);
    return derived;
  }

  /**
   * Could resolving this open leaf still change the root? Under an "any"
   * ancestor that is already satisfied, it cannot — the alternative closed it.
   */
  #affectsRoot(
    node: RequirementNodeRow,
    byId: Map<string, RequirementNodeRow>,
    children: Map<string, RequirementNodeRow[]>,
    derived: Map<string, RequirementStatus>,
  ): boolean {
    let cursor: RequirementNodeRow | undefined = node;
    while (cursor && cursor.parentId !== null) {
      const parent = byId.get(cursor.parentId);
      if (!parent) break;
      if (parent.composition === "any" && (derived.get(parent.id) ?? parent.status) === "satisfied") return false;
      cursor = parent;
    }
    return true;
  }

  /**
   * Rebuild a render graph from node rows. Beyond the satisfied-subtree
   * collapse, two STRUCTURAL reductions serve the digest's degradation
   * ladder: collapsing named subtrees (those delegated to open sessions —
   * their seats already carry the detail) and shedding depth from the bottom.
   * A collapsed unsatisfied subtree renders a per-subtree count suffix — a
   * display summary in the pointer() idiom, never a model-reported value.
   */
  #statusOutline(
    userSessionId: string,
    nodes: RequirementNodeRow[],
    options: { collapseSatisfied: boolean; collapseSubtreesOf?: ReadonlySet<string>; maxDepth?: number },
  ): string {
    const derived = this.#derivedStatuses(nodes);
    const latest = this.#store.latestChanges(this.#project(userSessionId));
    const byParent = new Map<string | null, RequirementNodeRow[]>();
    for (const node of nodes) {
      const list = byParent.get(node.parentId) ?? [];
      list.push(node);
      byParent.set(node.parentId, list);
    }
    const subtreeCounts = (id: string): { satisfied: number; total: number } => {
      let satisfied = 0;
      let total = 0;
      const walk = (parentId: string) => {
        for (const child of byParent.get(parentId) ?? []) {
          total += 1;
          if ((derived.get(child.id) ?? child.status) === "satisfied") satisfied += 1;
          walk(child.id);
        }
      };
      walk(id);
      return { satisfied, total };
    };
    const build = (parentId: string | null, depth: number): RequirementGraphNode[] =>
      (byParent.get(parentId) ?? [])
        .slice()
        .sort(siblingOrder)
        .map((node) => {
          const satisfied = (derived.get(node.id) ?? node.status) === "satisfied";
          const hasChildren = (byParent.get(node.id) ?? []).length > 0;
          const structural = hasChildren && !satisfied
            && (options.collapseSubtreesOf?.has(node.id) === true
              || (options.maxDepth !== undefined && depth + 1 >= options.maxDepth));
          const collapse = (options.collapseSatisfied && satisfied) || structural;
          const counts = structural ? subtreeCounts(node.id) : null;
          return {
            id: node.id,
            statement: counts === null
              ? node.statement
              : `${node.statement} (subtree: ${counts.satisfied}/${counts.total} satisfied — read_requirements scopeId "${node.id}")`,
            composition: node.composition,
            children: collapse ? [] : build(node.id, depth + 1),
          };
        });
    const graph: RequirementGraph = { title: null, preamble: [], nodes: build(null, 0) };
    return renderStatusOutline(graph, (id) => {
      const status = derived.get(id);
      if (status === undefined) return undefined;
      const change = latest.get(id);
      return {
        status,
        ...(change === undefined ? {} : { verifiedBy: change.verifiedBy, evidenceCount: change.evidence.length }),
      };
    });
  }
}

/**
 * Deterministic sibling order shared by EVERY rendering of the graph
 * (derive, digest, summary outline): document ord, then committed before
 * refinement on a tie (a mid-run refinement child can tie a later-renumbered
 * committed sibling), then mint order — never SQLite's insertion order.
 */
function siblingOrder(a: RequirementNodeRow, b: RequirementNodeRow): number {
  const originRank = (node: RequirementNodeRow) => (node.origin === "committed" ? 0 : 1);
  return a.ord - b.ord || originRank(a) - originRank(b) || mintNumberOf(a.id) - mintNumberOf(b.id);
}

/** The numeric part of a minted id ("r7" → 7) — normalization and ordering. */
function mintNumberOf(id: string): number {
  return Number(/^r(\d+)/.exec(id)?.[1] ?? 0);
}

/**
 * The intent prose of a parsed document: title + preamble sections, verbatim.
 * Null when the document carried no prose — an empty section renders nothing.
 */
export function renderIntentDocument(graph: RequirementGraph): string | null {
  const parts: string[] = [];
  if (graph.title !== null && graph.title.trim() !== "") parts.push(`# ${graph.title.trim()}`);
  for (const section of graph.preamble) {
    const body = section.body.trim();
    parts.push(body === "" ? `## ${section.heading}` : `## ${section.heading}\n${body}`);
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** Truncate to a UTF-8 byte budget without splitting a multibyte character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // A cut mid-sequence decodes as replacement characters at the tail; strip them.
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
}
