/**
 * The requirement graph service: the run's committed specification and its
 * live state — the ONE governing spine (the legacy spec store it replaced
 * was retired by migration 0017, which converted pre-graph governing text
 * into intent revisions).
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
  ChangeImpactAffected,
  ChangeImpactBasis,
  ChangeImpactSourceKind,
  ChangeImpactWire,
  EvidenceRef,
  RequirementComposition,
  RequirementFrontierEntry,
  RequirementGraph,
  RequirementGraphNode,
  RequirementNodeWire,
  RequirementParseError,
  RequirementReversal,
  RequirementStatus,
  RequirementVerificationGap,
  RequirementVerifiedBy,
  RequirementVerifyExpectation,
} from "@agentique-console/shared";
import {
  REQUIREMENT_MAX_DEPTH,
  REQUIREMENT_MAX_NODES,
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
  RequirementStatusChangeRow,
  RequirementStore,
} from "../db/stores/requirement-store.ts";
import type { AssumptionStore } from "../db/stores/assumption-store.ts";
import type { ProjectStore } from "../db/stores/project-store.ts";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import { profileWritesFiles } from "../agent-profiles/registry.ts";

const TERMINAL_STATUSES = new Set(["satisfied", "violated", "infeasible"]);

/** Bound on the injected digest; the full outline stays a tool call away. */
const DIGEST_MAX_BYTES = 8 * 1024;

/** Bound on gap/frontier enumerations riding prompts and nudges. */
const GAP_LIST_MAX = 6;

/**
 * Ranks for comparing a claim's recorded tier against a declared expectation:
 * self < independent ≤ operator. The operator's own verdict satisfies an
 * `independent` expectation (their word IS the gate); `console` never sets
 * `satisfied`, ranked top defensively.
 */
const TIER_RANK: Record<RequirementVerifiedBy, number> = { self: 0, independent: 1, operator: 2, console: 2 };
const EXPECTATION_RANK: Record<RequirementVerifyExpectation, number> = { independent: 1, operator: 2 };

/**
 * Who is standing behind a status claim, as console-owned facts. The tier
 * (`verifiedBy`) is DERIVED from this — never chosen by the reporting model:
 * the measured party does not get to classify its own measurement's
 * independence. Seat facts come from the commission-time profile SNAPSHOT, so
 * a later profile edit or rotation cannot change what a recorded tier meant.
 */
export type RequirementClaimant =
  | { kind: "operator" }
  | { kind: "main" }
  | {
      kind: "seat";
      agentSessionId: string;
      agent: string;
      profileRole: string | undefined;
      profileTools: readonly string[] | undefined;
    };

/**
 * The tier derivation: `operator` for the operator's own verdicts; `self` for
 * main and every write-capable seat; `independent` only for a seat whose
 * snapshotted profile is a write-isolated reviewer — the archetype whose whole
 * job is verification evidence, kept apart from the work it judges. A
 * read-only coordinator relaying an implementer's claim records `self`:
 * relaying is not verifying. (`console` is reserved for mechanical resets and
 * never derives here.)
 */
export function deriveVerifiedBy(claimant: RequirementClaimant): "self" | "independent" | "operator" {
  if (claimant.kind === "operator") return "operator";
  if (claimant.kind === "main") return "self";
  return claimant.profileRole === "reviewer" && !profileWritesFiles(claimant.profileTools)
    ? "independent"
    : "self";
}

/**
 * The two prompt-injection contracts the composer, runner, and checkpoints
 * consume. RequirementService implements both; call sites keep one dependency.
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

/** One id whose meaning/validity changed — a starting point of the impact closure. */
export interface ImpactSeed {
  id: string;
  basis: "changed" | "retired" | "reopened" | "falsified";
}

/** The graph-side transitive closure of one change — console facts only. */
export interface ImpactClosureResult {
  /** Seeds, their descendants, dependents (edges onto affected nodes OR their ancestors), and the dependents' descendants — to a fixed point. */
  requirements: { id: string; basis: ChangeImpactBasis; via: string }[];
  /** Terminal claims inside the affected set recorded before the change. */
  suspectClaims: ChangeImpactAffected["suspectClaims"];
  /** Open sessions whose delegated subtrees intersect the affected set. */
  sessionIds: string[];
}

/** What the wired recorder (ChangeImpactService) receives — everything the graph side computed. */
export interface ImpactRecordInput {
  userSessionId: string;
  sourceKind: ChangeImpactSourceKind;
  sourceRef: string;
  note: string | null;
  seedIds: string[];
  closure: ImpactClosureResult;
  atRevision: number;
  computedAtOrd: number;
}

/** Shared per-call reads for outline rendering (see #outlineContext). */
interface OutlineContext {
  derived: Map<string, RequirementStatus>;
  latest: Map<string, RequirementStatusChangeRow>;
  gaps: RequirementVerificationGap[];
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
  readonly #bus: EventBus;
  readonly #resolveProject: (userSessionId: string) => string;
  #frontierDeps: RequirementFrontierDeps | null = null;
  #pendingProposalCheck: ((userSessionId: string) => boolean) | null = null;
  #wakeNote: ((userSessionId: string, text: string) => void) | null = null;
  #impactRecorder: ((input: ImpactRecordInput) => ChangeImpactWire | null) | null = null;

