import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AgentProfileDetail, AgentProfileSummary, ProfileValidationIssue } from "@agentique-console/shared";
import type { Db } from "../db/client.ts";
import { agentProfileTrust, mintedProfiles } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { nowIso } from "../ids.ts";
import { ConflictError, InvalidInputError, NotFoundError } from "../errors.ts";

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  purpose: z.string().min(1),
  instructions: z.string().min(1),
  tools: z.array(z.string()).min(1),
  permissionMode: z.enum(["default", "plan", "bypassPermissions"]),
  model: z.string().optional(),
  effort: z.string().optional(),
  handoffExtension: z.enum(["generic", "coordination", "implementation", "investigation", "review"]).optional(),
  /**
   * Exempts the profile's agents from write-ownership disjointness: a
   * read-only reviewer inspects everyone's files, so exclusive scopes do
   * not apply to it.
   */
  exemptFromOwnership: z.boolean().default(false),
  maxTurns: z.number().int().min(1).max(100).default(40),
  /**
   * MCP servers this profile's agents get, merged with the console's own.
   * This is where CAPABILITY lives: the Console owns coordination and supplies
   * nothing else. Browser automation, for instance, is a declared stdio server,
   * not a console tool — the console-built browser and process tools were
   * deleted after a live run in which `browser_evaluate` was broken 100% of the
   * time behind a green test suite, screenshots cost a round trip each to look
   * at, and one keypress per call made real verification unaffordable.
   *
   * Keys become the `mcp__<key>__*` tool prefix and are auto-approved for the
   * profile's agents. `CONSOLE_MCP_DISABLED` names servers to drop.
   */
  mcpServers: z.record(z.string(), z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  })).default({}),
  skills: z.array(z.string()).optional(),
  entryAgent: z.string().optional(),
  pluginPath: z.string().optional(),
  revision: z.string().optional(),
  source: z.enum(["builtin", "workspace"]).optional(),
});

export type AgentProfile = z.infer<typeof ProfileSchema>;

const READ_TOOLS = ["Read", "Glob", "Grep"];
const CODE_TOOLS = [...READ_TOOLS, "Edit", "Write", "Bash"];
/**
 * Every evidence-gathering profile reaches the web. A reviewer checking an API
 * against its upstream docs and an explorer tracing a dependency's behavior
 * both need the source, not a recollection of it. The write profiles are
 * deliberately excluded: their job is a bounded change, and Bash already gives
 * them the network when validation genuinely needs it.
 */
const WEB_TOOLS = ["WebSearch", "WebFetch"];

/**
 * The browser the visual profiles drive. Declared, not vendored: the Console
 * launches what the manifest names and owns none of it. Swap or disable it
 * with CONSOLE_BROWSER_MCP / CONSOLE_MCP_DISABLED — a profile that names a
 * server the host cannot start says so in a runtime notice and runs without it.
 */
const BROWSER_MCP = {
  browser: {
    command: "npx",
    args: [
      "-y", "@playwright/mcp@latest",
      // Headed is this server's DEFAULT and fails on a headless host; Chrome's
      // own sandbox fails inside a container or WSL. Both were verified by
      // driving the server over stdio, not assumed.
      "--headless", "--no-sandbox", "--isolated",
      // Without this a screenshot comes back as a file path and costs a second
      // round trip to look at — 60 of one live run's 330 requests were exactly
      // that. With it the image is in the tool result.
      "--image-responses", "allow",
      "--viewport-size", "1280x800",
    ],
  },
};

/**
 * The servers a mint may attach BY NAME. The declaration (command, args) is
 * console-owned; a mint can never supply a command — arbitrary server launch
 * stays human-only, through workspace profile bundles and the trust click.
 */
export const ATTACHABLE_MCP_SERVERS: Record<string, { command: string; args: string[] }> = {
  ...BROWSER_MCP,
};

