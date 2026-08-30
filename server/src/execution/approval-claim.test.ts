/**
 * The canonical approval use (execution-model §6.4 "approval claim"): one
 * append-only row per claimed `approve_once` grant, enforced by the
 * database, decided from canonical rows alone, and unchanged by retries,
 * reopen, or provider outcomes.
 */
import { canonicalJson, canonicalToolCall, type ApprovedToolCallUse, type Decision, type Invocation } from "@agentique-console/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { openHarness } from "../persistence/test-support.ts";
import { accepted, COMPLETED_RESULT, openRuntimeHarness, propose, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness, type RuntimeSeed } from "./test-support.ts";

const CALL = { tool: "shell", input: { command: "rm -rf build", cwd: "/w" } };
/** Several prepared Attempts stay in flight across scenarios; the default governor would refuse capacity. */
const WIDE_GOVERNOR = { providers: { fake: { maxConcurrency: 20 } }, maxProcessConcurrency: 20, maxWorktrees: null };
const CANONICAL = canonicalToolCall(CALL);
const DIGEST = sha256Hex(CANONICAL);

/** Blocks the Invocation on an approval of CALL; returns the open Decision. */
async function blockOnApproval(h: RuntimeHarness, invocation: Invocation): Promise<Decision> {
  h.provider.script({ kind: "tool_calls", calls: [CALL], then: { kind: "succeed", result: COMPLETED_RESULT } });
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "approval_required") throw new Error(`expected approval_required, got ${outcome.kind}`);
  return outcome.decision;
}

function successor(h: RuntimeHarness, s: RuntimeSeed, blocked: Invocation, decision: Decision | null, outcome: "approve_once" | "deny" = "approve_once") {
  const subject = decision?.subject ?? null;
  return h.preparation.prepare({
    runId: s.created.run.id,
    planNodeId: s.created.root.id,
    role: "orchestrator",
    purpose: "decision_resolution",
    agentDefinitionRevisionId: s.orchestrator.id,
    continuedFromInvocationId: blocked.id,
    taskIds: [],
    patternPosition: null,
    inputs: decision && subject ? [{ kind: "side_effect_approval_resolution", decisionId: decision.id, blockedInvocationId: blocked.id, attemptId: subject.attemptId, tool: subject.tool, callDigest: subject.callDigest, callArtifactId: subject.callArtifactId, outcome }] : [],
  });
}

interface Granted {
  s: RuntimeSeed;
  blocked: Invocation;
  decision: Decision;
  invocation: Invocation;
  attemptId: ApprovedToolCallUse["attemptId"];
}

