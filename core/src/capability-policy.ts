import {
  isWriteCapableTool,
  READ_ONLY_CAPABILITY_TOOLS,
  type AgentCapabilities,
  type AgentDefinitionRevision,
  type ToolDisposition,
  type ToolPolicy,
  type WorkspaceCapabilityPolicy,
} from "./agents.ts";
import type { InvocationPurpose, InvocationRole } from "./invocations.ts";

/**
 * The role policy of execution-model §6.4, applied to provider capabilities:
 * the Orchestrator and a Worker may use whatever their definition and the
 * Workspace allow; a Coordinator uses only what coordination needs (reading
 * and writing inside its own node's worktree, no shell and no MCP servers);
 * an Evaluator or route selector is always read-only.
 */
export interface RoleCapabilityPolicy {
  /** The capability tools the role may hold, or `null` for every declared tool. */
  tools: readonly string[] | null;
  mcpServers: boolean;
}

export const ROLE_CAPABILITY_POLICY: Readonly<Record<InvocationRole, RoleCapabilityPolicy>> = {
  orchestrator: { tools: null, mcpServers: true },
  worker: { tools: null, mcpServers: true },
  coordinator: { tools: [...READ_ONLY_CAPABILITY_TOOLS, "write"], mcpServers: false },
  evaluator: { tools: READ_ONLY_CAPABILITY_TOOLS, mcpServers: false },
};

/**
 * Purposes whose Invocations are read-only whatever the role holds
 * (execution-model §10): the Orchestrator's `final_synthesis` turn runs after
 * verification and must not change the verified state, so it holds only the
 * read-only tools and no MCP server — a policy the runtime computes and
 * persists in the manifest, never a prompt instruction.
 */
export const READ_ONLY_PURPOSES = ["final_synthesis"] as const satisfies readonly InvocationPurpose[];

/** The effective capability policy of a role narrowed by the Invocation's purpose. */
export function capabilityPolicyFor(role: InvocationRole, purpose: InvocationPurpose | null): RoleCapabilityPolicy {
  const rolePolicy = ROLE_CAPABILITY_POLICY[role];
  if (purpose !== null && (READ_ONLY_PURPOSES as readonly string[]).includes(purpose)) {
    return { tools: rolePolicy.tools === null ? READ_ONLY_CAPABILITY_TOOLS : rolePolicy.tools.filter((tool) => (READ_ONLY_CAPABILITY_TOOLS as readonly string[]).includes(tool)), mcpServers: false };
  }
  return rolePolicy;
}

/** The effective provider capability policy of one Attempt. */
export interface EffectiveCapabilityPolicy {
  /** Tools and MCP servers the provider may expose: every declared tool whose effective disposition is not `denied`. */
  capabilities: AgentCapabilities;
  /** The effective disposition of every declared tool, denied ones included, keys in code-unit order. */
  toolPolicy: ToolPolicy;
}

function narrow(current: ToolDisposition, by: ToolDisposition): ToolDisposition {
  if (current === "denied" || by === "denied") return "denied";
  if (current === "approval_required" || by === "approval_required") return "approval_required";
  return "allowed";
}

/**
 * `Agent Definition capabilities ∩ role policy ∩ Workspace policy`, per tool:
 * the definition's disposition (default `allowed` for a declared tool with no
 * entry), narrowed to `denied` by a role (or a read-only purpose) that does
 * not hold the tool or a Workspace that denies it, and to
 * `approval_required` by a Workspace that requires approval. A disposition
 * is never widened, and `approval_required` is never read as `allowed`.
 */
export function effectiveCapabilityPolicy(
  revision: Pick<AgentDefinitionRevision, "capabilities" | "toolPolicy">,
  role: InvocationRole,
  workspace: WorkspaceCapabilityPolicy,
  purpose: InvocationPurpose | null = null,
): EffectiveCapabilityPolicy {
  const rolePolicy = capabilityPolicyFor(role, purpose);
  const toolPolicy: ToolPolicy = {};
  for (const tool of [...revision.capabilities.tools].sort()) {
    let disposition: ToolDisposition = revision.toolPolicy[tool] ?? "allowed";
    if (rolePolicy.tools !== null && !rolePolicy.tools.includes(tool)) disposition = narrow(disposition, "denied");
    if (workspace.deniedTools.includes(tool)) disposition = narrow(disposition, "denied");
    if (workspace.approvalRequiredTools.includes(tool)) disposition = narrow(disposition, "approval_required");
    toolPolicy[tool] = disposition;
  }
  const tools = Object.keys(toolPolicy).filter((tool) => toolPolicy[tool] !== "denied");
  const mcpServers = rolePolicy.mcpServers ? [...revision.capabilities.mcpServers].filter((s) => !workspace.deniedMcpServers.includes(s)).sort() : [];
  return { capabilities: { tools, mcpServers }, toolPolicy };
}

/** True when the effective policy grants any write-capable capability, so the Invocation needs an isolated worktree and produces a Changeset. */
export function grantsWriteCapability(policy: Pick<EffectiveCapabilityPolicy, "capabilities">): boolean {
  return policy.capabilities.tools.some(isWriteCapableTool) || policy.capabilities.mcpServers.length > 0;
}
