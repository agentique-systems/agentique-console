/**
 * The native tool classification and the SDK-upgrade tripwire: every native
 * tool of the installed SDK is either a capability's tool or denied by name,
 * exactly once; the mapping between the console's capability names and the
 * native tools is total in both directions; nothing is exposed that a
 * capability set does not grant.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALWAYS_DENIED_NATIVE_TOOLS, CAPABILITY_NATIVE_TOOLS, CAPABILITY_TOOL_SURFACE, capabilityToolOf, DENIED_BACKGROUND, DENIED_COORDINATION, DENIED_DISCOVERY, DENIED_HOST_SURFACE, DENIED_HUMAN_SURFACE, DENIED_SCHEDULING, DENIED_TASK_STATE, DENIED_WORKTREES, disallowedNativeTools, KNOWN_META_TOOLS, mcpServerOf, NATIVE_TOOL_SURFACE, nativeExposureOf, SCHEMA_NAME_ALIASES } from "./native-tools.ts";

/** Union member names of the installed SDK's `ToolInputSchemas`, mapped to tool names. */
function installedToolSurface(): string[] {
  const require = createRequire(import.meta.url);
  const declarations = readFileSync(path.join(path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "sdk-tools.d.ts"), "utf8");
  const union = /export type ToolInputSchemas =([\s\S]*?);/.exec(declarations)?.[1];
  if (!union) throw new Error("sdk-tools.d.ts no longer declares ToolInputSchemas: update the extractor and re-audit the surface");
  const names = [...union.matchAll(/\|\s*([A-Za-z0-9]+)Input\b/g)].map((match) => match[1]!);
  if (names.length < 20) throw new Error(`suspiciously small surface (${names.length}): the extractor no longer matches the declaration`);
  return names
    .filter((name) => name !== "ToolOutputSchemas")
    .map((name) => (name in SCHEMA_NAME_ALIASES ? SCHEMA_NAME_ALIASES[name] : name))
    .filter((name): name is string => name !== null);
}

describe("native tool surface", () => {
  it("classifies every native tool of the installed SDK exactly once, and names nothing the SDK does not ship except documented meta tools", () => {
    const installed = installedToolSurface();
    const surface = new Set(NATIVE_TOOL_SURFACE);
    expect(installed.filter((name) => !surface.has(name)), "unclassified native tools: classify them in native-tools.ts").toEqual([]);
    const seen = new Map<string, number>();
    for (const name of NATIVE_TOOL_SURFACE) seen.set(name, (seen.get(name) ?? 0) + 1);
    expect([...seen].filter(([, count]) => count > 1).map(([name]) => name)).toEqual([]);
    const installedSet = new Set(installed);
    expect(NATIVE_TOOL_SURFACE.filter((name) => !installedSet.has(name) && !KNOWN_META_TOOLS.has(name))).toEqual([]);
    for (const category of [DENIED_COORDINATION, DENIED_TASK_STATE, DENIED_SCHEDULING, DENIED_HUMAN_SURFACE, DENIED_HOST_SURFACE, DENIED_WORKTREES, DENIED_BACKGROUND, DENIED_DISCOVERY]) {
      for (const name of category) expect(ALWAYS_DENIED_NATIVE_TOOLS, name).toContain(name);
    }
    // No capability tool is denied and no denied tool is a capability tool.
    expect(CAPABILITY_TOOL_SURFACE.filter((name) => ALWAYS_DENIED_NATIVE_TOOLS.includes(name))).toEqual([]);
  });

  it("fails on a simulated new native tool", () => {
    const simulated = [...installedToolSurface(), "BrandNewNativeThing"];
    const surface = new Set(NATIVE_TOOL_SURFACE);
    expect(simulated.filter((name) => !surface.has(name))).toEqual(["BrandNewNativeThing"]);
  });

  it("maps capability names to native tools and back, totally and consistently", () => {
    for (const [capability, tools] of Object.entries(CAPABILITY_NATIVE_TOOLS)) for (const tool of tools) expect(capabilityToolOf(tool), tool).toBe(capability);
    for (const denied of ALWAYS_DENIED_NATIVE_TOOLS) expect(capabilityToolOf(denied), denied).toBeNull();
    expect(capabilityToolOf("mcp__docs__search")).toBe("mcp__docs__search");
    expect(mcpServerOf("mcp__docs__search")).toBe("docs");
    expect(mcpServerOf("mcp____x")).toBeNull();
    expect(mcpServerOf("Bash")).toBeNull();
  });

  it("exposes exactly the mapped native tools of a capability set in canonical order, reports unmapped names, and denies the rest by name", () => {
    expect(nativeExposureOf(["shell", "read"])).toEqual({ tools: ["Read", "Bash"], unmapped: [] });
    expect(nativeExposureOf(["write", "frobnicate", "mcp__docs__search"])).toEqual({ tools: ["Edit", "Write", "NotebookEdit"], unmapped: ["frobnicate"] });
    expect(nativeExposureOf([])).toEqual({ tools: [], unmapped: [] });
    const denied = disallowedNativeTools(["Read", "Bash"]);
    expect(denied).not.toContain("Read");
    expect(denied).not.toContain("Bash");
    expect(denied).toEqual(NATIVE_TOOL_SURFACE.filter((t) => t !== "Read" && t !== "Bash"));
    expect(disallowedNativeTools([])).toEqual([...NATIVE_TOOL_SURFACE]);
  });
});
