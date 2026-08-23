/**
 * The parser of record for native Claude agent-definition files
 * (`.claude/agents/*.md`) and for SKILL.md frontmatter — a real YAML parser
 * (`yaml`), never a hand-rolled subset, because "Claude-valid" must mean the
 * file parses as a legitimate native definition, not that it fits an
 * Agentique-shaped slice of YAML.
 *
 * Three independent verdicts flow from here:
 *  - NATIVE-FORMAT-VALID (`parseNativeAgentFile`): frontmatter + body parse,
 *    the document is a map, and the native identity fields are usable.
 *  - AGENTIQUE-COMPATIBLE (`evaluateNativeAgent`): every native field that
 *    affects execution is either applied with its native meaning preserved,
 *    provably non-semantic for AgentSession execution (ignored, listed), or
 *    a named incompatibility. Nothing is silently dropped or reinterpreted;
 *    a valid-but-incompatible definition is never labeled "invalid".
 *  - TRUST is the registry's concern (source-identity revision hash).
 *
 * Agentique-specific concepts live under ONE reserved frontmatter key,
 * `agentique:` — orchestration metadata with no native equivalent. A future
 * maintainer can attribute every key to Claude or to `agentique.*` on sight.
 */
import YAML from "yaml";

export type NativeAgentParse =
  | { formatValid: false; error: string }
  | { formatValid: true; fields: Record<string, unknown>; body: string };

/**
 * Boundary split only — the leading `---` fence at byte 0 through the next
 * fence line. CRLF tolerated. Never interprets the YAML between the fences.
 */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  return { frontmatter: match[1]!, body: text.slice(match[0].length) };
}

