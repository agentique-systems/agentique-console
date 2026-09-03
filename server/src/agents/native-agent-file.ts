/**
 * The parser and evaluator of native Claude agent definition files
 * (`.claude/agents/<name>.md`; execution-model §11; migration-contract §6).
 * A real YAML parser splits the frontmatter; every native field is then
 * either read into the console's Agent Definition content with its native
 * meaning preserved, accepted as informational (it affects no execution),
 * or named as an explicit rejection. Nothing is silently ignored or
 * reinterpreted, and the retired `agentique:` map is a rejection like any
 * other unsupported field. Validation produces content only; nothing here
 * touches persistence or the Workspace.
 */
import { MODEL_EFFORTS, type AgentDefinitionContent, type Allocation, type ModelEffort } from "@agentique-console/core";
import YAML from "yaml";
import { ALWAYS_DENIED_NATIVE_TOOLS, CAPABILITY_NATIVE_TOOLS, capabilityToolOf, isMcpToolName, mcpServerOf } from "../provider/native-tools.ts";

export interface FieldReason {
  field: string;
  reason: string;
}

export type NativeAgentParse = { formatValid: false; error: string } | { formatValid: true; fields: Record<string, unknown>; body: string };

/** Boundary split only: the leading `---` fence through the next fence line; CRLF tolerated; the YAML between is not interpreted here. */
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
    return { formatValid: false, error: `frontmatter is not valid YAML: ${error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)}` };
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) return { formatValid: false, error: "frontmatter must be a YAML map" };
  return { formatValid: true, fields: document as Record<string, unknown>, body: split.body };
}

/** The defaults a native file does not express: the console's model policy and limits for a file-sourced definition. */
export interface NativeAgentDefaults {
  model: string;
  effort: ModelEffort;
  maxContextOccupancy: number;
  allocation: Allocation;
  maxWallClockMs: number | null;
}

/** Native fields that would change execution in ways the console cannot honor; each is a named rejection, never a silent drop. */
const UNSUPPORTED_NATIVE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  skills: "native `skills` preloads skill content into the provider session; an Attempt receives only its Context Manifest",
  hooks: "agent-scoped hooks would run provider-side around tool calls; the runtime's authorization boundary is the only hook",
  memory: "native agent memory directories are provider session state; the runtime has no equivalent",
  maxTurns: "native `maxTurns` bounds one provider session; Attempt limits are the definition's default limits and the Run Budget",
  background: "background execution is a native Agent-tool concern; the runtime schedules Invocations itself",
  observer: "observer agents are a native-execution feature",
  observerMessage: "observer agents are a native-execution feature",
  initialPrompt: "the first message of an Attempt is its Context Manifest",
  criticalSystemReminder_EXPERIMENTAL: "experimental native field; not reproduced",
  isolation: "native worktree isolation is a native Agent-tool concern; the runtime owns Workspaces and worktrees",
  agentique: "the `agentique:` frontmatter map is retired; the console reads native fields only",
});

/** Native fields that affect no execution: accepted and reported, never applied. */
const INFORMATIONAL_FIELDS: ReadonlySet<string> = new Set(["description", "color"]);

const ALL_CAPABILITIES: readonly string[] = Object.keys(CAPABILITY_NATIVE_TOOLS);
const DENIED_NATIVE: ReadonlySet<string> = new Set(ALWAYS_DENIED_NATIVE_TOOLS);

function toolList(value: unknown): string[] | null {
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return (value as string[]).map((entry) => entry.trim());
  return null;
}

/** A native tool name (or a console capability name) as the console's capability tool name, or a reason it cannot be. */
function capabilityOf(name: string): { capability: string } | { reason: string } {
  if (ALL_CAPABILITIES.includes(name)) return { capability: name };
  const mapped = capabilityToolOf(name);
  if (mapped !== null) return { capability: mapped };
  if (DENIED_NATIVE.has(name)) return { reason: `native tool ${name} cannot be executed by the console (coordination, task state, scheduling, human, host, worktree, background, and discovery surfaces are runtime-owned)` };
  return { reason: `unrecognized native tool ${name}` };
}

export interface EvaluatedNativeAgent {
  /** The native `name` field, or `null` when absent (the file stem then names the definition). */
  nativeName: string | null;
  content: Omit<AgentDefinitionContent, "provenance">;
  /** Informational fields present in the file (accepted, not applied). */
  informational: string[];
}

export type NativeAgentEvaluation = { ok: true; agent: EvaluatedNativeAgent } | { ok: false; reasons: FieldReason[] };

/**
 * Reads the native fields into Agent Definition content: `tools` (omitted
 * means every capability, the native "inherits all tools" meaning) minus
 * `disallowedTools`, `mcpServers` by name, `model` and `effort` into the
 * model policy (with the console's defaults where absent), `permissionMode`
 * only as `default`, the body as the instructions, and every declared
 * capability `allowed` in the Tool Policy (the runtime narrows it by role and
 * Workspace policy). Anything else is an explicit rejection.
 */
