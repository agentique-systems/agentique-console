// The requirement outline grammar (shared/src/requirements.ts). The parser is
// the highest-blast-radius piece of the requirement graph — the operator's
// in-place card edits go through it — so every documented rule and error case
// is pinned here.
import { describe, expect, it } from "vitest";

import {
  deriveComposedStatus,
  flattenRequirementGraph,
  parseRequirementsDocument,
  REQUIREMENT_MAX_DEPTH,
  REQUIREMENT_MAX_NODES,
  renderCommitted,
  renderStatusOutline,
  requirementStatusCounts,
  type RequirementGraph,
  type RequirementStatus,
} from "@agentique-console/shared";

const CANONICAL = `# Ship the CLI

## Context
A small command-line tool for tracking.

## Out of scope
Windows support.

## Requirements
- r1: The CLI parses every documented flag
  - r2: \`--help\` output matches the documented flags
  - r3 (any of): Config is loadable
    - r4: TOML config parses
    - r5: JSON config parses
- r6: \`npm run verify\` passes from a clean checkout
`;

function mustParse(text: string): RequirementGraph {
  const result = parseRequirementsDocument(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.graph;
}

describe("parseRequirementsDocument", () => {
  it("parses the canonical form: title, preamble, ids, composition, nesting", () => {
    const graph = mustParse(CANONICAL);
    expect(graph.title).toBe("Ship the CLI");
    expect(graph.preamble).toEqual([
      { heading: "Context", body: "A small command-line tool for tracking." },
      { heading: "Out of scope", body: "Windows support." },
    ]);
    const flat = flattenRequirementGraph(graph);
    expect(flat.map((row) => row.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(flat.find((row) => row.id === "r3")?.composition).toBe("any");
    expect(flat.find((row) => row.id === "r4")?.parentId).toBe("r3");
    expect(flat.find((row) => row.id === "r6")?.parentId).toBeNull();
    expect(flat.find((row) => row.id === "r2")?.depth).toBe(1);
  });

  it("round-trips: renderCommitted(parse(x)) is a fixed point", () => {
    const graph = mustParse(CANONICAL);
    const rendered = renderCommitted(graph);
    expect(rendered).toBe(CANONICAL);
    expect(mustParse(rendered)).toEqual(graph);
  });

  it("treats a line without a minted id as a NEW node — colons and all", () => {
    const graph = mustParse("## Requirements\n- latency: p95 under 200ms\n- (any of) A config source exists\n");
    expect(graph.nodes[0]).toMatchObject({ id: null, statement: "latency: p95 under 200ms", composition: "all" });
    expect(graph.nodes[1]).toMatchObject({ id: null, statement: "A config source exists", composition: "any" });
  });

  it("accepts tab indentation and normalizes on render", () => {
    const graph = mustParse("## Requirements\n- r1: Parent\n\t- r2: Child\n");
    expect(flattenRequirementGraph(graph).find((row) => row.id === "r2")?.parentId).toBe("r1");
    expect(renderCommitted(graph)).toContain("  - r2: Child");
  });

  it("rejects a duplicate id with its line number", () => {
    const result = parseRequirementsDocument("## Requirements\n- r1: One\n- r1: Two\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ line: 3, message: 'duplicate requirement id "r1"' }]);
    }
  });

  it("rejects a non-list line inside ## Requirements", () => {
    const result = parseRequirementsDocument("## Requirements\nprose does not belong here\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain("expected a list item");
  });

  it("rejects a skipped nesting level", () => {
    const result = parseRequirementsDocument("## Requirements\n- r1: Parent\n    - r2: Too deep\n");
    // First nested line DEFINES the unit, so 4 spaces = one level; a real skip
    // needs an established unit first.
    expect(result.ok).toBe(true);
    const skipped = parseRequirementsDocument("## Requirements\n- r1: A\n  - r2: B\n      - r3: C\n");
    expect(skipped.ok).toBe(false);
    if (!skipped.ok) expect(skipped.errors[0]?.message).toContain("nested more than one level");
  });

  it("rejects an empty statement and a missing ## Requirements section", () => {
    const empty = parseRequirementsDocument("## Requirements\n- r1:\n");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors[0]?.message).toContain("statement is empty");
    const missing = parseRequirementsDocument("# Title\n\nJust prose.\n");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]?.message).toContain("missing '## Requirements'");
  });

  it("enforces the depth and node caps", () => {
    let deep = "## Requirements\n";
    for (let level = 0; level < REQUIREMENT_MAX_DEPTH + 1; level += 1) {
      deep += `${"  ".repeat(level)}- r${level + 1}: Level ${level}\n`;
    }
    const tooDeep = parseRequirementsDocument(deep);
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) expect(tooDeep.errors[0]?.message).toContain("maximum depth");

    let wide = "## Requirements\n";
    for (let index = 0; index < REQUIREMENT_MAX_NODES + 1; index += 1) wide += `- r${index + 1}: Node ${index}\n`;
    const tooMany = parseRequirementsDocument(wide);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.errors[0]?.message).toContain(`${REQUIREMENT_MAX_NODES}`);
  });

  it("handles CRLF input", () => {
    const graph = mustParse("## Requirements\r\n- r1: Windows line endings\r\n");
    expect(graph.nodes[0]?.id).toBe("r1");
  });

  it("keeps leading prose without a heading as an unlabelled preamble section", () => {
    const graph = mustParse("Some context first.\n\n## Requirements\n- r1: A thing\n");
    expect(graph.preamble).toEqual([{ heading: "", body: "Some context first." }]);
    expect(mustParse(renderCommitted(graph))).toEqual(graph);
  });
});

