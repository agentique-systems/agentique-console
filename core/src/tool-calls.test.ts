import { describe, expect, it } from "vitest";
import { decisionRequestSchema, decisionSubjectSchema } from "./decisions.ts";
import { newId } from "./ids.ts";
import { canonicalToolCall, proposedToolCallSchema, SIDE_EFFECT_APPROVAL_OPTIONS, TOOL_CALL_MAX_BYTES } from "./tool-calls.ts";

describe("proposed tool calls", () => {
  it("canonicalizes by sorted keys with no whitespace, so equal calls have equal bytes whatever their key order", () => {
    const a = canonicalToolCall({ tool: "shell", input: { cwd: "/w", command: "rm -rf build", env: { B: "2", A: "1" } } });
    const b = canonicalToolCall({ tool: "shell", input: { env: { A: "1", B: "2" }, command: "rm -rf build", cwd: "/w" } });
    expect(a).toBe(b);
    expect(a).toBe('{"input":{"command":"rm -rf build","cwd":"/w","env":{"A":"1","B":"2"}},"tool":"shell"}');
    expect(canonicalToolCall({ tool: "shell", input: { command: "rm -rf build " } })).not.toBe(a);
    expect(canonicalToolCall({ tool: "write", input: { command: "rm -rf build", cwd: "/w", env: { A: "1", B: "2" } } })).not.toBe(a);
    expect(canonicalToolCall({ tool: "read", input: null })).toBe('{"input":null,"tool":"read"}');
    expect(TOOL_CALL_MAX_BYTES).toBe(65_536);
  });

  it("accepts only JSON input and a non-empty tool name", () => {
    expect(proposedToolCallSchema.safeParse({ tool: "shell", input: { command: "ls", args: ["-l", 1, true, null] } }).success).toBe(true);
    expect(proposedToolCallSchema.safeParse({ tool: "", input: {} }).success).toBe(false);
    expect(proposedToolCallSchema.safeParse({ tool: "shell", input: { when: new Date() } }).success).toBe(false);
    expect(proposedToolCallSchema.safeParse({ tool: "shell", input: { n: Number.POSITIVE_INFINITY } }).success).toBe(false);
    expect(proposedToolCallSchema.safeParse({ tool: "shell", input: {}, display: "rm" }).success).toBe(false);
  });
});

describe("side-effect approval Decisions", () => {
  const subject = { kind: "side_effect_approval" as const, tool: "shell", callDigest: "a".repeat(64), callArtifactId: newId("artifact"), runId: newId("run"), planNodeId: newId("planNode"), invocationId: newId("invocation"), attemptId: newId("attempt") };
  const request = {
    conversationId: newId("conversation"),
    runId: subject.runId,
    kind: "side_effect_approval" as const,
    resolutionPolicy: "operator_required" as const,
    requestedBy: { kind: "invocation" as const, invocationId: subject.invocationId },
    question: "Approve?",
    options: [
      { id: "approve_once", label: "Approve once", description: null },
      { id: "deny", label: "Deny", description: null },
    ],
    recommendedOptionId: null,
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [subject.planNodeId] },
    deadlineAt: null,
    activationCondition: null,
    subject,
    supersedesDecisionId: null,
  };

  it("carries exactly the typed subject, the two stable options, and a Run; no other kind carries a subject", () => {
    expect(SIDE_EFFECT_APPROVAL_OPTIONS).toEqual(["approve_once", "deny"]);
    expect(decisionSubjectSchema.safeParse(subject).success).toBe(true);
    expect(decisionSubjectSchema.safeParse({ ...subject, call: "rm -rf" }).success).toBe(false);
    expect(decisionRequestSchema.safeParse(request).success).toBe(true);
    expect(decisionRequestSchema.safeParse({ ...request, subject: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, runId: null }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, options: [{ id: "approve", label: "Approve", description: null }, { id: "deny", label: "Deny", description: null }] }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, options: [...request.options, { id: "approve_always", label: "Always", description: null }] }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, resolutionPolicy: "use_default_after_deadline", recommendedOptionId: "approve_once", rationale: "r", deadlineAt: "2026-01-01T00:00:00.000Z" }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, kind: "operator_choice" }).success).toBe(false);
    expect(decisionRequestSchema.safeParse({ ...request, kind: "operator_choice", subject: null }).success).toBe(true);
  });
});
