/**
 * Agent-requested Decisions at the store and the database (execution-model
 * §8.2; invariant 19): the requester is a running Invocation of the Run; a
 * requirement_waiver carries its pinned subject; an Invocation ends
 * `blocked` only on the open Decision it requested (or the approval of its
 * intercepted call); a resolution names one of the Decision's options; a
 * waiver status change names the operator's `waive` resolution; an accepted
 * request_decision row names its open Decision and exists once per
 * Invocation; a stale waiver is superseded once, by the runtime, without a
 * superseding Decision, and never changes again.
 */
import { ConflictError, InvariantViolationError, ValidationError, type DecisionRequest } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { openHarness, seedArtifact, seedInvocation, seedManifest, seedRequirements, seedRun, seedWorkerNode, type Harness, type Seeded } from "../test-support.ts";

/** A running Worker Invocation (with its running Attempt) on a single node of the seeded Run. */
function runningWorker(h: Harness, s: Seeded) {
  const node = seedWorkerNode(h, s, "single");
  const invocation = seedInvocation(h, s, { role: "worker", purpose: "step", planNodeId: node.id });
  seedManifest(h, s, invocation);
  const attempt = h.stores.invocations.createAttempt({ invocationId: invocation.id, startMode: "fresh", resumedFromAttemptId: null });
  h.stores.invocations.transition(invocation.id, { to: "running" });
  h.stores.invocations.transitionAttempt(attempt.id, { to: "running", capacityLeaseId: null });
  return { node, invocation: h.stores.invocations.get(invocation.id), attempt };
}

function choice(s: Seeded, invocationId: string, overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    conversationId: s.conversation.id,
    runId: s.run.id,
    kind: "operator_choice",
    resolutionPolicy: "operator_required",
    requestedBy: { kind: "invocation", invocationId: invocationId as never },
    question: "Which one?",
    options: [
      { id: "a", label: "A", description: null },
      { id: "b", label: "B", description: "the other" },
    ],
    recommendedOptionId: "a",
    rationale: null,
    affects: { requirementIds: [], taskIds: [], planNodeIds: [s.root.id] },
    deadlineAt: null,
    activationCondition: null,
    subject: null,
    supersedesDecisionId: null,
    ...overrides,
  };
}

function waiver(s: Seeded, invocationId: string, requirementId: string, revisionId: string, overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return choice(s, invocationId, {
    kind: "requirement_waiver",
    question: `Waive Requirement ${requirementId}?`,
    options: [
      { id: "waive", label: "Waive", description: null },
      { id: "deny", label: "Deny", description: null },
    ],
    recommendedOptionId: null,
    rationale: "cannot be met",
    affects: { requirementIds: [requirementId as never], taskIds: [], planNodeIds: [] },
    subject: { kind: "requirement_waiver", runId: s.run.id, requirementId: requirementId as never, requirementRevisionId: revisionId as never, evidenceArtifactIds: [] },
    ...overrides,
  });
}

