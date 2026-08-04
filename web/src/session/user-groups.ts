/**
 * The presentation grouping that sits BETWEEN the fold and the renderer.
 *
 * The orchestrator is read-only — Read/Glob/Grep, the task board, Agent and
 * SendMessage, plus the console's own MCP tools — so a routine turn is a run
 * of "search → read → delegate". Rendering each of those as its own bordered
 * Tool card turns one thought into a wall of boxes, so consecutive tool calls
 * collapse into a single chain-of-thought block.
 *
 * Deliberately separate from `user-fold.ts`: that fold is the wire contract's
 * shape and is pinned by its own golden suite. This is a view concern and can
 * be re-cut without touching it. Same rules apply though — pure, idempotent,
 * total over the item union.
 */
import type { ToolItem, UserItem } from "./user-fold";

export interface ChainItem {
  readonly type: "chain";
  /** Render identity: the first tool's uid, which is already unique. */
  readonly uid: string;
  readonly tools: readonly ToolItem[];
  /** No result yet on the last call — the chain is still being written. */
  readonly active: boolean;
}

export type UserGroup = Exclude<UserItem, ToolItem> | ChainItem;

export function groupKey(group: UserGroup): string {
  return group.type === "chain" ? `chain:${group.uid}` : itemKeyOf(group);
}

/** Mirrors user-fold's itemKey for the non-tool arms it still passes through. */
function itemKeyOf(item: Exclude<UserItem, ToolItem>): string {
  switch (item.type) {
    case "message":
      return `message:${item.seq}`;
    case "question":
      return `question:${item.interactionId}`;
    case "plan":
      return `plan:${item.interactionId}`;
    case "turn":
      return `turn:${item.turnId}`;
    case "turn_error":
      return `turn_error:${item.turnId}`;
    case "runtime":
      return `runtime:${item.uid}`;
  }
}

/**
 * Anything that is not a tool call breaks the chain — a reply, a card, or a
 * turn hairline all mean the previous run of thinking ended.
 */
export function groupUserItems(items: readonly UserItem[]): UserGroup[] {
  const groups: UserGroup[] = [];
  let run: ToolItem[] | null = null;

  const flush = () => {
    if (run === null) return;
    groups.push(chainOf(run));
    run = null;
  };

  for (const item of items) {
    if (item.type === "tool") {
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

function chainOf(tools: readonly ToolItem[]): ChainItem {
  const last = tools[tools.length - 1];
  return {
    type: "chain",
    uid: tools[0]?.uid ?? "chain",
    tools: [...tools],
    active: last !== undefined && last.output === undefined && last.isError !== true,
  };
}

/** A tool call is still open until its result pairs with it. */
export function toolStatus(tool: ToolItem): "active" | "complete" | "failed" {
  if (tool.isError === true) return "failed";
  return tool.output === undefined ? "active" : "complete";
}

type Category =
  | "search"
  | "read"
  | "fetch"
  | "delegate"
  | "speak"
  | "task"
  | "console"
  | "other";

/**
 * Bare tool names, since the orchestrator's toolset is fixed by
 * server/src/orchestrator/options.ts. Console MCP tools arrive fully
 * qualified (`mcp__console__…`) and are matched by prefix below.
 */
const CATEGORIES: Readonly<Record<string, Category>> = {
  Glob: "search",
  Grep: "search",
  WebSearch: "search",
  Read: "read",
  NotebookRead: "read",
  WebFetch: "fetch",
  Agent: "delegate",
  SendMessage: "speak",
  TaskCreate: "task",
  TaskUpdate: "task",
  TaskView: "task",
};

export function categoryOf(name: string): Category {
  if (name.startsWith("mcp__console__")) return "console";
  return CATEGORIES[name] ?? "other";
}

/** Singular/plural noun per category, counted over the run. */
const NOUNS: Readonly<Record<Category, readonly [string, string]>> = {
  search: ["search", "searches"],
  read: ["file", "files"],
  fetch: ["page", "pages"],
  delegate: ["agent", "agents"],
  speak: ["message", "messages"],
  task: ["task update", "task updates"],
  console: ["console call", "console calls"],
  other: ["step", "steps"],
};

const VERBS: Readonly<Record<Category, string>> = {
  // "ran 1 search", not "searched 1 search" — the noun already says it.
  search: "ran",
  read: "read",
  fetch: "fetched",
  delegate: "spawned",
  speak: "sent",
  task: "made",
  console: "made",
  other: "ran",
};

/**
 * "read 6 files · spawned 2 agents" — the one-line header that has to justify
 * leaving the chain collapsed. Ordered by first appearance so it reads as the
 * narrative it is, not as a sorted tally.
 */
export function chainSummary(tools: readonly ToolItem[]): string {
  const counts = new Map<Category, number>();
  for (const tool of tools) {
    const category = categoryOf(tool.name);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [category, count] of counts) {
    const nouns = NOUNS[category];
    const noun = count === 1 ? nouns[0] : nouns[1];
    parts.push(`${VERBS[category]} ${count} ${noun}`);
  }
  return parts.join(" · ");
}

/**
 * Glob/Grep results arrive as a newline-separated blob (the server caps tool
 * payloads at 16KB in sdk/mapping.ts). Rendering the first few as chips turns
 * "searched 1 search" into something worth reading while collapsed.
 *
 * Deliberately conservative: anything that is not a plain string of plausible
 * path-ish lines gets no chips rather than a mangled blob.
 */
export function searchResultsOf(tool: ToolItem, limit = 6): string[] {
  if (categoryOf(tool.name) !== "search") return [];
  if (typeof tool.output !== "string") return [];
  const lines = tool.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.includes(" "));
  return lines.slice(0, limit);
}
