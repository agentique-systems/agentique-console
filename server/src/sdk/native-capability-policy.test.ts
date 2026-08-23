/**
 * The SDK-upgrade tripwire and the intersection-semantics contracts.
 *
 * The tripwire enumerates the installed SDK's native tool surface from the
 * `ToolInputSchemas` union in sdk-tools.d.ts — type NAMES only, never line
 * shapes — and fails when a name appears that the policy has not classified.
 * The parser is intentionally version-coupled to the pinned SDK's generated
 * declaration file; if the shape changes, update the extractor AND classify
 * whatever new tools arrived.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_WAIT_TOOLS, DENIED_COORDINATION, DENIED_HOST_SURFACE, DENIED_HUMAN_SURFACE,
  DENIED_SCHEDULING, DENIED_TASK_STATE, DISCOVERY_TOOLS, KNOWN_META_TOOLS,
  NATIVE_TOOL_SURFACE, SCHEMA_NAME_ALIASES, WORKSPACE_TOOLS, WORKTREE_TOOLS,
  effectiveNativeTools, mainDisallowedNativeTools, nativeToolCeiling,
  policyAllowedNativeTools, seatDisallowedNativeTools,
} from "./native-capability-policy.ts";

/** Union member names of `ToolInputSchemas`, mapped to tool names. */
function installedToolSurface(): string[] {
  const require = createRequire(import.meta.url);
  const declarations = readFileSync(
    path.join(path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "sdk-tools.d.ts"),
    "utf8",
  );
  const union = /export type ToolInputSchemas =([\s\S]*?);/.exec(declarations)?.[1];
  if (!union) throw new Error("sdk-tools.d.ts no longer declares ToolInputSchemas — update the tripwire extractor AND re-audit the surface");
  const names = [...union.matchAll(/\|\s*([A-Za-z0-9]+)Input\b/g)].map((match) => match[1]!);
  if (names.length < 20) throw new Error(`suspiciously small surface (${names.length}) — the extractor no longer matches the declaration shape`);
  return names
    .filter((name) => name !== "ToolOutputSchemas")
    .map((name) => (name in SCHEMA_NAME_ALIASES ? SCHEMA_NAME_ALIASES[name] : name))
    .filter((name): name is string => name !== null);
}

describe("SDK-upgrade tripwire", () => {
  it("every native tool of the installed SDK is classified exactly once", () => {
    const installed = installedToolSurface();
    const unclassified = installed.filter((name) => !NATIVE_TOOL_SURFACE.has(name));
    expect(unclassified, `SDK tool surface changed — classify in native-capability-policy.ts: ${unclassified.join(", ")}`).toEqual([]);

    const categories = [
      WORKSPACE_TOOLS, DISCOVERY_TOOLS, BACKGROUND_WAIT_TOOLS, WORKTREE_TOOLS,
      DENIED_COORDINATION, DENIED_TASK_STATE, DENIED_SCHEDULING, DENIED_HUMAN_SURFACE, DENIED_HOST_SURFACE,
    ];
    const seen = new Map<string, number>();
    for (const category of categories) for (const name of category) seen.set(name, (seen.get(name) ?? 0) + 1);
    const duplicated = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
    expect(duplicated, "a tool may live in exactly one category").toEqual([]);

    // Every classified name is either in the installed union or a documented
    // meta tool — a rename (Task→Agent style) lands here, not in silence.
    const installedSet = new Set(installed);
    const phantom = [...NATIVE_TOOL_SURFACE].filter((name) => !installedSet.has(name) && !KNOWN_META_TOOLS.has(name));
    expect(phantom, "classified but neither installed nor a documented meta tool").toEqual([]);
  });

  it("fails on a simulated new tool", () => {
    // The extractor feeds NATIVE_TOOL_SURFACE membership checks; a name the
    // policy has never seen must surface, not vanish.
    const simulated = [...installedToolSurface(), "BrandNewNativeThing"];
    expect(simulated.filter((name) => !NATIVE_TOOL_SURFACE.has(name))).toEqual(["BrandNewNativeThing"]);
  });
});

describe("native tool ceiling", () => {
  it("omitted tools means inherit — never an empty or predefined list", () => {
    expect(nativeToolCeiling({ disallowedTools: [] })).toBe("inherit");
    const effective = effectiveNativeTools({ disallowedTools: [] }, "seat");
    expect(effective).toEqual(policyAllowedNativeTools("seat"));
  });

  it("an explicit tools list is the ceiling across the whole surface — meta tools included", () => {
    const effective = effectiveNativeTools({ tools: ["Read", "Grep"], disallowedTools: [] }, "seat");
    expect([...effective].sort()).toEqual(["Grep", "Read"]);
    const denied = seatDisallowedNativeTools(effective);
    for (const name of ["Bash", "Edit", "Skill", "ToolSearch", "Monitor", "EnterWorktree", "AskUserQuestion", "Workflow", "TodoWrite", "ScheduleWakeup"]) {
      expect(denied, `${name} must be denied by name`).toContain(name);
    }
  });

  it("the author's disallowedTools bind under inheritance too", () => {
    const effective = effectiveNativeTools({ disallowedTools: ["WebFetch"] }, "seat");
    expect(effective.has("WebFetch")).toBe(false);
    expect(effective.has("WebSearch")).toBe(true);
    expect(seatDisallowedNativeTools(effective)).toContain("WebFetch");
  });

  it("policy denials survive an author who grants a denied tool", () => {
    const effective = effectiveNativeTools({ tools: ["Read", "Agent", "TodoWrite"], disallowedTools: [] }, "seat");
    expect([...effective]).toEqual(["Read"]);
  });

  it("main's policy keeps the canUseTool-intercepted pair out of BOTH lists", () => {
    const denied = mainDisallowedNativeTools();
    expect(denied).toContain("EnterPlanMode");
    expect(denied).toContain("Monitor");
    expect(denied).toContain("Workflow");
    expect(denied).toContain("TodoWrite");
    expect(denied).not.toContain("AskUserQuestion");
    expect(denied).not.toContain("ExitPlanMode");
  });
});
