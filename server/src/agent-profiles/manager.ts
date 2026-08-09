import fs from "node:fs";
import path from "node:path";
import type { AgentProfileDetail, ManagerSession, ProfileProposal } from "@agentique-console/shared";
import type { Config } from "../config.ts";
import type { Repo, UserSessionRow } from "../db/repo.ts";
import type { WorkspaceService } from "../workspaces/service.ts";
import type { AgentProfileRegistry } from "./registry.ts";
import { ProfileSchema } from "./registry.ts";
import { newId, nowIso } from "../ids.ts";
import type { OrchestratorRunner } from "../orchestrator/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { badRequest, conflict, notFound } from "../api/errors.ts";

export class ManagerService {
  constructor(private readonly deps: { repo: Repo; workspaces: WorkspaceService; profiles: AgentProfileRegistry; config: Config; bus: EventBus; runner: () => OrchestratorRunner }) {}

  create(workspaceId: string, input: { profileId?: string; sourceProfileId?: string } = {}): ManagerSession {
    this.deps.workspaces.get(workspaceId);
    const profileKey = input.profileId ?? `draft:${newId("task")}`;
    const existing = this.deps.repo.findManagerSession(workspaceId, profileKey);
    if (existing) return this.#wire(existing);
    const selected = input.profileId ? this.deps.profiles.detail(workspaceId, input.profileId) : undefined;
    const now = nowIso();
    const row: UserSessionRow = { id: newId("us"), workspaceId, title: input.profileId ? `Manager · ${input.profileId}` : "Manager · new profile",
      mode: "plan_execute", phase: "planning", status: "open", purpose: "profile_manager", subjectKey: profileKey,
      sdkSessionId: null, sdkGeneration: 0, sdkTurnCount: 0, contextTokens: 0,
      memory: selected ? this.#profileContext(selected) : "",
      latestHandoffId: null, cumulativeCostUsd: 0, cumulativeApiDurationMs: 0, runState: "active" as const, runBaseCommit: null, createdAt: now, updatedAt: now };
    this.deps.repo.insertUserSession(row);
    if (input.sourceProfileId) this.#seed(row.id, workspaceId, input.sourceProfileId);
    else if (selected?.source === "workspace") for (const file of selected.files) this.stageFile(row.id, file.path, file.content);
    return this.#wire(row);
  }