  constructor(
    store: RequirementStore,
    projects: ProjectStore,
    assumptions: AssumptionStore,
    bus: EventBus,
    resolveProject: (userSessionId: string) => string,
  ) {
    this.#store = store;
    this.#projects = projects;
    this.#assumptions = assumptions;
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
   * Wired once in createApp: how a computed impact closure becomes a durable
   * change-impact row (ChangeImpactService.record). The graph side computes
   * the closure; the recorder enriches with task/assignment facts, persists
   * idempotently, and may decline (returns null) when nothing stale or active
   * is touched. Unwired (unit harnesses): impacts are simply not recorded.
   */
  setImpactRecorder(record: (input: ImpactRecordInput) => ChangeImpactWire | null): void {
    this.#impactRecorder = record;
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

  /**
   * When the FIRST revision was approved — the moment the run became
   * governed. Sessions commissioned before it are never branded unscoped
   * (matching the eval checker's created-after-first-approval semantics).
   */
  firstApprovedAt(userSessionId: string): string | null {
    const times = this.#store.listRevisionMetas(this.#project(userSessionId))
      .filter((row) => (row.status === "approved" || row.status === "superseded") && row.approvedAt !== null)
      .map((row) => row.approvedAt!);
    return times.length === 0 ? null : times.reduce((min, at) => (at < min ? at : min));
  }

  listRevisions(userSessionId: string): RequirementRevisionRow[] {
    return this.#store.listRevisions(this.#project(userSessionId));
  }

  getRevision(id: string): RequirementRevisionRow | undefined {
    return this.#store.getRevision(id);
  }

  /** The route's soft-fail hook: structural errors, or id problems, or ok. */
  validateDocument(
    userSessionId: string,
    text: string,
    opts: { scopeId?: string; intent?: boolean } = {},
  ): { ok: true } | { ok: false; errors: RequirementParseError[] } {
    const parsed = parseRequirementsDocument(text);
    if (!parsed.ok) return parsed;
    const kindErrors = this.#kindErrors(userSessionId, parsed.graph, opts);
    if (kindErrors.length > 0) return { ok: false, errors: kindErrors };
    if (opts.intent === true) return { ok: true };
    const idErrors = this.#unknownIdErrors(userSessionId, parsed.graph, text, opts.scopeId);
    if (idErrors.length > 0) return { ok: false, errors: idErrors };
    return { ok: true };
  }

  /** Kind-shape rules: a subtree patch is structure-only; an intent patch is prose-only. */
  #kindErrors(
    userSessionId: string,
    graph: RequirementGraph,
    opts: { scopeId?: string; intent?: boolean },
  ): RequirementParseError[] {
    if (opts.intent === true) {
      if (graph.nodes.length > 0) {
        return [{ line: 1, message: "an intent amendment carries prose only — leave ## Requirements empty; structure changes go through a subtree or full proposal" }];
      }
      if (graph.title === null && graph.preamble.length === 0) {
        return [{ line: 1, message: "an intent amendment needs a title or prose sections" }];
      }
      return [];
    }
    if (opts.scopeId !== undefined) {
      if (graph.title !== null || graph.preamble.length > 0) {
        return [{ line: 1, message: "a subtree amendment carries structure only (## Requirements) — intent prose changes go through an intent proposal" }];
      }
      if (graph.nodes.length === 0) {
        return [{ line: 1, message: "the ## Requirements section has no requirements" }];
      }
    }
    return [];
  }

  /**
   * The ExitPlanMode compat path: an operator-approved plan that does not
   * parse as a requirement outline still governs — recorded as an approved
   * INTENT revision holding the prose verbatim (leading-prose graph, no
   * nodes; the same shape migration 0017 gave pre-graph runs), so one spine
   * holds every governing text. Deliberately bypasses the outline parser:
   * this path exists precisely for text the parser rejects. The caller's
   * best-effort catch decides that plan approval itself never fails on
   * recording (the plan text stays durable on the approval interaction
   * either way).
   */
  recordIntentFallback(userSessionId: string, text: string, interactionId: string, edited: boolean): void {
    const projectId = this.#project(userSessionId);
    const graph: RequirementGraph = { title: null, preamble: [{ heading: "", body: text }], nodes: [] };
    const draft = this.#store.insertDraft({
      projectId,
      userSessionId,
      document: text,
      graph: graph as unknown as Record<string, unknown>,
      changeNote: "approved via ExitPlanMode",
      baseRevision: this.#store.latestApproved(projectId)?.revision ?? 0,
      kind: "intent",
      scopeId: null,
    });
    const approved = this.#store.applyApproval({
      revisionId: draft.id,
      document: text,
      graph: graph as unknown as Record<string, unknown>,
      edited,
      interactionId,
      ops: { inserts: [], updates: [], retires: [] },
    });
    this.#projects.setIntentDocument(projectId, text);
    this.#bus.append({
      type: "user_session.requirements.updated",
      userSessionId,
      payload: {
        userSessionId,
        revision: approved.revision,
        changeNote: "approved via ExitPlanMode",
        edited,
        nodeCount: 0,
        added: [],
        retired: [],
        kind: "intent",
      },
    });
  }

  /**
   * Draft a revision. Throws RequirementParseFailure (with line errors) when
   * the outline does not parse or names an id this session never minted — the
   * tool result carries the lines so main can fix and re-propose.
   */
  propose(
    userSessionId: string,
    document: string,
    changeNote?: string,
    opts: { scopeId?: string; intent?: boolean } = {},
  ): RequirementRevisionRow {
    if (this.#pendingProposalCheck?.(userSessionId)) {
      throw new InvalidInputError(
        "a requirements proposal is already awaiting the operator — resolve that card before proposing again",
      );
    }
    if (opts.intent === true && opts.scopeId !== undefined) {
      throw new InvalidInputError("a proposal is intent OR subtree, not both");
    }
    const projectId = this.#project(userSessionId);
    const kind: "full" | "intent" | "subtree" = opts.intent === true ? "intent" : opts.scopeId !== undefined ? "subtree" : "full";
    if (kind === "subtree") {
      const scope = this.#liveNode(userSessionId, opts.scopeId!);
      if (scope.origin !== "committed") {
        throw new InvalidInputError(`${scope.id} is a refinement node — name it in a proposal first (promotion), or scope the amendment to its committed ancestor`);
      }
    }
    // Staged elaboration is not optional at scale: a whole-document proposal
    // over a graph past the parser bound could never re-render canonically.
    if (kind === "full" && this.#store.liveNodes(projectId).length > REQUIREMENT_MAX_NODES) {
      throw new InvalidInputError(
        `the live graph exceeds ${REQUIREMENT_MAX_NODES} nodes — a whole-document proposal cannot re-render within the parser bound; amend per subtree (scopeId) or amend the prose alone (intent)`,
      );
    }
    const parsed = parseRequirementsDocument(document);
    if (!parsed.ok) throw new RequirementParseFailure(parsed.errors);
    const kindErrors = this.#kindErrors(userSessionId, parsed.graph, opts);
    if (kindErrors.length > 0) throw new RequirementParseFailure(kindErrors);
    if (kind === "full" && parsed.graph.nodes.length === 0) {
      throw new RequirementParseFailure([{ line: 1, message: "the ## Requirements section has no requirements" }]);
    }
    if (kind !== "intent") {
      const idErrors = this.#unknownIdErrors(userSessionId, parsed.graph, document, opts.scopeId);
      if (idErrors.length > 0) throw new RequirementParseFailure(idErrors);
    }
    return this.#store.insertDraft({
      projectId,
      userSessionId,
      document,
      graph: parsed.graph as unknown as Record<string, unknown>,
      changeNote: changeNote ?? null,
      baseRevision: this.#store.latestApproved(projectId)?.revision ?? 0,
      kind,
      scopeId: opts.scopeId ?? null,
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
  ): { revision: RequirementRevisionRow; added: string[]; retired: string[]; changed: string[]; impact: ChangeImpactWire | null } {
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
    const kindOpts = { ...(draft.scopeId === null ? {} : { scopeId: draft.scopeId }), intent: draft.kind === "intent" };
    const parsed = parseRequirementsDocument(input.document);
    if (!parsed.ok) throw new RequirementParseFailure(parsed.errors);
    const kindErrors = this.#kindErrors(draft.userSessionId, parsed.graph, kindOpts);
    if (kindErrors.length > 0) throw new RequirementParseFailure(kindErrors);
    if (draft.kind !== "intent") {
      const idErrors = this.#unknownIdErrors(draft.userSessionId, parsed.graph, input.document, draft.scopeId ?? undefined);
      if (idErrors.length > 0) throw new RequirementParseFailure(idErrors);
    }

    // Kind decides the op set: intent touches no nodes; subtree diffs only
    // inside its scope (nodes outside are untouched BY CONSTRUCTION — they
    // never enter the diff); full diffs everything, as before.
    const computed = draft.kind === "intent"
      ? { graph: parsed.graph, ops: { inserts: [], updates: [], retires: [] } as ApprovalNodeOps, resets: [] as { id: string; from: RequirementStatus }[], changedStatements: [] as string[] }
      : this.#computeApproval(draft.userSessionId, parsed.graph, draft.revision, draft.scopeId ?? undefined);
    const { graph, ops, resets, changedStatements } = computed;
    // The impact closure runs against PRE-approval state, deliberately:
    // applyApproval retires a dropped node's links in its transaction, so a
    // post-approval pass could no longer see who depended on a retired
    // requirement. Statement-changed and retired nodes are excluded from the
    // suspect set — their claims are mechanically reset/retired by the very
    // approval, journaled as console status changes; what remains suspect is
    // the untouched evidence downstream of the change.
    const impactSeeds: ImpactSeed[] = [
      ...changedStatements.map((id) => ({ id, basis: "changed" as const })),
      ...ops.retires.map((id) => ({ id, basis: "retired" as const })),
    ];
    const impactClosure = impactSeeds.length === 0 ? null : this.#impactClosure(draft.userSessionId, impactSeeds, {
      excludeFromSuspects: new Set(impactSeeds.map((seed) => seed.id)),
    });
    const canonical = renderCommitted(graph);
    const approved = this.#store.applyApproval({
      revisionId,
      document: canonical,
      graph: graph as unknown as Record<string, unknown>,
      edited: input.edited,
      interactionId: input.interactionId ?? null,
      ops,
    });
    // The intent prose (title + preamble) is the project's CURRENT approved
    // milestone/specification, stored on the project so it outlives sessions.
    // full/intent approvals write it (a proseless FULL document clears it —
    // "" reads as null and skips the fallback); a subtree patch never touches
    // it. The separate operator-authored objective is never touched here.
    if (draft.kind !== "subtree") {
      this.#projects.setIntentDocument(approved.projectId, renderIntentDocument(graph) ?? "");
    }
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
        kind: approved.kind,
        ...(approved.scopeId === null ? {} : { scopeId: approved.scopeId }),
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
    // Persist the impact AFTER the approval committed (a failed approval must
    // record nothing), stamped with the post-approval clock so a claim made
    // against the new revision always reads as later than the change.
    const impact = impactClosure === null ? null : (this.#impactRecorder?.({
      userSessionId: approved.userSessionId,
      sourceKind: "amendment",
      sourceRef: `rev:${approved.revision}`,
      note: approved.changeNote,
      seedIds: impactSeeds.map((seed) => seed.id),
      closure: impactClosure,
      atRevision: approved.revision,
      computedAtOrd: this.#store.nextChangeOrd(approved.projectId) - 1,
    }) ?? null);
    return { revision: approved, added, retired: ops.retires, changed: changedStatements, impact };
  }

  reject(revisionId: string): void {
    this.#store.reject(revisionId);
  }

  /**
   * What an approval of this document WOULD do, for the card: added
   * statements (ids not yet minted), changed statements (status will reset),
   * retirements (committed ids absent, refinement descendants cascading).
   * A pure read — nothing mints, nothing writes. Null when the text does not
   * parse (the card's live parse reports that separately).
   */
  previewChanges(
    userSessionId: string,
    document: string,
    opts: { scopeId?: string; intent?: boolean } = {},
  ): { added: string[]; changed: { id: string; statement: string }[]; retired: { id: string; statement: string }[] } | null {
    const parsed = parseRequirementsDocument(document);
    if (!parsed.ok) return null;
    if (opts.intent === true) return { added: [], changed: [], retired: [] };
    const scopeSet = opts.scopeId === undefined ? null : this.#subtreeIds(userSessionId, opts.scopeId, { includeRoot: false });
    const allLive = this.#store.liveNodes(this.#project(userSessionId));
    const live = scopeSet === null ? allLive : allLive.filter((node) => scopeSet.has(node.id));
    const liveById = new Map(live.map((node) => [node.id, node]));
    const flat = flattenRequirementGraph(parsed.graph);
    const added = flat.filter((row) => row.id === null).map((row) => row.statement);
    const changed = flat
      .filter((row) => row.id !== null && liveById.has(row.id) && liveById.get(row.id)!.statement !== row.statement.trim())
      .map((row) => ({ id: row.id!, statement: row.statement.trim() }));
    const present = new Set(flat.map((row) => row.id).filter((id): id is string => id !== null));
    const retiredIds = new Set(live.filter((node) => node.origin === "committed" && !present.has(node.id)).map((node) => node.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of live) {
        if (retiredIds.has(node.id) || present.has(node.id)) continue;
        if (node.parentId !== null && retiredIds.has(node.parentId)) { retiredIds.add(node.id); grew = true; }
      }
    }
    const retired = live.filter((node) => retiredIds.has(node.id)).map((node) => ({ id: node.id, statement: node.statement }));
    return { added, changed, retired };
  }

  /**
   * Which OPEN sessions an amendment touches: a session is affected when its
   * delegated subtrees intersect the change's transitive closure. Console
   * facts only — main judges materiality; this names where to look.
   */
  sessionsAffectedByChange(userSessionId: string, changedIds: string[]): string[] {
    if (changedIds.length === 0) return [];
    return this.#impactClosure(userSessionId, changedIds.map((id) => ({ id, basis: "changed" as const }))).sessionIds;
  }

  /**
   * The transitive impact closure of a set of changed/retired/withdrawn ids —
   * a deterministic fixed point, unlike the single link pass it replaced:
   * - a changed node's DESCENDANTS are affected (they refine how it is
   *   discharged, so a changed parent meaning reaches them);
   * - a `depends_on` edge fires when its target is an affected node OR an
   *   ancestor of one (depending on a node means depending on the subtree
   *   that composes it), making the dependent and ITS descendants affected;
   * - iterate until nothing grows (depends_on is acyclic; the loop is bounded
   *   by the node count either way).
   * Suspect claims are terminal claims inside the closure — prior evidence
   * the change may have invalidated; sessions are the open delegations whose
   * subtrees intersect it. Amendments call this against PRE-approval state so
   * dependents of retired nodes are captured before retirement removes their
   * links.
   */
  #impactClosure(
    userSessionId: string,
    seeds: ImpactSeed[],
    opts: {
      /** Ids whose claims are mechanically handled elsewhere (statement resets, retirements, the withdrawn claim itself). */
      excludeFromSuspects?: ReadonlySet<string>;
      /** Ids not counted for session matching (a withdrawal's own subtree — those sessions made the change, they are not downstream of it). */
      excludeFromSessionMatching?: ReadonlySet<string>;
    } = {},
  ): ImpactClosureResult {
    const projectId = this.#project(userSessionId);
    const nodes = this.#store.liveNodes(projectId);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const byParent = new Map<string | null, RequirementNodeRow[]>();
    for (const node of nodes) {
      const list = byParent.get(node.parentId) ?? [];
      list.push(node);
      byParent.set(node.parentId, list);
    }
    const affected = new Map<string, { basis: ChangeImpactBasis; via: string }>();
    // affected ∪ their live ancestors: an edge onto an ancestor of a changed
    // node depends on the subtree that contains the change.
    const ancestorTouched = new Set<string>();
    const touch = (id: string) => {
      for (let cursor: string | null | undefined = id; cursor != null && !ancestorTouched.has(cursor); cursor = byId.get(cursor)?.parentId) {
        ancestorTouched.add(cursor);
      }
    };
    const addAffected = (id: string, basis: ChangeImpactBasis, via: string): void => {
      if (affected.has(id)) return;
      affected.set(id, { basis, via });
      touch(id);
    };
    const addDescendants = (rootId: string, via: string): void => {
      for (const child of byParent.get(rootId) ?? []) {
        addAffected(child.id, "descendant", via);
        addDescendants(child.id, via);
      }
    };
    for (const seed of seeds) {
      addAffected(seed.id, seed.basis, seed.id);
      addDescendants(seed.id, seed.id);
    }
    const dependsEdges = this.#store.liveLinks(projectId).filter((row) => row.kind === "depends_on");
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of dependsEdges) {
        if (affected.has(edge.fromId) || !ancestorTouched.has(edge.toId)) continue;
        addAffected(edge.fromId, "dependent", edge.toId);
        addDescendants(edge.fromId, edge.fromId);
        grew = true;
      }
    }

    const latest = this.#store.latestChanges(projectId);
    const suspectClaims: ImpactClosureResult["suspectClaims"] = [];
    for (const id of affected.keys()) {
      if (opts.excludeFromSuspects?.has(id) === true) continue;
      const change = latest.get(id);
      if (change === undefined || !TERMINAL_STATUSES.has(change.toStatus)) continue;
      suspectClaims.push({
        requirementId: id,
        status: change.toStatus as "satisfied" | "violated" | "infeasible",
        verifiedBy: change.verifiedBy,
        actor: change.actor,
        ord: change.ord,
        at: change.createdAt,
      });
    }
    suspectClaims.sort((a, b) => mintNumberOf(a.requirementId) - mintNumberOf(b.requirementId));

    const openSessions = this.#frontierDeps?.openAgentSessionIds(userSessionId) ?? new Set<string>();
    const matchable = [...affected.keys()].filter((id) => opts.excludeFromSessionMatching?.has(id) !== true);
    const sessionIds = new Set<string>();
    for (const delegation of this.#store.delegationsForUserSession(userSessionId)) {
      if (!openSessions.has(delegation.agentSessionId) || sessionIds.has(delegation.agentSessionId)) continue;
      const subtree = this.#subtreeIds(userSessionId, delegation.requirementId, { includeRoot: true });
      if (matchable.some((id) => subtree.has(id))) sessionIds.add(delegation.agentSessionId);
    }

    const requirements = [...affected.entries()]
      .map(([id, meta]) => ({ id, basis: meta.basis, via: meta.via }))
      .sort((a, b) => mintNumberOf(a.id) - mintNumberOf(b.id));
    return { requirements, suspectClaims, sessionIds: [...sessionIds].sort() };
  }

  /**
   * Compute the closure for one change event and hand it to the wired
   * recorder — the path for changes that leave the graph's rows as they were
   * (a withdrawn claim, a falsified assumption). Amendments compute inside
   * approve() instead, against pre-approval state. Returns the durable impact
   * (null when no recorder is wired, the seeds are empty, or the recorder
   * declined because nothing stale or active was touched).
   */
  recordImpact(input: {
    userSessionId: string;
    sourceKind: ChangeImpactSourceKind;
    sourceRef: string;
    note?: string;
    seeds: ImpactSeed[];
    excludeFromSuspects?: ReadonlySet<string>;
    excludeFromSessionMatching?: ReadonlySet<string>;
  }): ChangeImpactWire | null {
    if (this.#impactRecorder === null || input.seeds.length === 0) return null;
    const projectId = this.#project(input.userSessionId);
    const closure = this.#impactClosure(input.userSessionId, input.seeds, {
      ...(input.excludeFromSuspects === undefined ? {} : { excludeFromSuspects: input.excludeFromSuspects }),
      ...(input.excludeFromSessionMatching === undefined ? {} : { excludeFromSessionMatching: input.excludeFromSessionMatching }),
    });
    return this.#impactRecorder({
      userSessionId: input.userSessionId,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      note: input.note ?? null,
      seedIds: input.seeds.map((seed) => seed.id),
      closure,
      atRevision: this.#store.latestApproved(projectId)?.revision ?? 0,
      computedAtOrd: this.#store.nextChangeOrd(projectId) - 1,
    });
  }

  // ── live state ───────────────────────────────────────────────────────────

  /**
   * A leaf status claim. Terminal statuses require evidence (the operator's
   * own verdicts are exempt — their word IS the gate, recorded as such).
   * Reports land on LEAVES only: a parent's status is derived, never asserted.
   * The verification tier is DERIVED from the claimant (deriveVerifiedBy),
   * never supplied by the reporting model.
   */
  reportStatus(input: {
    userSessionId: string;
    requirementId: string;
    to: "open" | "satisfied" | "violated" | "infeasible";
    evidence: EvidenceRef[];
    claimant: RequirementClaimant;
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
    if (input.to !== "open" && input.evidence.length === 0 && input.claimant.kind !== "operator") {
      throw new InvalidInputError(`marking ${node.id} ${input.to} requires at least one evidence ref`);
    }
    const verifiedBy = deriveVerifiedBy(input.claimant);
    const actor = input.claimant.kind === "seat" ? input.claimant.agent : input.claimant.kind;
    const agentSessionId = input.claimant.kind === "seat" ? input.claimant.agentSessionId : undefined;
    const atRevision = this.#store.latestApproved(projectId)?.revision ?? 0;
    const { change, node: updated } = this.#store.applyStatusChange({
      projectId,
      userSessionId: input.userSessionId,
      requirementId: input.requirementId,
      toStatus: input.to,
      evidence: input.evidence,
      verifiedBy,
      actor,
      agentSessionId: agentSessionId ?? null,
      atRevision,
      note: input.note ?? null,
    });
    this.#bus.append({
      type: "requirement.status.changed",
      userSessionId: input.userSessionId,
      ...(agentSessionId === undefined ? {} : { agentSessionId }),
      payload: {
        userSessionId: input.userSessionId,
        requirementId: input.requirementId,
        from: change.fromStatus,
        to: change.toStatus,
        verifiedBy,
        actor,
        ...(agentSessionId === undefined ? {} : { agentSessionId }),
        evidenceCount: input.evidence.length,
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });
    // A dependency moving out from under terminal claims is a fact main must
    // judge: record the transitive impact durably and wake main naming the
    // suspect dependents. Record-and-display — no status is rewritten here.
    // The withdrawal's own subtree is excluded from session matching (those
    // sessions made or own the change; they are not downstream of it). An
    // impact is recorded only when downstream terminal claims exist — the
    // status change itself is already visible structurally. The wake fires on
    // the closure regardless of whether a recorder is wired.
    if (input.to === "open" || input.to === "violated") {
      const closure = this.#impactClosure(input.userSessionId, [{ id: node.id, basis: "reopened" }], {
        excludeFromSuspects: new Set([node.id]),
        excludeFromSessionMatching: this.#subtreeIds(input.userSessionId, node.id, { includeRoot: true }),
      });
      if (closure.suspectClaims.length > 0) {
        const impact = this.#impactRecorder?.({
          userSessionId: input.userSessionId,
          sourceKind: "claim_withdrawn",
          sourceRef: change.id,
          note: `${node.id} ${input.to === "open" ? "reopened" : "reported violated"} by ${actor}`,
          seedIds: [node.id],
          closure,
          atRevision,
          computedAtOrd: change.ord,
        }) ?? null;
        const suspects = closure.suspectClaims.map((claim) => claim.requirementId);
        const impactLine = impact === null ? "" :
          `Change impact ${impact.id} records the affected set durably — record your judgment with reconcile_change_impact; completion holds while it is open. `;
        this.#wakeNote?.(input.userSessionId,
          `[Console: ${node.id} was ${input.to === "open" ? "reopened" : "reported violated"} by ${actor}. ` +
          `These requirements depend on it (directly or transitively) and hold terminal claims recorded BEFORE this change: ${suspects.join(", ")}. ` +
          `${impactLine}Judge whether their claims still stand — reopen with report_requirement, re-verify, or amend. The Console changed nothing.]`);
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
   * Subtree membership: the node or one of its ancestors was delegated to the
   * session. False for unknown/retired nodes and delegation-less sessions.
   */
  withinDelegation(userSessionId: string, agentSessionId: string, requirementId: string): boolean {
    const roots = new Set(this.delegationSet(agentSessionId));
    if (roots.size === 0) return false;
    const byId = new Map(this.#store.liveNodes(this.#project(userSessionId)).map((row) => [row.id, row]));
    let cursor: RequirementNodeRow | undefined = byId.get(requirementId);
    while (cursor) {
      if (roots.has(cursor.id)) return true;
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    return false;
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
    if (!byId.has(requirementId)) throw new NotFoundError(`no live requirement ${requirementId}`);
    if (this.withinDelegation(userSessionId, agentSessionId, requirementId)) return;
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
        verifyExpectation: node.verifyExpectation,
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

  /**
   * Satisfied leaves whose recorded tier falls below their declared
   * verification expectation — the node's own `(verify: …)` marker or an
   * ancestor's, strongest wins. Derived, displayed, never a gate.
   */
  verificationGaps(userSessionId: string): RequirementVerificationGap[] {
    const projectId = this.#project(userSessionId);
    const nodes = this.#store.liveNodes(projectId);
    if (nodes.length === 0) return [];
    return this.#verificationGaps(nodes, this.#store.latestChanges(projectId));
  }

  /** Effective declared expectation: the node's own `(verify: …)` marker or an ancestor's, strongest wins. */
  #effectiveExpectation(node: RequirementNodeRow, byId: Map<string, RequirementNodeRow>): RequirementVerifyExpectation | null {
    let strongest: RequirementVerifyExpectation | null = null;
    for (let cursor: RequirementNodeRow | undefined = node; cursor; cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)) {
      const declared = cursor.verifyExpectation;
      if (declared !== null && (strongest === null || EXPECTATION_RANK[declared] > EXPECTATION_RANK[strongest])) {
        strongest = declared;
      }
    }
    return strongest;
  }

  #verificationGaps(
    nodes: RequirementNodeRow[],
    latest: ReturnType<RequirementStore["latestChanges"]>,
  ): RequirementVerificationGap[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const hasChildren = new Set(nodes.map((node) => node.parentId).filter((id) => id !== null));
    const gaps: RequirementVerificationGap[] = [];
    for (const node of this.#depthFirst(nodes)) {
      if (hasChildren.has(node.id) || node.status !== "satisfied") continue;
      const expected = this.#effectiveExpectation(node, byId);
      if (expected === null) continue;
      const change = latest.get(node.id);
      const recordedRank = change === undefined ? TIER_RANK.self : TIER_RANK[change.verifiedBy];
      if (recordedRank >= EXPECTATION_RANK[expected]) continue;
      gaps.push({
        requirementId: node.id,
        statement: node.statement,
        expected,
        recorded: {
          verifiedBy: change?.verifiedBy ?? "self",
          actor: change?.actor ?? "unknown",
          at: change?.createdAt ?? node.updatedAt,
        },
      });
    }
    return gaps;
  }

  /**
   * The completion coverage frontier: every live LEAF, exactly once, with the
   * console-owned facts sign-off accounting needs — state, invalidation
   * staleness, the actual evidence refs behind the latest terminal claim, and
   * the declared-vs-recorded verification tier. Parents never appear (their
   * status is derived, so counting leaves counts each obligation once);
   * retired nodes are out of scope entirely.
   *
   * `moot` classifies a leaf under a satisfied `any` ancestor whose own chain
   * did not produce that satisfaction: the chosen alternative discharged the
   * obligation, so the leaf is accounted for but can never be an exception.
   */
  completionObligations(userSessionId: string): import("@agentique-console/shared").CoverageObligation[] {
    const projectId = this.#project(userSessionId);
    const nodes = this.#store.liveNodes(projectId);
    if (nodes.length === 0) return [];
    const derived = this.#derivedStatuses(nodes);
    const latest = this.#store.latestChanges(projectId);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const hasChildren = new Set(nodes.map((node) => node.parentId).filter((id): id is string => id !== null));
    const links = this.#linkViews(projectId);
    const statusOf = (id: string): RequirementStatus => derived.get(id) ?? byId.get(id)?.status ?? "open";

    /** Moot iff some satisfied `any` ancestor was NOT satisfied through this leaf's chain. */
    const isMoot = (leaf: RequirementNodeRow): boolean => {
      let chainSatisfied = statusOf(leaf.id) === "satisfied";
      for (let cursor = leaf.parentId; cursor !== null; ) {
        const ancestor = byId.get(cursor);
        if (!ancestor) break;
        if (ancestor.composition === "any" && statusOf(ancestor.id) === "satisfied" && !chainSatisfied) return true;
        chainSatisfied = chainSatisfied && statusOf(ancestor.id) === "satisfied";
        cursor = ancestor.parentId;
      }
      return false;
    };

    return this.#depthFirst(nodes)
      .filter((node) => !hasChildren.has(node.id))
      .map((node) => {
        const change = latest.get(node.id);
        const terminal = change !== undefined && TERMINAL_STATUSES.has(change.toStatus);
        // The same deterministic invalidation marks derive() renders: a
        // terminal claim is stale when something under it moved LATER on the
        // shared ordinal clock. Self-clearing via any new claim on the node.
        const stale = terminal
          && ((links.dependsOn.get(node.id) ?? []).some((target) => (latest.get(target)?.ord ?? 0) > change.ord)
            || (links.restsOn.get(node.id) ?? []).some((entry) => entry.status === "falsified" && (entry.resolvedOrd ?? 0) > change.ord));
        const state = isMoot(node) ? "moot" : (statusOf(node.id) as Exclude<RequirementStatus, "retired">);
        const expected = this.#effectiveExpectation(node, byId);
        return {
          requirementId: node.id,
          statement: node.statement,
          state,
          stale,
          claim: terminal
            ? { verifiedBy: change.verifiedBy, actor: change.actor, at: change.createdAt, evidence: change.evidence }
            : null,
          verification: state === "satisfied" && expected !== null
            ? { expected, met: TIER_RANK[change?.verifiedBy ?? "self"] >= EXPECTATION_RANK[expected] }
            : null,
        };
      });
  }

  /**
   * Terminal claims the run later withdrew, oldest first — a change whose
   * `fromStatus` was terminal, made by anyone but the console (console rows
   * are exactly the mechanical statement-resets and retirements; an operator
   * reopen counts, attributed). Pure journal facts: displayed in the summary
   * and panel, exported for evaluation, never a verdict input.
   */
  reversals(userSessionId: string): RequirementReversal[] {
    const projectId = this.#project(userSessionId);
    const rows = this.#store.listReversalChanges(projectId);
    if (rows.length === 0) return [];
    const statements = new Map(this.#store.listNodes(projectId).map((node) => [node.id, node.statement]));
    return rows.map((change) => {
      // The withdrawn claim: the change immediately before this one on the
      // requirement's chain. The journal chains fromStatus to the prior
      // toStatus inside one transaction, so a terminal fromStatus always has
      // a prior terminal row — the `?? null` is defensive, not semantic.
      const prior = this.#store.changeBefore(projectId, change.requirementId, change.ord);
      const original = prior !== undefined && TERMINAL_STATUSES.has(prior.toStatus)
        ? { actor: prior.actor, verifiedBy: prior.verifiedBy, evidenceCount: prior.evidence.length, at: prior.createdAt }
        : null;
      return {
        requirementId: change.requirementId,
        statement: statements.get(change.requirementId) ?? "",
        from: change.fromStatus as "satisfied" | "violated" | "infeasible",
        to: change.toStatus as RequirementStatus,
        at: change.createdAt,
        reversedBy: { actor: change.actor, verifiedBy: change.verifiedBy },
        original,
      };
    });
  }

  // ── prompt surfaces (the GoverningDigest contract) ───────────────────────

  /**
   * The prompt injection. Requirement outline with live statuses when a
   * revision governs; EMPTY when nothing governs (prompt-cache byte-stability
   * rule). Over the byte cap it first collapses fully-satisfied subtrees,
   * then truncates with a marker.
   */
  digest(userSessionId: string): string {
    const projectId = this.#project(userSessionId);
    const approved = this.#store.latestApproved(projectId);
    if (!approved) return "";
    const nodes = this.#store.liveNodes(projectId);
    const header = `## Requirements (rev ${approved.revision}, authoritative — statuses are console-derived; claim leaves with evidence via report_requirement)`;
    // The current intent prose travels with the outline: the milestone context
    // keeps distributed work aligned, so it degrades LAST. A prose-less
    // run renders byte-identically to before (cache stability).
    const intent = this.intentDocument(userSessionId);
    const prose = intent === null ? "" : `${intent}\n\n`;
    const trail = this.#store.listRevisionMetas(projectId)
      .filter((row) => row.changeNote !== null && (row.status === "approved" || row.status === "superseded"))
      .slice(-5)
      .map((row) => `- rev ${row.revision}: ${row.changeNote}`);
    const trailBlock = trail.length > 0 ? `\n\nAmendment trail:\n${trail.join("\n")}` : "";
    // One read set for the whole ladder: latest claims, derived statuses and
    // gaps are computed once here and shared by every degradation step below.
    const context = this.#outlineContext(nodes, this.#store.latestChanges(projectId));
    // Gaps ride with the trail, after the outline: the collapse-satisfied
    // ladder erases exactly the satisfied leaves that carry them. Bounded
    // like the trail so a pathological run cannot grow the prompt.
    const gaps = context.gaps;
    const gapLines = gaps.slice(0, GAP_LIST_MAX)
      .map((gap) => `- ${gap.requirementId} needs ${gap.expected} verification (claimed ${gap.recorded.verifiedBy} by ${gap.recorded.actor})`);
    if (gaps.length > GAP_LIST_MAX) gapLines.push(`- …and ${gaps.length - GAP_LIST_MAX} more (read_requirements lists them)`);
    const gapBlock = gapLines.length > 0 ? `\n\nVerification gaps (satisfied below their declared tier):\n${gapLines.join("\n")}` : "";
    const assemble = (body: string) => `${header}\n${prose}${body}${gapBlock}${trailBlock}`;

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
      const body = this.#statusOutline(nodes, context, step);
      if (Buffer.byteLength(assemble(body), "utf8") <= DIGEST_MAX_BYTES) return assemble(body);
    }
    // Last resorts. BYTE-accurate truncation: String.slice counts UTF-16 code
    // units, so a multibyte outline (CJK, emoji) would blow past the cap by
    // up to 3x and could cut a surrogate pair in half. The outline truncates
    // first; the prose only when even that cannot fit.
    const marker = "\n…(truncated — read_requirements returns the full outline)";
    const shallow = this.#statusOutline(nodes, context, ladder.at(-1) ?? { collapseSatisfied: true });
    const fixed = Buffer.byteLength(`${header}\n${prose}${marker}${gapBlock}${trailBlock}`, "utf8");
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
    const context = this.#outlineContext(nodes, this.#store.latestChanges(projectId));
    return this.#statusOutline(nodes, context, { collapseSatisfied: false });
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

  /** One line for checkpoints and deliveries; null = nothing governs. */
  pointer(userSessionId: string): string | null {
    const projectId = this.#project(userSessionId);
    const approved = this.#store.latestApproved(projectId);
    if (!approved) return null;
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
  summarySnapshot(userSessionId: string): {
    revision: number;
    counts: Record<RequirementStatus, number>;
    outline: string;
    verificationGaps: RequirementVerificationGap[];
    reversals: RequirementReversal[];
  } | null {
    const projectId = this.#project(userSessionId);
    const approved = this.#store.latestApproved(projectId);
    if (!approved) return null;
    const nodes = this.#store.liveNodes(projectId);
    const context = this.#outlineContext(nodes, this.#store.latestChanges(projectId));
    return {
      revision: approved.revision,
      counts: requirementStatusCounts(nodes.map((node) => context.derived.get(node.id) ?? node.status)),
      outline: this.#statusOutline(nodes, context, { collapseSatisfied: false }),
      verificationGaps: context.gaps,
      reversals: this.reversals(userSessionId),
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

  /**
   * Ids present in a document must be ones this project minted and kept live
   * — and inside a SUBTREE amendment, descendants of its scope: a scoped
   * approval cannot touch nodes outside its scope by construction, so a
   * document that names one is a mistake to surface, never to absorb.
   */
  #unknownIdErrors(userSessionId: string, graph: RequirementGraph, text: string, scopeId?: string): RequirementParseError[] {
    const all = this.#store.listNodes(this.#project(userSessionId));
    const known = new Set(all.map((node) => node.id));
    const retired = new Map(all.filter((node) => node.retiredInRevision !== null)
      .map((node) => [node.id, node.retiredInRevision!]));
    const inScope = scopeId === undefined ? null : this.#subtreeIds(userSessionId, scopeId, { includeRoot: false });
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
      // A retired id can never come back: its row still holds the (project,
      // id) primary key, and ids are minted once. Rejecting HERE keeps the
      // failure at propose/validate time with a line error, instead of a
      // constraint violation inside the approval transaction.
      const retiredIn = retired.get(row.id);
      if (retiredIn !== undefined) {
        errors.push({ line: line > 0 ? line : 1, message: `requirement id "${row.id}" was retired in rev ${retiredIn} — omit the id tag to reintroduce it as a new requirement` });
        continue;
      }
      if (inScope !== null && !inScope.has(row.id)) {
        errors.push({ line: line > 0 ? line : 1, message: `requirement "${row.id}" sits outside the amendment scope (${scopeId}) — amend it in its own subtree` });
      }
    }
    return errors;
  }

  /** Live descendant ids of a scope node (optionally including the root). */
  #subtreeIds(userSessionId: string, scopeId: string, opts: { includeRoot: boolean }): Set<string> {
    const nodes = this.#store.liveNodes(this.#project(userSessionId));
    const byParent = new Map<string | null, RequirementNodeRow[]>();
    for (const node of nodes) {
      const list = byParent.get(node.parentId) ?? [];
      list.push(node);
      byParent.set(node.parentId, list);
    }
    const out = new Set<string>(opts.includeRoot ? [scopeId] : []);
    const walk = (id: string) => {
      for (const child of byParent.get(id) ?? []) { out.add(child.id); walk(child.id); }
    };
    walk(scopeId);
    return out;
  }

  /**
   * The approval diff: parse result → minted ids + node operations. Retiring
   * a committed node retires its refinement descendants with it; a refinement
   * node named in the document is PROMOTED to committed.
   */
  #computeApproval(userSessionId: string, parsed: RequirementGraph, revision: number, scopeId?: string): { graph: RequirementGraph; ops: ApprovalNodeOps; resets: { id: string; from: RequirementStatus }[]; changedStatements: string[] } {
    let nextNumber = this.#store.maxNodeNumber(this.#project(userSessionId)) + 1;
    const mint = (node: RequirementGraphNode): RequirementGraphNode => ({
      ...node,
      id: node.id ?? `r${nextNumber++}`,
      statement: node.statement.trim(),
      children: node.children.map(mint),
    });
    const graph: RequirementGraph = { ...parsed, nodes: parsed.nodes.map(mint) };

    // Scoped: the universe is the scope's DESCENDANTS — nodes outside never
    // enter the diff, so a subtree approval cannot touch them by
    // construction; the document's top-level rows parent to the scope node.
    const allLive = this.#store.liveNodes(this.#project(userSessionId));
    const scopeSet = scopeId === undefined ? null : this.#subtreeIds(userSessionId, scopeId, { includeRoot: false });
    const live = scopeSet === null ? allLive : allLive.filter((node) => scopeSet.has(node.id));
    const liveById = new Map(live.map((node) => [node.id, node]));
    const flat = flattenRequirementGraph(graph)
      .map((row) => (scopeId !== undefined && row.parentId === null ? { ...row, parentId: scopeId } : row));
    const present = new Set(flat.map((row) => row.id as string));

    const ops: ApprovalNodeOps = { inserts: [], updates: [], retires: [] };
    const resets: { id: string; from: RequirementStatus }[] = [];
    const changedStatements: string[] = [];
    for (const row of flat) {
      const id = row.id as string;
      const existing = liveById.get(id);
      if (!existing) {
        ops.inserts.push({ id, parentId: row.parentId, ord: row.ord, statement: row.statement,
          composition: row.composition, verifyExpectation: row.verifyExpectation });
        continue;
      }
      const statementChanged = existing.statement !== row.statement;
      if (statementChanged) changedStatements.push(id);
      if (statementChanged && existing.status !== "open") resets.push({ id, from: existing.status });
      // An expectation change updates the node WITHOUT resetting its status:
      // the statement (what the evidence attested to) is unchanged — the gap
      // between the recorded tier and the new declaration derives at read.
      const expectationChanged = (existing.verifyExpectation ?? null) !== (row.verifyExpectation ?? null);
      const moved = existing.parentId !== row.parentId || existing.ord !== row.ord
        || existing.composition !== row.composition;
      const promote = existing.origin === "refinement";
      if (statementChanged || moved || promote || expectationChanged) {
        ops.updates.push({
          id,
          // The patch ALWAYS carries the expectation: a move that also drops
          // the marker must apply both, never half of the line.
          patch: {
            parentId: row.parentId,
            ord: row.ord,
            statement: row.statement,
            composition: row.composition,
            verifyExpectation: row.verifyExpectation,
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
    return { graph, ops, resets, changedStatements };
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
   * The precomputed reads one outline rendering consumes — computed ONCE per
   * public call and shared across the digest's degradation-ladder steps, so a
   * ladder walk does not re-read latest claims or re-derive statuses per step.
   */
  #outlineContext(nodes: RequirementNodeRow[], latest: ReturnType<RequirementStore["latestChanges"]>): OutlineContext {
    return {
      derived: this.#derivedStatuses(nodes),
      latest,
      gaps: this.#verificationGaps(nodes, latest),
    };
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
    nodes: RequirementNodeRow[],
    context: OutlineContext,
    options: { collapseSatisfied: boolean; collapseSubtreesOf?: ReadonlySet<string>; maxDepth?: number },
  ): string {
    const { derived, latest } = context;
    const gaps = new Map(context.gaps.map((gap) => [gap.requirementId, gap.expected]));
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
            verifyExpectation: node.verifyExpectation,
            children: collapse ? [] : build(node.id, depth + 1),
          };
        });
    const graph: RequirementGraph = { title: null, preamble: [], nodes: build(null, 0) };
    return renderStatusOutline(graph, (id) => {
      const status = derived.get(id);
      if (status === undefined) return undefined;
      const change = latest.get(id);
      const gap = gaps.get(id);
      return {
        status,
        ...(change === undefined ? {} : { verifiedBy: change.verifiedBy, evidenceCount: change.evidence.length }),
        ...(gap === undefined ? {} : { verifyGap: gap }),
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
