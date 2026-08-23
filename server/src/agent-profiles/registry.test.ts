import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileRegistry, ProfileSchema } from "./registry.ts";
import { openDb } from "../db/client.ts";
import { ArtifactStore } from "../events/artifact-store.ts";
import { EventBus } from "../events/bus.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("AgentProfileRegistry", () => {

  it("discovers workspace plugin bundles and trusts only an exact revision", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-workspace-")); dirs.push(workspace);
    const root = path.join(workspace, ".agentique", "agents", "schema-reviewer");
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    const manifest = { id: "schema-reviewer", title: "Schema reviewer", purpose: "Review schemas", instructions: "Review only.", tools: ["Read"], skills: ["schema-review"], permissionMode: "default", sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false } };
    fs.writeFileSync(path.join(root, "agentique.profile.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "schema-reviewer", version: "0.1.0" }));
    const { db } = openDb(":memory:"); const bus = new EventBus(db, new ArtifactStore(db));
    const registry = new AgentProfileRegistry({ getWorkspaceRoot: () => workspace, db, bus });
    const [profile] = registry.summaries("ws_1").filter((entry) => entry.source === "workspace");
    expect(profile).toMatchObject({ id: "schema-reviewer", valid: true, trusted: false });
    registry.trust("ws_1", profile!.id, profile!.revision);
    expect(registry.get(profile!.id, "ws_1").skills).toEqual(["schema-review"]);
    fs.writeFileSync(path.join(root, "agentique.profile.json"), JSON.stringify({ ...manifest, instructions: "Changed." }));
    expect(() => registry.get(profile!.id, "ws_1")).toThrow(/not trusted/);
  });
});

function makeRegistry() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-workspace-")); dirs.push(workspace);
  const { db } = openDb(":memory:"); const bus = new EventBus(db, new ArtifactStore(db));
  const registry = new AgentProfileRegistry({ getWorkspaceRoot: () => workspace, db, bus });
  const write = (relPath: string, content: string) => {
    const absolute = path.join(workspace, relPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };
  return { workspace, registry, write };
}

const NATIVE = `---
name: db-reviewer
description: Reviews SQLite schema and migrations
tools: Read, Grep, Bash
agentique:
  role: reviewer
  exemptFromOwnership: true
  assignmentTurnBudget: 25
---
Review only. Run focused tests and report concrete defects.
`;

