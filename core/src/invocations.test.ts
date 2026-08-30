import { invocationFundingDefects } from "./invocations.ts";
import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import {
  ACTIVE_INVOCATION_STATUSES,
  assertPurposeForRole,
  ATTEMPT_FAILURE_MAX_MESSAGE_LENGTH,
  ATTEMPT_KINDS,
  ATTEMPT_START_MODES,
  ATTEMPT_STATUSES,
  attemptSchema,
  boundedFailureMessage,
  boundResultViolations,
  contextManifestContentSchema,
  INVOCATION_MACHINE,
  INVOCATION_PURPOSES,
  INVOCATION_ROLES,
  invocationInputSchema,
  invocationSchema,
  isContinuationExpired,
  isContinuationSafeTermination,
  PURPOSES_BY_ROLE,
  RESULT_MAX_VIOLATIONS,
  retryBackoffMs,
  retryDecisionSchema,
  roleOfPurpose,
  RUNTIME_TOOLS_BY_ROLE,
} from "./invocations.ts";

describe("purposes", () => {
  it("is the exact closed enum of fourteen purposes", () => {
    expect([...INVOCATION_PURPOSES].sort()).toEqual(
      ["operator_input", "plan_revision", "node_result", "decision_resolution", "gate_result", "publication_result", "final_synthesis", "step", "task", "select", "evaluate", "decompose", "replan", "synthesize"].sort(),
    );
    expect(INVOCATION_ROLES).toEqual(["orchestrator", "worker", "coordinator", "evaluator"]);
  });

  it("maps every purpose to exactly one role", () => {
    const seen = new Map<string, string>();
    for (const role of INVOCATION_ROLES) {
      for (const purpose of PURPOSES_BY_ROLE[role]) {
        expect(seen.has(purpose), purpose).toBe(false);
        seen.set(purpose, role);
        expect(roleOfPurpose(purpose)).toBe(role);
      }
    }
    expect(seen.size).toBe(INVOCATION_PURPOSES.length);
    expect(() => assertPurposeForRole("worker", "decompose")).toThrow(/not valid for role worker/);
    expect(() => assertPurposeForRole("orchestrator", "operator_input")).not.toThrow();
  });

  it("rejects arbitrary purpose strings and role/purpose mismatches at the schema", () => {
    const input = {
      runId: newId("run"),
      planNodeId: newId("planNode"),
      role: "worker",
      purpose: "step",
      agentDefinitionRevisionId: newId("agentDefinitionRevision"),
      continuedFromInvocationId: null,
      patternPosition: { kind: "single" },
      taskIds: [],
      allocation: { costUsd: 1, tokens: 100, attempts: 2 },
    };
    expect(invocationInputSchema.safeParse(input).success).toBe(true);
    // The position agrees with the role and purpose; only a Gate Evaluator has none.
    expect(invocationInputSchema.safeParse({ ...input, patternPosition: { kind: "orchestrator" } }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, patternPosition: { kind: "chain_step", index: 2, count: 2 } }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, patternPosition: null }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, role: "evaluator", purpose: "evaluate", patternPosition: null }).success).toBe(true);
    expect(invocationInputSchema.safeParse({ ...input, purpose: "turn" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, purpose: "chat" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, purpose: "evaluate" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, role: "specialist" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, allocation: { costUsd: 1, tokens: 100, attempts: 0 } }).success).toBe(false);
  });

  it("binds the final-reserve allocation source to exactly two role/purpose pairs", () => {
    const base = {
      runId: newId("run"),
      planNodeId: newId("planNode"),
      agentDefinitionRevisionId: newId("agentDefinitionRevision"),
      continuedFromInvocationId: null,
      taskIds: [],
      allocation: { costUsd: 1, tokens: 100, attempts: 2 },
    };
    const synthesis = { ...base, role: "orchestrator", purpose: "final_synthesis", patternPosition: { kind: "orchestrator" }, allocationSource: "run_final_reserve", finalReserveUse: "final_synthesis" };
    const completion = { ...base, role: "evaluator", purpose: "evaluate", patternPosition: null, allocationSource: "run_final_reserve", finalReserveUse: "run_completion" };
    expect(invocationInputSchema.safeParse(synthesis).success).toBe(true);
    expect(invocationInputSchema.safeParse(completion).success).toBe(true);
    // Source and use go together.
    expect(invocationInputSchema.safeParse({ ...synthesis, finalReserveUse: null }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...synthesis, allocationSource: "plan_node" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...base, role: "orchestrator", purpose: "final_synthesis", finalReserveUse: "final_synthesis" }).success).toBe(false);
    // Wrong role or purpose for the use.
    expect(invocationInputSchema.safeParse({ ...synthesis, purpose: "operator_input" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...completion, finalReserveUse: "final_synthesis" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...synthesis, role: "evaluator", purpose: "evaluate" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...completion, purpose: "select" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...base, role: "worker", purpose: "step", allocationSource: "run_final_reserve", finalReserveUse: "run_completion" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...base, role: "coordinator", purpose: "decompose", allocationSource: "run_final_reserve", finalReserveUse: "final_synthesis" }).success).toBe(false);
    // A final-reserve Invocation executes no Task; an ordinary evaluate Invocation is plan_node by default.
    expect(invocationInputSchema.safeParse({ ...completion, taskIds: [newId("task")] }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...base, role: "evaluator", purpose: "evaluate", patternPosition: null }).success).toBe(true);
    expect(invocationFundingDefects({ role: "evaluator", purpose: "select", allocationSource: "run_final_reserve", finalReserveUse: "run_completion" })).toHaveLength(1);
    expect(invocationFundingDefects({ role: "worker", purpose: "step", allocationSource: "plan_node", finalReserveUse: null })).toEqual([]);
  });
});