/** A blocked Invocation, its `approve_once` Decision, and a running successor Attempt whose manifest carries the grant; the provider is not yet called. */
async function granted(h: RuntimeHarness, s = seedRuntime(h)): Promise<Granted> {
  const { invocation } = startRun(h, s).prepared;
  const open = await blockOnApproval(h, invocation);
  h.stores.decisions.resolve(open.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
  const decision = h.stores.decisions.get(open.id);
  const blocked = h.stores.invocations.get(invocation.id);
  const next = successor(h, s, blocked, decision);
  const prepared = await h.executor.prepareNextAttempt(next.invocation.id);
  if (prepared.kind !== "prepared") throw new Error(prepared.kind);
  return { s, blocked, decision, invocation: prepared.invocation, attemptId: prepared.attempt.id };
}

const claimOf = (g: Granted, overrides: Partial<{ decisionId: string; invocationId: string; attemptId: string; tool: string; callDigest: string }> = {}) =>
  ({ decisionId: g.decision.id, invocationId: g.invocation.id, attemptId: g.attemptId, tool: CALL.tool, callDigest: DIGEST, ...overrides }) as Parameters<RuntimeHarness["stores"]["approvedToolCallUses"]["claim"]>[0];

describe("approval use store", () => {
  it("claims a matching resolved approve_once grant exactly once, with one bounded Event, and refuses the second claim without writing", async () => {
    const h = openRuntimeHarness();
    try {
      const g = await granted(h);
      expect(h.stores.approvedToolCallUses.claimable(g.decision.id)).toEqual({ claimable: true });
      const seq = h.ctx.journal.lastSeq();
      const first = h.stores.approvedToolCallUses.claim(claimOf(g));
      expect(first.kind).toBe("claimed");
      if (first.kind !== "claimed") return;
      expect(first.use).toMatchObject({ decisionId: g.decision.id, tool: "shell", callDigest: DIGEST, runId: g.s.created.run.id, planNodeId: g.s.created.root.id, invocationId: g.invocation.id, attemptId: g.attemptId });
      expect(first.use.id).toMatch(/^acu_[0-9a-f]{24}$/);
      // Queries derive from the row alone.
      expect(h.stores.approvedToolCallUses.get(first.use.id)).toEqual(first.use);
      expect(h.stores.approvedToolCallUses.getByDecision(g.decision.id)).toEqual(first.use);
      expect(h.stores.approvedToolCallUses.listByInvocation(g.invocation.id)).toEqual([first.use]);
      expect(h.stores.approvedToolCallUses.listByAttempt(g.attemptId)).toEqual([first.use]);
      expect(h.stores.approvedToolCallUses.listByRun(g.s.created.run.id)).toEqual([first.use]);
      expect(h.stores.approvedToolCallUses.claimable(g.decision.id)).toEqual({ claimable: false, reason: "already_used" });
      // One Event, carrying the use (ids, tool, digest, time) and never the call.
      const events = h.ctx.journal.read({ runId: g.s.created.run.id, afterSeq: seq });
      expect(events.map((e) => e.type)).toEqual(["approved_tool_call.used"]);
      expect(events[0]).toMatchObject({ subjectType: "approved_tool_call_use", subjectId: first.use.id, payload: first.use, scope: { runId: g.s.created.run.id, planNodeId: g.s.created.root.id, invocationId: g.invocation.id, attemptId: g.attemptId } });
      expect(canonicalJson(events)).not.toContain("rm -rf");
      // A second claim in the same Attempt is refused and writes nothing.
      expect(h.stores.approvedToolCallUses.claim(claimOf(g))).toEqual({ kind: "refused", reason: "already_used" });
      expect(h.ctx.journal.lastSeq()).toBe(seq + 1);
      expect(h.stores.approvedToolCallUses.listByRun(g.s.created.run.id)).toHaveLength(1);
      // A re-entrant claim inside one transaction sees the uncommitted row and is refused too; the outer transaction still commits nothing new.
      const g2 = await granted(h, seedRuntime(h));
      const seq2 = h.ctx.journal.lastSeq();
      const both = h.ctx.tx.write(() => [h.stores.approvedToolCallUses.claim(claimOf(g2)), h.stores.approvedToolCallUses.claim(claimOf(g2))]);
      expect(both.map((c) => c.kind)).toEqual(["claimed", "refused"]);
      expect(h.ctx.journal.lastSeq()).toBe(seq2 + 1);
      expect(h.stores.approvedToolCallUses.listByRun(g2.s.created.run.id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("refuses a different tool, a different digest, a denial, an open or superseded Decision, a manifest without the grant, and a non-running or foreign Attempt", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const g = await granted(h);
      const uses = h.stores.approvedToolCallUses;
      expect(uses.claim(claimOf(g, { tool: "write" }))).toEqual({ kind: "refused", reason: "call_mismatch" });
      expect(uses.claim(claimOf(g, { callDigest: sha256Hex(canonicalToolCall({ tool: "shell", input: { command: "rm -rf build", cwd: "/x" } })) }))).toEqual({ kind: "refused", reason: "call_mismatch" });
      // The blocked predecessor's own Attempt is not the claimant.
      expect(uses.claim(claimOf(g, { attemptId: g.decision.subject!.attemptId }))).toEqual({ kind: "refused", reason: "attempt_mismatch" });
      // A Decision that is not a side-effect approval.
      const choice = h.stores.decisions.request({ conversationId: g.s.created.run.conversationId, runId: g.s.created.run.id, kind: "operator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "operator" }, question: "q", options: [{ id: "approve_once", label: "A", description: null }, { id: "deny", label: "D", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: null });
      expect(uses.claim(claimOf(g, { decisionId: choice.id }))).toEqual({ kind: "refused", reason: "not_side_effect_approval" });
      expect(uses.claimable(choice.id)).toEqual({ claimable: false, reason: "not_side_effect_approval" });
      expect(uses.listByRun(g.s.created.run.id)).toEqual([]);

      // A denial is never claimable, and neither is an open Decision; the successor of a denial carries no grant.
      const s2 = seedRuntime(h);
      const { invocation: inv2 } = startRun(h, s2).prepared;
      const open = await blockOnApproval(h, inv2);
      expect(uses.claimable(open.id)).toEqual({ claimable: false, reason: "not_resolved" });
      h.stores.decisions.resolve(open.id, { resolvedBy: "operator", chosenOptionId: "deny", rationale: null, artifactIds: [] });
      const denied = h.stores.decisions.get(open.id);
      expect(uses.claimable(denied.id)).toEqual({ claimable: false, reason: "not_approved" });
      const after = successor(h, s2, h.stores.invocations.get(inv2.id), denied, "deny");
      expect(after.manifest.content.approvedCalls).toEqual([]);
      const prepared2 = await h.executor.prepareNextAttempt(after.invocation.id);
      if (prepared2.kind !== "prepared") throw new Error(prepared2.kind);
      expect(uses.claim({ decisionId: denied.id, invocationId: after.invocation.id, attemptId: prepared2.attempt.id, tool: "shell", callDigest: DIGEST })).toEqual({ kind: "refused", reason: "not_approved" });

      // A manifest that does not carry the grant cannot claim it even though the Decision is approved.
      const s3 = seedRuntime(h);
      const { invocation: inv3 } = startRun(h, s3).prepared;
      const open3 = await blockOnApproval(h, inv3);
      h.stores.decisions.resolve(open3.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      const bare = successor(h, s3, h.stores.invocations.get(inv3.id), null);
      expect(bare.manifest.content.approvedCalls).toEqual([]);
      const prepared3 = await h.executor.prepareNextAttempt(bare.invocation.id);
      if (prepared3.kind !== "prepared") throw new Error(prepared3.kind);
      expect(uses.claim({ decisionId: open3.id, invocationId: bare.invocation.id, attemptId: prepared3.attempt.id, tool: "shell", callDigest: DIGEST })).toEqual({ kind: "refused", reason: "not_in_manifest" });
      expect(uses.claimable(open3.id)).toEqual({ claimable: true });

      // A superseded Decision is never claimable.
      h.stores.decisions.request({ conversationId: s3.created.run.conversationId, runId: s3.created.run.id, kind: "operator_choice", resolutionPolicy: "operator_required", requestedBy: { kind: "operator" }, question: "again", options: [{ id: "a", label: "A", description: null }], recommendedOptionId: null, rationale: null, affects: { requirementIds: [], taskIds: [], planNodeIds: [] }, deadlineAt: null, activationCondition: null, subject: null, supersedesDecisionId: open3.id });
      expect(h.stores.decisions.get(open3.id).status).toBe("superseded");
      expect(uses.claimable(open3.id)).toEqual({ claimable: false, reason: "not_resolved" });

      // A terminal Attempt (and its terminal Invocation) can no longer claim.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      const finished = await h.executor.executePreparedAttempt(g.attemptId);
      expect(finished).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
      expect(uses.claim(claimOf(g))).toEqual({ kind: "refused", reason: "invocation_not_running" });
      expect(uses.listByRun(g.s.created.run.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("refuses a grant of another Run, another Plan Node, another predecessor, or a non-running Attempt of the right Invocation", async () => {
    const h = openRuntimeHarness({ governor: WIDE_GOVERNOR });
    try {
      const g = await granted(h);
      const uses = h.stores.approvedToolCallUses;
      // Another Run's running Attempt.
      const other = seedRuntime(h);
      const { invocation: otherInvocation } = startRun(h, other).prepared;
      const otherPrepared = await h.executor.prepareNextAttempt(otherInvocation.id);
      if (otherPrepared.kind !== "prepared") throw new Error(otherPrepared.kind);
      expect(uses.claim(claimOf(g, { invocationId: otherInvocation.id, attemptId: otherPrepared.attempt.id }))).toEqual({ kind: "refused", reason: "run_mismatch" });
      // The same Run, another Plan Node (a Worker on a child node).
      const planning = seedPlanningRuntime(h);
      const plan = accepted(propose(h, planning, [{ pattern: "single", operation: { agentDefinitionRevisionId: planning.worker.id, title: "build" }, allocation: { costUsd: 6, tokens: 60_000, attempts: 4 } }]));
      const node = plan.graph.nodes[1]!;
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      expect(await h.executor.advanceInvocation(planning.invocation.id)).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
      h.stores.plans.transitionNode(node.id, { to: "ready" });
      h.stores.plans.transitionNode(node.id, { to: "running" });
      const openWorker = await blockOnApproval(h, h.preparation.prepare({ runId: planning.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", agentDefinitionRevisionId: planning.worker.id, continuedFromInvocationId: null, taskIds: [], patternPosition: null }).invocation);
      h.stores.decisions.resolve(openWorker.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      // An Orchestrator successor on the root, continuing from the Orchestrator's own terminal Invocation, is on another Plan Node than the Worker's Decision.
      const rootBlocked = await blockOnApproval(h, h.preparation.prepare({ runId: planning.created.run.id, planNodeId: planning.created.root.id, role: "orchestrator", purpose: "node_result", agentDefinitionRevisionId: planning.orchestrator.id, continuedFromInvocationId: planning.invocation.id, taskIds: [], patternPosition: null }).invocation);
      h.stores.decisions.resolve(rootBlocked.id, { resolvedBy: "operator", chosenOptionId: "approve_once", rationale: null, artifactIds: [] });
      const rootSuccessor = successor(h, planning, h.stores.invocations.get(rootBlocked.subject!.invocationId), h.stores.decisions.get(rootBlocked.id));
      const rootPrepared = await h.executor.prepareNextAttempt(rootSuccessor.invocation.id);
      if (rootPrepared.kind !== "prepared") throw new Error(rootPrepared.kind);
      expect(uses.claim({ decisionId: openWorker.id, invocationId: rootSuccessor.invocation.id, attemptId: rootPrepared.attempt.id, tool: "shell", callDigest: DIGEST })).toEqual({ kind: "refused", reason: "plan_node_mismatch" });
      // The same Plan Node and Run, but a Decision whose blocked Invocation is not this successor's predecessor.
      expect(uses.claim({ decisionId: rootBlocked.id, invocationId: g.invocation.id, attemptId: g.attemptId, tool: "shell", callDigest: DIGEST })).toEqual({ kind: "refused", reason: "run_mismatch" });
      const first = h.stores.decisions.get(rootBlocked.id);
      const firstSuccessor = rootSuccessor.invocation;
      // Finish the successor and start a third Orchestrator Invocation continuing from it: the grant names the first blocked Invocation, not this predecessor.
      h.provider.script({ kind: "succeed", result: COMPLETED_RESULT });
      expect(await h.executor.executePreparedAttempt(rootPrepared.attempt.id)).toMatchObject({ kind: "finalized", attempt: { status: "succeeded" } });
      const third = h.preparation.prepare({ runId: planning.created.run.id, planNodeId: planning.created.root.id, role: "orchestrator", purpose: "node_result", agentDefinitionRevisionId: planning.orchestrator.id, continuedFromInvocationId: firstSuccessor.id, taskIds: [], patternPosition: null });
      const thirdPrepared = await h.executor.prepareNextAttempt(third.invocation.id);
      if (thirdPrepared.kind !== "prepared") throw new Error(thirdPrepared.kind);
      expect(uses.claim({ decisionId: first.id, invocationId: third.invocation.id, attemptId: thirdPrepared.attempt.id, tool: "shell", callDigest: DIGEST })).toEqual({ kind: "refused", reason: "predecessor_mismatch" });
      // A non-running Attempt of the right Invocation: the successor's first Attempt failed transiently, the second is running.
      const s4 = seedRuntime(h);
      const g4 = await granted(h, s4);
      h.provider.script({ kind: "transient_error" });
      const failed = await h.executor.executePreparedAttempt(g4.attemptId);
      expect(failed).toMatchObject({ kind: "finalized", attempt: { status: "failed", failureClass: "provider_transient" }, settlement: { kind: "retry_pending" } });
      h.clock.advance(10_000);
      const second = await h.executor.prepareNextAttempt(g4.invocation.id);
      if (second.kind !== "prepared") throw new Error(second.kind);
      expect(uses.claim(claimOf(g4))).toEqual({ kind: "refused", reason: "attempt_not_running" });
      expect(uses.claim(claimOf(g4, { attemptId: second.attempt.id })).kind).toBe("claimed");
      expect(uses.listByRun(g.s.created.run.id)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("is enforced by the database: one use per Decision, every ownership fact re-checked at insertion, rows never updated or deleted", async () => {
    const h = openRuntimeHarness();
    try {
      const g = await granted(h);
      const sqlite = h.database.sqlite;
      const now = h.clock.now();
      const insert = (overrides: Partial<Record<"id" | "decision" | "tool" | "digest" | "run" | "node" | "invocation" | "attempt", string>> = {}) =>
        sqlite
          .prepare("INSERT INTO approved_tool_call_uses (id, decision_id, tool, call_digest, run_id, plan_node_id, invocation_id, attempt_id, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(overrides.id ?? `acu_${"1".repeat(24)}`, overrides.decision ?? g.decision.id, overrides.tool ?? "shell", overrides.digest ?? DIGEST, overrides.run ?? g.s.created.run.id, overrides.node ?? g.s.created.root.id, overrides.invocation ?? g.invocation.id, overrides.attempt ?? g.attemptId, now);
      const trigger = /approved_tool_call_use claims a resolved approve_once/;
      expect(() => insert({ tool: "write" })).toThrow(trigger);
      expect(() => insert({ digest: "b".repeat(64) })).toThrow(trigger);
      expect(() => insert({ attempt: g.decision.subject!.attemptId })).toThrow(trigger);
      expect(() => insert({ invocation: g.blocked.id })).toThrow(trigger);
      // The BEFORE INSERT trigger runs before the column checks, so a malformed digest or empty tool is refused as a mismatch.
      expect(() => insert({ digest: "abc" })).toThrow(trigger);
      expect(() => insert({ tool: "" })).toThrow(trigger);
      // A foreign Run and Plan Node fail the trigger even with a consistent row shape.
      const other = seedRuntime(h);
      expect(() => insert({ run: other.created.run.id })).toThrow(trigger);
      expect(() => insert({ node: other.created.root.id })).toThrow(trigger);
      expect(sqlite.prepare("SELECT count(*) AS n FROM approved_tool_call_uses").get()).toEqual({ n: 0 });
      // The valid row inserts once; the unique index refuses a second use of the Decision whatever its id or Attempt.
      insert();
      expect(() => insert({ id: `acu_${"2".repeat(24)}` })).toThrow(/UNIQUE constraint failed: approved_tool_call_uses.decision_id/);
      expect(() => sqlite.prepare("UPDATE approved_tool_call_uses SET tool = 'write'").run()).toThrow(/append-only/);
      expect(() => sqlite.prepare("UPDATE approved_tool_call_uses SET attempt_id = ?").run(g.decision.subject!.attemptId)).toThrow(/append-only/);
      expect(() => sqlite.prepare("DELETE FROM approved_tool_call_uses").run()).toThrow(/append-only/);
      expect(h.stores.approvedToolCallUses.getByDecision(g.decision.id)).toMatchObject({ id: `acu_${"1".repeat(24)}` });
      expect(h.stores.approvedToolCallUses.claim(claimOf(g))).toEqual({ kind: "refused", reason: "already_used" });
    } finally {
      h.close();
    }
  });

  it("serializes competing claims through the database write lock: one committed winner, the loser refused after the commit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-claim-"));
    const file = path.join(dir, "console.db");
    const a = openRuntimeHarness({ base: openHarness(file) });
    let b: RuntimeHarness | null = null;
    try {
      const g = await granted(a);
      // A second connection to the same database, as another process would hold; it does not wait for the lock.
      b = openRuntimeHarness({ base: openHarness(file, { clock: a.clock }) });
      b.database.sqlite.pragma("busy_timeout = 0");
      const competitor = b;
      const winner = a.ctx.tx.write(() => {
        const claimed = a.stores.approvedToolCallUses.claim(claimOf(g));
        // While the claim transaction holds the write lock, the competitor cannot even begin; nothing of its claim persists.
        expect(() => competitor.stores.approvedToolCallUses.claim(claimOf(g))).toThrow(/SQLITE_BUSY|database is locked/);
        return claimed;
      });
      expect(winner.kind).toBe("claimed");
      expect(competitor.stores.approvedToolCallUses.claim(claimOf(g))).toEqual({ kind: "refused", reason: "already_used" });
      expect(competitor.stores.approvedToolCallUses.getByDecision(g.decision.id)).toEqual(winner.kind === "claimed" ? winner.use : null);
      expect(competitor.ctx.journal.read({ runId: g.s.created.run.id, type: "approved_tool_call.used" })).toHaveLength(1);
    } finally {
      b?.close();
      a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a claimed grant consumed and an unclaimed grant claimable across close and reopen, from rows alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-claim-"));
    const file = path.join(dir, "console.db");
    const first = openRuntimeHarness({ base: openHarness(file) });
    let claimed!: Granted;
    let unclaimed!: Granted;
    let use!: ApprovedToolCallUse;
    try {
      claimed = await granted(first);
      const outcome = first.stores.approvedToolCallUses.claim(claimOf(claimed));
      if (outcome.kind !== "claimed") throw new Error(outcome.reason);
      use = outcome.use;
      unclaimed = await granted(first, seedRuntime(first));
    } finally {
      first.close();
    }
    const reopened = openRuntimeHarness({ base: openHarness(file) });
    try {
      expect(reopened.stores.approvedToolCallUses.getByDecision(claimed.decision.id)).toEqual(use);
      expect(reopened.stores.approvedToolCallUses.claimable(claimed.decision.id)).toEqual({ claimable: false, reason: "already_used" });
      expect(reopened.stores.approvedToolCallUses.claimable(unclaimed.decision.id)).toEqual({ claimable: true });
      // Recovery interrupts the previous process's Attempts and repairs nothing about uses.
      const report = reopened.recovery.recover();
      expect(report.interruptedAttemptIds.sort()).toEqual([claimed.attemptId, unclaimed.attemptId].sort());
      expect(reopened.stores.approvedToolCallUses.getByDecision(claimed.decision.id)).toEqual(use);
      expect(reopened.stores.approvedToolCallUses.claimable(unclaimed.decision.id)).toEqual({ claimable: true });
      // The interrupted claimant's retry cannot reclaim; the unclaimed grant's retry can claim.
      for (const g of [claimed, unclaimed]) {
        const retry = await reopened.executor.prepareNextAttempt(g.invocation.id);
        if (retry.kind !== "prepared") throw new Error(retry.kind);
        expect(retry.attempt.number).toBe(2);
        const outcome = reopened.stores.approvedToolCallUses.claim(claimOf(g, { attemptId: retry.attempt.id }));
        expect(outcome).toMatchObject(g === claimed ? { kind: "refused", reason: "already_used" } : { kind: "claimed", use: { attemptId: retry.attempt.id } });
      }
      expect(reopened.provider.requests).toHaveLength(0);
    } finally {
      reopened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
