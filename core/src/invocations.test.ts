import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import {
  assertPurposeForRole,
  ATTEMPT_KINDS,
  ATTEMPT_START_MODES,
  ATTEMPT_STATUSES,
  attemptSchema,
  contextManifestContentSchema,
  INVOCATION_PURPOSES,
  INVOCATION_ROLES,
  invocationInputSchema,
  invocationSchema,
  isContinuationExpired,
  PURPOSES_BY_ROLE,
  roleOfPurpose,
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
      taskIds: [],
      allocation: { costUsd: 1, tokens: 100, attempts: 2 },
    };
    expect(invocationInputSchema.safeParse(input).success).toBe(true);
    expect(invocationInputSchema.safeParse({ ...input, purpose: "turn" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, purpose: "chat" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, purpose: "evaluate" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, role: "specialist" }).success).toBe(false);
    expect(invocationInputSchema.safeParse({ ...input, allocation: { costUsd: 1, tokens: 100, attempts: 0 } }).success).toBe(false);
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
      taskIds: [],
      allocation: { costUsd: 1, tokens: 100, attempts: 2 },
      status: "pending",
      waitReason: null,
      failureReason: null,
      result: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      endedAt: null,
    };
    expect(invocationSchema.safeParse(record).success).toBe(true);
    expect(invocationSchema.safeParse({ ...record, continuedFromInvocationId: record.id }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, status: "waiting" }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, status: "waiting", waitReason: "decision" }).success).toBe(true);
    expect(invocationSchema.safeParse({ ...record, status: "failed", failureReason: "attempts_exhausted" }).success).toBe(false);
    expect(invocationSchema.safeParse({ ...record, status: "failed", failureReason: "attempts_exhausted", endedAt: record.createdAt }).success).toBe(true);
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

  it("treats a continuation as expired at or after its expiry", () => {
    expect(isContinuationExpired({ expiresAt: null }, "2026-01-01T00:00:00.000Z")).toBe(false);
    expect(isContinuationExpired({ expiresAt: "2026-01-01T00:00:00.000Z" }, "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isContinuationExpired({ expiresAt: "2026-01-02T00:00:00.000Z" }, "2026-01-01T00:00:00.000Z")).toBe(false);
  });
});

describe("context manifest", () => {
  it("is strict: no unknown fields and no provider payloads can be carried", () => {
    const content = {
      agentDefinitionRevisionId: newId("agentDefinitionRevision"),
      agentDefinitionContentHash: "a".repeat(64),
      instructions: "Do the thing.",
      role: "worker",
      purpose: "step",
      patternPosition: "chain step 1 of 2",
      continuedFromInvocationId: null,
      runId: newId("run"),
      planNodeId: newId("planNode"),
      tasks: [],
      requirementRevisionId: null,
      requirements: [],
      decisions: [],
      handoffIds: [],
      readableArtifactIds: [],
      startingSnapshotId: null,
      worktreePath: null,
      allocation: { costUsd: 1, tokens: 100, attempts: 2 },
      maxWallClockMs: null,
      toolPolicy: {},
      runtimeTools: ["return_result"],
    };
    expect(contextManifestContentSchema.safeParse(content).success).toBe(true);
    expect(contextManifestContentSchema.safeParse({ ...content, providerContinuation: "opaque" }).success).toBe(false);
    expect(contextManifestContentSchema.safeParse({ ...content, transcript: [] }).success).toBe(false);
  });
});