describe("invocation record", () => {
  it("records continuedFromInvocationId and forbids self-continuation", () => {
    const record = {
      id: newId("invocation"),
      runId: newId("run"),
      planNodeId: newId("planNode"),
      role: "orchestrator",
      purpose: "node_result",
      agentDefinitionRevisionId: newId("agentDefinitionRevision"),
      continuedFromInvocationId: newId("invocation"),
      patternPosition: { kind: "orchestrator" },
      taskIds: [],
      allocation: { costUsd: 1, tokens: 100, attempts: 2 },
      allocationSource: "plan_node",
      finalReserveUse: null,
      status: "pending",
      waitReason: null,
      failureReason: null,
      blockedByDecisionId: null,
      result: null,
      workspaceCleanup: "none",
      workspaceReleasedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      endedAt: null,
    };
    expect(invocationSchema.safeParse(record).success).toBe(true);
    // The Workspace cleanup obligation: released exactly when a release time is recorded.
    expect(invocationSchema.safeParse({ ...record, workspaceCleanup: "pending" }).success).toBe(true);
    expect(invocationSchema.safeParse({ ...record, workspaceCleanup: "released" }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, workspaceCleanup: "released", workspaceReleasedAt: record.createdAt }).success).toBe(true);
    expect(invocationSchema.safeParse({ ...record, workspaceReleasedAt: record.createdAt }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, continuedFromInvocationId: record.id }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, status: "waiting" }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, status: "waiting", waitReason: "decision" }).success).toBe(true);
    expect(invocationSchema.safeParse({ ...record, status: "failed", failureReason: "attempts_exhausted" }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, status: "failed", failureReason: "attempts_exhausted", endedAt: record.createdAt }).success).toBe(true);
    // `blocked` is terminal and names its side_effect_approval Decision, exactly then.
    expect(invocationSchema.safeParse({ ...record, status: "blocked", endedAt: record.createdAt }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, status: "blocked", blockedByDecisionId: newId("decision"), endedAt: record.createdAt }).success).toBe(true);
    expect(invocationSchema.safeParse({ ...record, status: "blocked", blockedByDecisionId: newId("decision") }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, blockedByDecisionId: newId("decision") }).success).toBe(false);
    expect(INVOCATION_MACHINE.isTerminal("blocked")).toBe(true);
    expect(INVOCATION_MACHINE.canTransition("running", "blocked")).toBe(true);
    expect(INVOCATION_MACHINE.canTransition("waiting", "blocked")).toBe(false);
    expect(ACTIVE_INVOCATION_STATUSES).not.toContain("blocked" as never);
  });
});