describe("agent-requested decisions", () => {
  it("are requested by a running Invocation of the Run — never a pending, terminal, or foreign one, never a non-requestable kind — at the store and at the database", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const w = runningWorker(h, s);
      const decision = h.stores.decisions.request(choice(s, w.invocation.id));
      expect(decision).toMatchObject({ kind: "operator_choice", status: "open", requestedBy: { kind: "invocation", invocationId: w.invocation.id }, supersessionReason: null, supersededByDecisionId: null });
      expect(h.stores.decisions.requestedByInvocation(w.invocation.id).map((d) => d.id)).toEqual([decision.id]);
      expect(h.stores.decisions.listByRun(s.run.id).map((d) => d.id)).toContain(decision.id);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "decision.requested" }).at(-1)!.actor).toEqual({ kind: "invocation", invocationId: w.invocation.id });
      // A pending Invocation, an Invocation of another Run, and a Decision without a Run are refused.
      const pending = seedInvocation(h, s, { role: "orchestrator", purpose: "operator_input", allocation: { costUsd: 0, tokens: 0, attempts: 1 } });
      expect(() => h.stores.decisions.request(choice(s, pending.id))).toThrow(ConflictError);
      const other = seedRun(h);
      const foreign = runningWorker(h, other);
      expect(() => h.stores.decisions.request(choice(s, foreign.invocation.id))).toThrow(InvariantViolationError);
      expect(() => h.stores.decisions.request(choice(s, w.invocation.id, { runId: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } }))).toThrow(InvariantViolationError);
      // The closed kinds with another owner are never requested by an Invocation (the request schema refuses them).
      for (const kind of ["orchestrator_choice", "signoff", "publish", "budget_increase"] as const) {
        expect(() => h.stores.decisions.request(choice(s, w.invocation.id, { kind }))).toThrow(ValidationError);
      }
      // The database re-checks the requester: a raw row naming a missing or non-running Invocation is refused.
      const raw = (requestedBy: string, id: string) =>
        h.database.sqlite
          .prepare("INSERT INTO decisions (id, conversation_id, run_id, kind, resolution_policy, status, requested_by, question, options, recommended_option_id, rationale, affects, deadline_at, activation_condition, subject, created_at) VALUES (?, ?, ?, 'operator_choice', 'operator_required', 'open', ?, 'q', '[{\"id\":\"a\",\"label\":\"A\",\"description\":null}]', NULL, NULL, '{\"requirementIds\":[],\"taskIds\":[],\"planNodeIds\":[]}', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z')")
          .run(id, s.conversation.id, s.run.id, requestedBy);
      expect(() => raw(JSON.stringify({ kind: "invocation", invocationId: "inv_000000000000000000000000" }), "dec_000000000000000000000001")).toThrow(/running invocation of its own run/);
      expect(() => raw(JSON.stringify({ kind: "invocation", invocationId: pending.id }), "dec_000000000000000000000002")).toThrow(/running invocation of its own run/);
      expect(() => raw(JSON.stringify({ kind: "invocation", invocationId: foreign.invocation.id }), "dec_000000000000000000000003")).toThrow(/running invocation of its own run/);
      expect(() => raw(JSON.stringify({ kind: "operator" }), "dec_000000000000000000000004")).not.toThrow();
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET kind = 'budget_increase' WHERE id = ?").run(decision.id)).toThrow(/immutable/);
    } finally {
      h.close();
    }
  });

  it("ends an Invocation blocked only on the open Decision it requested (or the approval of its own call), at the store and at the database", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const w = runningWorker(h, s);
      const own = h.stores.decisions.request(choice(s, w.invocation.id));
      const operatorChoice = h.stores.decisions.request(choice(s, w.invocation.id, { requestedBy: { kind: "operator" } }));
      const another = runningWorker(h, s);
      const theirs = h.stores.decisions.request(choice(s, another.invocation.id));
      h.stores.invocations.transitionAttempt(w.attempt.id, { to: "failed", failureClass: "decision_requested", transcriptArtifactId: null, failureDetail: { message: "requested", violations: [], tool: null, cancelled: false }, retryDecision: { permitted: false, reason: "decision_requested", notBefore: null } });
      expect(() => h.stores.invocations.transition(w.invocation.id, { to: "blocked", decisionId: operatorChoice.id })).toThrow(InvariantViolationError);
      expect(() => h.stores.invocations.transition(w.invocation.id, { to: "blocked", decisionId: theirs.id })).toThrow(InvariantViolationError);
      expect(() => h.database.sqlite.prepare("UPDATE invocations SET status = 'blocked', blocked_by_decision_id = ?, ended_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(theirs.id, w.invocation.id)).toThrow(/blocked invocation names the open decision/);
      const blocked = h.stores.invocations.transition(w.invocation.id, { to: "blocked", decisionId: own.id });
      expect(blocked).toMatchObject({ status: "blocked", blockedByDecisionId: own.id });
      expect(h.ctx.journal.read({ runId: s.run.id, type: "invocation.blocked" }).map((e) => e.payload)).toEqual([{ invocationId: w.invocation.id, decisionId: own.id }]);
      // A resolved Decision no longer blocks a further Invocation.
      h.stores.decisions.resolve(theirs.id, { resolvedBy: "operator", chosenOptionId: "b", rationale: null, artifactIds: [] });
      h.stores.invocations.transitionAttempt(another.attempt.id, { to: "failed", failureClass: "decision_requested", transcriptArtifactId: null, failureDetail: { message: "requested", violations: [], tool: null, cancelled: false }, retryDecision: { permitted: false, reason: "decision_requested", notBefore: null } });
      expect(() => h.stores.invocations.transition(another.invocation.id, { to: "blocked", decisionId: theirs.id })).toThrow(InvariantViolationError);
    } finally {
      h.close();
    }
  });

  it("resolves only to one of the Decision's options at the database, and records an accepted request_decision once per Invocation naming its open Decision", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const w = runningWorker(h, s);
      const decision = h.stores.decisions.request(choice(s, w.invocation.id));
      expect(() => h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "zzz", rationale: null, artifactIds: [] })).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET status = 'resolved', resolved_by = 'operator', chosen_option_id = 'zzz', resolved_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(decision.id)).toThrow(/one of its own options/);
      // The accepted call names the open Decision the Invocation requested; another Decision, or a second request, is refused.
      const digest = "b".repeat(64);
      const result = { tool: "request_decision" as const, decisionId: decision.id, status: "open" as const, blocksInvocation: true as const };
      const other = h.stores.decisions.request(choice(s, w.invocation.id, { requestedBy: { kind: "operator" } }));
      expect(() => h.stores.runtimeToolCalls.record({ invocationId: w.invocation.id, attemptId: w.attempt.id, tool: "request_decision", callDigest: digest, result: { ...result, decisionId: other.id } })).toThrow(/names an open requestable decision/);
      const call = h.stores.runtimeToolCalls.record({ invocationId: w.invocation.id, attemptId: w.attempt.id, tool: "request_decision", callDigest: digest, result });
      expect(h.stores.runtimeToolCalls.find(w.invocation.id, "request_decision", digest)?.id).toBe(call.id);
      expect(() => h.stores.runtimeToolCalls.record({ invocationId: w.invocation.id, attemptId: w.attempt.id, tool: "request_decision", callDigest: "c".repeat(64), result })).toThrow(/UNIQUE constraint failed: runtime_tool_calls\.invocation_id/);
      expect(() => h.database.sqlite.prepare("UPDATE runtime_tool_calls SET call_digest = ? WHERE id = ?").run("d".repeat(64), call.id)).toThrow(/append-only/);
      expect(() => h.database.sqlite.prepare("DELETE FROM runtime_tool_calls WHERE id = ?").run(call.id)).toThrow(/append-only/);
    } finally {
      h.close();
    }
  });

  it("supersedes an open requirement_waiver as stale exactly once, by the runtime, with no superseding Decision, and a superseded Decision never changes again", () => {
    const h = openHarness();
    try {
      const s = seedRun(h);
      const { leafIds, revision } = seedRequirements(h, s);
      const w = runningWorker(h, s);
      const artifact = seedArtifact(h, s, "evidence");
      const request = waiver(s, w.invocation.id, leafIds[0]!, revision.id, { subject: { kind: "requirement_waiver", runId: s.run.id, requirementId: leafIds[0]!, requirementRevisionId: revision.id, evidenceArtifactIds: [artifact.id] } });
      const decision = h.stores.decisions.request(request);
      expect(decision.subject).toEqual({ kind: "requirement_waiver", runId: s.run.id, requirementId: leafIds[0], requirementRevisionId: revision.id, evidenceArtifactIds: [artifact.id] });
      // A foreign Evidence Artifact, a subject that disagrees with `affects`, and a subject without a revision are refused.
      const other = seedRun(h);
      const foreignArtifact = seedArtifact(h, other, "foreign");
      expect(() => h.stores.decisions.request(waiver(s, w.invocation.id, leafIds[1]!, revision.id, { subject: { kind: "requirement_waiver", runId: s.run.id, requirementId: leafIds[1]!, requirementRevisionId: revision.id, evidenceArtifactIds: [foreignArtifact.id] } }))).toThrow(InvariantViolationError);
      expect(() => h.stores.decisions.request(waiver(s, w.invocation.id, leafIds[1]!, revision.id, { affects: { requirementIds: [leafIds[0]!], taskIds: [], planNodeIds: [] } }))).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("INSERT INTO decisions (id, conversation_id, run_id, kind, resolution_policy, status, requested_by, question, options, recommended_option_id, rationale, affects, deadline_at, activation_condition, subject, created_at) VALUES ('dec_000000000000000000000009', ?, ?, 'requirement_waiver', 'operator_required', 'open', '{\"kind\":\"runtime\"}', 'q', '[{\"id\":\"waive\",\"label\":\"W\",\"description\":null},{\"id\":\"deny\",\"label\":\"D\",\"description\":null}]', NULL, 'r', ?, NULL, NULL, ?, '2026-01-01T00:00:00.000Z')").run(s.conversation.id, s.run.id, JSON.stringify({ requirementIds: [leafIds[1]], taskIds: [], planNodeIds: [] }), JSON.stringify({ kind: "requirement_waiver", runId: s.run.id, requirementId: leafIds[1], requirementRevisionId: "reqr_000000000000000000000000", evidenceArtifactIds: [] }))).toThrow(/requirement revision of its own conversation/);
      // Supersession: once, with the closed reason and one Event; never for a choice, never twice, never resolved afterwards.
      const superseded = h.stores.decisions.supersede(decision.id, "requirement_waiver_stale");
      expect(superseded).toMatchObject({ status: "superseded", supersessionReason: "requirement_waiver_stale", supersededByDecisionId: null, resolution: null });
      expect(h.stores.decisions.get(decision.id)).toEqual(superseded);
      expect(h.ctx.journal.read({ runId: s.run.id, type: "decision.superseded" }).map((e) => [e.payload, e.actor])).toEqual([[{ decisionId: decision.id, supersededByDecisionId: null, reason: "requirement_waiver_stale" }, { kind: "runtime" }]]);
      expect(() => h.stores.decisions.supersede(decision.id, "requirement_waiver_stale")).toThrow(ConflictError);
      expect(() => h.stores.decisions.resolve(decision.id, { resolvedBy: "operator", chosenOptionId: "waive", rationale: "late", artifactIds: [] })).toThrow(ValidationError);
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET status = 'open', supersession_reason = NULL WHERE id = ?").run(decision.id)).toThrow(/never changes again/);
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET status = 'resolved', resolved_by = 'operator', chosen_option_id = 'waive', resolved_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(decision.id)).toThrow(/never changes again/);
      const plain = h.stores.decisions.request(choice(s, w.invocation.id));
      expect(() => h.stores.decisions.supersede(plain.id, "requirement_waiver_stale")).toThrow(ConflictError);
      expect(() => h.database.sqlite.prepare("UPDATE decisions SET status = 'superseded', supersession_reason = 'requirement_waiver_stale' WHERE id = ?").run(plain.id)).toThrow(/decisions_stale_waiver_only/);
      // A waiver status change names the operator's waive resolution of the pinned Requirement, at the store and at the database.
      const second = h.stores.decisions.request(waiver(s, w.invocation.id, leafIds[1]!, revision.id));
      h.stores.decisions.resolve(second.id, { resolvedBy: "operator", chosenOptionId: "deny", rationale: "keep", artifactIds: [] });
      expect(() => h.stores.requirements.recordStatusChange({ requirementId: leafIds[1]!, runId: s.run.id, to: "waived", actor: "operator", evidence: [], gateId: null, decisionId: second.id, rationale: "keep" })).toThrow(/not waive/);
      expect(() => h.database.sqlite.prepare("INSERT INTO requirement_status_changes (requirement_id, conversation_id, run_id, from_status, to_status, actor, evidence, gate_id, decision_id, rationale, created_at) VALUES (?, ?, ?, 'open', 'waived', 'operator', '[]', NULL, ?, 'x', '2026-01-01T00:00:00.000Z')").run(leafIds[1], s.conversation.id, s.run.id, second.id)).toThrow(/chose waive/);
      expect(h.stores.requirements.get(leafIds[1]!).status).toBe("open");
    } finally {
      h.close();
    }
  });
});
