/**
 * Bounded seat delivery views: the deterministic selection layer between the
 * durable stores and the delivery prompt. The stores stay large; what a seat
 * is automatically shown scales with its active frontier, and everything
 * omitted stays one deterministic read away (task_list, read_requirements,
 * roster_status, list_decisions).
 *
 * Two laws every selector here obeys:
 * - WITHIN BUDGET, RENDER EVERYTHING BYTE-IDENTICALLY. Small sessions —
 *   which is most sessions — must compose the exact bytes they composed
 *   before this layer existed, for prompt caching and test stability alike.
 * - OVER BUDGET, SELECT BY RELEVANCE, RENDER IN CANONICAL ORDER, AND SAY
 *   WHAT WAS OMITTED. Selection is semantic (assigned/owned, blocking,
 *   flagged, pinned-by-requirement), never purely chronological; the
 *   omission marker always carries a count and the tool that recovers the
 *   rest. Nothing is silently dropped.
 *
 * Selection is pure and testable; prompt prose stays in the composer.
 */
import type { ChangeImpactWire } from "@agentique-console/shared";

/**
 * Task-ledger view bounds. The byte cap matches the decision digest's 4 KiB
 * convention (orchestrator/decisions.ts); the entry cap is sized so any
 * session with a few dozen units — the working range the patterns produce —
 * renders its whole ledger unchanged.
 */
export const TASK_VIEW_MAX_ENTRIES = 32;
export const TASK_VIEW_MAX_BYTES = 4 * 1024;

/**
 * Decision-delta bounds: the same entry/byte caps as the spawn digest
 * (orchestrator/decisions.ts DIGEST_MAX_*), so a delivery can never carry a
 * larger decision block than a fresh spawn would.
 */
export const DECISION_DELTA_MAX_ENTRIES = 40;
export const DECISION_DELTA_MAX_BYTES = 4 * 1024;

/**
 * Delivery-roster bound: the default global resident cap (config
 * `agentMaxResident` tops out at 12) — a delivery never renders more seats
 * than could concurrently be resident under default policy. Map/reduce waves
 * and large plan/execute crews stay reachable through roster_status.
 */
export const ROSTER_MAX_SEATS = 12;

/**
 * Delegated-requirements budget: the same 8 KiB the main digest holds itself
 * to (orchestrator/requirements.ts DIGEST_MAX_BYTES) — a seat's standing
 * requirement block should never outweigh main's view of the whole graph.
 */
export const DELEGATED_VIEW_MAX_BYTES = 8 * 1024;

/** Open change impacts rendered per delivery; the rest are counted. */
export const IMPACT_VIEW_MAX_ENTRIES = 3;

function bytesOf(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) total += Buffer.byteLength(line, "utf8") + 1;
  return total;
}

/** The slice of a wire task the ledger view selects on. */
export interface TaskViewTask {
  id: string;
  status: string;
  owner: string | null;
  dependencyIds: readonly string[];
  ready: boolean;
  /** The canonical ledger line (tasks/service.ts taskLedgerLine). */
  line: string;
}

export interface TaskView {
  lines: string[];
  /** Rendered only when something was omitted — null keeps small ledgers byte-identical. */
  omittedLine: string | null;
}

/**
 * The bounded execution view of one seat's ledger. Within budget: every live
 * task, ledger order, exactly as before. Over budget, priority classes:
 * the seat's own active units, then their direct incomplete blockers, then
 * anyone's in-progress work, then ready pending units (the "sat pending
 * forever" class a live run suffered), then blocked pending, then completed.
 * Selected lines keep ledger order; the omission line counts the rest by
 * status and points at task_list.
 */
