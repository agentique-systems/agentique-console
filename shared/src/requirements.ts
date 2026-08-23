// The requirement graph: the run's committed specification as a recursive
// outline of declarative statements — what must be TRUE of the finished work,
// never how to make it true. This module is pure and dependency-free on
// purpose: the server uses it to parse proposals and render the canonical
// document; the web uses it to live-validate the operator's in-place edits and
// to preview the tree. Both sides compile against ONE grammar, so an edit that
// parses in the card is an edit that parses on the server.
//
// Two renderers, one parser:
// - `renderCommitted` emits the canonical COMMITTED form (structure only) and
//   is a fixed point of `parseRequirementsDocument` — parse(render(g)) ≡ g.
// - `renderStatusOutline` decorates the same outline with live statuses for
//   prompts and panels; it is a view and is NEVER parsed.

export type RequirementComposition = "all" | "any";

/**
 * Semantic statuses, deliberately not numeric. `open` is the default;
 * `satisfied`/`violated`/`infeasible` are claims that require evidence;
 * `retired` means an approved amendment removed the node from scope.
 */
export type RequirementStatus = "open" | "satisfied" | "violated" | "infeasible" | "retired";

/** Who stood behind a status change; "console" marks mechanical resets only. */
export type RequirementVerifiedBy = "self" | "independent" | "operator" | "console";

export interface RequirementGraphNode {
  /** Stable per-session id ("r1", "r2", …). null = a new line awaiting mint. */
  id: string | null;
  statement: string;
  /** How the node's children combine; leaves carry "all" harmlessly. */
  composition: RequirementComposition;
  children: RequirementGraphNode[];
}

export interface RequirementGraph {
  /** The `# Title` line, if present. */
  title: string | null;
  /** Prose sections other than `## Requirements`, kept verbatim in order. */
  preamble: { heading: string; body: string }[];
  /** Top-level requirements; the run's root composes them with "all". */
  nodes: RequirementGraphNode[];
}

export interface RequirementParseError {
  line: number;
  message: string;
}

export type RequirementParseResult =
  | { ok: true; graph: RequirementGraph }
  | { ok: false; errors: RequirementParseError[] };

/** Flattened row for diffs and tree rendering; `ord` is the sibling index. */
export interface FlatRequirementNode {
  id: string | null;
  parentId: string | null;
  ord: number;
  depth: number;
  statement: string;
  composition: RequirementComposition;
}

export const REQUIREMENT_MAX_DEPTH = 8;
export const REQUIREMENT_MAX_NODES = 200;

const REQUIREMENTS_HEADING = "## requirements";
/**
 * The minted id shape. Restricting ids to this shape is what keeps the grammar
 * unambiguous: `- latency: under 200ms` is a STATEMENT containing a colon,
 * never an id claim, because "latency" is not `r<digits>`.
 */
const ID_PATTERN = /^r\d+(?:\.\d+)*$/;
const ANY_OF = "(any of)";

interface Line {
  raw: string;
  number: number;
}

/**
 * Parse the canonical outline. Never throws; structural problems come back as
 * `{ line, message }` errors so a card or a tool result can point at them.
 */