  list(workspaceId: string): ManagerSession[] { return this.deps.repo.listManagerSessions(workspaceId).map((row) => this.#wire(row)); }
  get(id: string): ManagerSession { const row = this.#row(id); return this.#wire(row); }
  postMessage(id: string, text: string) { const row = this.#row(id); if (row.phase === "executing") {
    this.deps.repo.patchUserSession(id, { phase: "planning" });
    this.deps.bus.append({ type: "user_session.updated", userSessionId: id, payload: { sessionId: id, patch: { phase: "planning" } } });
    this.deps.runner().recycleSession(id);
  } return this.deps.runner().postOperatorMessage(id, text); }

  stageFile(id: string, relativePath: string, content: string): ProfileProposal {
    this.#row(id); const safe = this.#safeRelative(relativePath); const root = this.#draftRoot(id); fs.mkdirSync(path.dirname(path.join(root, safe)), { recursive: true });
    fs.writeFileSync(path.join(root, safe), content, "utf8"); return this.proposal(id)!;
  }
  deleteFile(id: string, relativePath: string): ProfileProposal { this.#row(id); const target = path.join(this.#draftRoot(id), this.#safeRelative(relativePath)); if (fs.existsSync(target)) fs.unlinkSync(target); return this.proposal(id)!; }

  proposal(id: string): ProfileProposal | null {
    const row = this.#row(id); const root = this.#draftRoot(id); if (!fs.existsSync(root)) return null;
    const staged = this.#files(root); const manifest = staged.find((file) => file.path === "agentique.profile.json");
    let profileId: string | null = null; const issues: ProfileProposal["issues"] = [];
    if (!manifest) issues.push({ level: "error", path: "agentique.profile.json", message: "missing profile manifest" });
    else { try { const parsed = ProfileSchema.safeParse(JSON.parse(manifest.content)); if (!parsed.success) issues.push({ level: "error", path: manifest.path, message: parsed.error.message }); else profileId = parsed.data.id; } catch (error) { issues.push({ level: "error", path: manifest.path, message: error instanceof Error ? error.message : String(error) }); } }
    if (profileId && this.deps.profiles.detail(row.workspaceId, profileId)?.source === "builtin") issues.push({ level: "error", path: "agentique.profile.json", message: "built-in profiles are immutable; clone it to a new id" });
    if (!staged.some((file) => file.path === ".claude-plugin/plugin.json")) issues.push({ level: "warning", path: ".claude-plugin/plugin.json", message: "Claude plugin manifest is recommended" });
    const current = profileId ? this.deps.profiles.detail(row.workspaceId, profileId) : undefined;
    const before = new Map((current?.files ?? []).map((file) => [file.path, file.content])); const after = new Map(staged.map((file) => [file.path, file.content]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    return { managerSessionId: id, baseRevision: this.#baseRevision(row), profileId,
      files: paths.filter((file) => before.get(file) !== after.get(file)).map((file) => ({ path: file, before: before.get(file) ?? null, after: after.get(file) ?? null })),
      issues, valid: profileId !== null && issues.every((issue) => issue.level !== "error") };
  }

  apply(id: string): { profileId: string; revision: string } {
    const row = this.#row(id); if (row.phase !== "executing") throw conflict("approve the Manager plan before applying profile files");
    const proposal = this.proposal(id); if (!proposal?.valid || !proposal.profileId) throw badRequest("profile proposal is not valid");
    const current = this.deps.profiles.detail(row.workspaceId, proposal.profileId);
    if ((current?.source === "workspace" ? current.revision : null) !== proposal.baseRevision) throw conflict("profile changed after this proposal was staged");
    const target = this.deps.profiles.profileRoot(row.workspaceId, proposal.profileId); const parent = path.dirname(target); fs.mkdirSync(parent, { recursive: true });
    const temp = path.join(parent, `.${proposal.profileId}.apply-${newId("artifact")}`); fs.cpSync(this.#draftRoot(id), temp, { recursive: true });
    const backup = `${target}.backup-${Date.now()}`;
    try { if (fs.existsSync(target)) fs.renameSync(target, backup); fs.renameSync(temp, target); if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true }); }
    catch (error) { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true }); if (fs.existsSync(backup)) fs.renameSync(backup, target); if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true }); throw error; }
    const detail = this.deps.profiles.detail(row.workspaceId, proposal.profileId); if (!detail?.valid) throw badRequest("applied profile failed validation");
    this.deps.repo.patchUserSession(id, { subjectKey: proposal.profileId, phase: "planning", title: `Manager · ${proposal.profileId}`, memory: this.#profileContext(detail) });
    this.deps.bus.append({ type: "agent_profile.changed", workspaceId: row.workspaceId, payload: { workspaceId: row.workspaceId, profileId: proposal.profileId, revision: detail.revision, trusted: false } });
    return { profileId: proposal.profileId, revision: detail.revision };
  }

  #seed(id: string, workspaceId: string, sourceId: string): void {
    const detail = this.deps.profiles.detail(workspaceId, sourceId); if (!detail) return;
    const targetId = `${sourceId}-copy`; const manifest = { id: targetId, title: `${detail.title} copy`, purpose: detail.purpose, instructions: detail.instructions,
      tools: detail.tools, skills: detail.skills, permissionMode: detail.permissionMode, ...(detail.model ? { model: detail.model } : {}), ...(detail.effort ? { effort: detail.effort } : {}),
      maxTurns: detail.maxTurns, sandboxRequired: detail.sandboxRequired, runtime: detail.runtime, ...(detail.handoffExtension ? { handoffExtension: detail.handoffExtension } : {}) };
    this.stageFile(id, "agentique.profile.json", JSON.stringify(manifest, null, 2));
    this.stageFile(id, ".claude-plugin/plugin.json", JSON.stringify({ name: targetId, description: detail.purpose, version: "0.1.0" }, null, 2));
  }
  #row(id: string): UserSessionRow { const row = this.deps.repo.getUserSession(id); if (!row || row.purpose !== "profile_manager") throw notFound(`no manager session ${id}`); return row; }
  #baseRevision(row: UserSessionRow): string | null { try { const parsed = JSON.parse(row.memory) as { selectedProfile?: { source?: string; revision?: string } }; return parsed.selectedProfile?.source === "workspace" ? parsed.selectedProfile.revision ?? null : null; } catch { return null; } }
  #profileContext(detail: AgentProfileDetail): string { return JSON.stringify({ selectedProfile: { id: detail.id, title: detail.title, purpose: detail.purpose, source: detail.source, revision: detail.revision, trusted: detail.trusted, instructions: detail.instructions, tools: detail.tools, skills: detail.skills, runtime: detail.runtime, components: detail.components } }, null, 2); }
  #wire(row: UserSessionRow): ManagerSession { const key = row.subjectKey ?? `draft:${row.id}`; return { id: row.id, workspaceId: row.workspaceId, profileKey: key, profileId: key.startsWith("draft:") ? null : key, title: row.title ?? "Manager", phase: row.phase, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt }; }
  #draftRoot(id: string): string { return path.join(this.deps.config.dataDir, "manager-drafts", id); }
  #safeRelative(value: string): string { const normalized = path.posix.normalize(value.replaceAll("\\", "/")); if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || normalized === "..") throw badRequest("profile path escapes the bundle"); return normalized; }
  #files(root: string): { path: string; content: string }[] { const out: { path: string; content: string }[] = []; const visit = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const absolute = path.join(dir, entry.name); if (entry.isDirectory()) visit(absolute); else if (entry.isFile()) out.push({ path: path.relative(root, absolute), content: fs.readFileSync(absolute, "utf8") }); } }; visit(root); return out.sort((a, b) => a.path.localeCompare(b.path)); }
}
