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