describe("attempts", () => {
  it("has exactly two kinds, two start modes, and seven statuses; turn is not a kind", () => {
    expect(ATTEMPT_KINDS).toEqual(["initial", "retry"]);
    expect(ATTEMPT_START_MODES).toEqual(["fresh", "resumed"]);
    expect(ATTEMPT_STATUSES).toEqual(["pending", "running", "succeeded", "failed", "timed_out", "interrupted", "cancelled"]);
    expect((ATTEMPT_KINDS as readonly string[]).includes("turn")).toBe(false);
  });

  it("numbers initial as 1 and ties resumedFromAttemptId to the resumed start mode", () => {
    const attempt = {
      id: newId("attempt"),
      invocationId: newId("invocation"),
      runId: newId("run"),
      planNodeId: newId("planNode"),
      number: 1,
      kind: "initial",
      startMode: "fresh",
      resumedFromAttemptId: null,
      status: "pending",
      failureClass: null,
      failureDetail: null,
      retryDecision: null,
      transcriptArtifactId: null,
      capacityLeaseId: null,
      result: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      endedAt: null,
    };
    expect(attemptSchema.safeParse(attempt).success).toBe(true);
    expect(attemptSchema.safeParse({ ...attempt, kind: "turn" }).success).toBe(false);
    expect(attemptSchema.safeParse({ ...attempt, number: 2 }).success).toBe(false);
    expect(attemptSchema.safeParse({ ...attempt, number: 2, kind: "retry" }).success).toBe(true);
    expect(attemptSchema.safeParse({ ...attempt, startMode: "resumed" }).success).toBe(false);
    expect(attemptSchema.safeParse({ ...attempt, number: 2, kind: "retry", startMode: "resumed", resumedFromAttemptId: newId("attempt") }).success).toBe(true);
    expect(attemptSchema.safeParse({ ...attempt, status: "interrupted", endedAt: attempt.createdAt }).success).toBe(false);
    expect(attemptSchema.safeParse({ ...attempt, status: "interrupted", failureClass: "interrupted", endedAt: attempt.createdAt }).success).toBe(true);
  });

  it("records bounded failure detail and a durable retry decision only on a terminal, unsuccessful Attempt", () => {
    const terminal = {
      id: newId("attempt"),
      invocationId: newId("invocation"),
      runId: newId("run"),
      planNodeId: newId("planNode"),
      number: 1,
      kind: "initial",
      startMode: "fresh",
      resumedFromAttemptId: null,
      status: "failed",
      failureClass: "result_invalid",
      failureDetail: { message: "result invalid", violations: [{ code: "unknown_artifact", message: "art_x does not exist", path: "artifactIds.0" }], tool: null, cancelled: false },
      retryDecision: { permitted: true, reason: "result_invalid", notBefore: null },
      transcriptArtifactId: null,
      capacityLeaseId: null,
      result: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
    };
    expect(attemptSchema.safeParse(terminal).success).toBe(true);
    // A running Attempt carries neither; a succeeded Attempt carries neither.
    expect(attemptSchema.safeParse({ ...terminal, status: "running", failureClass: null, endedAt: null }).success).toBe(false);
    const result = { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "ok", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null };
    expect(attemptSchema.safeParse({ ...terminal, status: "succeeded", failureClass: null, failureDetail: null, retryDecision: null, result }).success).toBe(true);
    expect(attemptSchema.safeParse({ ...terminal, status: "succeeded", failureClass: null, failureDetail: null, result }).success).toBe(false);
    // The decision's reason agrees with its permission and a refusal carries no notBefore.
    expect(retryDecisionSchema.safeParse({ permitted: false, reason: "provider_permanent", notBefore: null }).success).toBe(true);
    expect(retryDecisionSchema.safeParse({ permitted: false, reason: "result_invalid", notBefore: null }).success).toBe(false);
    expect(retryDecisionSchema.safeParse({ permitted: true, reason: "provider_permanent", notBefore: null }).success).toBe(false);
    expect(retryDecisionSchema.safeParse({ permitted: false, reason: "cancelled", notBefore: "2026-01-01T00:00:00.000Z" }).success).toBe(false);
    expect(retryDecisionSchema.safeParse({ permitted: true, reason: "provider_transient", notBefore: "2026-01-01T00:00:00.000Z" }).success).toBe(true);
    // A cancelled Attempt never permits a retry; detail is bounded and single-line.
    expect(attemptSchema.safeParse({ ...terminal, status: "cancelled", failureClass: null, retryDecision: { permitted: true, reason: "interrupted", notBefore: null } }).success).toBe(false);
    expect(attemptSchema.safeParse({ ...terminal, status: "cancelled", failureClass: null, retryDecision: { permitted: false, reason: "cancelled", notBefore: null } }).success).toBe(true);
    expect(boundedFailureMessage("line one\nstack line two")).toBe("line one");
    expect(boundedFailureMessage("x".repeat(600)).length).toBe(ATTEMPT_FAILURE_MAX_MESSAGE_LENGTH);
    expect(boundedFailureMessage("   ")).toBe("failure");
    expect(boundResultViolations(Array.from({ length: 30 }, (_, i) => ({ code: "malformed" as const, message: `v${i}`, path: null })))).toHaveLength(RESULT_MAX_VIOLATIONS);
  });

  it("computes deterministic backoff and continuation-safe terminations", () => {
    expect([1, 2, 3, 4].map((n) => retryBackoffMs(n, 1000, 5000))).toEqual([1000, 2000, 4000, 5000]);
    const base = { status: "failed" as const, failureClass: "result_invalid" as const, failureDetail: null };
    expect(isContinuationSafeTermination({ ...base, status: "succeeded", failureClass: null })).toBe(true);
    expect(isContinuationSafeTermination(base)).toBe(true);
    expect(isContinuationSafeTermination({ ...base, status: "interrupted", failureClass: "interrupted" })).toBe(true);
    expect(isContinuationSafeTermination({ ...base, failureClass: "provider_transient" })).toBe(true);
    expect(isContinuationSafeTermination({ ...base, failureClass: "provider_permanent" })).toBe(false);
    expect(isContinuationSafeTermination({ ...base, failureClass: "tool_failure" })).toBe(false);
    expect(isContinuationSafeTermination({ ...base, failureClass: "allocation_exhausted" })).toBe(false);
    expect(isContinuationSafeTermination({ ...base, status: "cancelled", failureClass: null })).toBe(false);
    expect(isContinuationSafeTermination({ ...base, status: "interrupted", failureClass: "interrupted", failureDetail: { message: "cancelled", violations: [], tool: null, cancelled: true } })).toBe(false);
    expect(isContinuationSafeTermination({ ...base, status: "running", failureClass: null })).toBe(false);
  });

  it("treats a continuation as expired at or after its expiry", () => {
    expect(isContinuationExpired({ expiresAt: null }, "2026-01-01T00:00:00.000Z")).toBe(false);
    expect(isContinuationExpired({ expiresAt: "2026-01-01T00:00:00.000Z" }, "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isContinuationExpired({ expiresAt: "2026-01-02T00:00:00.000Z" }, "2026-01-01T00:00:00.000Z")).toBe(false);
  });
});

describe("context manifest", () => {
  const content = {
    agentDefinitionRevisionId: newId("agentDefinitionRevision"),
    agentDefinitionContentHash: "a".repeat(64),
    instructions: "Do the thing.",
    modelPolicy: { model: "claude-fable-5", effort: "medium", maxContextOccupancy: 0.8 },
    role: "worker",
    purpose: "step",
    patternPosition: { kind: "chain_step", index: 0, count: 2 },
    continuedFromInvocationId: null,
    runId: newId("run"),
    planNodeId: newId("planNode"),
    tasks: [],
    requirementRevisionId: null,
    requirements: [],
    acceptanceCriteria: [],
    decisions: [],
    inputs: [],
    handoffs: [],
    artifacts: [],
    startingSnapshotId: null,
    worktreePath: null,
    allocation: { costUsd: 1, tokens: 100, attempts: 2 },
    allocationSource: "plan_node",
    finalReserveUse: null,
    maxWallClockMs: null,
    capabilities: { tools: ["read"], mcpServers: [] },
    toolPolicy: { read: "allowed", shell: "denied" },
    runtimeTools: ["return_result"],
    approvedCalls: [],
  };

  it("is strict: no unknown fields and no provider payloads can be carried", () => {
    expect(contextManifestContentSchema.safeParse(content).success).toBe(true);
    expect(contextManifestContentSchema.safeParse({ ...content, providerContinuation: "opaque" }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, transcript: [] }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, storageKey: "k" }).success).toBe(false);
  });

  it("keeps capabilities, Tool Policy, runtime tools, funding, and ordering consistent", () => {
    // Every effective capability carries a non-denied disposition.
    expect(contextManifestContentSchema.safeParse({ ...content, capabilities: { tools: ["shell"], mcpServers: [] } }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, capabilities: { tools: ["write"], mcpServers: [] } }).success).toBe(false);
    // Runtime tools are restricted by role.
    expect(contextManifestContentSchema.safeParse({ ...content, runtimeTools: ["revise_execution_plan"] }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, role: "orchestrator", purpose: "operator_input", patternPosition: { kind: "orchestrator" }, runtimeTools: ["revise_execution_plan", "return_result"] }).success).toBe(true);
    // The typed position must agree with the role and purpose.
    expect(contextManifestContentSchema.safeParse({ ...content, role: "orchestrator", purpose: "operator_input", runtimeTools: ["return_result"] }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, role: "evaluator", purpose: "evaluate", runtimeTools: ["update_task"] }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, runtimeTools: ["peer_message"] }).success).toBe(false);
    // Funding agrees.
    expect(contextManifestContentSchema.safeParse({ ...content, finalReserveUse: "final_synthesis" }).success).toBe(false);
    // Collections are in canonical id order.
    const a = { artifactId: "art_" + "a".repeat(24), mediaType: "text/plain", byteSize: 1, title: null };
    const b = { ...a, artifactId: "art_" + "b".repeat(24) };
    expect(contextManifestContentSchema.safeParse({ ...content, artifacts: [a, b] }).success).toBe(true);
    expect(contextManifestContentSchema.safeParse({ ...content, artifacts: [b, a] }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, inputs: [{ kind: "operator_message", conversationMessageId: newId("conversationMessage"), content: "hello" }] }).success).toBe(true);
    expect(contextManifestContentSchema.safeParse({ ...content, inputs: [{ kind: "chat_history", messages: [] }] }).success).toBe(false);
    // Approved calls come only from approve_once resolutions among the inputs, ordered by digest.
    const resolution = { kind: "side_effect_approval_resolution", decisionId: newId("decision"), blockedInvocationId: newId("invocation"), attemptId: newId("attempt"), tool: "shell", callDigest: "c".repeat(64), callArtifactId: newId("artifact"), outcome: "approve_once" };
    const approved = { decisionId: resolution.decisionId, tool: "shell", callDigest: resolution.callDigest };
    expect(contextManifestContentSchema.safeParse({ ...content, inputs: [resolution], approvedCalls: [approved] }).success).toBe(true);
    expect(contextManifestContentSchema.safeParse({ ...content, inputs: [{ ...resolution, outcome: "deny" }], approvedCalls: [approved] }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, approvedCalls: [approved] }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, inputs: [resolution], approvedCalls: [{ ...approved, callDigest: "d".repeat(64) }] }).success).toBe(false);
  });

  it("restricts runtime tools by the §6.4 role matrix", () => {
    expect(RUNTIME_TOOLS_BY_ROLE.orchestrator).toContain("revise_execution_plan");
    expect(RUNTIME_TOOLS_BY_ROLE.coordinator).toContain("propose_tasks");
    expect(RUNTIME_TOOLS_BY_ROLE.coordinator).not.toContain("create_tasks");
    expect(RUNTIME_TOOLS_BY_ROLE.worker).not.toContain("propose_tasks");
    expect(RUNTIME_TOOLS_BY_ROLE.evaluator).not.toContain("update_task");
    expect(RUNTIME_TOOLS_BY_ROLE.evaluator).not.toContain("request_decision");
    for (const role of INVOCATION_ROLES) {
      expect(RUNTIME_TOOLS_BY_ROLE[role]).toContain("return_result");
      expect(RUNTIME_TOOLS_BY_ROLE[role]).toContain("read_artifact");
      if (role !== "orchestrator") expect(RUNTIME_TOOLS_BY_ROLE[role]).not.toContain("record_decision");
    }
    expect(RUNTIME_TOOLS_BY_ROLE.orchestrator).toContain("record_decision");
  });
});
