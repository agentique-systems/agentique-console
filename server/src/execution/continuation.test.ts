/**
 * Provider resumption (execution-model §6.6; invariant 17 optional and
 * non-canonical): an Attempt is `resumed` only when every check passes,
 * and every missing condition yields a `fresh` Attempt with the same
 * outcome.
 */
import { canonicalJson, type Invocation } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../persistence/blob-store.ts";
import { MemoryContinuationPayloadStore } from "../provider/continuation-store.ts";
import { DEFAULT_USAGE } from "../provider/fake.ts";
import { manifestContinuationContext } from "./continuation-policy.ts";
import { InvocationPreparationService } from "./invocation-preparation-service.ts";
import { COMPLETED_RESULT, openRuntimeHarness, seedPlanningRuntime, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function run(h: RuntimeHarness, invocation: Invocation) {
  const outcome = await h.executor.advanceInvocation(invocation.id);
  if (outcome.kind !== "finalized") throw new Error(`expected finalized, got ${outcome.kind}`);
  return outcome;
}

/** The next Orchestrator Invocation after `previous`, continuing from it with one operator message. */
function successor(h: RuntimeHarness, s: ReturnType<typeof seedRuntime>, previous: Invocation, overrides: { agentDefinitionRevisionId?: string } = {}) {
  const message = h.stores.conversations.postMessage({ conversationId: s.created.run.conversationId, author: "operator", content: "Also add --help.", runId: s.created.run.id, invocationId: null });
  return h.preparation.prepare({
    runId: s.created.run.id,
    planNodeId: s.created.root.id,
    role: "orchestrator",
    purpose: "operator_input",
    ...(overrides.agentDefinitionRevisionId ? { agentDefinitionRevisionId: overrides.agentDefinitionRevisionId } : {}),
    continuedFromInvocationId: previous.id,
    patternPosition: { kind: "orchestrator" as const },
    inputs: [{ kind: "operator_message", conversationMessageId: message.id, content: message.content }],
  });
}

describe("provider continuation", () => {
  it("resumes a retry within one Invocation from a safe termination, then a successor Invocation across the boundary, passing the verified payload", async () => {
    const h = openRuntimeHarness();
    try {
      const s = seedRuntime(h);
      const first = startRun(h, s).prepared.invocation;
      h.provider.script(
        { kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: ["art_000000000000000000000000"] }, continuation: "state after attempt 1" },
        { kind: "succeed", result: COMPLETED_RESULT, continuation: "state after attempt 2" },
        { kind: "succeed", result: COMPLETED_RESULT, continuation: null },
      );
      // Attempt 1 ends result_invalid (safe) with a payload; Attempt 2 is a resumed retry that receives it.
      const a1 = await run(h, first);
      expect(a1.attempt.failureClass).toBe("result_invalid");
      expect(h.stores.continuations.get(a1.attempt.id)).toMatchObject({ attemptId: a1.attempt.id, provider: "fake" });
      expect(h.executor.inspectInvocation(first.id).resumeCandidateAttemptId).toBe(a1.attempt.id);
      const a2 = await run(h, first);
      expect(a2.attempt).toMatchObject({ number: 2, kind: "retry", startMode: "resumed", resumedFromAttemptId: a1.attempt.id, status: "succeeded" });
      expect(decoder.decode(h.provider.requests[1]!.continuation!)).toBe("state after attempt 1");
      // Across the Invocation boundary: the successor's manifest differs only by its new input, so it resumes from Attempt 2.
      const next = successor(h, s, first);
      expect(h.executor.inspectInvocation(next.invocation.id).resumeCandidateAttemptId).toBe(a2.attempt.id);
      const b1 = await run(h, next.invocation);
      expect(b1.attempt).toMatchObject({ number: 1, kind: "initial", startMode: "resumed", resumedFromAttemptId: a2.attempt.id, status: "succeeded" });
      expect(decoder.decode(h.provider.requests[2]!.continuation!)).toBe("state after attempt 2");
      // Resumption is recorded only on the Attempt; no payload or storage key reaches any Event, manifest, result, or diagnostic.
      const journal = canonicalJson(h.ctx.journal.read({ runId: s.created.run.id }));
      for (const secret of ["state after attempt", "storageKey", "fake/att_"]) expect(journal).not.toContain(secret);
      expect(canonicalJson(h.stores.invocations.getManifest(next.invocation.id))).not.toContain("state after attempt");
      expect(h.ctx.journal.read({ runId: s.created.run.id, type: "attempt.created" }).map((e) => (e.payload as { startMode: string }).startMode)).toEqual(["fresh", "resumed", "resumed"]);
    } finally {
      h.close();
    }
  });

  it("starts fresh, with the same result, when the adapter does not support continuation or the payload is missing, expired, corrupt, or truncated", async () => {
    for (const variant of ["unsupported", "missing", "expired", "corrupt", "truncated"] as const) {
      const payloads = new MemoryContinuationPayloadStore(sha256Hex);
      const h = openRuntimeHarness({ supportsContinuation: variant !== "unsupported", payloads });
      try {
        const s = seedRuntime(h);
        const first = startRun(h, s).prepared.invocation;
        h.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: ["art_000000000000000000000000"] }, continuation: "state" }, { kind: "succeed", result: COMPLETED_RESULT });
        const a1 = await run(h, first);
        expect(a1.attempt.failureClass).toBe("result_invalid");
        const row = h.stores.continuations.get(a1.attempt.id);
        if (variant === "unsupported") expect(row).toBeNull();
        else expect(row).not.toBeNull();
        switch (variant) {
          case "missing":
            await payloads.delete(row!.storageKey);
            break;
          case "expired":
            h.stores.continuations.put({ ...row!, expiresAt: "2026-01-01T00:00:00.000Z" });
            break;
          case "corrupt":
            await payloads.put(row!.storageKey, encoder.encode("tampered"));
            break;
          case "truncated":
            await h.continuations.truncate();
            break;
          case "unsupported":
            break;
        }
        const a2 = await run(h, first);
        expect(a2.attempt, variant).toMatchObject({ number: 2, kind: "retry", startMode: "fresh", resumedFromAttemptId: null, status: "succeeded" });
        expect(h.provider.requests[1]!.continuation, variant).toBeNull();
        expect(a2.settlement.invocation.status, variant).toBe("succeeded");
        if (variant === "corrupt") {
          expect(h.stores.continuations.get(a1.attempt.id)).toBeNull();
          expect(await payloads.get(row!.storageKey)).toBeNull();
        }
      } finally {
        h.close();
      }
    }
  });

  it("starts fresh when the prior termination is unsafe, the definition or Tool Policy changed, the manifest differs beyond its inputs, or the projected context does not fit", async () => {
    // Unsafe termination: a permanent failure ends the Invocation; a tool failure is not continued.
    const u = openRuntimeHarness();
    try {
      const s = seedRuntime(u);
      const first = startRun(u, s).prepared.invocation;
      u.provider.script({ kind: "tool_failure", tool: "shell", continuation: "state" }, { kind: "succeed", result: COMPLETED_RESULT });
      const a1 = await run(u, first);
      expect(a1.attempt.failureClass).toBe("tool_failure");
      expect(u.stores.continuations.get(a1.attempt.id)).not.toBeNull();
      expect(u.executor.inspectInvocation(first.id).resumeCandidateAttemptId).toBeNull();
      expect((await run(u, first)).attempt.startMode).toBe("fresh");
    } finally {
      u.close();
    }
    // A changed Agent Definition revision or Tool Policy across the boundary.
    const d = openRuntimeHarness();
    try {
      const s = seedRuntime(d);
      const first = startRun(d, s).prepared.invocation;
      d.provider.script({ kind: "succeed", result: COMPLETED_RESULT, continuation: "state" }, { kind: "succeed", result: COMPLETED_RESULT });
      await run(d, first);
      const definition = d.stores.agents.ensureDefinition("orchestrator");
      const revised = d.stores.agents.appendRevision(definition.id, {
        provenance: { kind: "builtin" },
        modelPolicy: s.orchestrator.modelPolicy,
        instructions: s.orchestrator.instructions,
        capabilities: s.orchestrator.capabilities,
        toolPolicy: { read: "allowed", write: "allowed", shell: "allowed" },
        defaultLimits: s.orchestrator.defaultLimits,
      });
      expect(revised.id).not.toBe(s.orchestrator.id);
      // A position runs exactly the revision its node shape pins: a successor cannot switch definitions, so a changed
      // definition is refused at preparation rather than reaching the continuation policy at all.
      expect(() => successor(d, s, first, { agentDefinitionRevisionId: revised.id })).toThrow(/runs Agent Definition revision/);
      expect(d.stores.invocations.listByRun(s.created.run.id)).toHaveLength(1);
    } finally {
      d.close();
    }
    // A manifest that differs beyond its logical inputs — here the effective Tool Policy narrowed by the Workspace policy under the same revision — is not continued.
    const m = openRuntimeHarness();
    try {
      const s = seedRuntime(m);
      const first = startRun(m, s).prepared.invocation;
      m.provider.script({ kind: "succeed", result: COMPLETED_RESULT, continuation: "state" }, { kind: "succeed", result: COMPLETED_RESULT });
      await run(m, first);
      const narrowed = new InvocationPreparationService(m.ctx, m.stores, m.executionWorkspace, { workspacePolicy: { deniedTools: ["shell"], approvalRequiredTools: [], deniedMcpServers: [] } });
      const message = m.stores.conversations.postMessage({ conversationId: s.created.run.conversationId, author: "operator", content: "Continue.", runId: s.created.run.id, invocationId: null });
      const next = narrowed.prepare({ runId: s.created.run.id, planNodeId: s.created.root.id, role: "orchestrator", purpose: "operator_input", continuedFromInvocationId: first.id, patternPosition: { kind: "orchestrator" }, inputs: [{ kind: "operator_message", conversationMessageId: message.id, content: message.content }] });
      expect(next.manifest.content.toolPolicy.shell).toBe("denied");
      expect(manifestContinuationContext(next.manifest)).not.toBe(manifestContinuationContext(m.stores.invocations.getManifest(first.id)));
      expect(m.executor.inspectInvocation(next.invocation.id).resumeCandidateAttemptId).toBeNull();
      expect((await run(m, next.invocation)).attempt).toMatchObject({ startMode: "fresh", status: "succeeded" });
      // A Worker on another node has no predecessor at all: never a candidate.
      const s2 = seedPlanningRuntime(m);
      const outcome = m.planRevisions.propose({ runId: s2.created.run.id, proposedByInvocationId: s2.invocation.id, source: { version: 1, expressions: [{ pattern: "single", operation: { agentDefinitionRevisionId: s2.worker.id }, allocation: { costUsd: 4, tokens: 40_000, attempts: 4 } }] } });
      if (!outcome.accepted) throw new Error(outcome.reasons.map((r) => r.message).join("; "));
      const node = outcome.graph.nodes[1]!;
      m.stores.plans.transitionNode(node.id, { to: "ready" });
      m.stores.plans.transitionNode(node.id, { to: "running" });
      const worker = m.preparation.prepare({ runId: s2.created.run.id, planNodeId: node.id, role: "worker", purpose: "step", continuedFromInvocationId: null, patternPosition: { kind: "single" } });
      expect(m.executor.inspectInvocation(worker.invocation.id).resumeCandidateAttemptId).toBeNull();
    } finally {
      m.close();
    }
    // Projected context or cost: the last prompt exceeded the context policy, or the token allocation cannot cover it.
    const c = openRuntimeHarness({ executor: { retry: { backoffBaseMs: 1000, backoffMaxMs: 1000 }, continuation: { contextWindowTokens: 1_000 } } });
    try {
      const s = seedRuntime(c);
      const first = startRun(c, s).prepared.invocation;
      c.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: ["art_000000000000000000000000"] }, continuation: "state", usage: [{ ...DEFAULT_USAGE, inputTokensUncached: 900 }] }, { kind: "succeed", result: COMPLETED_RESULT });
      await run(c, first);
      // 900 tokens of prompt exceed 0.8 × 1000: fresh.
      expect(c.executor.inspectInvocation(first.id).resumeCandidateAttemptId).toBeNull();
      expect((await run(c, first)).attempt.startMode).toBe("fresh");
    } finally {
      c.close();
    }
    const t = openRuntimeHarness();
    try {
      const s = seedRuntime(t);
      const first = t.runStart.start({ runId: s.created.run.id, conversationMessageId: s.message.id }).prepared.invocation;
      expect(first.allocation.tokens).toBe(20_000);
      t.provider.script({ kind: "succeed", result: { ...COMPLETED_RESULT, artifactIds: ["art_000000000000000000000000"] }, continuation: "state", usage: [{ ...DEFAULT_USAGE, inputTokensUncached: 12_000 }] }, { kind: "succeed", result: COMPLETED_RESULT });
      await run(t, first);
      // 12 000 tokens of prompt do not fit the 8 000 tokens left of the allocation: fresh.
      expect(t.executor.inspectInvocation(first.id).resumeCandidateAttemptId).toBeNull();
      expect((await run(t, first)).attempt.startMode).toBe("fresh");
    } finally {
      t.close();
    }
  });
});