describe("renderStatusOutline", () => {
  it("decorates with glyphs, verification, and evidence counts; omits retired", () => {
    const graph = mustParse(CANONICAL);
    const info: Record<string, { status: RequirementStatus; verifiedBy?: "self" | "independent"; evidenceCount?: number }> = {
      r1: { status: "open" },
      r2: { status: "satisfied", verifiedBy: "independent", evidenceCount: 2 },
      r3: { status: "satisfied" },
      r4: { status: "satisfied", verifiedBy: "self", evidenceCount: 1 },
      r5: { status: "retired" },
      r6: { status: "infeasible", evidenceCount: 1 },
    };
    const outline = renderStatusOutline(graph, (id) => info[id]);
    expect(outline).toContain("- [·] r1: The CLI parses every documented flag");
    expect(outline).toContain("[✓] r2: `--help` output matches the documented flags — satisfied, independent, 2 evidence");
    expect(outline).toContain("[✓] r4: TOML config parses — satisfied, self, 1 evidence");
    expect(outline).not.toContain("r5");
    expect(outline).toContain("[⊘] r6: `npm run verify` passes from a clean checkout — infeasible, 1 evidence");
  });
});

describe("deriveComposedStatus", () => {
  const derive = deriveComposedStatus;
  it("derives 'all' composition mechanically", () => {
    expect(derive("all", ["satisfied", "satisfied"])).toBe("satisfied");
    expect(derive("all", ["satisfied", "open"])).toBe("open");
    expect(derive("all", ["satisfied", "violated"])).toBe("violated");
    expect(derive("all", ["infeasible", "open"])).toBe("infeasible");
    expect(derive("all", ["violated", "infeasible"])).toBe("violated");
    expect(derive("all", ["satisfied", "retired"])).toBe("satisfied");
    expect(derive("all", ["retired"])).toBe("open");
    expect(derive("all", [])).toBe("open");
  });
  it("derives 'any' composition mechanically", () => {
    expect(derive("any", ["violated", "satisfied"])).toBe("satisfied");
    expect(derive("any", ["violated", "open"])).toBe("open");
    expect(derive("any", ["violated", "violated"])).toBe("violated");
    expect(derive("any", ["violated", "infeasible"])).toBe("infeasible");
    expect(derive("any", ["retired", "open"])).toBe("open");
  });
});

describe("requirementStatusCounts", () => {
  it("counts by status", () => {
    expect(requirementStatusCounts(["open", "satisfied", "satisfied", "infeasible"])).toEqual({
      open: 1, satisfied: 2, violated: 0, infeasible: 1, retired: 0,
    });
  });
});

