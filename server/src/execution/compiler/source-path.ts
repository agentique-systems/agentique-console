/**
 * The canonical source-path grammar. A source path names the position in a
 * source revision that a compiled Plan Node was produced from, and is the
 * logical key reconciliation uses to match nodes across revisions.
 *
 * ```
 * path      := "root" | expression
 * expression := "e" index { "/" segment }
 * segment   := "steps/" index                  a composite chain step
 *            | "steps/" index ".." index        a maximal run of leaf chain steps (one chain node)
 *            | "items/" index                   a composite parallel item
 *            | "leaves"                         the leaf items of a composite parallel (one parallel node)
 *            | "join"                           the compiler-emitted join of a composite parallel
 *            | "aggregate"                      the aggregation node of a composite parallel
 *            | "branches/" label                a composite route branch
 *            | "rounds/" round "/producer"      one unrolled evaluator-optimizer producer round
 *            | "rounds/" round "/evaluate"      the evaluate-only node of that round
 * index     := decimal integer >= 0 (position in a semantically ordered array)
 * round     := decimal integer >= 1
 * label     := the branch label, percent-encoded: [A-Za-z0-9_-] verbatim, every
 *              other UTF-8 byte as %XX with upper-case hex digits
 * ```
 *
 * Properties: deterministic (a function of the normalized source alone);
 * unique within a revision (every emitted node gets a distinct path);
 * independent of object insertion order (route branches are keyed by
 * label, never by position); safe for any branch label (percent-encoding
 * is injective and never produces `/`); stable under appending unrelated
 * later siblings (indices name positions, so earlier positions do not
 * move); and expressive enough to name inline roles (which live inside a
 * node and need no path of their own), unrolled rounds, joins, aggregators,
 * selectors (inside their route node), and composite branches.
 */

const SAFE = /^[A-Za-z0-9_-]$/;

export const ROOT_PATH = "root";

export function encodeLabel(label: string): string {
  const bytes = new TextEncoder().encode(label);
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    out += byte < 0x80 && SAFE.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function decodeLabel(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const char = encoded[i]!;
    if (char === "%") {
      const hex = encoded.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) throw new Error(`malformed label escape at ${i} in ${encoded}`);
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else if (SAFE.test(char)) {
      bytes.push(char.charCodeAt(0));
    } else {
      throw new Error(`unencoded character ${JSON.stringify(char)} in ${encoded}`);
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}

export const sourcePath = {
  expression: (index: number): string => `e${index}`,
  step: (parent: string, index: number): string => `${parent}/steps/${index}`,
  stepRun: (parent: string, from: number, to: number): string => `${parent}/steps/${from}..${to}`,
  item: (parent: string, index: number): string => `${parent}/items/${index}`,
  leaves: (parent: string): string => `${parent}/leaves`,
  join: (parent: string): string => `${parent}/join`,
  aggregate: (parent: string): string => `${parent}/aggregate`,
  branch: (parent: string, label: string): string => `${parent}/branches/${encodeLabel(label)}`,
  producerRound: (parent: string, round: number): string => `${parent}/rounds/${round}/producer`,
  evaluateRound: (parent: string, round: number): string => `${parent}/rounds/${round}/evaluate`,
};

export type SourcePathSegment =
  | { kind: "step"; index: number }
  | { kind: "step_run"; from: number; to: number }
  | { kind: "item"; index: number }
  | { kind: "leaves" }
  | { kind: "join" }
  | { kind: "aggregate" }
  | { kind: "branch"; label: string }
  | { kind: "producer_round"; round: number }
  | { kind: "evaluate_round"; round: number };

export type ParsedSourcePath = { kind: "root" } | { kind: "expression"; index: number; segments: SourcePathSegment[] };

const INDEX = /^(0|[1-9][0-9]*)$/;
const ROUND = /^[1-9][0-9]*$/;

/** Parses a path under the grammar; throws on anything the grammar does not produce. */
export function parseSourcePath(path: string): ParsedSourcePath {
  if (path === ROOT_PATH) return { kind: "root" };
  const parts = path.split("/");
  const head = parts.shift()!;
  const expression = /^e(0|[1-9][0-9]*)$/.exec(head);
  if (!expression) throw new Error(`source path ${path} does not start with an expression index`);
  const segments: SourcePathSegment[] = [];
  while (parts.length > 0) {
    const word = parts.shift()!;
    switch (word) {
      case "steps": {
        const value = parts.shift() ?? "";
        const run = /^(0|[1-9][0-9]*)\.\.(0|[1-9][0-9]*)$/.exec(value);
        if (run) {
          const from = Number(run[1]);
          const to = Number(run[2]);
          if (to <= from) throw new Error(`source path ${path} has an empty step run`);
          segments.push({ kind: "step_run", from, to });
        } else if (INDEX.test(value)) {
          segments.push({ kind: "step", index: Number(value) });
        } else {
          throw new Error(`source path ${path} has a malformed step segment`);
        }
        break;
      }
      case "items": {
        const value = parts.shift() ?? "";
        if (!INDEX.test(value)) throw new Error(`source path ${path} has a malformed item segment`);
        segments.push({ kind: "item", index: Number(value) });
        break;
      }
      case "leaves":
        segments.push({ kind: "leaves" });
        break;
      case "join":
        segments.push({ kind: "join" });
        break;
      case "aggregate":
        segments.push({ kind: "aggregate" });
        break;
      case "branches": {
        const value = parts.shift();
        if (value === undefined || value === "") throw new Error(`source path ${path} has an empty branch label`);
        segments.push({ kind: "branch", label: decodeLabel(value) });
        break;
      }
      case "rounds": {
        const value = parts.shift() ?? "";
        const role = parts.shift();
        if (!ROUND.test(value) || (role !== "producer" && role !== "evaluate")) throw new Error(`source path ${path} has a malformed round segment`);
        segments.push(role === "producer" ? { kind: "producer_round", round: Number(value) } : { kind: "evaluate_round", round: Number(value) });
        break;
      }
      default:
        throw new Error(`source path ${path} has an unknown segment ${word}`);
    }
  }
  return { kind: "expression", index: Number(expression[1]), segments };
}
