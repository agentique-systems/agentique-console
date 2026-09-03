import { z } from "zod";
import { allocationSchema, type Allocation } from "./budgets.ts";
import type { AgentDefinitionId, AgentDefinitionRevisionId, ConversationId, DecisionId, SnapshotId } from "./ids.ts";
import {
  canonicalJson,
  idSchema,
  nonEmptyString,
  positiveCount,
  sha256Hex,
  timestampSchema,
  type Timestamp,
} from "./validation.ts";

/** Per-capability disposition an Agent Definition revision carries. */
export const TOOL_DISPOSITIONS = ["allowed", "denied", "approval_required"] as const;
export type ToolDisposition = (typeof TOOL_DISPOSITIONS)[number];

/** Tool name → disposition, for every provider-native tool the revision declares. */
export type ToolPolicy = Record<string, ToolDisposition>;

export const toolPolicySchema: z.ZodType<ToolPolicy> = z.record(nonEmptyString, z.enum(TOOL_DISPOSITIONS));

export const AGENT_DEFINITION_PROVENANCE_KINDS = ["builtin", "workspace_file", "conversation"] as const;
export type AgentDefinitionProvenanceKind = (typeof AGENT_DEFINITION_PROVENANCE_KINDS)[number];

export type AgentDefinitionProvenance =
  | { kind: "builtin" }
  | { kind: "workspace_file"; path: string; snapshotId: SnapshotId }
  | { kind: "conversation"; conversationId: ConversationId; approvedByDecisionId: DecisionId };

export const agentDefinitionProvenanceSchema: z.ZodType<AgentDefinitionProvenance> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("builtin") }),
  z.strictObject({ kind: z.literal("workspace_file"), path: nonEmptyString, snapshotId: idSchema("snapshot") }),
  z.strictObject({
    kind: z.literal("conversation"),
    conversationId: idSchema("conversation"),
    approvedByDecisionId: idSchema("decision"),
  }),
]);

export const MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export interface ModelPolicy {
  model: string;
  effort: ModelEffort;
  /** Maximum context occupancy (0..1) before a `fresh` Attempt is preferred over `resumed`. */
  maxContextOccupancy: number;
}

export const modelPolicySchema: z.ZodType<ModelPolicy> = z.strictObject({
  model: nonEmptyString,
  effort: z.enum(MODEL_EFFORTS),
  maxContextOccupancy: z.number().min(0).max(1),
});

export interface AgentCapabilities {
  /** Provider-native tool names the definition declares. */
  tools: string[];
  /** MCP server names the definition declares. */
  mcpServers: string[];
}

export const agentCapabilitiesSchema: z.ZodType<AgentCapabilities> = z.strictObject({
  tools: z.array(nonEmptyString).refine((t) => new Set(t).size === t.length, { message: "tools must be unique" }),
  mcpServers: z
    .array(nonEmptyString)
    .refine((s) => new Set(s).size === s.length, { message: "MCP servers must be unique" }),
});

export interface AgentDefaultLimits {
  allocation: Allocation;
  maxWallClockMs: number | null;
}

export const agentDefaultLimitsSchema: z.ZodType<AgentDefaultLimits> = z.strictObject({
  allocation: allocationSchema,
  maxWallClockMs: positiveCount.nullable(),
});

/** The stable logical identity shared by every revision of a definition. */
export interface AgentDefinition {
  id: AgentDefinitionId;
  name: string;
  createdAt: Timestamp;
}

export const agentDefinitionSchema: z.ZodType<AgentDefinition> = z.strictObject({
  id: idSchema("agentDefinition"),
  name: nonEmptyString,
  createdAt: timestampSchema,
});

/** The content of one immutable revision; the hash is computed over it. */
export interface AgentDefinitionContent {
  provenance: AgentDefinitionProvenance;
  modelPolicy: ModelPolicy;
  instructions: string;
  capabilities: AgentCapabilities;
  toolPolicy: ToolPolicy;
  defaultLimits: AgentDefaultLimits;
}

export const agentDefinitionContentSchema: z.ZodType<AgentDefinitionContent> = z
  .strictObject({
    provenance: agentDefinitionProvenanceSchema,
    modelPolicy: modelPolicySchema,
    instructions: z.string(),
    capabilities: agentCapabilitiesSchema,
    toolPolicy: toolPolicySchema,
    defaultLimits: agentDefaultLimitsSchema,
  })
  .refine((c) => Object.keys(c.toolPolicy).every((tool) => c.capabilities.tools.includes(tool)), {
    message: "the Tool Policy names only declared tools",
    path: ["toolPolicy"],
  });

