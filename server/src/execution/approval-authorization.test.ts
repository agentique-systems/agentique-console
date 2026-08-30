/**
 * Approval authorization end to end (execution-model §6.4, §6.5, §14):
 * the adapter proposes, the runtime canonicalizes, evaluates the Tool
 * Policy, and claims a grant in its own committed transaction before the
 * call may run; the claim survives provider failure, retries, failed
 * finalization, and restart; and no raw call reaches any record.
 */
import { canonicalJson, canonicalToolCall, ValidationError, type Decision, type Invocation } from "@agentique-console/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { openHarness } from "../persistence/test-support.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedRuntime, startRun, type RuntimeHarness, type RuntimeSeed } from "./test-support.ts";

const CALL = { tool: "shell", input: { command: "rm -rf build", cwd: "/w" } };
const CANONICAL = canonicalToolCall(CALL);
const DIGEST = sha256Hex(CANONICAL);
const RAW = ["rm -rf build", '"cwd":"/w"', CANONICAL];

async function blockOnApproval(h: RuntimeHarness, invocation: Invocation): Promise<Decision> {
  h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "approval_required") throw new Error(`expected approval_required, got ${outcome.kind}`);
  return outcome.decision;
}

const resolution = (blocked: Invocation, decision: Decision, outcome: "approve_once" | "deny" = "approve_once") => {
  const s = decision.subject!;
  return { kind: "side_effect_approval_resolution" as const, decisionId: decision.id, blockedInvocationId: blocked.id, attemptId: s.attemptId, tool: s.tool, callDigest: s.callDigest, callArtifactId: s.callArtifactId, outcome };
};

function successor(h: RuntimeHarness, s: RuntimeSeed, blocked: Invocation, inputs: ReturnType<typeof resolution>[]) {
  return h.preparation.prepare({ runId: s.created.run.id, planNodeId: s.created.root.id, role: "orchestrator", purpose: "decision_resolution", agentDefinitionRevisionId: s.orchestrator.id, continuedFromInvocationId: blocked.id, taskIds: [], patternPosition: null, inputs });
}

