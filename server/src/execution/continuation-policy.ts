/**
 * Provider resumption safety (execution-model §6.6), decided from canonical
 * facts only: which prior Attempt, if any, the next Attempt of an Invocation
 * may continue from. A candidate exists when the adapter supports
 * continuation, the prior Attempt ended in a safe state, the same Agent
 * Definition revision and effective Tool Policy apply, the manifest differs
 * across an Invocation boundary only by the new logical inputs, an
 * unexpired index row exists, and the projected context and cost fit the
 * allocation and context policy. Whether the payload is present and intact
 * is checked when the Attempt is prepared; every failure yields `fresh`.
 */
import { canonicalJson, isContinuationSafeTermination, type Attempt, type AttemptId, type ContextManifest, type Invocation, type Timestamp } from "@agentique-console/core";
import type { Stores } from "../persistence/stores/index.ts";
import type { ContinuationService } from "../provider/continuation.ts";
import type { ProviderAdapter } from "../provider/adapter.ts";

export interface ContinuationPolicyConfig {
  /** The provider's context window in tokens; the last prompt size over `maxContextOccupancy × window` prefers a fresh start. */
  contextWindowTokens: number;
}

export type ContinuationCandidate = { attemptId: AttemptId; boundary: "same_invocation" | "invocation" };

/**
 * The manifest fields that must be identical for a continuation across an
 * Invocation boundary: the definition, its instructions and model policy,
 * the role, node, and Run, and the effective capabilities, Tool Policy,
 * runtime tools, and funding. Everything else — purpose, inputs, Handoffs,
 * Artifacts, Decisions, Tasks, Requirements, the new Invocation's starting
 * Snapshot and worktree, its allocation — is the new logical input the
 * successor was created to receive.
 */
export function manifestContinuationContext(manifest: ContextManifest): string {
  const c = manifest.content;
  return canonicalJson({
    agentDefinitionRevisionId: c.agentDefinitionRevisionId,
    agentDefinitionContentHash: c.agentDefinitionContentHash,
    instructions: c.instructions,
    modelPolicy: c.modelPolicy,
    role: c.role,
    runId: c.runId,
    planNodeId: c.planNodeId,
    capabilities: c.capabilities,
    toolPolicy: c.toolPolicy,
    runtimeTools: c.runtimeTools,
    allocationSource: c.allocationSource,
    finalReserveUse: c.finalReserveUse,
  });
}

export function continuationCandidate(
  stores: Stores,
  continuations: ContinuationService,
  provider: Pick<ProviderAdapter, "provider" | "supportsContinuation">,
  config: ContinuationPolicyConfig,
  invocation: Invocation,
  manifest: ContextManifest,
  now: Timestamp,
): ContinuationCandidate | null {
  if (!provider.supportsContinuation) return null;
  const attempts = stores.invocations.listAttempts(invocation.id);
  const latest = attempts.at(-1) ?? null;
  let prior: Attempt | null = null;
  let boundary: ContinuationCandidate["boundary"];
  if (latest !== null) {
    prior = latest;
    boundary = "same_invocation";
  } else {
    if (invocation.continuedFromInvocationId === null) return null;
    const previous = stores.invocations.get(invocation.continuedFromInvocationId);
    if (previous.agentDefinitionRevisionId !== invocation.agentDefinitionRevisionId) return null;
    let previousManifest: ContextManifest;
    try {
      previousManifest = stores.invocations.getManifest(previous.id);
    } catch {
      return null;
    }
    if (manifestContinuationContext(previousManifest) !== manifestContinuationContext(manifest)) return null;
    prior = stores.invocations.latestAttempt(previous.id);
    boundary = "invocation";
  }
  if (prior === null || !isContinuationSafeTermination(prior)) return null;
  if (!continuations.indexed(prior.id, now)) return null;
  if (!fitsContextPolicy(stores, config, invocation, manifest, prior)) return null;
  return { attemptId: prior.id, boundary };
}

/** The prior Attempt's last prompt size must fit the context policy and the remaining token allocation. */
function fitsContextPolicy(stores: Stores, config: ContinuationPolicyConfig, invocation: Invocation, manifest: ContextManifest, prior: Attempt): boolean {
  const rows = stores.usage.listByAttempt(prior.id);
  const last = rows.at(-1);
  if (!last) return true;
  const occupancy = last.inputTokensUncached + last.cacheCreationTokens + last.cacheReadTokens;
  if (occupancy > manifest.content.modelPolicy.maxContextOccupancy * config.contextWindowTokens) return false;
  const consumed = stores.usage.consumedByInvocation(invocation.id);
  return invocation.allocation.tokens - consumed.tokens >= occupancy;
}