// Regressions from the pre-merge adversarial review.
describe("review regressions", () => {
  it("case variants of the id and the any-of marker amend the id — never a silent new node", () => {
    // '- r3 (ANY OF): …' minting a NEW node would retire r3 (and its status
    // history) at the next approval, on a pure case retype.
    const flat = flattenRequirementGraph(mustParse("## Requirements\n- R3 (ANY OF): Config is loadable\n"));
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ id: "r3", composition: "any", statement: "Config is loadable" });
  });

  it("preamble blank runs collapse at parse, keeping renderCommitted a fixed point", () => {
    const graph = mustParse("## Context\npara1\n\n\npara2\n\n## Requirements\n- r1: x\n");
    expect(graph.preamble[0]?.body).toBe("para1\n\npara2");
    expect(mustParse(renderCommitted(graph))).toEqual(graph);
  });
});

// The (verify: …) marker: declared verification expectations in the committed
// grammar. Same paren slot as (any of); canonical order (any of) then
// (verify: …); parser accepts either order and case variants; unknown or
// duplicate markers after a valid id are LINE ERRORS (the silent-remint
// hazard: "- r4 (any off): x" must never quietly mint a fresh node).
describe("(verify:) markers", () => {
  const CANONICAL_VERIFY = `## Requirements
- r1: The CLI parses every documented flag
  - r2 (verify: independent): \`--help\` output matches the documented flags
  - r3 (any of) (verify: operator): Config is loadable
    - r4: TOML config parses
- r5: \`npm run verify\` passes
`;

  it("parses expectations and keeps the canonical form a fixed point", () => {
    const graph = mustParse(CANONICAL_VERIFY);
    const flat = flattenRequirementGraph(graph);
    expect(flat.find((row) => row.id === "r2")?.verifyExpectation).toBe("independent");
    expect(flat.find((row) => row.id === "r3")).toMatchObject({ composition: "any", verifyExpectation: "operator" });
    expect(flat.find((row) => row.id === "r4")?.verifyExpectation).toBeNull();
    expect(renderCommitted(graph)).toBe(CANONICAL_VERIFY);
    expect(mustParse(renderCommitted(graph))).toEqual(graph);
  });

  it("normalizes marker order and case to the canonical form", () => {
    const messy = `## Requirements
- r1 (VERIFY: Independent) (Any Of): Config is loadable
`;
    const graph = mustParse(messy);
    expect(flattenRequirementGraph(graph)[0]).toMatchObject({ id: "r1", composition: "any", verifyExpectation: "independent" });
    expect(renderCommitted(graph)).toContain("- r1 (any of) (verify: independent): Config is loadable");
    expect(mustParse(renderCommitted(graph))).toEqual(graph);
  });

  it("rejects unknown and duplicate markers after a valid id, with line numbers", () => {
    const unknown = parseRequirementsDocument("## Requirements\n- r4 (any off): x\n");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors[0]).toMatchObject({ line: 2 });
    if (!unknown.ok) expect(unknown.errors[0]?.message).toContain('unknown marker "(any off)"');
    const badValue = parseRequirementsDocument("## Requirements\n- r4 (verify: peer): x\n");
    expect(badValue.ok).toBe(false);
    const duplicate = parseRequirementsDocument("## Requirements\n- r4 (verify: independent) (verify: operator): x\n");
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errors[0]?.message).toContain("duplicate (verify: …) marker");
  });

  it("id-less lines take leading markers; unrecognized parens stay statements", () => {
    const graph = mustParse("## Requirements\n- (any of) (verify: independent) A config source loads\n- (draft) figure out X\n");
    const [first, second] = graph.nodes;
    expect(first).toMatchObject({ id: null, composition: "any", verifyExpectation: "independent", statement: "A config source loads" });
    expect(second).toMatchObject({ id: null, composition: "all", verifyExpectation: null, statement: "(draft) figure out X" });
    expect(mustParse(renderCommitted(graph))).toEqual(graph);
  });

  it("renders the expectation marker and the needs-verification chip in the status outline", () => {
    const graph = mustParse(CANONICAL_VERIFY);
    const outline = renderStatusOutline(graph, (id) =>
      id === "r2"
        ? { status: "satisfied", verifiedBy: "self", evidenceCount: 1, verifyGap: "independent" }
        : { status: "open" });
    expect(outline).toContain("- [✓] r2 (verify: independent): `--help` output matches the documented flags — satisfied, self, 1 evidence, needs independent verification");
    expect(outline).toContain("- [·] r3 (any of) (verify: operator): Config is loadable");
  });
});