/** A blocked Invocation, its `approve_once` Decision, and the pending successor whose manifest carries the grant. */
async function approved(h: RuntimeHarness, s = seedRuntime(h)) {
  const { invocation } = startRun(h, s).prepared;
  const open = await blockOnApproval(h, invocation);
  h.stores.decisions.resolve(open.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
  const decision = h.stores.decisions.get(open.id);
  const blocked = h.stores.invocations.get(invocation.id);
  const next = successor(h, s, blocked, [resolution(blocked, decision)]);
  expect(next.manifest.content.approvedCalls).toEqual([{ decisionId: decision.id, tool: "shell", callDigest: DIGEST }]);
  return { s, blocked, decision, invocation: next.invocation, manifest: next.manifest };
}

function assertNoRawCall(h: RuntimeHarness, runId: RuntimeSeed["created"]["run"]["id"]) {
  const records = canonicalJson({
    events: h.ctx.journal.read({ runId }),
    attempts: h.stores.invocations.listByRun(runId).flatMap((i) => h.stores.invocations.listAttempts(i.id)),
    uses: h.stores.approvedToolCallUses.listByRun(runId),
    diagnostics: h.executionDiagnostics,
    persistence: h.diagnostics,
    transient: h.transient,
    inputs: h.provider.requests.map((r) => r.request.input.text),
  });
  for (const forbidden of RAW) expect(records).not.toContain(forbidden);
  expect(records).toContain(DIGEST);
}

describe("approval authorization", () => {
  it("allowed tools need no use, a denied tool never executes, an invalid call creates nothing, and an ungranted approval_required call ends blocked", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      const read = { tool: "read", input: { path: "README.md" } };
      const denied = { tool: "network", input: { url: "https://example.invalid" } };
      const oversize = { tool: "shell", input: { command: "x".repeat(70_000) } };
      // An allowed call executes with no claim; an undeclared tool is denied and the Attempt fails as a tool failure (retryable once).
      h.provider.script({ kind: "tool_calls", calls: [read, denied], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const first = await h.executor.advanceInvocation(invocation.id);
      expect(first).toMatchObject({ kind: "finalized", attempt: { status: "failed", failureClass: "tool_failure", failureDetail: { tool: "network", message: "tool network is denied by the Tool Policy" }, retryDecision: { permitted: true, reason: "tool_failure" } } });
      expect(h.provider.requests[0]!.authorizations.map((a) => a.authorization)).toEqual([{ kind: "allowed", tool: "read" }, { kind: "denied", tool: "network" }]);
      expect(h.provider.executed.map((e) => e.call.tool)).toEqual(["read"]);
      // An over-bound call is invalid: no use, no Artifact, no Decision, a tool failure naming the tool.
      h.provider.script({ kind: "tool_calls", calls: [oversize], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const second = await h.executor.advanceInvocation(invocation.id);
      expect(second).toMatchObject({ kind: "finalized", attempt: { status: "failed", failureClass: "tool_failure", failureDetail: { tool: "shell" } } });
      expect(h.provider.requests[1]!.authorizations[0]!.authorization).toMatchObject({ kind: "invalid", tool: "shell" });
      expect(h.stores.approvedToolCallUses.listByRun(s.created.run.id)).toEqual([]);
      expect(h.stores.decisions.listByConversation(s.created.run.conversationId)).toEqual([]);
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "approved_tool_call.used" })).toEqual([]);
      // An approval_required tool without a grant ends the Invocation blocked on a Decision whose subject names the exact digest.
      const s2 = seedRuntime(h);
      const decision = await blockOnApproval(h, startRun(h, s2).prepared.invocation);
      expect(decision.subject).toMatchObject({ tool: "shell", callDigest: DIGEST });
      expect(h.provider.requests.at(-1)!.authorizations).toEqual([{ attemptId: h.provider.requests.at(-1)!.attemptId, call: CALL, authorization: { kind: "approval_required", tool: "shell", callDigest: DIGEST } }]);
      expect(h.provider.executed.map((e) => e.call.tool)).toEqual(["read"]);
      expect(h.provider.requests.every((r) => !r.inTransaction)).toBe(true);
      assertNoRawCall(h, s2.created.run.id);
    } finally {
      h.close();
    }
  });

  it("claims the grant exactly once: the approved call executes once and a second proposal of the same call needs a new Decision", async () => {
    const h = openRuntimeHarness();
    try {
      const a = await approved(h);
      const seq = h.ctx.journal.lastSeq();
      h.provider.script({ kind: "tool_calls", calls: [CALL, CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const outcome = await h.executor.advanceInvocation(a.invocation.id);
      expect(outcome.kind).toBe("approval_required");
      if (outcome.kind !== "approval_required") return;
      // The claim committed in its own transaction, before the finalization transaction, and the call executed exactly once.
      const authorizations = h.provider.requests.at(-1)!.authorizations.map((x) => x.authorization);
      expect(authorizations).toEqual([{ kind: "approved_once", tool: "shell", callDigest: DIGEST, decisionId: a.decision.id, useId: expect.stringMatching(/^acu_/) }, { kind: "approval_required", tool: "shell", callDigest: DIGEST }]);
      expect(h.provider.executed).toHaveLength(1);
      const use = h.stores.approvedToolCallUses.getByDecision(a.decision.id);
      expect(use).toMatchObject({ decisionId: a.decision.id, invocationId: a.invocation.id, attemptId: outcome.attempt.id, tool: "shell", callDigest: DIGEST });
      const events = h.ctx.journal.read({ runId: a.s.created.run.id, afterSeq: seq }).map((e) => e.type);
      expect(events.slice(0, 5)).toEqual(["attempt.created", "capacity_lease.granted", "attempt.started", "invocation.started", "approved_tool_call.used"]);
      expect(events.indexOf("approved_tool_call.used")).toBeLessThan(events.indexOf("attempt.failed"));
      // The second proposal opens a new Decision for the same digest; the first Decision is consumed for good.
      expect(outcome.decision.id).not.toBe(a.decision.id);
      expect(outcome.decision.subject).toMatchObject({ tool: "shell", callDigest: DIGEST, invocationId: a.invocation.id, attemptId: outcome.attempt.id });
      expect(h.stores.invocations.get(a.invocation.id)).toMatchObject({ status: "blocked", blockedByDecisionId: outcome.decision.id });
      expect(h.stores.approvedToolCallUses.claimable(a.decision.id)).toEqual({ claimable: false, reason: "already_used" });
      expect(h.stores.approvedToolCallUses.listByAttempt(outcome.attempt.id)).toEqual([use]);
      // A consumed grant is never delivered again: a later successor may carry the new resolution, never the used one.
      h.stores.decisions.resolve(outcome.decision.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      const second = h.stores.decisions.get(outcome.decision.id);
      const blockedAgain = h.stores.invocations.get(a.invocation.id);
      expect(() => successor(h, a.s, blockedAgain, [resolution(blockedAgain, second), resolution(a.blocked, a.decision)])).toThrow(ValidationError);
      expect(() => successor(h, a.s, blockedAgain, [resolution(blockedAgain, second), resolution(a.blocked, a.decision)])).toThrow(/already used/);
      expect(h.stores.invocations.listByRun(a.s.created.run.id)).toHaveLength(2);
      const third = successor(h, a.s, blockedAgain, [resolution(blockedAgain, second)]);
      expect(third.manifest.content.approvedCalls).toEqual([{ decisionId: second.id, tool: "shell", callDigest: DIGEST }]);
      h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      expect(await h.executor.advanceInvocation(third.invocation.id)).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
      expect(h.provider.executed).toHaveLength(2);
      expect(h.stores.approvedToolCallUses.listByRun(a.s.created.run.id).map((u) => u.decisionId)).toEqual([a.decision.id, second.id]);
      assertNoRawCall(h, a.s.created.run.id);
    } finally {
      h.close();
    }
  });

  it("keeps the approval consumed when the provider fails after the claim: the retry receives the unchanged manifest but cannot repeat the call", async () => {
    for (const failure of [{ kind: "transient_error" as const }, { kind: "throw" as const, error: new Error("socket hang up") }]) {
      const h = openRuntimeHarness();
      try {
        const a = await approved(h);
        // Attempt 1 claims and executes the approved call, then the provider fails transiently (returning or throwing).
        h.provider.script({ kind: "tool_calls", calls: [CALL], then: failure });
        const first = await h.executor.advanceInvocation(a.invocation.id);
        expect(first).toMatchObject({ kind: "finalized", attempt: { number: 1, status: "failed", failureClass: "provider_transient", retryDecision: { permitted: true, reason: "provider_transient" } }, settlement: { kind: "retry_pending" } });
        if (first.kind !== "finalized") return;
        expect(h.provider.executed).toHaveLength(1);
        const use = h.stores.approvedToolCallUses.getByDecision(a.decision.id);
        expect(use).toMatchObject({ attemptId: first.attempt.id });
        // Nothing restored or deleted the claim: the finalization committed around it and the use row is unchanged.
        expect(h.ctx.journal.read({ runId: a.s.created.run.id, type: "approved_tool_call.used" })).toHaveLength(1);
        // Attempt 2: the same immutable manifest, the same grant list, but the claim is refused and the adapter may not execute.
        h.clock.advance(60_000);
        h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
        const second = await h.executor.advanceInvocation(a.invocation.id);
        expect(second).toMatchObject({ kind: "approval_required", attempt: { number: 2, kind: "retry", status: "failed" }, settlement: { invocation: { status: "blocked" } } });
        if (second.kind !== "approval_required") return;
        expect(h.stores.invocations.getManifest(a.invocation.id)).toEqual(a.manifest);
        expect(h.provider.requests.at(-1)!.authorizations.map((x) => x.authorization)).toEqual([{ kind: "approval_required", tool: "shell", callDigest: DIGEST }]);
        expect(h.provider.executed).toHaveLength(1);
        expect(h.stores.approvedToolCallUses.getByDecision(a.decision.id)).toEqual(use);
        expect(h.stores.approvedToolCallUses.listByAttempt(second.attempt.id)).toEqual([]);
        // The retry may request a new approval for the call; the operator decides again.
        expect(second.decision.subject).toMatchObject({ callDigest: DIGEST, attemptId: second.attempt.id });
        expect(h.stores.decisions.listByConversation(a.s.created.run.conversationId).filter((d) => d.kind === "side_effect_approval")).toHaveLength(2);
        assertNoRawCall(h, a.s.created.run.id);
      } finally {
        h.close();
      }
    }
  });

  it("conservatively consumes an approval claimed by a process that died before executing the call; the restarted process cannot repeat it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-authorization-"));
    const file = path.join(dir, "console.db");
    const first = openRuntimeHarness({ base: openHarness(file) });
    let a!: Awaited<ReturnType<typeof approved>>;
    let attemptId!: string;
    try {
      a = await approved(first);
      const prepared = await first.executor.prepareNextAttempt(a.invocation.id);
      if (prepared.kind !== "prepared") throw new Error(prepared.kind);
      attemptId = prepared.attempt.id;
      // The runtime claimed the grant for the running Attempt, and the process died before the adapter executed the call.
      const claim = first.stores.approvedToolCallUses.claim({ decisionId: a.decision.id, invocationId: a.invocation.id, attemptId: prepared.attempt.id, tool: "shell", callDigest: DIGEST });
      expect(claim.kind).toBe("claimed");
      expect(first.provider.executed).toEqual([]);
    } finally {
      first.close();
    }
    const reopened = openRuntimeHarness({ base: openHarness(file) });
    try {
      const report = reopened.recovery.recover();
      expect(report.interruptedAttemptIds).toEqual([attemptId]);
      expect(report.retryEligible).toEqual([{ invocationId: a.invocation.id, notBefore: null, resumeCandidateAttemptId: null }]);
      // The use is read back as committed; no reconstruction, no transcript, no payload.
      expect(reopened.stores.approvedToolCallUses.getByDecision(a.decision.id)).toMatchObject({ attemptId, invocationId: a.invocation.id });
      expect(reopened.stores.approvedToolCallUses.claimable(a.decision.id)).toEqual({ claimable: false, reason: "already_used" });
      reopened.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
      const retry = await reopened.executor.advanceInvocation(a.invocation.id);
      expect(retry).toMatchObject({ kind: "approval_required", attempt: { number: 2, startMode: "fresh" } });
      expect(reopened.provider.requests[0]!.authorizations.map((x) => x.authorization)).toEqual([{ kind: "approval_required", tool: "shell", callDigest: DIGEST }]);
      expect(reopened.provider.executed).toEqual([]);
      expect(reopened.stores.approvedToolCallUses.listByRun(a.s.created.run.id)).toHaveLength(1);
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authorizes nothing when the claim transaction or its COMMIT fails: no row, no Event, no execution, a bounded diagnostic, and the retry claims normally", async () => {
    for (const variant of ["commit", "callback"] as const) {
      const h = openRuntimeHarness();
      try {
        const a = await approved(h);
        const prepared = await h.executor.prepareNextAttempt(a.invocation.id);
        if (prepared.kind !== "prepared") throw new Error(prepared.kind);
        const seq = h.ctx.journal.lastSeq();
        let restore = () => {};
        if (variant === "commit") {
          const sqlite = h.database.sqlite as unknown as { exec: (sql: string) => unknown };
          const exec = sqlite.exec.bind(h.database.sqlite);
          let armed = true;
          sqlite.exec = (sql: string) => {
            if (sql === "COMMIT" && armed) {
              armed = false;
              throw new Error("disk I/O error at COMMIT");
            }
            return exec(sql);
          };
          restore = () => {
            sqlite.exec = exec;
          };
        } else {
          const claim = h.stores.approvedToolCallUses.claim.bind(h.stores.approvedToolCallUses);
          let armed = true;
          h.stores.approvedToolCallUses.claim = (input, options) => {
            if (armed) {
              armed = false;
              throw new Error("use insert failed");
            }
            return claim(input, options);
          };
          restore = () => {
            h.stores.approvedToolCallUses.claim = claim;
          };
        }
        h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
        const first = await h.executor.executePreparedAttempt(prepared.attempt.id);
        restore();
        const message = variant === "commit" ? "disk I/O error at COMMIT" : "use insert failed";
        expect(first).toMatchObject({ kind: "finalized", attempt: { status: "failed", failureClass: "tool_failure", failureDetail: { tool: "shell", message: `authorization failed: ${message}` }, retryDecision: { permitted: true, reason: "tool_failure" } } });
        expect(h.provider.requests.at(-1)!.authorizations.map((x) => x.authorization)).toEqual([{ kind: "failed", tool: "shell", message }]);
        expect(h.provider.executed).toEqual([]);
        expect(h.stores.approvedToolCallUses.getByDecision(a.decision.id)).toBeNull();
        expect(h.stores.approvedToolCallUses.claimable(a.decision.id)).toEqual({ claimable: true });
        expect(h.ctx.journal.read({ runId: a.s.created.run.id, afterSeq: seq, type: "approved_tool_call.used" })).toEqual([]);
        expect(h.executionDiagnostics).toEqual([{ kind: "tool_call_authorization_failed", invocationId: a.invocation.id, attemptId: prepared.attempt.id, tool: "shell", callDigest: DIGEST, message }]);
        expect(h.ctx.tx.inTransaction).toBe(false);
        // Recoverable: the retry claims and executes the call once.
        h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
        const second = await h.executor.advanceInvocation(a.invocation.id);
        expect(second).toMatchObject({ kind: "finalized", attempt: { number: 2, status: "succeeded" }, settlement: { invocation: { status: "succeeded" } } });
        if (second.kind !== "finalized") return;
        expect(h.provider.requests.at(-1)!.authorizations[0]!.authorization).toMatchObject({ kind: "approved_once", decisionId: a.decision.id });
        expect(h.provider.executed).toHaveLength(1);
        expect(h.stores.approvedToolCallUses.getByDecision(a.decision.id)).toMatchObject({ attemptId: second.attempt.id });
        assertNoRawCall(h, a.s.created.run.id);
      } finally {
        h.close();
      }
    }
  });

  it("the runtime canonicalizes an adapter's approval_required completion by the same contract: an over-bound call is a tool failure, never a truncated subject", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const { invocation } = startRun(h, s).prepared;
      // An adapter that reports approval_required without consulting the port, with an over-bound call.
      const execute = h.provider.execute.bind(h.provider);
      h.provider.execute = async (request) => {
        const outcome = await execute(request);
        return { ...outcome, completion: { kind: "approval_required", call: { tool: "shell", input: { command: "x".repeat(70_000) } } } };
      };
      const outcome = await h.executor.advanceInvocation(invocation.id);
      expect(outcome).toMatchObject({ kind: "finalized", attempt: { status: "failed", failureClass: "tool_failure", failureDetail: { tool: "shell" } } });
      expect(h.stores.decisions.listByConversation(s.created.run.conversationId)).toEqual([]);
      expect(h.stores.artifacts.listByRun(s.created.run.id).filter((a) => a.mediaType === "application/x-tool-call+json")).toEqual([]);
    } finally {
      h.close();
    }
  });
});