export function parseRequirementsDocument(text: string): RequirementParseResult {
  const lines: Line[] = text.split(/\r\n|\r|\n/).map((raw, index) => ({ raw, number: index + 1 }));
  const errors: RequirementParseError[] = [];

  let title: string | null = null;
  const preamble: { heading: string; body: string }[] = [];
  const nodes: RequirementGraphNode[] = [];

  /** Section state: null = before any heading; "" = leading prose bucket. */
  let section: string | null = null;
  let sectionLines: string[] = [];
  let inRequirements = false;
  let sawRequirementsHeading = false;

  const flushSection = () => {
    if (section === null || inRequirements) return;
    // Blank runs collapse and leading blanks strip HERE so the parse is
    // canonical: renderCommitted collapses at the joins too, and
    // parse(render(g)) must equal g (fixed point).
    const body = sectionLines.join("\n").replace(/\s+$/, "").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
    if (section !== "" || body !== "") preamble.push({ heading: section, body });
    sectionLines = [];
  };

  // Indentation → depth. The unit is inferred from the first nested line and
  // then enforced; tabs count as one unit each.
  let indentUnit: number | null = null;
  const stack: { node: RequirementGraphNode; depth: number }[] = [];
  const seenIds = new Set<string>();
  let nodeCount = 0;

  for (const line of lines) {
    const raw = line.raw;
    const trimmed = raw.trim();

    if (trimmed.startsWith("# ") && !trimmed.startsWith("## ")) {
      if (title === null && section === null && nodes.length === 0) {
        title = trimmed.slice(2).trim();
        continue;
      }
      // A stray level-1 heading later on is prose in whatever section holds it.
    }

    if (trimmed.startsWith("## ")) {
      flushSection();
      const heading = trimmed.slice(3).trim();
      if (heading.toLowerCase() === "requirements") {
        inRequirements = true;
        sawRequirementsHeading = true;
        section = null;
      } else {
        inRequirements = false;
        section = heading;
      }
      continue;
    }

    if (!inRequirements) {
      if (section === null && trimmed !== "") section = "";
      if (section !== null) sectionLines.push(raw);
      continue;
    }

    // Inside ## Requirements: list items only (blank lines allowed).
    if (trimmed === "") continue;
    const item = /^([ \t]*)[-*][ \t]+(.*)$/.exec(raw);
    if (!item) {
      errors.push({ line: line.number, message: "expected a list item ('- …') under ## Requirements" });
      continue;
    }
    const [, indent = "", rest = ""] = item;
    const width = indentWidth(indent);
    let depth = 0;
    if (width > 0) {
      if (indentUnit === null) indentUnit = width;
      if (width % indentUnit !== 0) {
        errors.push({ line: line.number, message: `indentation of ${width} is not a multiple of the outline's unit (${indentUnit})` });
        continue;
      }
      depth = width / indentUnit;
    }
    if (depth > stack.length) {
      errors.push({ line: line.number, message: "list item is nested more than one level below its parent" });
      continue;
    }
    if (depth >= REQUIREMENT_MAX_DEPTH) {
      errors.push({ line: line.number, message: `deeper than the maximum depth of ${REQUIREMENT_MAX_DEPTH}` });
      continue;
    }

    const parsed = parseNodeText(rest.trim());
    if (parsed.id !== null) {
      if (seenIds.has(parsed.id)) {
        errors.push({ line: line.number, message: `duplicate requirement id "${parsed.id}"` });
        continue;
      }
      seenIds.add(parsed.id);
    }
    if (parsed.statement === "") {
      errors.push({ line: line.number, message: "requirement statement is empty" });
      continue;
    }
    nodeCount += 1;
    if (nodeCount > REQUIREMENT_MAX_NODES) {
      errors.push({ line: line.number, message: `more than ${REQUIREMENT_MAX_NODES} requirements` });
      break;
    }

    const node: RequirementGraphNode = {
      id: parsed.id,
      statement: parsed.statement,
      composition: parsed.composition,
      children: [],
    };
    stack.length = depth;
    const parent = stack[depth - 1];
    if (parent) parent.node.children.push(node);
    else nodes.push(node);
    stack.push({ node, depth });
  }
  flushSection();

  if (!sawRequirementsHeading) {
    errors.push({ line: lines.length, message: "missing '## Requirements' section" });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, graph: { title, preamble, nodes } };
}

function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === "\t" ? 2 : 1;
  return width;
}

function parseNodeText(text: string): { id: string | null; composition: RequirementComposition; statement: string } {
  // `rN[.N…] (any of): statement` | `rN[.N…]: statement`. Case-insensitive on
  // BOTH the id and the marker, normalized to lowercase: a case variant the
  // operator retypes ("R3", "(ANY OF)") must amend r3, never silently mint a
  // new node and retire the old one with its status history.
  const withId = /^(r\d+(?:\.\d+)*)\s*(\(any of\))?\s*:\s*(.*)$/i.exec(text);
  const claimedId = (withId?.[1] ?? "").toLowerCase();
  if (withId && ID_PATTERN.test(claimedId)) {
    return { id: claimedId, composition: withId[2] ? "any" : "all", statement: (withId[3] ?? "").trim() };
  }
  // `(any of): statement` | `(any of) statement` — a new node with alternatives.
  if (text.toLowerCase().startsWith(ANY_OF)) {
    const rest = text.slice(ANY_OF.length).replace(/^\s*:?\s*/, "");
    return { id: null, composition: "any", statement: rest.trim() };
  }
  // Anything else — colons and all — is a plain statement of a new node.
  return { id: null, composition: "all", statement: text };
}

/**
 * Render the canonical COMMITTED form: title, preamble sections verbatim, then
 * the requirement outline with 2-space indentation. This is the text the
 * operator edits on the approval card and the text a revision stores; it is a
 * fixed point of the parser.
 */
