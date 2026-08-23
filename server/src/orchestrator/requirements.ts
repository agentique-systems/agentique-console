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
  RequirementVerificationGap,
  RequirementVerifiedBy,
  RequirementVerifyExpectation,
} from "@agentique-console/shared";
import {
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
  RequirementNodeRow,
  RequirementRevisionRow,
  RequirementStore,
} from "../db/stores/requirement-store.ts";
import { InvalidInputError, NotFoundError } from "../errors.ts";
import { profileWritesFiles } from "../agent-profiles/registry.ts";
import type { SpecService } from "./spec.ts";

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
  readonly #legacy: SpecService;
  readonly #bus: EventBus;
  #frontierDeps: RequirementFrontierDeps | null = null;

  constructor(store: RequirementStore, legacy: SpecService, bus: EventBus) {
    this.#store = store;
    this.#legacy = legacy;
    this.#bus = bus;
  }

  /** Wired once in createApp — the frontier reads other aggregates' facts. */
  setFrontierDeps(deps: RequirementFrontierDeps): void {
    this.#frontierDeps = deps;
  }

  // ── committed structure ──────────────────────────────────────────────────

  latestApproved(userSessionId: string): RequirementRevisionRow | undefined {
    return this.#store.latestApproved(userSessionId);
  }

  listRevisions(userSessionId: string): RequirementRevisionRow[] {
    return this.#store.listRevisions(userSessionId);
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
    const parsed = parseRequirementsDocument(document);
    if (!parsed.ok) throw new RequirementParseFailure(parsed.errors);
    if (parsed.graph.nodes.length === 0) {
      throw new RequirementParseFailure([{ line: 1, message: "the ## Requirements section has no requirements" }]);
    }
    const idErrors = this.#unknownIdErrors(userSessionId, parsed.graph, document);
    if (idErrors.length > 0) throw new RequirementParseFailure(idErrors);
    return this.#store.insertDraft({
      userSessionId,
      document,
      graph: parsed.graph as unknown as Record<string, unknown>,
      changeNote: changeNote ?? null,
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
    const node = this.#liveNode(input.userSessionId, input.requirementId);
    const children = this.#store.liveNodes(input.userSessionId).filter((row) => row.parentId === node.id);
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
    const atRevision = this.#store.latestApproved(input.userSessionId)?.revision ?? 0;
    const { change, node: updated } = this.#store.applyStatusChange({
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
    const parent = this.#liveNode(input.userSessionId, input.parentId);
    if (input.children.length === 0) throw new InvalidInputError("decompose needs at least one child statement");
    const existing = this.#store.liveNodes(input.userSessionId).filter((row) => row.parentId === parent.id);
    // Past the LAST existing sibling ord, not sibling count: an amendment
    // renumbers committed children by document position, so count-based ords
    // would collide with a later-approved committed sibling.
    const baseOrd = existing.reduce((max, row) => Math.max(max, row.ord + 1), 0);
    let nextNumber = this.#store.maxNodeNumber(input.userSessionId) + 1;
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
      userSessionId: input.userSessionId,
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
    const byId = new Map(this.#store.liveNodes(userSessionId).map((row) => [row.id, row]));
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
    const nodes = this.#depthFirst(this.#store.liveNodes(userSessionId));
    const derived = this.#derivedStatuses(nodes);
    const latest = this.#store.latestChanges(userSessionId);
    const openSessions = this.#frontierDeps?.openAgentSessionIds(userSessionId) ?? new Set<string>();
    const delegatedTo = new Map<string, string[]>();
    for (const delegation of this.#store.delegationsForUserSession(userSessionId)) {
      if (!openSessions.has(delegation.agentSessionId)) continue;
      const list = delegatedTo.get(delegation.requirementId) ?? [];
      list.push(delegation.agentSessionId);
      delegatedTo.set(delegation.requirementId, list);
    }
    return nodes.map((node) => {
      const change = latest.get(node.id);
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
      };
    });
  }

  /** The run root's derived status: every top-level requirement, composed "all". */
  rootStatus(userSessionId: string): RequirementStatus {
    const nodes = this.#store.liveNodes(userSessionId);
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
    const nodes = this.#store.liveNodes(userSessionId);
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

    return nodes
      .filter((node) => (children.get(node.id) ?? []).length === 0)
      .filter((node) => (derived.get(node.id) ?? node.status) === "open")
      .filter((node) => this.#affectsRoot(node, byId, children, derived))
      .map((node) => {
        const sessions = sessionsFor(node.id);
        const annotations: RequirementFrontierEntry["annotations"] = [];
        if (sessions.length > 0) annotations.push("in_progress");
        if (blockedIds.has(node.id)) annotations.push("blocked");
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
    const nodes = this.#store.liveNodes(userSessionId);
    if (nodes.length === 0) return [];
    return this.#verificationGaps(nodes, this.#store.latestChanges(userSessionId));
  }

  #verificationGaps(
    nodes: RequirementNodeRow[],
    latest: ReturnType<RequirementStore["latestChanges"]>,
  ): RequirementVerificationGap[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const hasChildren = new Set(nodes.map((node) => node.parentId).filter((id) => id !== null));
    const effective = (node: RequirementNodeRow): RequirementVerifyExpectation | null => {
      let strongest: RequirementVerifyExpectation | null = null;
      for (let cursor: RequirementNodeRow | undefined = node; cursor; cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)) {
        const declared = cursor.verifyExpectation;
        if (declared !== null && (strongest === null || EXPECTATION_RANK[declared] > EXPECTATION_RANK[strongest])) {
          strongest = declared;
        }
      }
      return strongest;
    };
    const gaps: RequirementVerificationGap[] = [];
    for (const node of this.#depthFirst(nodes)) {
      if (hasChildren.has(node.id) || node.status !== "satisfied") continue;
      const expected = effective(node);
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

  // ── prompt surfaces (the GoverningDigest contract) ───────────────────────

  /**
   * The prompt injection. Requirement outline with live statuses when a
   * revision governs; the legacy spec digest for pre-graph runs; EMPTY when
   * nothing governs (prompt-cache byte-stability rule). Over the byte cap it
   * first collapses fully-satisfied subtrees, then truncates with a marker.
   */
  digest(userSessionId: string): string {
    const approved = this.#store.latestApproved(userSessionId);
    if (!approved) return this.#legacy.digest(userSessionId);
    const nodes = this.#store.liveNodes(userSessionId);
    const outline = this.#statusOutline(userSessionId, nodes, { collapseSatisfied: false });
    let body = outline;
    if (Buffer.byteLength(body, "utf8") > DIGEST_MAX_BYTES) {
      body = this.#statusOutline(userSessionId, nodes, { collapseSatisfied: true });
    }
    if (Buffer.byteLength(body, "utf8") > DIGEST_MAX_BYTES) {
      // BYTE-accurate truncation: String.slice counts UTF-16 code units, so a
      // multibyte outline (CJK, emoji) would blow past the cap by up to 3x
      // and could cut a surrogate pair in half.
      body = `${truncateUtf8(body, DIGEST_MAX_BYTES)}\n…(truncated — read_requirements returns the full outline)`;
    }
    const trail = this.#store.listRevisions(userSessionId)
      .filter((row) => row.changeNote !== null && (row.status === "approved" || row.status === "superseded"))
      .slice(-5)
      .map((row) => `- rev ${row.revision}: ${row.changeNote}`);
    // Gaps ride OUTSIDE the byte-capped body: the collapse-satisfied fallback
    // erases exactly the satisfied leaves that carry them. Bounded like the
    // trail so a pathological run cannot grow the prompt.
    const gaps = this.verificationGaps(userSessionId);
    const gapLines = gaps.slice(0, GAP_LIST_MAX)
      .map((gap) => `- ${gap.requirementId} needs ${gap.expected} verification (claimed ${gap.recorded.verifiedBy} by ${gap.recorded.actor})`);
    if (gaps.length > GAP_LIST_MAX) gapLines.push(`- …and ${gaps.length - GAP_LIST_MAX} more (read_requirements lists them)`);
    return `## Requirements (rev ${approved.revision}, authoritative — statuses are console-derived; claim leaves with evidence via report_requirement)\n${body}` +
      (gapLines.length > 0 ? `\n\nVerification gaps (satisfied below their declared tier):\n${gapLines.join("\n")}` : "") +
      (trail.length > 0 ? `\n\nAmendment trail:\n${trail.join("\n")}` : "");
  }

  /** One line for checkpoints and deliveries; legacy fallback; null = nothing governs. */
  pointer(userSessionId: string): string | null {
    const approved = this.#store.latestApproved(userSessionId);
    if (!approved) {
      const legacy = this.#legacy.pointer(userSessionId);
      return legacy === null ? null : `spec ${legacy}`;
    }
    const nodes = this.#store.liveNodes(userSessionId);
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
  } | null {
    const approved = this.#store.latestApproved(userSessionId);
    if (!approved) return null;
    const nodes = this.#store.liveNodes(userSessionId);
    const derived = this.#derivedStatuses(nodes);
    return {
      revision: approved.revision,
      counts: requirementStatusCounts(nodes.map((node) => derived.get(node.id) ?? node.status)),
      outline: this.#statusOutline(userSessionId, nodes, { collapseSatisfied: false }),
      verificationGaps: this.verificationGaps(userSessionId),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  #liveNode(userSessionId: string, requirementId: string): RequirementNodeRow {
    const node = this.#store.getNode(userSessionId, requirementId);
    if (!node || node.retiredInRevision !== null) {
      throw new NotFoundError(`no live requirement ${requirementId} — read_requirements lists the current graph`);
    }
    return node;
  }

  /** Ids present in a document must be ones this session minted and kept live. */
  #unknownIdErrors(userSessionId: string, graph: RequirementGraph, text: string): RequirementParseError[] {
    const all = this.#store.listNodes(userSessionId);
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
    let nextNumber = this.#store.maxNodeNumber(userSessionId) + 1;
    const mint = (node: RequirementGraphNode): RequirementGraphNode => ({
      ...node,
      id: node.id ?? `r${nextNumber++}`,
      statement: node.statement.trim(),
      children: node.children.map(mint),
    });
    const graph: RequirementGraph = { ...parsed, nodes: parsed.nodes.map(mint) };

    const live = this.#store.liveNodes(userSessionId);
    const liveById = new Map(live.map((node) => [node.id, node]));
    const flat = flattenRequirementGraph(graph);
    const present = new Set(flat.map((row) => row.id as string));

    const ops: ApprovalNodeOps = { inserts: [], updates: [], retires: [] };
    const resets: { id: string; from: RequirementStatus }[] = [];
    for (const row of flat) {
      const id = row.id as string;
      const existing = liveById.get(id);
      if (!existing) {
        ops.inserts.push({ id, parentId: row.parentId, ord: row.ord, statement: row.statement,
          composition: row.composition, verifyExpectation: row.verifyExpectation });
        continue;
      }
      const statementChanged = existing.statement !== row.statement;
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

  /** Rebuild a render graph from node rows (title from the approved revision). */
  #statusOutline(
    userSessionId: string,
    nodes: RequirementNodeRow[],
    options: { collapseSatisfied: boolean },
  ): string {
    const derived = this.#derivedStatuses(nodes);
    const latest = this.#store.latestChanges(userSessionId);
    const gaps = new Map(this.#verificationGaps(nodes, latest).map((gap) => [gap.requirementId, gap.expected]));
    const byParent = new Map<string | null, RequirementNodeRow[]>();
    for (const node of nodes) {
      const list = byParent.get(node.parentId) ?? [];
      list.push(node);
      byParent.set(node.parentId, list);
    }
    const build = (parentId: string | null): RequirementGraphNode[] =>
      (byParent.get(parentId) ?? [])
        .slice()
        .sort(siblingOrder)
        .map((node) => ({
          id: node.id,
          statement: node.statement,
          composition: node.composition,
          verifyExpectation: node.verifyExpectation,
          children: options.collapseSatisfied && (derived.get(node.id) ?? node.status) === "satisfied"
            ? []
            : build(node.id),
        }));
    const graph: RequirementGraph = { title: null, preamble: [], nodes: build(null) };
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
  const mintNumber = (node: RequirementNodeRow) => Number(/^r(\d+)/.exec(node.id)?.[1] ?? 0);
  return a.ord - b.ord || originRank(a) - originRank(b) || mintNumber(a) - mintNumber(b);
}

/** Truncate to a UTF-8 byte budget without splitting a multibyte character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // A cut mid-sequence decodes as replacement characters at the tail; strip them.
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
}
