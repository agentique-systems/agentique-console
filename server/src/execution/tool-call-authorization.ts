/**
 * The runtime-owned tool-call authorization boundary (execution-model
 * §6.4). The adapter proposes the exact provider-neutral call and learns
 * one closed outcome; the runtime canonicalizes the call, evaluates the
 * effective Tool Policy, and — for an `approval_required` tool — claims a
 * matching unconsumed grant in its own committed transaction before the
 * adapter may execute anything. The port is bound to one Attempt,
 * Invocation, manifest, and policy when the provider request is built:
 * the adapter chooses no Invocation, Attempt, Decision, or use.
 *
 * Only a committed claim permits execution. The claim is never rolled
 * back because the provider later fails, the Attempt is retried,
 * finalization fails, or the process crashes; the same Decision can never
 * be claimed twice. This is at-most-once authorization: a crash between
 * the claim and the external call conservatively consumes the approval.
 */
import { boundedFailureMessage, canonicalToolCall, proposedToolCallSchema, TOOL_CALL_MAX_BYTES, type ApprovedToolCall, type AttemptId, type InvocationId, type PlanNodeId, type ProposedToolCall, type RunId, type ToolPolicy } from "@agentique-console/core";
import { sha256Hex } from "../persistence/blob-store.ts";
import type { PersistenceContext } from "../persistence/context.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { WriteOptions } from "../persistence/stores/support.ts";
import type { ToolCallAuthorization, ToolCallAuthorizationPort } from "../provider/adapter.ts";
import type { ExecutionDiagnosticSink } from "./workspace-cleanup.ts";

/** A proposed call validated and canonicalized once: the canonical bytes and their digest, or why the call is not a call. */
export type CanonicalizedToolCall = { kind: "ok"; call: ProposedToolCall; canonical: string; bytes: Uint8Array; digest: string } | { kind: "invalid"; tool: string | null; message: string };

/** The one canonicalization every runtime path uses: schema-valid, canonical JSON of `{ input, tool }`, bounded at `TOOL_CALL_MAX_BYTES`. */
export function canonicalizeToolCall(proposed: unknown): CanonicalizedToolCall {
  const parsed = proposedToolCallSchema.safeParse(proposed);
  const tool = typeof proposed === "object" && proposed !== null && typeof (proposed as { tool?: unknown }).tool === "string" ? (proposed as { tool: string }).tool : null;
  if (!parsed.success) return { kind: "invalid", tool, message: "proposed call is not a provider-neutral tool call (tool name and JSON input)" };
  const canonical = canonicalToolCall(parsed.data);
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength > TOOL_CALL_MAX_BYTES) return { kind: "invalid", tool: parsed.data.tool, message: `proposed ${parsed.data.tool} call exceeds the ${TOOL_CALL_MAX_BYTES}-byte canonical bound` };
  return { kind: "ok", call: parsed.data, canonical, bytes, digest: sha256Hex(canonical) };
}

/** What the runtime binds an authorization port to; all of it comes from canonical rows of the Attempt being executed. */
export interface ToolCallAuthorizationBinding {
  runId: RunId;
  planNodeId: PlanNodeId;
  invocationId: InvocationId;
  attemptId: AttemptId;
  /** The manifest's effective Tool Policy; an undeclared tool is `denied`. */
  toolPolicy: ToolPolicy;
  /** The manifest's approval grants: eligibility input whose consumption the store decides. */
  approvedCalls: ApprovedToolCall[];
}

export class ToolCallAuthorizer implements ToolCallAuthorizationPort {
  constructor(
    private readonly ctx: PersistenceContext,
    private readonly stores: Stores,
    private readonly binding: ToolCallAuthorizationBinding,
    private readonly options: WriteOptions = {},
    private readonly diagnostics: ExecutionDiagnosticSink = () => {},
  ) {}

  authorize(proposed: ProposedToolCall): ToolCallAuthorization {
    // The provider executes outside every transaction, so a claim always opens its own root transaction.
    if (this.ctx.tx.inTransaction) throw new Error("tool-call authorization is requested outside any persistence transaction");
    const canonical = canonicalizeToolCall(proposed);
    if (canonical.kind === "invalid") return { kind: "invalid", tool: canonical.tool, message: canonical.message };
    const { tool } = canonical.call;
    const disposition = this.binding.toolPolicy[tool] ?? "denied";
    if (disposition === "allowed") return { kind: "allowed", tool };
    if (disposition === "denied") return { kind: "denied", tool };
    const grant = this.binding.approvedCalls.find((g) => g.tool === tool && g.callDigest === canonical.digest);
    if (!grant) return { kind: "approval_required", tool, callDigest: canonical.digest };
    let outcome: ReturnType<Stores["approvedToolCallUses"]["claim"]>;
    try {
      outcome = this.stores.approvedToolCallUses.claim({ decisionId: grant.decisionId, invocationId: this.binding.invocationId, attemptId: this.binding.attemptId, tool, callDigest: canonical.digest }, this.options);
    } catch (error) {
      // The claim transaction failed (callback, constraint, or COMMIT): nothing persisted and nothing authorized. If another claimant
      // won meanwhile the grant is simply consumed; otherwise the failure is reported, bounded, and the retry may claim again.
      if (this.stores.approvedToolCallUses.getByDecision(grant.decisionId) !== null) return { kind: "approval_required", tool, callDigest: canonical.digest };
      const message = boundedFailureMessage(error instanceof Error ? error.message : String(error));
      this.diagnostics({ kind: "tool_call_authorization_failed", invocationId: this.binding.invocationId, attemptId: this.binding.attemptId, tool, callDigest: canonical.digest, message });
      return { kind: "failed", tool, message };
    }
    if (outcome.kind === "refused") return { kind: "approval_required", tool, callDigest: canonical.digest };
    return { kind: "approved_once", tool, callDigest: canonical.digest, decisionId: outcome.use.decisionId, useId: outcome.use.id };
  }
}