export function selectTaskView(tasks: readonly TaskViewTask[], seat: string): TaskView {
  const lines = tasks.map((task) => task.line);
  if (tasks.length <= TASK_VIEW_MAX_ENTRIES && bytesOf(lines) <= TASK_VIEW_MAX_BYTES) {
    return { lines, omittedLine: null };
  }
  const own = new Set(tasks.filter((task) => task.owner === seat && (task.status === "pending" || task.status === "in_progress")).map((task) => task.id));
  const blockers = new Set(tasks.filter((task) => own.has(task.id)).flatMap((task) => task.dependencyIds));
  const classOf = (task: TaskViewTask): number => {
    if (own.has(task.id)) return 0;
    if (blockers.has(task.id) && task.status !== "completed") return 1;
    if (task.status === "in_progress") return 2;
    if (task.status === "pending" && task.ready) return 3;
    if (task.status === "pending") return 4;
    return 5;
  };
  const ranked = tasks.map((task, index) => ({ task, index, rank: classOf(task) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const selected = new Set<number>();
  let bytes = 0;
  for (const entry of ranked) {
    const size = Buffer.byteLength(entry.task.line, "utf8") + 1;
    if (selected.size >= TASK_VIEW_MAX_ENTRIES || bytes + size > TASK_VIEW_MAX_BYTES) break;
    selected.add(entry.index);
    bytes += size;
  }
  const omitted = tasks.filter((_, index) => !selected.has(index));
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const task of omitted) {
    if (task.status === "pending") counts.pending += 1;
    else if (task.status === "in_progress") counts.in_progress += 1;
    else if (task.status === "completed") counts.completed += 1;
  }
  const parts = [
    ...(counts.pending > 0 ? [`${counts.pending} pending`] : []),
    ...(counts.in_progress > 0 ? [`${counts.in_progress} in progress`] : []),
    ...(counts.completed > 0 ? [`${counts.completed} completed`] : []),
  ];
  return {
    lines: tasks.map((task, index) => ({ task, index })).filter(({ index }) => selected.has(index)).map(({ task }) => task.line),
    omittedLine: `(${omitted.length} more task(s) not shown: ${parts.join(" · ")} — task_list returns the full ledger)`,
  };
}

/** One decision-delta candidate: the rendered line plus its relevance pin. */
export interface DecisionDeltaEntry {
  line: string;
  /** Named requirement still live and unsatisfied in the seat's scope (decisionPin). */
  pinned: boolean;
}

export interface DecisionDeltaView {
  /** Selected lines, chronological — reading order is preserved whatever the selection order was. */
  lines: string[];
  omitted: number;
}

/**
 * The bounded decision delta. Within caps every unseen decision renders in
 * order, exactly as before. Over caps, scope-pinned decisions (oldest first)
 * take the budget before mere recency (newest first) — a long-parked seat
 * hears what governs ITS requirements before it hears what happened last.
 */
export function selectDecisionDelta(entries: readonly DecisionDeltaEntry[]): DecisionDeltaView {
  const all = entries.map((entry) => entry.line);
  if (entries.length <= DECISION_DELTA_MAX_ENTRIES && bytesOf(all) <= DECISION_DELTA_MAX_BYTES) {
    return { lines: all, omitted: 0 };
  }
  const indexed = entries.map((entry, index) => ({ entry, index }));
  const candidates = [
    ...indexed.filter(({ entry }) => entry.pinned),
    ...indexed.filter(({ entry }) => !entry.pinned).reverse(),
  ];
  const selected = new Set<number>();
  let bytes = 0;
  for (const { entry, index } of candidates) {
    const size = Buffer.byteLength(entry.line, "utf8") + 1;
    if (selected.size >= DECISION_DELTA_MAX_ENTRIES || bytes + size > DECISION_DELTA_MAX_BYTES) break;
    selected.add(index);
    bytes += size;
  }
  return {
    lines: indexed.filter(({ index }) => selected.has(index)).map(({ entry }) => entry.line),
    omitted: entries.length - selected.size,
  };
}

/** The lane/row facts the roster selection reads — no worktree diffs needed to select. */
export interface RosterSeatFacts {
  name: string;
  /** Lane is live or mid-turn right now. */
  live: boolean;
  lastActiveAt: string | null;
}

/**
 * Which seats a delivery's roster renders. `null` means "all of them" — the
 * within-budget identity case. Over the cap: the addressed seat, every live
 * seat, then the most recently active parked seats fill the remainder; the
 * rest are counted and stay one roster_status call away. Work-state detail
 * (including git diff stats) is only ever computed for selected seats.
 */
export function selectRosterSeats(seats: readonly RosterSeatFacts[], self: string | null): { names: ReadonlySet<string>; omitted: number } | null {
  if (seats.length <= ROSTER_MAX_SEATS) return null;
  const names = new Set<string>();
  for (const seat of seats) {
    if (seat.name === self || seat.live) names.add(seat.name);
  }
  const parked = seats.filter((seat) => !names.has(seat.name))
    .map((seat, index) => ({ seat, index }))
    .sort((a, b) => (b.seat.lastActiveAt ?? "").localeCompare(a.seat.lastActiveAt ?? "") || a.index - b.index);
  for (const { seat } of parked) {
    if (names.size >= ROSTER_MAX_SEATS) break;
    names.add(seat.name);
  }
  return { names, omitted: seats.length - names.size };
}

/** One delegated-subtree node as the bounding ladder sees it, depth-first order. */
export interface DelegatedViewNode {
  id: string;
  /** Parent WITHIN the delegated subtree; null for a delegated root. */
  parentId: string | null;
  /** The fully rendered line (indentation included) — the byte-identity unit. */
  line: string;
  derivedStatus: string;
  flagged: boolean;
}

export interface DelegatedView {
  lines: string[];
  /** Rendered only when nodes were dropped without a collapsed-line trace. */
  omittedLine: string | null;
}

/**
 * The delegated-requirements bounding ladder, mirroring the main digest's
 * philosophy (orchestrator/requirements.ts):
 *  0. full subtree — byte-identical whenever it fits;
 *  1. collapse fully-satisfied unflagged subtrees to their top line with a
 *     count — stable finished work costs one line, not its whole shape;
 *  2. keep only the skeleton: delegated roots, flagged claims, unsatisfied
 *     nodes, and their ancestors (the governing boundary), counting the rest;
 *  3. shed unflagged skeleton lines from the bottom until it fits — flagged
 *     nodes and roots go last, so a revision-invalidated claim survives even
 *     a pathological budget.
 * Every step is deterministic; omissions always name read_requirements.
 */
export function selectDelegatedView(nodes: readonly DelegatedViewNode[], budget: number = DELEGATED_VIEW_MAX_BYTES): DelegatedView {
  const full = nodes.map((node) => node.line);
  if (bytesOf(full) <= budget) return { lines: full, omittedLine: null };

  const children = new Map<string, DelegatedViewNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const subtreeStable = new Map<string, boolean>();
  const subtreeSize = new Map<string, number>();
  const measure = (node: DelegatedViewNode): { stable: boolean; size: number } => {
    const kids = children.get(node.id) ?? [];
    let stable = node.derivedStatus === "satisfied" && !node.flagged;
    let size = 1;
    for (const kid of kids) {
      const sub = measure(kid);
      stable = stable && sub.stable;
      size += sub.size;
    }
    subtreeStable.set(node.id, stable);
    subtreeSize.set(node.id, size);
    return { stable, size };
  };
  for (const node of nodes) if (node.parentId === null) measure(node);

  // Step 1: collapse maximal stable subtrees below the roots.
  const collapsedUnder = new Set<string>();
  const step1: string[] = [];
  const emit = (node: DelegatedViewNode): void => {
    const kids = children.get(node.id) ?? [];
    if (node.parentId !== null && subtreeStable.get(node.id) === true && kids.length > 0) {
      const size = subtreeSize.get(node.id)! - 1;
      step1.push(`${node.line} (subtree: ${size}/${size} satisfied, collapsed)`);
      collapsedUnder.add(node.id);
      return;
    }
    step1.push(node.line);
    for (const kid of kids) emit(kid);
  };
  for (const node of nodes) if (node.parentId === null) emit(node);
  if (bytesOf(step1) <= budget) return { lines: step1, omittedLine: null };

  // Step 2: the attention skeleton — roots, flags, open work, and the
  // ancestor chain that keeps the boundary legible.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const keep = new Set<string>();
  for (const node of nodes) {
    if (node.parentId !== null && node.derivedStatus === "satisfied" && !node.flagged) continue;
    for (let cursor: DelegatedViewNode | undefined = node; cursor !== undefined; cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)) {
      if (keep.has(cursor.id)) break;
      keep.add(cursor.id);
    }
  }
  const skeleton = nodes.filter((node) => keep.has(node.id));
  const omittedNote = (dropped: number): string =>
    `(${dropped} requirement(s) not shown — read_requirements(scopeId) returns the full subtree with statuses)`;
  const step2 = skeleton.map((node) => node.line);
  if (bytesOf([...step2, omittedNote(nodes.length - skeleton.length)]) <= budget) {
    return { lines: step2, omittedLine: omittedNote(nodes.length - skeleton.length) };
  }

  // Step 3: shed skeleton lines bottom-up; flagged nodes, then roots, last.
  const shedOrder = [
    ...skeleton.filter((node) => node.parentId !== null && !node.flagged).reverse(),
    ...skeleton.filter((node) => node.parentId !== null && node.flagged).reverse(),
    ...skeleton.filter((node) => node.parentId === null).reverse(),
  ];
  const kept = new Set(skeleton.map((node) => node.id));
  for (const node of shedOrder) {
    if (kept.size <= 1) break;
    kept.delete(node.id);
    const lines = skeleton.filter((candidate) => kept.has(candidate.id)).map((candidate) => candidate.line);
    if (bytesOf([...lines, omittedNote(nodes.length - kept.size)]) <= budget) {
      return { lines, omittedLine: omittedNote(nodes.length - kept.size) };
    }
  }
  const last = skeleton.find((node) => kept.has(node.id)) ?? skeleton[0]!;
  return { lines: [last.line], omittedLine: omittedNote(nodes.length - 1) };
}

/**
 * The open change impacts that name one session as affected-and-unreconciled
 * — the revision-currency signal (orchestrator/change-impact.ts) projected
 * into that session's deliveries. Oldest first: the longest-standing
 * unreconciled change is the one most likely to already be baked into work.
 */
export function selectSessionImpacts(impacts: readonly ChangeImpactWire[], agentSessionId: string): { shown: ChangeImpactWire[]; omitted: number } {
  const mine = impacts
    .filter((impact) => impact.status === "open" && impact.outstanding.sessions.includes(agentSessionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { shown: mine.slice(0, IMPACT_VIEW_MAX_ENTRIES), omitted: Math.max(0, mine.length - IMPACT_VIEW_MAX_ENTRIES) };
}