export function renderCommitted(graph: RequirementGraph): string {
  const out: string[] = [];
  if (graph.title !== null && graph.title !== "") out.push(`# ${graph.title}`, "");
  for (const section of graph.preamble) {
    if (section.heading !== "") out.push(`## ${section.heading}`);
    if (section.body !== "") out.push(section.body);
    out.push("");
  }
  out.push("## Requirements");
  const walk = (nodes: RequirementGraphNode[], depth: number) => {
    for (const node of nodes) {
      const indent = "  ".repeat(depth);
      const anyOf = node.composition === "any" ? " (any of)" : "";
      out.push(node.id === null
        ? `${indent}- ${anyOf === "" ? "" : `${ANY_OF} `}${node.statement}`
        : `${indent}- ${node.id}${anyOf}: ${node.statement}`);
      walk(node.children, depth + 1);
    }
  };
  walk(graph.nodes, 0);
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Live info a status renderer needs per node; parents pass derived status. */
export interface RequirementStatusInfo {
  status: RequirementStatus;
  verifiedBy?: RequirementVerifiedBy;
  evidenceCount?: number;
}

const STATUS_GLYPH: Record<RequirementStatus, string> = {
  open: "·",
  satisfied: "✓",
  violated: "✗",
  infeasible: "⊘",
  retired: "†",
};

/**
 * Render the status-decorated outline for prompts and panels. A VIEW only —
 * never parsed, never stored as a revision document. Retired nodes are
 * omitted; the revision history carries them.
 */
export function renderStatusOutline(
  graph: RequirementGraph,
  info: (id: string) => RequirementStatusInfo | undefined,
): string {
  const out: string[] = [];
  const walk = (nodes: RequirementGraphNode[], depth: number) => {
    for (const node of nodes) {
      const nodeInfo = node.id === null ? undefined : info(node.id);
      if (nodeInfo?.status === "retired") continue;
      const status = nodeInfo?.status ?? "open";
      const glyph = STATUS_GLYPH[status];
      const anyOf = node.composition === "any" ? " (any of)" : "";
      const trail = statusTrail(nodeInfo);
      out.push(`${"  ".repeat(depth)}- [${glyph}] ${node.id ?? "new"}${anyOf}: ${node.statement}${trail}`);
      walk(node.children, depth + 1);
    }
  };
  walk(graph.nodes, 0);
  return out.join("\n");
}

function statusTrail(info: RequirementStatusInfo | undefined): string {
  if (!info || info.status === "open") return "";
  const parts: string[] = [info.status];
  if (info.verifiedBy && info.status === "satisfied") parts.push(info.verifiedBy);
  if (info.evidenceCount !== undefined && info.evidenceCount > 0) {
    parts.push(`${info.evidenceCount} evidence`);
  }
  return ` — ${parts.join(", ")}`;
}

/** Depth-first flatten with parent links — the diff and tree substrate. */
export function flattenRequirementGraph(graph: RequirementGraph): FlatRequirementNode[] {
  const rows: FlatRequirementNode[] = [];
  const walk = (nodes: RequirementGraphNode[], parentId: string | null, depth: number) => {
    nodes.forEach((node, ord) => {
      rows.push({ id: node.id, parentId, ord, depth, statement: node.statement, composition: node.composition });
      walk(node.children, node.id, depth + 1);
    });
  };
  walk(graph.nodes, null, 0);
  return rows;
}

/**
 * Mechanical status derivation over one node's live children. The console
 * derives; models only ever claim leaf statuses.
 * - "all": violated if any child violated; else infeasible if any infeasible;
 *   else satisfied iff every child satisfied; else open.
 * - "any": satisfied if any child satisfied; else open unless every child is
 *   terminal-negative (then infeasible, or violated when all are violated).
 */
export function deriveComposedStatus(
  composition: RequirementComposition,
  children: RequirementStatus[],
): RequirementStatus {
  const live = children.filter((status) => status !== "retired");
  if (live.length === 0) return "open";
  if (composition === "all") {
    if (live.includes("violated")) return "violated";
    if (live.includes("infeasible")) return "infeasible";
    if (live.every((status) => status === "satisfied")) return "satisfied";
    return "open";
  }
  if (live.includes("satisfied")) return "satisfied";
  if (live.every((status) => status === "violated")) return "violated";
  if (live.every((status) => status === "violated" || status === "infeasible")) return "infeasible";
  return "open";
}

/** Count live nodes by status — the pointer line's raw material. */
export function requirementStatusCounts(statuses: Iterable<RequirementStatus>): Record<RequirementStatus, number> {
  const counts: Record<RequirementStatus, number> = { open: 0, satisfied: 0, violated: 0, infeasible: 0, retired: 0 };
  for (const status of statuses) counts[status] += 1;
  return counts;
}