export function parseNativeAgentFile(text: string): NativeAgentParse {
  const split = splitFrontmatter(text);
  if (!split) return { formatValid: false, error: "no YAML frontmatter (a native agent definition starts with a --- fence)" };
  let document: unknown;
  try {
    document = YAML.parse(split.frontmatter);
  } catch (error) {
    return { formatValid: false, error: `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { formatValid: false, error: "frontmatter must be a YAML map" };
  }
  return { formatValid: true, fields: document as Record<string, unknown>, body: split.body };
}

/**
 * Generic frontmatter-document read for other native markdown (SKILL.md):
 * same fence split, same real YAML — one parser in the codebase. Returns an
 * empty map when there is no frontmatter or it fails to parse as a map.
 */
export function parseFrontmatterDocument(text: string): Record<string, unknown> {
  const parsed = parseNativeAgentFile(text);
  return parsed.formatValid ? parsed.fields : {};
}

/** The `agentique:` overlay — every key an Agentique-specific concept. */
export interface AgentiqueOverlay {
  role?: "orchestrator" | "explorer" | "planner" | "implementer" | "reviewer";
  handoffExtension?: "generic" | "coordination" | "implementation" | "investigation" | "review";
  exemptFromOwnership?: boolean;
  /** Console-enforced per-assignment budget — NOT native `maxTurns`. */
  assignmentTurnBudget?: number;
  /** Named in the capability brief — NOT native `skills` preload, not a filter. */
  recommendedSkills?: string[];
}

export interface FieldReason { field: string; reason: string }

/**
 * One native MCP declaration, lossless per supported form. `stdio`, `sse`
 * and `http` are console-EXECUTED (trust-gated launch through
 * `Options.mcpServers`); `ref` is the native name-reference form — "attach
 * an already-configured server" — which the console never launches: the
 * workspace's own native MCP config (root `.mcp.json`, SDK-owned) does, and
 * the console only grants `mcp__<name>`. One launcher per declaration,
 * always.
 */
export type McpDeclaration =
  | { transport: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { transport: "sse" | "http"; url: string; headers?: Record<string, string> }
  | { transport: "ref" };

export interface EvaluatedNativeAgent {
  name: string;
  description: string;
  body: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string;
  permissionMode?: string;
  mcpServers: Record<string, McpDeclaration>;
  overlay: AgentiqueOverlay;
  /** Native fields present but provably non-semantic for AgentSession execution. */
  ignored: string[];
}

export type NativeAgentEvaluation =
  | { compatible: true; agent: EvaluatedNativeAgent }
  | { compatible: false; reasons: FieldReason[] };

/**
 * Native fields Agentique cannot reproduce faithfully on a persistent
 * AgentSession lane — each present field is a named incompatibility, never a
 * silent drop. The reason points at the Agentique alternative where one
 * exists.
 */
const UNSUPPORTED_NATIVE_FIELDS: Readonly<Record<string, string>> = {
  skills: "native `skills` means preload, which AgentSession lanes cannot reproduce — recommend instead via `agentique.recommendedSkills`",
  maxTurns: "native `maxTurns` bounds one invocation; a persistent lane has none — use `agentique.assignmentTurnBudget`",
  hooks: "agent-scoped hooks are not applied by AgentSession execution",
  memory: "native agent memory directories are not loaded by AgentSession execution",
  observer: "observer agents are a native-execution feature",
  observerMessage: "observer agents are a native-execution feature",
  initialPrompt: "the first turn of an AgentSession is its console briefing",
  criticalSystemReminder_EXPERIMENTAL: "experimental native field; not reproduced",
};

const PERMISSION_MODES = new Set(["default", "plan", "bypassPermissions"]);
const OVERLAY_ROLES = new Set(["orchestrator", "explorer", "planner", "implementer", "reviewer"]);
const OVERLAY_EXTENSIONS = new Set(["generic", "coordination", "implementation", "investigation", "review"]);

/** Native `tools` frontmatter: a YAML list or the conventional comma-separated string. */
function toolList(value: unknown): string[] | null {
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
  return null;
}

function evaluateOverlay(value: unknown, reasons: FieldReason[]): AgentiqueOverlay {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    reasons.push({ field: "agentique", reason: "must be a map of Agentique governance keys" });
    return {};
  }
  const overlay: AgentiqueOverlay = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    switch (key) {
      case "role":
        if (typeof entry === "string" && OVERLAY_ROLES.has(entry)) overlay.role = entry as AgentiqueOverlay["role"];
        else reasons.push({ field: "agentique.role", reason: `one of ${[...OVERLAY_ROLES].join("|")}` });
        break;
      case "handoffExtension":
        if (typeof entry === "string" && OVERLAY_EXTENSIONS.has(entry)) overlay.handoffExtension = entry as AgentiqueOverlay["handoffExtension"];
        else reasons.push({ field: "agentique.handoffExtension", reason: `one of ${[...OVERLAY_EXTENSIONS].join("|")}` });
        break;
      case "exemptFromOwnership":
        if (typeof entry === "boolean") overlay.exemptFromOwnership = entry;
        else reasons.push({ field: "agentique.exemptFromOwnership", reason: "must be a boolean" });
        break;
      case "assignmentTurnBudget":
        if (typeof entry === "number" && Number.isInteger(entry) && entry >= 1 && entry <= 100) overlay.assignmentTurnBudget = entry;
        else reasons.push({ field: "agentique.assignmentTurnBudget", reason: "an integer 1..100" });
        break;
      case "recommendedSkills": {
        const skills = toolList(entry);
        if (skills !== null) overlay.recommendedSkills = skills;
        else reasons.push({ field: "agentique.recommendedSkills", reason: "a list of skill names" });
        break;
      }
      default:
        reasons.push({ field: `agentique.${key}`, reason: "unknown Agentique governance key" });
    }
  }
  return overlay;
}

/**
 * The full authorable `AgentMcpServerSpec` surface, lossless: a name
 * reference, a stdio command, or an SSE/HTTP url (whose `type` must be
 * explicit — guessing a transport would be a silent reinterpretation). The
 * SDK/in-process form is not authorable in YAML; anything unrecognizable is
 * a named incompatibility, never dropped or normalized into something else.
 */
function evaluateMcpServers(value: unknown, reasons: FieldReason[]): EvaluatedNativeAgent["mcpServers"] {
  const out: EvaluatedNativeAgent["mcpServers"] = {};
  if (value === undefined || value === null) return out;
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (typeof entry === "string") {
      out[entry] = { transport: "ref" };
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      reasons.push({ field: "mcpServers", reason: "each entry must be a server name or a {name: config} map" });
      continue;
    }
    for (const [name, config] of Object.entries(entry as Record<string, unknown>)) {
      const spec = config as { command?: unknown; args?: unknown; env?: unknown; url?: unknown; type?: unknown; headers?: unknown };
      if (typeof spec?.command === "string" && spec.command !== "") {
        out[name] = {
          transport: "stdio",
          command: spec.command,
          args: Array.isArray(spec.args) && spec.args.every((a) => typeof a === "string") ? (spec.args as string[]) : [],
          ...(spec.env !== undefined && typeof spec.env === "object" && spec.env !== null ? { env: spec.env as Record<string, string> } : {}),
        };
      } else if (typeof spec?.url === "string") {
        if (spec.type === "sse" || spec.type === "http") {
          out[name] = { transport: spec.type, url: spec.url,
            ...(spec.headers !== undefined && typeof spec.headers === "object" && spec.headers !== null ? { headers: spec.headers as Record<string, string> } : {}) };
        } else {
          reasons.push({ field: "mcpServers", reason: `"${name}" declares a url without an explicit type: sse|http — the console will not guess a transport` });
        }
      } else {
        reasons.push({ field: "mcpServers", reason: `"${name}" is not a recognizable MCP declaration` });
      }
    }
  }
  return out;
}

/**
 * The per-field disposition table. `fallbackName` is the file's basename —
 * used only when the native `name` field is absent (mirroring the native
 * loader's identity behavior; see the discovery notes in registry.ts).
 */
export function evaluateNativeAgent(fields: Record<string, unknown>, body: string, fallbackName: string): NativeAgentEvaluation {
  const reasons: FieldReason[] = [];
  const ignored: string[] = [];

  const name = typeof fields.name === "string" && fields.name.trim() !== "" ? fields.name.trim() : fallbackName;
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (description === "") reasons.push({ field: "description", reason: "a native agent definition requires a description" });
  if (body.trim() === "") reasons.push({ field: "body", reason: "the body is the agent's system prompt and must not be empty" });

  let tools: string[] | undefined;
  if (fields.tools !== undefined) {
    const parsed = toolList(fields.tools);
    if (parsed === null) reasons.push({ field: "tools", reason: "a list of tool names or a comma-separated string" });
    else tools = parsed;
  }
  let disallowedTools: string[] | undefined;
  if (fields.disallowedTools !== undefined) {
    const parsed = toolList(fields.disallowedTools);
    if (parsed === null) reasons.push({ field: "disallowedTools", reason: "a list of tool names or a comma-separated string" });
    else disallowedTools = parsed;
  }

  const model = typeof fields.model === "string" ? fields.model : undefined;
  if (fields.model !== undefined && model === undefined) reasons.push({ field: "model", reason: "must be a model name string" });
  const effort = typeof fields.effort === "string" ? fields.effort : undefined;
  if (fields.effort !== undefined && effort === undefined) reasons.push({ field: "effort", reason: "must be an effort level string" });

  let permissionMode: string | undefined;
  if (fields.permissionMode !== undefined) {
    if (typeof fields.permissionMode === "string" && PERMISSION_MODES.has(fields.permissionMode)) permissionMode = fields.permissionMode;
    else reasons.push({ field: "permissionMode", reason: `the console executes ${[...PERMISSION_MODES].join("|")}` });
  }

  const mcpServers = evaluateMcpServers(fields.mcpServers, reasons);
  const overlay = evaluateOverlay(fields.agentique, reasons);

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (["name", "description", "tools", "disallowedTools", "model", "effort", "permissionMode", "mcpServers", "agentique"].includes(key)) continue;
    if (key === "background") { ignored.push(key); continue; } // configures native Agent-tool invocation, which never occurs here
    const unsupported = UNSUPPORTED_NATIVE_FIELDS[key];
    reasons.push({ field: key, reason: unsupported ?? "unrecognized native field — semantic preservation cannot be guaranteed; update the console or remove the field" });
  }

  if (reasons.length > 0) return { compatible: false, reasons };
  return {
    compatible: true,
    agent: {
      name, description, body,
      ...(tools === undefined ? {} : { tools }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      mcpServers, overlay, ignored,
    },
  };
}
