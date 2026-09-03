import { describe, expect, it } from "vitest";
import { EMPTY_WORKSPACE_CAPABILITY_POLICY, type WorkspaceCapabilityPolicy } from "./agents.ts";
import { effectiveCapabilityPolicy, grantsWriteCapability } from "./capability-policy.ts";

const revision = {
  capabilities: { tools: ["shell", "read", "write", "search"], mcpServers: ["github"] },
  toolPolicy: { shell: "approval_required" as const, write: "allowed" as const },
};

describe("effective capability policy", () => {
  it("is the intersection of definition, role policy, and Workspace policy, keys in canonical order", () => {
    const orchestrator = effectiveCapabilityPolicy(revision, "orchestrator", EMPTY_WORKSPACE_CAPABILITY_POLICY);
    expect(orchestrator).toEqual({
      capabilities: { tools: ["read", "search", "shell", "write"], mcpServers: ["github"] },
      toolPolicy: { read: "allowed", search: "allowed", shell: "approval_required", write: "allowed" },
    });
    expect(Object.keys(orchestrator.toolPolicy)).toEqual(["read", "search", "shell", "write"]);
    expect(effectiveCapabilityPolicy(revision, "worker", EMPTY_WORKSPACE_CAPABILITY_POLICY)).toEqual(orchestrator);
  });

  it("makes Evaluators read-only and Coordinators coordination-only whatever the definition declares", () => {
    const evaluator = effectiveCapabilityPolicy(revision, "evaluator", EMPTY_WORKSPACE_CAPABILITY_POLICY);
    expect(evaluator).toEqual({
      capabilities: { tools: ["read", "search"], mcpServers: [] },
      toolPolicy: { read: "allowed", search: "allowed", shell: "denied", write: "denied" },
    });
    expect(grantsWriteCapability(evaluator)).toBe(false);
    const coordinator = effectiveCapabilityPolicy(revision, "coordinator", EMPTY_WORKSPACE_CAPABILITY_POLICY);
    expect(coordinator.capabilities).toEqual({ tools: ["read", "search", "write"], mcpServers: [] });
    expect(coordinator.toolPolicy.shell).toBe("denied");
    expect(grantsWriteCapability(coordinator)).toBe(true);
  });

  it("lets the Workspace narrow but never widen, and never reads approval_required as allowed", () => {
    const workspace: WorkspaceCapabilityPolicy = { deniedTools: ["write"], approvalRequiredTools: ["read"], deniedMcpServers: ["github"] };
    const policy = effectiveCapabilityPolicy(revision, "orchestrator", workspace);
    expect(policy.toolPolicy).toEqual({ read: "approval_required", search: "allowed", shell: "approval_required", write: "denied" });
    expect(policy.capabilities).toEqual({ tools: ["read", "search", "shell"], mcpServers: [] });
    // A definition that denies a tool stays denied even when the Workspace only asks for approval.
    const denied = effectiveCapabilityPolicy({ ...revision, toolPolicy: { shell: "denied" } }, "worker", { ...EMPTY_WORKSPACE_CAPABILITY_POLICY, approvalRequiredTools: ["shell"] });
    expect(denied.toolPolicy.shell).toBe("denied");
    expect(denied.capabilities.tools).not.toContain("shell");
    // An undeclared tool is never granted.
    expect(effectiveCapabilityPolicy({ capabilities: { tools: ["read"], mcpServers: [] }, toolPolicy: {} }, "orchestrator", EMPTY_WORKSPACE_CAPABILITY_POLICY).capabilities.tools).toEqual(["read"]);
  });

  it("treats every unknown tool and MCP server as write-capable", () => {
    expect(grantsWriteCapability({ capabilities: { tools: ["read", "browse"], mcpServers: [] } })).toBe(true);
    expect(grantsWriteCapability({ capabilities: { tools: ["read"], mcpServers: ["github"] } })).toBe(true);
    expect(grantsWriteCapability({ capabilities: { tools: ["read", "search"], mcpServers: [] } })).toBe(false);
    expect(effectiveCapabilityPolicy({ capabilities: { tools: ["browse"], mcpServers: [] }, toolPolicy: {} }, "evaluator", EMPTY_WORKSPACE_CAPABILITY_POLICY).capabilities.tools).toEqual([]);
  });
});
