import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { Repo } from "../db/repo.ts";
import { WorkspaceStore } from "../db/stores/workspace-store.ts";
import { workspaces } from "../db/schema.ts";
import { ArtifactStore } from "../events/artifact-store.ts";
import { EventBus } from "../events/bus.ts";
import { nowIso } from "../ids.ts";
import { loadConfig } from "../config.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import type { OrchestratorRunner } from "../orchestrator/runner.ts";
import { AgentProfileRegistry } from "./registry.ts";
import { ProfileManagerService } from "./manager.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("ProfileManagerService", () => {
  it("stages, atomically applies, and leaves a new revision disabled", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-manager-workspace-")); dirs.push(workspaceRoot);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-manager-data-")); dirs.push(dataDir);
    const { db, sqlite } = openDb(":memory:"); const bus = new EventBus(db, new ArtifactStore(db)); const repo = new Repo(db, sqlite); const now = nowIso();
    db.insert(workspaces).values({ id: "ws_1", name: "test", rootPath: workspaceRoot, metadata: {}, createdAt: now, updatedAt: now }).run();
    const workspaceService = new WorkspaceService(new WorkspaceStore(db), bus, [workspaceRoot]);
    const profiles = new AgentProfileRegistry({ getWorkspaceRoot: () => workspaceRoot, db, bus });
    const config = loadConfig({ CONSOLE_DATA_DIR: dataDir });
    const manager = new ProfileManagerService({ repo, workspaces: workspaceService, profiles, config, bus, runner: () => ({} as OrchestratorRunner) });
    const session = manager.create("ws_1");
    manager.stageFile(session.id, "agentique.profile.json", JSON.stringify({ id: "api-reviewer", title: "API reviewer", purpose: "Review API changes", instructions: "Review only.", tools: ["Read"], permissionMode: "default", sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false } }));
    manager.stageFile(session.id, ".claude-plugin/plugin.json", JSON.stringify({ name: "api-reviewer", version: "0.1.0" }));
    expect(manager.proposal(session.id)).toMatchObject({ profileId: "api-reviewer", valid: true, baseRevision: null });
    repo.patchUserSession(session.id, { phase: "executing" });
    const applied = manager.apply(session.id);
    expect(fs.existsSync(path.join(workspaceRoot, ".agentique", "agents", "api-reviewer", "agentique.profile.json"))).toBe(true);
    expect(profiles.detail("ws_1", "api-reviewer")).toMatchObject({ revision: applied.revision, trusted: false });
    expect(() => profiles.get("api-reviewer", "ws_1")).toThrow(/not trusted/);
    profiles.trust("ws_1", "api-reviewer", applied.revision);
    expect(profiles.get("api-reviewer", "ws_1").title).toBe("API reviewer");
  });
});