const BUILTINS: AgentProfile[] = [
  {
    id: "coordinator",
    title: "Coordinator",
    purpose: "Own a bounded workstream, assign each unit once, integrate results, and report milestones.",
    instructions: "You are the sole coordinator for this AgentSession. You own decomposition and integration. Send assignments only to your specialists. Do not implement their work, broadcast status, or repeat unchanged information. A merge-conflict failure means reassign against the current HEAD.\n\nWrite seats work in ISOLATED worktrees. Files they create are not visible in your workspace until they report completed and the Console merges them — an `ls` that shows nothing proves nothing. Read their progress from the roster line or ask the seat; never conclude from the filesystem that a seat has done nothing.\n\nReport to main for a blocking decision, material failure, milestone, or final result — and always before you go idle. If you are unsure whether a result is worth reporting, report it: the operator can act on a partial result and cannot act on silence. Relay what your specialists actually found, including defects and anything they could not verify, rather than a summary that they finished.",
    tools: [...READ_TOOLS, ...WEB_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    skills: ["handoff-discipline"],
    handoffExtension: "coordination",
    exemptFromOwnership: false,
    maxTurns: 35,
    mcpServers: {},
  },
  {
    id: "explorer",
    title: "Explorer",
    purpose: "Trace code and runtime behavior and return concrete evidence without editing.",
    instructions: "Inspect only the assigned scope. Cite concrete files, symbols, commands, and observations. Do not edit files. Upstream documentation and sources are reachable with WebSearch and WebFetch when the repository alone cannot settle a question — read the source rather than recalling it. Return one concise findings report to your coordinator.",
    tools: [...READ_TOOLS, ...WEB_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    skills: ["handoff-discipline"],
    handoffExtension: "investigation",
    exemptFromOwnership: false,
    maxTurns: 30,
    mcpServers: {},
  },
  {
    id: "implementer",
    title: "Implementer",
    purpose: "Implement and validate a clearly owned code change.",
    instructions: "You exclusively own the assigned files or component. Inspect before editing, preserve unrelated changes, implement the smallest complete change, and run relevant validation. Report changed files, tests, and remaining risks.",
    tools: CODE_TOOLS,
    permissionMode: "bypassPermissions",
    model: "claude-opus-5",
    skills: ["long-build-discipline", "build-hygiene", "worktree-etiquette", "probe-method", "handoff-discipline"],
    handoffExtension: "implementation",
    exemptFromOwnership: false,
    maxTurns: 50,
    mcpServers: {},
  },
  {
    id: "frontend-implementer",
    title: "Frontend implementer",
    purpose: "Implement frontend behavior and validate the rendered application.",
    instructions: "Own the assigned frontend slice. Run the application, drive the real browser through your MCP browser tools, test interactions, and report concrete validation rather than visual guesses.",
    tools: CODE_TOOLS,
    permissionMode: "bypassPermissions",
    model: "claude-opus-5",
    skills: ["long-build-discipline", "build-hygiene", "worktree-etiquette", "handoff-discipline"],
    handoffExtension: "implementation",
    exemptFromOwnership: false,
    maxTurns: 50,
    mcpServers: BROWSER_MCP,
  },
  {
    id: "reviewer",
    title: "Reviewer",
    purpose: "Review a completed change and report actionable defects with evidence.",
    instructions: "Review only; do not edit. Inspect the diff, run relevant validation, and report defects by severity with file references and reproduction evidence. Say explicitly when no defect is found.",
    tools: [...READ_TOOLS, "Bash", ...WEB_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    skills: ["long-build-discipline", "worktree-etiquette", "handoff-discipline"],
    handoffExtension: "review",
    exemptFromOwnership: true,
    maxTurns: 35,
    mcpServers: {},
  },
  {
    id: "visual-reviewer",
    title: "Visual reviewer",
    purpose: "Inspect a rendered UI through browser interaction and screenshots.",
    instructions: "Review only; do not edit. Exercise the assigned user flow in the browser, capture evidence, inspect console/runtime errors, and report concrete visual or interaction defects.",
    tools: [...READ_TOOLS, "Bash", ...WEB_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    skills: ["long-build-discipline", "worktree-etiquette", "handoff-discipline"],
    handoffExtension: "review",
    exemptFromOwnership: true,
    maxTurns: 35,
    mcpServers: BROWSER_MCP,
  },
  {
    id: "researcher",
    title: "Researcher",
    purpose: "Gather focused external or repository evidence for one decision.",
    instructions: "Research only the assigned question. Reach primary sources directly with WebSearch and WebFetch and cite the URLs you actually read; a named source you could not open is not evidence. Separate facts from inference, and return a concise recommendation with evidence.",
    tools: [...READ_TOOLS, ...WEB_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    skills: ["handoff-discipline"],
    handoffExtension: "investigation",
    exemptFromOwnership: false,
    maxTurns: 30,
    mcpServers: {},
  },
];

export class AgentProfileRegistry {
  readonly #profiles: ReadonlyMap<string, AgentProfile>;
  readonly #options: { getWorkspaceRoot: (workspaceId: string) => string; db: Db; bus: EventBus } | null;

  /** Orchestrator-minted narrow-only variants; loaded from the DB at boot. */
  readonly #minted = new Map<string, AgentProfile>();

  constructor(options?: { getWorkspaceRoot: (workspaceId: string) => string; db: Db; bus: EventBus }) {
    const profiles = new Map(BUILTINS.map((profile) => [profile.id, Object.freeze(profile)]));
    this.#profiles = profiles;
    this.#options = options ?? null;
    if (options) {
      try {
        for (const row of options.db.select().from(mintedProfiles).all()) {
          const parsed = ProfileSchema.safeParse(row.profile);
          if (parsed.success) this.#minted.set(parsed.data.id, Object.freeze(parsed.data));
        }
      } catch { /* pre-migration database; mints simply start empty */ }
    }
  }

  /**
   * Mint a profile the orchestrator may seat: a NARROW-ONLY variant of a
   * trusted base. Every dimension is bounded by the base — subset tools,
   * same-or-lower permissionMode, additive instructions, catalog-name-only
   * MCP attachments — so a mint grants strictly less than the per-seat
   * instruction/model overrides the orchestrator already holds, and needs no
   * per-mint operator approval. Resolved ONCE here; seats snapshot the
   * result exactly as they snapshot any profile.
   */
  mint(input: {
    id: string; userSessionId: string; baseProfileId: string; workspaceId?: string;
    title?: string; purpose?: string; instructionsAppend?: string;
    tools?: string[]; permissionMode?: "default" | "plan" | "bypassPermissions";
    model?: string; skills?: string[]; attachServers?: string[]; maxTurns?: number; why?: string;
  }): AgentProfile {
    if (this.#minted.has(input.id) || this.#profiles.has(input.id)) {
      throw new ConflictError(`profile id "${input.id}" already exists`);
    }
    const base = this.get(input.baseProfileId, input.workspaceId);
    const tools = input.tools ?? base.tools;
    const widened = tools.filter((tool) => !base.tools.includes(tool));
    if (widened.length > 0) {
      throw new InvalidInputError(`a mint may only narrow — tools not in base "${base.id}": ${widened.join(", ")}`);
    }
    const rank: Record<AgentProfile["permissionMode"], number> = { plan: 0, default: 1, bypassPermissions: 2 };
    const permissionMode = input.permissionMode ?? base.permissionMode;
    if (rank[permissionMode] > rank[base.permissionMode]) {
      throw new InvalidInputError(`a mint may not raise permissionMode above the base's "${base.permissionMode}"`);
    }
    const attached: AgentProfile["mcpServers"] = {};
    for (const name of input.attachServers ?? []) {
      const declared = ATTACHABLE_MCP_SERVERS[name];
      if (declared === undefined) {
        throw new InvalidInputError(`"${name}" is not an attachable console-catalog MCP server (attachable: ${Object.keys(ATTACHABLE_MCP_SERVERS).join(", ")})`);
      }
      attached[name] = { command: declared.command, args: declared.args };
    }
    const profile = ProfileSchema.parse({
      ...base,
      id: input.id,
      title: input.title ?? `${base.title} (specialized)`,
      purpose: input.purpose ?? base.purpose,
      instructions: input.instructionsAppend === undefined ? base.instructions
        : `${base.instructions}\n\nSpecialization:\n${input.instructionsAppend}`,
      tools, permissionMode,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.skills === undefined ? {} : { skills: input.skills }),
      mcpServers: { ...base.mcpServers, ...attached },
      ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      revision: `mint:${input.id}`,
    });
    this.#options?.db.insert(mintedProfiles).values({
      id: profile.id, userSessionId: input.userSessionId, baseProfileId: base.id,
      baseRevision: base.revision ?? `builtin:${base.id}`,
      profile: profile as unknown as Record<string, unknown>,
      why: input.why ?? null, createdAt: nowIso(),
    }).run();
    this.#minted.set(profile.id, Object.freeze(profile));
    this.#options?.bus.append({
      type: "agent_profile.minted",
      userSessionId: input.userSessionId,
      payload: { userSessionId: input.userSessionId, profileId: profile.id, baseProfileId: base.id,
        baseRevision: base.revision ?? `builtin:${base.id}`, tools: profile.tools,
        permissionMode: profile.permissionMode, ...(input.why === undefined ? {} : { why: input.why }) },
    });
    return profile;
  }

  get(id: string, workspaceId?: string): AgentProfile {
    // Mints resolve first: validated at mint time against a then-trusted
    // base, run-scoped, never re-gated on the base's later trust state.
    const minted = this.#minted.get(id);
    if (minted) return minted;
    const profile = workspaceId === undefined ? this.#profiles.get(id) : this.#resolvedWorkspaceProfile(workspaceId, id);
    if (!profile) throw new Error(`unknown agent profile \"${id}\"`);
    if (workspaceId !== undefined && profile.source === "workspace" && !this.isTrusted(workspaceId, id, profile.revision ?? "")) {
      throw new Error(`agent profile \"${id}\" revision is not trusted`);
    }
    return profile;
  }

  list(workspaceId?: string): AgentProfile[] {
    if (workspaceId === undefined || this.#options === null) return [...this.#profiles.values(), ...this.#minted.values()];
    const workspace = this.#workspaceProfiles(workspaceId).filter((entry) => entry.profile !== null).map((entry) => entry.profile!);
    return [...this.#profiles.values(), ...workspace, ...this.#minted.values()];
  }

  /**
   * Workspace-scoped reads 404 on an unknown workspace even when the answer
   * would not touch it (builtin profiles) — the API contract the routes rely
   * on instead of a route-level guard.
   */
  #assertWorkspace(workspaceId: string): void {
    this.#options?.getWorkspaceRoot(workspaceId);
  }

  summaries(workspaceId: string): AgentProfileSummary[] {
    this.#assertWorkspace(workspaceId);
    const builtins = [...this.#profiles.values()].map((profile) => this.#summary(profile, "builtin", `builtin:${profile.id}`, true, true, []));
    const workspace = this.#workspaceProfiles(workspaceId).map(({ id, profile, revision, issues, files }) =>
      this.#summary(profile ?? this.#invalidPlaceholder(id), "workspace", revision, this.isTrusted(workspaceId, id, revision), issues.every((i) => i.level !== "error"), files));
    return [...builtins, ...workspace];
  }

  detail(workspaceId: string, id: string): AgentProfileDetail | undefined {
    this.#assertWorkspace(workspaceId);
    const builtin = this.#profiles.get(id);
    if (builtin) return this.#detail(builtin, "builtin", `builtin:${id}`, true, [], []);
    const entry = this.#workspaceProfiles(workspaceId).find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    return this.#detail(entry.profile ?? this.#invalidPlaceholder(id), "workspace", entry.revision,
      this.isTrusted(workspaceId, id, entry.revision), entry.issues, entry.files);
  }

  trust(workspaceId: string, id: string, revision: string): void {
    if (!this.#options) throw new Error("workspace profiles unavailable");
    const detail = this.detail(workspaceId, id);
    if (!detail || detail.source !== "workspace") throw new NotFoundError(`no workspace profile ${id}`);
    if (!detail.valid || detail.revision !== revision) throw new ConflictError("profile revision is invalid or stale");
    this.#options.db.insert(agentProfileTrust).values({ workspaceId, profileId: id, revision, trustedAt: nowIso() }).onConflictDoNothing().run();
    this.#options.bus.append({ type: "agent_profile.changed", workspaceId, payload: { workspaceId, profileId: id, revision, trusted: true } });
  }

  untrust(workspaceId: string, id: string): void {
    if (!this.#options) return;
    this.#options.db.delete(agentProfileTrust).where(and(eq(agentProfileTrust.workspaceId, workspaceId), eq(agentProfileTrust.profileId, id))).run();
    const revision = this.detail(workspaceId, id)?.revision ?? "unknown";
    this.#options.bus.append({ type: "agent_profile.changed", workspaceId, payload: { workspaceId, profileId: id, revision, trusted: false } });
  }

  isTrusted(workspaceId: string, id: string, revision: string): boolean {
    if (this.#profiles.has(id)) return true;
    return this.#options?.db.select().from(agentProfileTrust).where(and(eq(agentProfileTrust.workspaceId, workspaceId), eq(agentProfileTrust.profileId, id), eq(agentProfileTrust.revision, revision))).get() !== undefined;
  }

  profileRoot(workspaceId: string, id: string): string {
    if (!this.#options) throw new Error("workspace profiles unavailable");
    return path.join(this.#options.getWorkspaceRoot(workspaceId), ".agentique", "agents", id);
  }

  #resolvedWorkspaceProfile(workspaceId: string, id: string): AgentProfile | undefined {
    return this.#workspaceProfiles(workspaceId).find((entry) => entry.id === id)?.profile ?? this.#profiles.get(id);
  }

  #workspaceProfiles(workspaceId: string): { id: string; profile: AgentProfile | null; revision: string; issues: ProfileValidationIssue[]; files: { path: string; content: string }[] }[] {
    if (!this.#options) return [];
    const base = path.join(this.#options.getWorkspaceRoot(workspaceId), ".agentique", "agents");
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9-]*$/.test(entry.name)).map((entry) => {
      const root = path.join(base, entry.name); const files = this.#readFiles(root); const revision = this.#revision(files); const issues: ProfileValidationIssue[] = [];
      const manifest = files.find((file) => file.path === "agentique.profile.json");
      if (!manifest) return { id: entry.name, profile: null, revision, files, issues: [{ level: "error", path: "agentique.profile.json", message: "missing Agentique profile manifest" }] };
      try {
        const parsed = ProfileSchema.safeParse(JSON.parse(manifest.content));
        if (!parsed.success) return { id: entry.name, profile: null, revision, files, issues: [{ level: "error", path: manifest.path, message: parsed.error.message }] };
        if (parsed.data.id !== entry.name) issues.push({ level: "error", path: manifest.path, message: "profile id must match its directory" });
        const pluginManifest = files.some((file) => file.path === ".claude-plugin/plugin.json");
        if (!pluginManifest) issues.push({ level: "warning", path: ".claude-plugin/plugin.json", message: "bundle has no Claude plugin manifest" });
        return { id: entry.name, profile: { ...parsed.data, pluginPath: root, revision, source: "workspace" }, revision, files, issues };
      } catch (error) { return { id: entry.name, profile: null, revision, files, issues: [{ level: "error", path: manifest.path, message: error instanceof Error ? error.message : String(error) }] }; }
    });
  }

  #readFiles(root: string): { path: string; content: string }[] {
    const output: { path: string; content: string }[] = [];
    const visit = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name); const resolved = fs.realpathSync(absolute); if (!resolved.startsWith(`${fs.realpathSync(root)}${path.sep}`) && resolved !== fs.realpathSync(root)) continue;
      if (entry.isDirectory()) visit(absolute); else if (entry.isFile() && fs.statSync(absolute).size <= 256_000) output.push({ path: path.relative(root, absolute), content: fs.readFileSync(absolute, "utf8") });
    } };
    visit(root); return output.sort((a, b) => a.path.localeCompare(b.path));
  }

  #revision(files: { path: string; content: string }[]): string { const hash = crypto.createHash("sha256"); for (const file of files) hash.update(file.path).update("\0").update(file.content).update("\0"); return hash.digest("hex"); }
  #invalidPlaceholder(id: string): AgentProfile { return { id, title: id, purpose: "Invalid profile", instructions: "", tools: [], skills: [], permissionMode: "default", exemptFromOwnership: false, maxTurns: 1, mcpServers: {} }; }
  #componentCounts(files: { path: string }[]): Record<string, number> { const counts: Record<string, number> = {}; for (const file of files) { const kind = file.path.startsWith("skills/") ? "skills" : file.path.startsWith("hooks/") ? "hooks" : file.path.startsWith("agents/") ? "agents" : file.path === ".mcp.json" ? "mcp" : "files"; counts[kind] = (counts[kind] ?? 0) + 1; } return counts; }
  #summary(profile: AgentProfile, source: "builtin" | "workspace", revision: string, trusted: boolean, valid: boolean, files: { path: string }[]): AgentProfileSummary { return { id: profile.id, title: profile.title, purpose: profile.purpose, source, revision, trusted, valid, tools: profile.tools, skills: profile.skills ?? [], componentCounts: this.#componentCounts(files) }; }
  #detail(profile: AgentProfile, source: "builtin" | "workspace", revision: string, trusted: boolean, issues: ProfileValidationIssue[], files: { path: string; content: string }[]): AgentProfileDetail {
    const summary = this.#summary(profile, source, revision, trusted, issues.every((i) => i.level !== "error"), files);
    const components = files.filter((file) => file.path !== "agentique.profile.json" && file.path !== ".claude-plugin/plugin.json").map((file) => { const kind = file.path.startsWith("skills/") ? "skill" : file.path.startsWith("hooks/") ? "hook" : file.path.startsWith("agents/") ? "agent" : file.path === ".mcp.json" ? "mcp" : file.path.startsWith("commands/") ? "command" : file.path.startsWith("monitors/") ? "monitor" : file.path === "settings.json" ? "settings" : "other"; return { kind, name: path.basename(file.path), path: file.path, supported: ["skill", "hook", "agent", "mcp", "command", "settings"].includes(kind), summary: file.content.slice(0, 160) } as AgentProfileDetail["components"][number]; });
    return { ...summary, instructions: profile.instructions, permissionMode: profile.permissionMode, model: profile.model ?? null, effort: profile.effort ?? null, maxTurns: profile.maxTurns, mcpServers: profile.mcpServers, handoffExtension: profile.handoffExtension ?? null, pluginPath: profile.pluginPath ?? null, components, files, issues };
  }
}