export function evaluateNativeAgent(fields: Record<string, unknown>, body: string, defaults: NativeAgentDefaults): NativeAgentEvaluation {
  const reasons: FieldReason[] = [];
  const informational: string[] = [];
  let nativeName: string | null = null;
  if (fields.name !== undefined) {
    if (typeof fields.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fields.name.trim())) nativeName = fields.name.trim();
    else reasons.push({ field: "name", reason: "must be a short identifier of letters, digits, dots, underscores, or hyphens" });
  }
  if (body.trim() === "") reasons.push({ field: "body", reason: "the body is the definition's instructions and must not be empty" });

  let capabilities: string[] | null = null;
  if (fields.tools !== undefined) {
    const parsed = toolList(fields.tools);
    if (parsed === null) reasons.push({ field: "tools", reason: "a list of tool names or a comma-separated string" });
    else {
      const set = new Set<string>();
      for (const name of parsed) {
        const mapped = capabilityOf(name);
        if ("reason" in mapped) reasons.push({ field: "tools", reason: mapped.reason });
        else set.add(mapped.capability);
      }
      capabilities = [...set];
    }
  }
  const declared = capabilities ?? [...ALL_CAPABILITIES];
  if (fields.disallowedTools !== undefined) {
    const parsed = toolList(fields.disallowedTools);
    if (parsed === null) reasons.push({ field: "disallowedTools", reason: "a list of tool names or a comma-separated string" });
    else {
      for (const name of parsed) {
        const mapped = capabilityOf(name);
        if ("reason" in mapped) {
          // Denying a tool the console never exposes changes nothing; it is informational.
          if (!DENIED_NATIVE.has(name)) reasons.push({ field: "disallowedTools", reason: mapped.reason });
          continue;
        }
        const natives = CAPABILITY_NATIVE_TOOLS[mapped.capability] ?? [];
        const explicitlyAllowed = capabilities !== null && toolList(fields.tools)!.some((allowed) => allowed !== name && (natives.includes(allowed) || allowed === mapped.capability));
        if (explicitlyAllowed) reasons.push({ field: "disallowedTools", reason: `cannot disallow ${name} while allowing another tool of the ${mapped.capability} capability; the console grants capabilities whole` });
        const index = declared.indexOf(mapped.capability);
        if (index >= 0) declared.splice(index, 1);
      }
    }
  }

  const mcpServers: string[] = [];
  if (fields.mcpServers !== undefined) {
    if (!Array.isArray(fields.mcpServers) || !fields.mcpServers.every((entry) => typeof entry === "string")) {
      reasons.push({ field: "mcpServers", reason: "a list of approved MCP server names; the console launches no server from a definition file" });
    } else {
      for (const name of fields.mcpServers as string[]) if (!mcpServers.includes(name)) mcpServers.push(name);
    }
  }
  for (const tool of declared) {
    if (!isMcpToolName(tool)) continue;
    const server = mcpServerOf(tool);
    if (server === null || !mcpServers.includes(server)) reasons.push({ field: "tools", reason: `MCP tool ${tool} names a server not declared in mcpServers` });
  }

  let model = defaults.model;
  if (fields.model !== undefined) {
    if (typeof fields.model !== "string" || fields.model.trim() === "") reasons.push({ field: "model", reason: "must be a model name string" });
    else if (fields.model.trim() !== "inherit") model = fields.model.trim();
  }
  let effort = defaults.effort;
  if (fields.effort !== undefined) {
    if (typeof fields.effort === "string" && (MODEL_EFFORTS as readonly string[]).includes(fields.effort)) effort = fields.effort as ModelEffort;
    else reasons.push({ field: "effort", reason: `one of ${MODEL_EFFORTS.join("|")}` });
  }
  if (fields.permissionMode !== undefined && fields.permissionMode !== "default") {
    reasons.push({ field: "permissionMode", reason: "only `default` can be honored: the runtime's Tool Policy and authorization boundary decide every call; a bypass, edit-accepting, plan, or ask-free mode cannot be reproduced" });
  }

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (["name", "tools", "disallowedTools", "model", "effort", "permissionMode", "mcpServers"].includes(key)) continue;
    if (INFORMATIONAL_FIELDS.has(key)) {
      informational.push(key);
      continue;
    }
    const unsupported = UNSUPPORTED_NATIVE_FIELDS[key];
    reasons.push({ field: key, reason: unsupported ?? "unrecognized native field; the console cannot guarantee its meaning is preserved" });
  }
  if (reasons.length > 0) return { ok: false, reasons };
  const tools = ALL_CAPABILITIES.filter((c) => declared.includes(c)).concat(declared.filter((c) => !ALL_CAPABILITIES.includes(c)).sort());
  return {
    ok: true,
    agent: {
      nativeName,
      informational: informational.sort(),
      content: {
        modelPolicy: { model, effort, maxContextOccupancy: defaults.maxContextOccupancy },
        instructions: body.replace(/\r\n/g, "\n"),
        capabilities: { tools, mcpServers: [...mcpServers].sort() },
        toolPolicy: Object.fromEntries(tools.map((tool) => [tool, "allowed" as const])),
        defaultLimits: { allocation: { ...defaults.allocation }, maxWallClockMs: defaults.maxWallClockMs },
      },
    },
  };
}