describe("native .claude/agents definitions", () => {
  it("discovers a native file, resolves the overlay, and trusts the source revision", () => {
    const { registry, write } = makeRegistry();
    write(".claude/agents/db-reviewer.md", NATIVE);
    const [summary] = registry.summaries("ws_1").filter((entry) => entry.source === "workspace");
    expect(summary).toMatchObject({ id: "db-reviewer", claudeValid: true, agentiqueCompatible: true, trusted: false, incompatibilityReasons: [] });
    registry.trust("ws_1", "db-reviewer", summary!.revision);
    const profile = registry.get("db-reviewer", "ws_1");
    expect(profile).toMatchObject({ purpose: "Reviews SQLite schema and migrations", role: "reviewer", exemptFromOwnership: true, maxTurns: 25, source: "workspace" });
    expect(profile.tools).toEqual(["Read", "Grep", "Bash"]);
    expect(profile.instructions).toContain("Review only.");
    expect(profile.pluginPath).toBeUndefined();
  });

  it("a valid native definition with an unsupported feature is compatible=false, NEVER invalid — and trust-ineligible", () => {
    const { registry, write } = makeRegistry();
    write(".claude/agents/preloader.md", "---\nname: preloader\ndescription: d\nskills: [pdf]\n---\nbody\n");
    const [summary] = registry.summaries("ws_1").filter((entry) => entry.source === "workspace");
    expect(summary).toMatchObject({ id: "preloader", claudeValid: true, valid: true, agentiqueCompatible: false });
    expect(summary!.incompatibilityReasons.join(" ")).toContain("agentique.recommendedSkills");
    expect(() => registry.trust("ws_1", "preloader", summary!.revision)).toThrow(/not Agentique-compatible/);
  });

  it("malformed YAML is not Claude-valid", () => {
    const { registry, write } = makeRegistry();
    write(".claude/agents/broken.md", "---\nname: [unclosed\n---\nbody\n");
    const [summary] = registry.summaries("ws_1").filter((entry) => entry.source === "workspace");
    expect(summary).toMatchObject({ claudeValid: false, valid: false, agentiqueCompatible: false });
  });

  it("an edit invalidates trust; a rename or move is a new source revision even with identical content", () => {
    const { registry, write, workspace } = makeRegistry();
    write(".claude/agents/db-reviewer.md", NATIVE);
    const before = registry.summaries("ws_1").find((entry) => entry.source === "workspace")!;
    registry.trust("ws_1", "db-reviewer", before.revision);
    expect(() => registry.get("db-reviewer", "ws_1")).not.toThrow();
    // Edit → new revision → untrusted until re-approved.
    write(".claude/agents/db-reviewer.md", NATIVE.replace("Review only.", "Review carefully."));
    expect(() => registry.get("db-reviewer", "ws_1")).toThrow(/not trusted/);
    // Restore content but MOVE the file: the path is part of the semantic
    // source identity, so trust does not follow.
    write(".claude/agents/db-reviewer.md", NATIVE);
    registry.trust("ws_1", "db-reviewer", registry.summaries("ws_1").find((e) => e.source === "workspace")!.revision);
    fs.mkdirSync(path.join(workspace, ".claude", "agents", "review"), { recursive: true });
    fs.renameSync(path.join(workspace, ".claude", "agents", "db-reviewer.md"), path.join(workspace, ".claude", "agents", "review", "db-reviewer.md"));
    expect(() => registry.get("db-reviewer", "ws_1")).toThrow(/not trusted/);
  });

  it("a higher-precedence same-name definition never inherits trust; the shadowed source says so", () => {
    const { registry, write } = makeRegistry();
    write(".claude/agents/nested/db-reviewer.md", NATIVE);
    const original = registry.summaries("ws_1").find((entry) => entry.source === "workspace")!;
    registry.trust("ws_1", "db-reviewer", original.revision);
    expect(() => registry.get("db-reviewer", "ws_1")).not.toThrow();
    // A shallower file claims the same native name: it is selected by
    // mirrored precedence and is UNTRUSTED — a different source revision.
    write(".claude/agents/db-reviewer.md", NATIVE.replace("Review only.", "I am the impostor."));
    const summaries = registry.summaries("ws_1").filter((entry) => entry.source === "workspace");
    const selected = summaries.find((entry) => entry.agentiqueCompatible);
    const shadowed = summaries.find((entry) => !entry.agentiqueCompatible);
    expect(selected?.trusted).toBe(false);
    expect(shadowed?.incompatibilityReasons.join(" ")).toContain("shadowed by");
    expect(() => registry.get("db-reviewer", "ws_1")).toThrow(/not trusted/);
  });

  it("a native name colliding with a built-in is shadowed by the built-in", () => {
    const { registry, write } = makeRegistry();
    write(".claude/agents/reviewer.md", NATIVE.replace("db-reviewer", "reviewer"));
    const entry = registry.summaries("ws_1").find((s) => s.source === "workspace" && s.id === "reviewer")!;
    expect(entry.agentiqueCompatible).toBe(false);
    expect(entry.incompatibilityReasons.join(" ")).toContain("built-in");
    expect(registry.get("reviewer", "ws_1").source).toBeUndefined(); // the built-in itself
  });

  it("an overlay sidecar replaces the frontmatter overlay and joins the trust hash", () => {
    const { registry, write } = makeRegistry();
    write(".claude/agents/plain.md", "---\nname: plain\ndescription: d\ntools: Read\n---\nbody\n");
    write(".agentique/agents/plain.overlay.json", JSON.stringify({ role: "explorer", assignmentTurnBudget: 10 }));
    const summary = registry.summaries("ws_1").find((entry) => entry.source === "workspace")!;
    registry.trust("ws_1", "plain", summary.revision);
    expect(registry.get("plain", "ws_1")).toMatchObject({ role: "explorer", maxTurns: 10 });
    // Editing ONLY the sidecar invalidates trust too.
    write(".agentique/agents/plain.overlay.json", JSON.stringify({ role: "explorer", assignmentTurnBudget: 11 }));
    expect(() => registry.get("plain", "ws_1")).toThrow(/not trusted/);
  });

  it("a ref MCP declaration resolves against the workspace .mcp.json or the profile is incompatible", () => {
    const { registry, write } = makeRegistry();
    write(".claude/agents/reffy.md", "---\nname: reffy\ndescription: d\nmcpServers: [github]\n---\nbody\n");
    // Unresolvable: the workspace configures no such server.
    let summary = registry.summaries("ws_1").find((entry) => entry.source === "workspace")!;
    expect(summary.agentiqueCompatible).toBe(false);
    expect(summary.incompatibilityReasons.join(" ")).toContain(".mcp.json");
    // The workspace's native MCP config declares it: resolvable, compatible,
    // and the console launches NOTHING for it (grant-only — see composer).
    write(".mcp.json", JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));
    summary = registry.summaries("ws_1").find((entry) => entry.source === "workspace")!;
    expect(summary.agentiqueCompatible).toBe(true);
    registry.trust("ws_1", "reffy", summary.revision);
    expect(registry.get("reffy", "ws_1").mcpServers).toEqual({ github: { transport: "ref" } });
  });

  it("nested files are discovered; a legacy bundle with the same id is shadowed by the native source", () => {
    const { registry, write } = makeRegistry();
    write(".claude/agents/team/db-reviewer.md", NATIVE);
    const legacyRoot = ".agentique/agents/db-reviewer";
    write(`${legacyRoot}/agentique.profile.json`, JSON.stringify({ id: "db-reviewer", title: "Legacy", purpose: "p", instructions: "x", tools: ["Read"], permissionMode: "default" }));
    const summaries = registry.summaries("ws_1").filter((entry) => entry.source === "workspace" && entry.id === "db-reviewer");
    expect(summaries).toHaveLength(2);
    const shadowed = summaries.find((entry) => !entry.agentiqueCompatible);
    expect(shadowed?.incompatibilityReasons.join(" ")).toContain("shadowed");
    registry.trust("ws_1", "db-reviewer", summaries.find((entry) => entry.agentiqueCompatible)!.revision);
    expect(registry.get("db-reviewer", "ws_1").purpose).toContain("SQLite");
  });
});

describe("role archetypes", () => {
  it("every builtin carries one of the five archetypes; planner is seated among them", () => {
    const registry = new AgentProfileRegistry();
    const roles = Object.fromEntries(registry.list().map((profile) => [profile.id, profile.role]));
    expect(roles).toMatchObject({
      coordinator: "orchestrator",
      planner: "planner",
      explorer: "explorer",
      researcher: "explorer",
      implementer: "implementer",
      "frontend-implementer": "implementer",
      reviewer: "reviewer",
      "visual-reviewer": "reviewer",
    });
    const planner = registry.get("planner");
    expect(planner.tools).not.toContain("Edit");
    expect(planner.tools).not.toContain("Write");
    expect(planner.handoffExtension).toBe("coordination");
  });

  it("a pre-archetype manifest without a role still parses, summarized as role null", () => {
    const parsed = ProfileSchema.safeParse({
      id: "legacy", title: "Legacy", purpose: "p", instructions: "x",
      tools: ["Read"], permissionMode: "default",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.role).toBeUndefined();
    const registry = new AgentProfileRegistry();
    expect(registry.list().find((profile) => profile.id === "planner")?.role).toBe("planner");
  });
});