export interface AgentDefinitionRevision extends AgentDefinitionContent {
  id: AgentDefinitionRevisionId;
  definitionId: AgentDefinitionId;
  contentHash: string;
  createdAt: Timestamp;
}

export const agentDefinitionRevisionSchema: z.ZodType<AgentDefinitionRevision> = z.strictObject({
  id: idSchema("agentDefinitionRevision"),
  definitionId: idSchema("agentDefinition"),
  contentHash: sha256Hex,
  provenance: agentDefinitionProvenanceSchema,
  modelPolicy: modelPolicySchema,
  instructions: z.string(),
  capabilities: agentCapabilitiesSchema,
  toolPolicy: toolPolicySchema,
  defaultLimits: agentDefaultLimitsSchema,
  createdAt: timestampSchema,
});

/** The bytes the content hash is computed over: canonical JSON of the content. */
export function agentDefinitionContentBytes(content: AgentDefinitionContent): string {
  return canonicalJson({
    provenance: content.provenance,
    modelPolicy: content.modelPolicy,
    instructions: content.instructions,
    capabilities: content.capabilities,
    toolPolicy: content.toolPolicy,
    defaultLimits: content.defaultLimits,
  });
}

/** Evaluators are read-only: every write-capable tool is denied for that role. */
export const READ_ONLY_ROLES = ["evaluator"] as const;

/**
 * The console's neutral capability tool names that only read (the
 * Workspace, the web). Every other declared tool — `write`, `shell`,
 * `worktree`, and any provider-specific name — is treated as write-capable,
 * so an unknown tool is never granted to a read-only role by accident.
 */
export const READ_ONLY_CAPABILITY_TOOLS = ["read", "search"] as const;

export function isWriteCapableTool(tool: string): boolean {
  return !(READ_ONLY_CAPABILITY_TOOLS as readonly string[]).includes(tool);
}

/**
 * The Run Workspace's capability policy (execution-model §6.4): tools and
 * MCP servers the Workspace denies outright, and tools whose every call
 * requires operator approval. It narrows; it never widens a definition.
 */
export interface WorkspaceCapabilityPolicy {
  deniedTools: string[];
  approvalRequiredTools: string[];
  deniedMcpServers: string[];
}

export const workspaceCapabilityPolicySchema: z.ZodType<WorkspaceCapabilityPolicy> = z.strictObject({
  deniedTools: z.array(nonEmptyString),
  approvalRequiredTools: z.array(nonEmptyString),
  deniedMcpServers: z.array(nonEmptyString),
});

export const EMPTY_WORKSPACE_CAPABILITY_POLICY: Readonly<WorkspaceCapabilityPolicy> = Object.freeze({
  deniedTools: [],
  approvalRequiredTools: [],
  deniedMcpServers: [],
});

/**
 * The Agent Definition file policy: a Workspace-file definition is one of the
 * Workspace's native `.claude/agents/<name>.md` files, named by a normalized
 * relative POSIX path with no `.` or `..` segments.
 */
export const AGENT_DEFINITION_FILE_PATTERN = /^\.claude\/agents\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/** Normalizes a definition file path under the file policy, or returns `null` when it is not a definition file. */
export function normalizeAgentDefinitionPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return AGENT_DEFINITION_FILE_PATTERN.test(normalized) ? normalized : null;
}

/** The name of the Agent Definition that holds the Orchestrator role (glossary: Orchestrator). */
export const ORCHESTRATOR_DEFINITION_NAME = "orchestrator";

/**
 * The capability tools the Orchestrator's definition must declare
 * (execution-model invariant 2: read, write, and shell capabilities so that
 * it may work directly). Capability names are the console's neutral names
 * that provider adapters map to native tools.
 */
export const ORCHESTRATOR_REQUIRED_TOOLS = ["read", "write", "shell"] as const;

/** Why an Agent Definition revision cannot hold the Orchestrator role; empty when it can. */
export function orchestratorDefinitionDefects(definitionName: string, revision: Pick<AgentDefinitionRevision, "capabilities" | "toolPolicy">): string[] {
  const defects: string[] = [];
  if (definitionName !== ORCHESTRATOR_DEFINITION_NAME) {
    defects.push(`definition ${definitionName} is not the ${ORCHESTRATOR_DEFINITION_NAME} definition`);
  }
  for (const tool of ORCHESTRATOR_REQUIRED_TOOLS) {
    if (!revision.capabilities.tools.includes(tool)) defects.push(`capability ${tool} is not declared`);
    else if (revision.toolPolicy[tool] === "denied") defects.push(`capability ${tool} is denied by the Tool Policy`);
  }
  return defects;
}
