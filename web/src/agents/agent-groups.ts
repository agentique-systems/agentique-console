/**
 * The agent-side twin of session/user-groups.ts: presentation grouping between
 * the fold and the renderer.
 *
 * Seats do the real work — Bash, Edit, Write, Read, Grep — so the inspector
 * fills with tool cards fast. Consecutive calls collapse into one Task block
 * per seat. The participant is part of the grouping key: two seats working
 * back to back are two runs, never one, because the seat label is the whole
 * point of the inspector.
 *
 * Pure, idempotent, total over the item union — and deliberately separate from
 * `agent-fold.ts`, which is the wire contract's shape and pinned by its own
 * golden suite.
 */
import type { AgentItem, AgentToolItem } from "./agent-fold";

// Re-exported so callers of this module get the whole tool-rendering vocabulary
// from one import; the implementations are shared with the user transcript.
export { shortenPath, subjectOf } from "@/lib/tool-text";

export interface ToolRunItem {
  readonly type: "tool_run";
  /** Render identity: the first tool's uid, which is already unique. */
  readonly uid: string;
  readonly participant: string;
  readonly tools: readonly AgentToolItem[];
  /** No result yet on the last call — the run is still going. */
  readonly active: boolean;
}

export type AgentGroup = Exclude<AgentItem, AgentToolItem> | ToolRunItem;

export function agentGroupKey(group: AgentGroup): string {
  return group.type === "tool_run" ? `tool_run:${group.uid}` : itemKeyOf(group);
}

/** Mirrors agent-fold's agentItemKey for the arms it still passes through. */
function itemKeyOf(item: Exclude<AgentItem, AgentToolItem>): string {
  switch (item.type) {
    case "message":
      return `message:${item.seq}`;
    case "routed":
      return `routed:${item.messageSeq}`;
    case "turn":
      return `turn:${item.turnId}`;
    case "turn_error":
      return `turn_error:${item.turnId}`;
    case "trace":
      return `trace:${item.uid}`;
  }
}

export function groupAgentItems(items: readonly AgentItem[]): AgentGroup[] {
  const groups: AgentGroup[] = [];
  let run: AgentToolItem[] | null = null;

  const flush = () => {
    if (run === null) return;
    groups.push(runOf(run));
    run = null;
  };

  for (const item of items) {
    if (item.type === "tool") {
      // A different seat is a different run, even with nothing in between.
      if (run !== null && run[0]?.participant !== item.participant) flush();
      if (run === null) run = [item];
      else run.push(item);
      continue;
    }
    flush();
    groups.push(item);
  }
  flush();
  return groups;
}

function runOf(tools: readonly AgentToolItem[]): ToolRunItem {
  const first = tools[0];
  const last = tools[tools.length - 1];
  return {
    type: "tool_run",
    uid: first?.uid ?? "run",
    participant: first?.participant ?? "unknown",
    tools: [...tools],
    active: last !== undefined && last.output === undefined && last.isError !== true,
  };
}

type Phrase = readonly [verb: string, singular: string, plural: string];

const NOUNS: Readonly<Record<string, Phrase>> = {
  Bash: ["ran", "command", "commands"],
  BashOutput: ["read", "output", "outputs"],
  Read: ["read", "file", "files"],
  Write: ["wrote", "file", "files"],
  Edit: ["edited", "file", "files"],
  NotebookEdit: ["edited", "notebook", "notebooks"],
  // Glob and Grep deliberately share a phrase: to the operator both are
  // "searching", and collapsing them keeps the summary short.
  Glob: ["searched", "pattern", "patterns"],
  Grep: ["searched", "pattern", "patterns"],
  WebFetch: ["fetched", "page", "pages"],
  WebSearch: ["searched", "the web", "the web"],
  SendMessage: ["sent", "message", "messages"],
  TaskCreate: ["made", "task update", "task updates"],
  TaskUpdate: ["made", "task update", "task updates"],
};

const FALLBACK: Phrase = ["ran", "step", "steps"];

/**
 * "ran 3 commands · edited 2 files" — the collapsed Task trigger has to say
 * enough that the operator can leave it collapsed. Ordered by first
 * appearance so it reads as the narrative it is, not as a sorted tally.
 */
export function runSummary(tools: readonly AgentToolItem[]): string {
  // Keyed by the phrase itself so tools that say the same thing (Glob and
  // Grep both "searched N patterns") collapse into one clause. The phrase is
  // carried in the value and never re-parsed out of the key — nouns contain
  // spaces ("task update").
  const counts = new Map<string, { phrase: Phrase; count: number }>();
  for (const tool of tools) {
    const phrase = NOUNS[tool.name] ?? FALLBACK;
    const key = phrase.join(" ");
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { phrase, count: 1 });
  }
  const parts: string[] = [];
  for (const { phrase, count } of counts.values()) {
    const [verb, singular, plural] = phrase;
    parts.push(`${verb} ${count} ${count === 1 ? singular : plural}`);
  }
  return parts.join(" · ");
}
