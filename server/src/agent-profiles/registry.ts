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
import { EFFORT_LEVELS } from "../sdk/effort.ts";
import { effectiveNativeTools } from "../sdk/native-capability-policy.ts";
import { evaluateNativeAgent, parseNativeAgentFile } from "./native-agent-file.ts";

/**
 * One discovered workspace definition source. `profile` is non-null only
 * when the source is Claude-valid, Agentique-compatible, and not shadowed —
 * the three verdicts stay independently visible either way.
 */
interface WorkspaceProfileEntry {
  id: string;
  profile: AgentProfile | null;
  revision: string;
  claudeValid: boolean;
  compatible: boolean;
  incompatibilityReasons: string[];
  issues: ProfileValidationIssue[];
  files: { path: string; content: string }[];
}

export const ProfileSchema = z.object({
  /**
   * For a workspace profile this is the NATIVE agent name — any native-legal
   * identity is accepted (git/path slugs are derived where needed, never
   * imposed on authorship). Built-ins and mints keep the strict slug shape,
   * enforced at their own construction sites.
   */
  id: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  /**
   * Role archetype — what kind of operator this profile is: an orchestrator
   * decomposes and integrates, an explorer produces knowledge, a planner
   * produces strategy, an implementer changes the artifact, a reviewer
   * produces verification evidence. Optional so pre-archetype workspace
   * manifests, snapshots, and minted rows keep parsing.
   */
  role: z.enum(["orchestrator", "explorer", "planner", "implementer", "reviewer"]).optional(),
  instructions: z.string().min(1),
  /**
   * The author's native tool ceiling. OMITTED preserves the native meaning —
   * "inherits all tools" (bounded by the capability policy) — and is never
   * normalized into a list; an explicit list is binding across the whole
   * native surface, meta tools included (`sdk/native-capability-policy.ts`).
   */
  tools: z.array(z.string()).min(1).optional(),
  /** The author's restrictions — honored whether or not `tools` is spelled out. */
  disallowedTools: z.array(z.string()).optional(),
  permissionMode: z.enum(["default", "plan", "bypassPermissions"]),
  model: z.string().optional(),
  /** Reasoning effort for the profile's agents; CONSOLE_EFFORT overrides it. */
  effort: z.enum(EFFORT_LEVELS).optional(),
  handoffExtension: z.enum(["generic", "coordination", "implementation", "investigation", "review"]).optional(),
  /**
   * Exempts the profile's agents from write-ownership disjointness: a
   * read-only reviewer inspects everyone's files, so exclusive scopes do
   * not apply to it.
   */
  exemptFromOwnership: z.boolean().default(false),
  maxTurns: z.number().int().min(1).max(100).default(40),
  /**
   * MCP servers this profile's agents get — the full authorable native
   * surface, lossless. This is where CAPABILITY lives: the Console owns
   * coordination and supplies nothing else. Browser automation, for
   * instance, is a declared stdio server, not a console tool — the
   * console-built browser and process tools were deleted after a live run
   * in which `browser_evaluate` was broken 100% of the time behind a green
   * test suite, screenshots cost a round trip each to look at, and one
   * keypress per call made real verification unaffordable.
   *
   * One launcher per declaration: `stdio`/`sse`/`http` forms are
   * console-EXECUTED (trust-gated, timeout-stamped, `CONSOLE_MCP_DISABLED`
   * removable); a `ref` form names a server the workspace's own native MCP
   * config launches (root `.mcp.json`, SDK-owned, native permissions) — the
   * console only grants it. Keys become the `mcp__<key>__*` prefix,
   * auto-approved for the profile's agents. The `transport` default keeps
   * legacy `{command,args}` manifests and snapshots parsing as stdio.
   */
  mcpServers: z.record(z.string(), z.union([
    z.object({
      transport: z.literal("stdio").default("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).optional(),
    }),
    z.object({
      transport: z.enum(["sse", "http"]),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    }),
    z.object({ transport: z.literal("ref") }),
  ])).default({}),
  skills: z.array(z.string()).optional(),
  entryAgent: z.string().optional(),
  pluginPath: z.string().optional(),
  revision: z.string().optional(),
  source: z.enum(["builtin", "workspace"]).optional(),
});

export type AgentProfile = z.infer<typeof ProfileSchema>;

/**
 * THE write-capability definition — the one the ownership rule and the
 * verification-tier derivation both key off. Bash can technically write too;
 * the ownership rule deliberately keys off the editing tools only, and the
 * tier derivation follows the same line so the two facts cannot fork.
 * Undefined tools (a pre-schema `{}` snapshot) count as writing — conservative
 * in both consumers.
 */
export function profileWritesFiles(tools: readonly string[] | undefined): boolean {
  return tools === undefined || tools.includes("Edit") || tools.includes("Write");
}

/**
 * A profile's `tools` list is its ceiling across the WHOLE native surface —
 * nothing is auto-added at spawn — so every built-in declares its meta tools
 * explicitly: Skill and ToolSearch for every profile (skill bodies and
 * deferred schemas are how a seat reaches its own capabilities), the
 * background-wait trio wherever Bash is granted, and the native worktree
 * pair wherever Edit/Write are. These used to be appended by the runtime;
 * now the author is the only one who grants.
 */
const DISCOVERY_TOOLS = ["Skill", "ToolSearch"];
const BACKGROUND_TOOLS = ["Monitor", "TaskOutput", "TaskStop"];
const WORKTREE_NATIVE_TOOLS = ["EnterWorktree", "ExitWorktree"];
const READ_TOOLS = ["Read", "Glob", "Grep"];
// NotebookEdit rides with the editors: a notebook is a code file, and
// isolated implementers held it in practice under the old runtime widening.
const CODE_TOOLS = [...READ_TOOLS, "Edit", "Write", "NotebookEdit", "Bash"];
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
    transport: "stdio" as const,
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
export const ATTACHABLE_MCP_SERVERS: Record<string, { transport: "stdio"; command: string; args: string[] }> = {
  ...BROWSER_MCP,
};

const BUILTINS: AgentProfile[] = [
  {
    id: "coordinator",
    title: "Coordinator",
    role: "orchestrator",
    purpose: "Own a bounded workstream, assign each unit once, integrate results, and report milestones.",
    instructions: "You are the sole coordinator for this AgentSession: you own decomposition and integration; your specialists own the work. Assign each unit once, to one specialist; on a merge-conflict failure, reassign against the current HEAD. Write seats work in ISOLATED worktrees — their files reach your workspace only when the Console merges a completed report, so read progress from the roster line or ask the seat rather than the filesystem. Report to main for a blocking decision, material failure, milestone or final result, and always before you go idle: relay what your specialists actually found, defects and unverified claims included — a partial result beats silence.",
    tools: [...READ_TOOLS, ...WEB_TOOLS, ...DISCOVERY_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    effort: "high",
    skills: ["handoff-discipline", "git-gud-coordinate"],
    handoffExtension: "coordination",
    exemptFromOwnership: false,
    maxTurns: 35,
    mcpServers: {},
  },
  {
    id: "planner",
    title: "Planner",
    role: "planner",
    purpose: "Decompose an objective into an ordered, checkable plan: refined requirements, a task DAG, and per-unit acceptance — without executing any of it.",
    instructions: "You plan; you do not build. Read the delegated requirements and the workspace until the decomposition is defensible, then produce: (1) refinements below your delegated requirement nodes where a committed statement is too coarse to verify directly (decompose_requirement); (2) the task DAG with dependencies and owners (task_create with blockedBy); (3) per-unit acceptance stated as the requirement each unit discharges. Name what remains consequentially uncertain rather than planning over it. Return one plan report; route scope questions to main or the operator — never widen scope yourself.",
    tools: [...READ_TOOLS, ...WEB_TOOLS, ...DISCOVERY_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    effort: "xhigh",
    skills: ["handoff-discipline"],
    handoffExtension: "coordination",
    exemptFromOwnership: false,
    maxTurns: 30,
    mcpServers: {},
  },
  {
    id: "explorer",
    title: "Explorer",
    role: "explorer",
    purpose: "Trace code and runtime behavior and return concrete evidence without editing.",
    instructions: "Inspect only the assigned scope and cite concrete files, symbols, commands, and observations. When the repository alone cannot settle a question, read upstream documentation and sources with WebSearch and WebFetch rather than recalling them. Return one concise findings report to your coordinator.",
    tools: [...READ_TOOLS, ...WEB_TOOLS, ...DISCOVERY_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    effort: "high",
    skills: ["handoff-discipline"],
    handoffExtension: "investigation",
    exemptFromOwnership: false,
    maxTurns: 30,
    mcpServers: {},
  },
  {
    id: "implementer",
    title: "Implementer",
    role: "implementer",
    purpose: "Implement and validate a clearly owned code change.",
    instructions: "You exclusively own the assigned files or component. Inspect before editing, preserve unrelated changes, implement the smallest complete change, and run the relevant validation. Report changed files, tests run, and remaining risks.",
    tools: [...CODE_TOOLS, ...DISCOVERY_TOOLS, ...BACKGROUND_TOOLS, ...WORKTREE_NATIVE_TOOLS],
    permissionMode: "bypassPermissions",
    model: "claude-opus-5",
    effort: "xhigh",
    skills: ["long-build-discipline", "build-hygiene", "worktree-etiquette", "probe-method", "handoff-discipline", "git-gud-commits", "git-gud-conflicts", "git-gud-sync", "git-gud-recover"],
    handoffExtension: "implementation",
    exemptFromOwnership: false,
    maxTurns: 50,
    mcpServers: {},
  },
  {
    id: "frontend-implementer",
    title: "Frontend implementer",
    role: "implementer",
    purpose: "Implement frontend behavior and validate the rendered application.",
    instructions: "You own the assigned frontend slice. Run the application, drive the real browser through your MCP browser tools, exercise the interactions, and report concrete validation rather than visual guesses.",
    tools: [...CODE_TOOLS, ...DISCOVERY_TOOLS, ...BACKGROUND_TOOLS, ...WORKTREE_NATIVE_TOOLS],
    permissionMode: "bypassPermissions",
    model: "claude-opus-5",
    effort: "xhigh",
    skills: ["long-build-discipline", "build-hygiene", "worktree-etiquette", "handoff-discipline", "git-gud-commits", "git-gud-conflicts", "git-gud-sync", "git-gud-recover"],
    handoffExtension: "implementation",
    exemptFromOwnership: false,
    maxTurns: 50,
    mcpServers: BROWSER_MCP,
  },
  {
    id: "reviewer",
    title: "Reviewer",
    role: "reviewer",
    purpose: "Review a completed change and report actionable defects with evidence.",
    instructions: "You review; you do not fix. Inspect the diff, run the relevant validation, and report defects by severity with file references and reproduction evidence. Say explicitly when no defect is found.",
    tools: [...READ_TOOLS, "Bash", ...WEB_TOOLS, ...DISCOVERY_TOOLS, ...BACKGROUND_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    effort: "xhigh",
    skills: ["long-build-discipline", "worktree-etiquette", "handoff-discipline", "git-gud-recover"],
    handoffExtension: "review",
    exemptFromOwnership: true,
    maxTurns: 35,
    mcpServers: {},
  },
  {
    id: "visual-reviewer",
    title: "Visual reviewer",
    role: "reviewer",
    purpose: "Inspect a rendered UI through browser interaction and screenshots.",
    instructions: "You review; you do not fix. Exercise the assigned user flow in the browser, capture evidence, inspect console and runtime errors, and report concrete visual or interaction defects.",
    tools: [...READ_TOOLS, "Bash", ...WEB_TOOLS, ...DISCOVERY_TOOLS, ...BACKGROUND_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    effort: "xhigh",
    skills: ["long-build-discipline", "worktree-etiquette", "handoff-discipline", "git-gud-recover"],
    handoffExtension: "review",
    exemptFromOwnership: true,
    maxTurns: 35,
    mcpServers: BROWSER_MCP,
  },
  {
    id: "researcher",
    title: "Researcher",
    role: "explorer",
    purpose: "Gather focused external or repository evidence for one decision.",
    instructions: "Research only the assigned question. Reach primary sources directly with WebSearch and WebFetch and cite the URLs you actually read — a source you could not open is not evidence. Separate facts from inference and return a concise recommendation with evidence.",
    tools: [...READ_TOOLS, ...WEB_TOOLS, ...DISCOVERY_TOOLS],
    permissionMode: "default",
    model: "claude-opus-5",
    effort: "high",
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
    if (!/^[a-z][a-z0-9-]*$/.test(input.id)) {
      throw new InvalidInputError(`mint id "${input.id}" must be a lowercase slug (a-z, 0-9, -)`);
    }
    if (this.#minted.has(input.id) || this.#profiles.has(input.id)) {
      throw new ConflictError(`profile id "${input.id}" already exists`);
    }
    const base = this.get(input.baseProfileId, input.workspaceId);
    // A mint is an Agentique-derived EXECUTION set, not a native definition:
    // an inherit-mode base materializes to its effective surface here, so the
    // subset rule always compares against what the base's seats actually hold.
    const baseCeiling = [...effectiveNativeTools(base, "seat")];
    const tools = input.tools ?? baseCeiling;
    const widened = tools.filter((tool) => !baseCeiling.includes(tool));
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
      attached[name] = { transport: "stdio", command: declared.command, args: declared.args };
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
        baseRevision: base.revision ?? `builtin:${base.id}`, tools: profile.tools ?? [],
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
    const builtins = [...this.#profiles.values()].map((profile) =>
      this.#summary(profile, "builtin", `builtin:${profile.id}`, { trusted: true, claudeValid: true, compatible: true, reasons: [] }, []));
    const workspace = this.#workspaceProfiles(workspaceId).map((entry) =>
      this.#summary(entry.profile ?? this.#invalidPlaceholder(entry.id), "workspace", entry.revision,
        { trusted: this.isTrusted(workspaceId, entry.id, entry.revision), claudeValid: entry.claudeValid && entry.issues.every((issue) => issue.level !== "error"),
          compatible: entry.compatible, reasons: entry.incompatibilityReasons }, entry.files));
    return [...builtins, ...workspace];
  }

  detail(workspaceId: string, id: string): AgentProfileDetail | undefined {
    this.#assertWorkspace(workspaceId);
    const builtin = this.#profiles.get(id);
    if (builtin) return this.#detail(builtin, "builtin", `builtin:${id}`, { trusted: true, claudeValid: true, compatible: true, reasons: [] }, [], []);
    const entry = this.#workspaceProfiles(workspaceId).find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    return this.#detail(entry.profile ?? this.#invalidPlaceholder(entry.id), "workspace", entry.revision,
      { trusted: this.isTrusted(workspaceId, entry.id, entry.revision), claudeValid: entry.claudeValid && entry.issues.every((issue) => issue.level !== "error"),
        compatible: entry.compatible, reasons: entry.incompatibilityReasons }, entry.issues, entry.files);
  }

  trust(workspaceId: string, id: string, revision: string): void {
    if (!this.#options) throw new Error("workspace profiles unavailable");
    const detail = this.detail(workspaceId, id);
    if (!detail || detail.source !== "workspace") throw new NotFoundError(`no workspace profile ${id}`);
    // A valid-but-incompatible native definition is trust-INELIGIBLE, never
    // "invalid": the reasons name exactly what the console cannot execute.
    if (!detail.agentiqueCompatible) throw new ConflictError(`profile is not Agentique-compatible: ${detail.incompatibilityReasons.join("; ")}`);
    if (!detail.valid || detail.revision !== revision) throw new ConflictError("profile revision is invalid or stale");
    this.#options.db.insert(agentProfileTrust).values({ workspaceId, profileId: id, revision, trustedAt: nowIso() }).onConflictDoNothing().run();
    this.#options.bus.append({ type: "agent_profile.changed", workspaceId, payload: { workspaceId, profileId: id, revision, trusted: true } });
  }

  isTrusted(workspaceId: string, id: string, revision: string): boolean {
    if (this.#profiles.has(id)) return true;
    return this.#options?.db.select().from(agentProfileTrust).where(and(eq(agentProfileTrust.workspaceId, workspaceId), eq(agentProfileTrust.profileId, id), eq(agentProfileTrust.revision, revision))).get() !== undefined;
  }

  #resolvedWorkspaceProfile(workspaceId: string, id: string): AgentProfile | undefined {
    return this.#workspaceProfiles(workspaceId).find((entry) => entry.id === id)?.profile ?? this.#profiles.get(id);
  }

  /**
   * Workspace profile discovery, two sources:
   *
   *  1. NATIVE (canonical): `.claude/agents/**‍/*.md` — genuine project
   *     agents, parsed by `native-agent-file.ts`. Identity is the native
   *     `name` (filename is only the fallback), so files an operator already
   *     has for interactive Claude are discoverable as candidate profiles;
   *     trust gates instantiation. The native `Agent` tool stays denied by
   *     the capability policy — the console is the execution engine for
   *     these definitions, and running one is an AgentSession.
   *  2. LEGACY (deprecated dual-read): `.agentique/agents/<id>/` bundles
   *     with `agentique.profile.json`. One transition release, then removed.
   *
   * Shadowing: built-in ids win, then the native source selected by
   * mirrored discovery precedence (shallower path, then lexicographic),
   * then legacy. A shadowed source is listed — Claude-valid, but
   * Agentique-incompatible with a "shadowed by" reason — and NEVER inherits
   * trust: the revision binds to the semantic source (path + name + bytes),
   * so a higher-precedence same-name file is a different revision.
   */
  #workspaceProfiles(workspaceId: string): WorkspaceProfileEntry[] {
    if (!this.#options) return [];
    const workspaceRoot = this.#options.getWorkspaceRoot(workspaceId);
    const entries = [...this.#nativeEntries(workspaceRoot), ...this.#legacyEntries(workspaceRoot)];
    const seen = new Set<string>();
    for (const entry of entries) {
      const shadowedBy = this.#profiles.has(entry.id) ? `built-in profile "${entry.id}"`
        : seen.has(entry.id) ? `a higher-precedence definition of "${entry.id}"` : null;
      seen.add(entry.id);
      if (shadowedBy !== null) {
        entry.profile = null;
        entry.compatible = false;
        entry.incompatibilityReasons = [...entry.incompatibilityReasons, `shadowed by ${shadowedBy}`];
      }
    }
    return entries;
  }

  /** Native `.claude/agents` definitions, in discovery-precedence order. */
  #nativeEntries(workspaceRoot: string): WorkspaceProfileEntry[] {
    const base = path.join(workspaceRoot, ".claude", "agents");
    if (!fs.existsSync(base)) return [];
    const files: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        const resolved = fs.realpathSync(absolute);
        if (!resolved.startsWith(`${fs.realpathSync(base)}${path.sep}`)) continue;
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() && entry.name.endsWith(".md") && fs.statSync(absolute).size <= 256_000) files.push(absolute);
      }
    };
    visit(base);
    // Mirrored native precedence: shallower first, then lexicographic —
    // deterministic whatever the filesystem returns.
    files.sort((a, b) => {
      const depth = a.split(path.sep).length - b.split(path.sep).length;
      return depth !== 0 ? depth : a.localeCompare(b);
    });
    return files.map((absolute) => this.#nativeEntry(workspaceRoot, absolute));
  }

  #nativeEntry(workspaceRoot: string, absolute: string): WorkspaceProfileEntry {
    const relPath = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
    const content = fs.readFileSync(absolute, "utf8");
    const fallbackName = path.basename(absolute, ".md");
    const parsed = parseNativeAgentFile(content);
    if (!parsed.formatValid) {
      return { id: fallbackName, profile: null, revision: this.#nativeRevision(relPath, fallbackName, content, null),
        claudeValid: false, compatible: false, incompatibilityReasons: [],
        issues: [{ level: "error", path: relPath, message: parsed.error }],
        files: [{ path: relPath, content }] };
    }
    const name = typeof parsed.fields.name === "string" && parsed.fields.name.trim() !== "" ? parsed.fields.name.trim() : fallbackName;
    // Overlay sidecar (the fallback home for governance metadata when the
    // frontmatter must stay pure): when present it REPLACES the frontmatter
    // overlay — one governance source at a time.
    const sidecarPath = path.join(workspaceRoot, ".agentique", "agents", `${name}.overlay.json`);
    let sidecar: { content: string } | null = null;
    let fields = parsed.fields;
    const issues: ProfileValidationIssue[] = [];
    if (fs.existsSync(sidecarPath)) {
      const sidecarContent = fs.readFileSync(sidecarPath, "utf8");
      sidecar = { content: sidecarContent };
      try {
        fields = { ...parsed.fields, agentique: JSON.parse(sidecarContent) as unknown };
      } catch (error) {
        issues.push({ level: "error", path: `.agentique/agents/${name}.overlay.json`, message: `overlay sidecar is not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const revision = this.#nativeRevision(relPath, name, content, sidecar?.content ?? null);
    const entryFiles = [{ path: relPath, content }, ...(sidecar ? [{ path: `.agentique/agents/${name}.overlay.json`, content: sidecar.content }] : [])];
    if (issues.some((issue) => issue.level === "error")) {
      return { id: name, profile: null, revision, claudeValid: true, compatible: false,
        incompatibilityReasons: issues.map((issue) => issue.message), issues, files: entryFiles };
    }
    const evaluated = evaluateNativeAgent(fields, parsed.body, fallbackName);
    if (!evaluated.compatible) {
      return { id: name, profile: null, revision, claudeValid: true, compatible: false,
        incompatibilityReasons: evaluated.reasons.map((reason) => `${reason.field}: ${reason.reason}`),
        issues, files: entryFiles };
    }
    const agent = evaluated.agent;
    // A `ref` declaration means "attach an already-configured server": it
    // must resolve against the workspace's native MCP config (root
    // `.mcp.json`, SDK-owned) or the definition is Agentique-incompatible —
    // never silently unlaunched.
    const refNames = Object.entries(agent.mcpServers).filter(([, declaration]) => declaration.transport === "ref").map(([serverName]) => serverName);
    if (refNames.length > 0) {
      const configured = this.#workspaceMcpNames(workspaceRoot);
      const unresolved = refNames.filter((serverName) => !configured.has(serverName));
      if (unresolved.length > 0) {
        return { id: name, profile: null, revision, claudeValid: true, compatible: false,
          incompatibilityReasons: unresolved.map((serverName) => `mcpServers: "${serverName}" references an MCP server not configured in this workspace's .mcp.json`),
          issues, files: entryFiles };
      }
    }
    const resolved = ProfileSchema.safeParse({
      id: agent.name, title: agent.name, purpose: agent.description,
      ...(agent.overlay.role === undefined ? {} : { role: agent.overlay.role }),
      instructions: agent.body,
      ...(agent.tools === undefined ? {} : { tools: agent.tools }),
      ...(agent.disallowedTools === undefined ? {} : { disallowedTools: agent.disallowedTools }),
      permissionMode: agent.permissionMode ?? "default",
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.effort === undefined ? {} : { effort: agent.effort }),
      ...(agent.overlay.handoffExtension === undefined ? {} : { handoffExtension: agent.overlay.handoffExtension }),
      exemptFromOwnership: agent.overlay.exemptFromOwnership ?? false,
      ...(agent.overlay.assignmentTurnBudget === undefined ? {} : { maxTurns: agent.overlay.assignmentTurnBudget }),
      mcpServers: agent.mcpServers,
      ...(agent.overlay.recommendedSkills === undefined ? {} : { skills: agent.overlay.recommendedSkills }),
      revision, source: "workspace",
    });
    if (!resolved.success) {
      // Post-evaluation schema misses (e.g. an effort level the console does
      // not execute) are compatibility findings, never "invalid Claude".
      return { id: name, profile: null, revision, claudeValid: true, compatible: false,
        incompatibilityReasons: resolved.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        issues, files: entryFiles };
    }
    return { id: name, profile: resolved.data, revision, claudeValid: true, compatible: true,
      incompatibilityReasons: [], issues, files: entryFiles };
  }

  /** Server names the workspace's native MCP config declares (root `.mcp.json` — SDK-owned; the console reads names only, never launches from it). */
  #workspaceMcpNames(workspaceRoot: string): Set<string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(workspaceRoot, ".mcp.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
      return new Set(Object.keys(parsed.mcpServers ?? {}));
    } catch {
      return new Set();
    }
  }

  /** Source-identity revision: workspace-relative path + native name + bytes (+ overlay bytes). A move or rename re-requires trust. */
  #nativeRevision(relPath: string, name: string, definition: string, overlay: string | null): string {
    return crypto.createHash("sha256")
      .update("agentique-profile-rev2\0").update(relPath).update("\0").update(name).update("\0")
      .update(crypto.createHash("sha256").update(definition).digest("hex")).update("\0")
      .update(overlay === null ? "-" : crypto.createHash("sha256").update(overlay).digest("hex"))
      .digest("hex");
  }

  /** The deprecated bundle form — dual-read for one transition release. */
  #legacyEntries(workspaceRoot: string): WorkspaceProfileEntry[] {
    const base = path.join(workspaceRoot, ".agentique", "agents");
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9-]*$/.test(entry.name)).map((entry) => {
      const root = path.join(base, entry.name); const files = this.#readFiles(root); const revision = this.#revision(files);
      const issues: ProfileValidationIssue[] = [{ level: "warning", path: "agentique.profile.json",
        message: "legacy bundle format — migrate to .claude/agents/<name>.md (scripts/migrate-profile.ts); this form is removed after the transition release" }];
      const invalid = (message: string, at: string): WorkspaceProfileEntry => ({ id: entry.name, profile: null, revision,
        claudeValid: false, compatible: false, incompatibilityReasons: [],
        issues: [...issues, { level: "error", path: at, message }], files });
      const manifest = files.find((file) => file.path === "agentique.profile.json");
      if (!manifest) return invalid("missing Agentique profile manifest", "agentique.profile.json");
      try {
        const parsed = ProfileSchema.safeParse(JSON.parse(manifest.content));
        if (!parsed.success) return invalid(parsed.error.message, manifest.path);
        if (parsed.data.id !== entry.name) issues.push({ level: "error", path: manifest.path, message: "profile id must match its directory" });
        const pluginManifest = files.some((file) => file.path === ".claude-plugin/plugin.json");
        if (!pluginManifest) issues.push({ level: "warning", path: ".claude-plugin/plugin.json", message: "bundle has no Claude plugin manifest" });
        const valid = issues.every((issue) => issue.level !== "error");
        return { id: entry.name, profile: valid ? { ...parsed.data, pluginPath: root, revision, source: "workspace" as const } : null,
          revision, claudeValid: valid, compatible: valid, incompatibilityReasons: [], issues, files };
      } catch (error) { return invalid(error instanceof Error ? error.message : String(error), manifest.path); }
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
  #summary(profile: AgentProfile, source: "builtin" | "workspace", revision: string,
    state: { trusted: boolean; claudeValid: boolean; compatible: boolean; reasons: string[] }, files: { path: string }[]): AgentProfileSummary {
    return { id: profile.id, title: profile.title, purpose: profile.purpose, role: profile.role ?? null, source, revision,
      trusted: state.trusted, valid: state.claudeValid, claudeValid: state.claudeValid,
      agentiqueCompatible: state.compatible, incompatibilityReasons: state.reasons,
      tools: profile.tools ?? [], skills: profile.skills ?? [], componentCounts: this.#componentCounts(files) };
  }
  #detail(profile: AgentProfile, source: "builtin" | "workspace", revision: string,
    state: { trusted: boolean; claudeValid: boolean; compatible: boolean; reasons: string[] }, issues: ProfileValidationIssue[], files: { path: string; content: string }[]): AgentProfileDetail {
    const summary = this.#summary(profile, source, revision, state, files);
    // Bundle `agents/*.md` beyond the profile itself are VISIBLE-ONLY: the
    // native Agent tool is denied by console policy, so nothing can run them.
    const components = files.filter((file) => file.path !== "agentique.profile.json" && file.path !== ".claude-plugin/plugin.json").map((file) => { const kind = file.path.startsWith("skills/") ? "skill" : file.path.startsWith("hooks/") ? "hook" : file.path.startsWith("agents/") ? "agent" : file.path === ".mcp.json" ? "mcp" : file.path.startsWith("commands/") ? "command" : file.path.startsWith("monitors/") ? "monitor" : file.path === "settings.json" ? "settings" : "other"; return { kind, name: path.basename(file.path), path: file.path, supported: ["skill", "hook", "mcp", "command", "settings"].includes(kind), summary: file.content.slice(0, 160) } as AgentProfileDetail["components"][number]; });
    return { ...summary, instructions: profile.instructions, permissionMode: profile.permissionMode, model: profile.model ?? null, effort: profile.effort ?? null, maxTurns: profile.maxTurns, mcpServers: profile.mcpServers, handoffExtension: profile.handoffExtension ?? null, pluginPath: profile.pluginPath ?? null, components, files, issues };
  }
}
