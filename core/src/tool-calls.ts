import { z } from "zod";
import type { ApprovedToolCallUseId, AttemptId, DecisionId, InvocationId, PlanNodeId, RunId } from "./ids.ts";
import { canonicalJson, idSchema, nonEmptyString, sha256Hex, timestampSchema, type JsonValue, type Timestamp } from "./validation.ts";

/**
 * A provider-neutral proposed capability tool call: the console's tool name
 * and the call's input as plain JSON. This is the one representation an
 * `approval_required` interception is recorded and enforced in; a
 * provider-specific display string is never used for equality or
 * enforcement.
 */
export interface ProposedToolCall {
  tool: string;
  input: JsonValue;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]));

export const proposedToolCallSchema: z.ZodType<ProposedToolCall> = z.strictObject({ tool: nonEmptyString, input: jsonValueSchema });

/** The media type of the Artifact that holds a proposed call's canonical bytes. */
export const TOOL_CALL_MEDIA_TYPE = "application/x-tool-call+json";

/** The bound on a proposed call's canonical bytes; a larger call is a tool failure, never a truncated approval subject. */
export const TOOL_CALL_MAX_BYTES = 65_536;

/**
 * The canonicalization contract: the UTF-8 bytes of the canonical JSON
 * (`canonicalJson`: object keys sorted at every depth, no whitespace,
 * `undefined` members dropped, no non-finite numbers) of exactly
 * `{ "input": …, "tool": … }`. Two calls are the same call if and only if
 * their canonical bytes are equal; the canonical digest is the SHA-256 of
 * these bytes, which is also the digest of the call Artifact.
 */
export function canonicalToolCall(call: ProposedToolCall): string {
  return canonicalJson({ tool: call.tool, input: call.input });
}

/** The closed option set of a `side_effect_approval` Decision. */
export const SIDE_EFFECT_APPROVAL_OPTIONS = ["approve_once", "deny"] as const;
export type SideEffectApprovalOption = (typeof SIDE_EFFECT_APPROVAL_OPTIONS)[number];

/**
 * An **approval grant**: one call the operator approved once, as the
 * successor Invocation's immutable Context Manifest carries it. A grant is
 * eligibility input and nothing more: it authorizes exactly this tool with
 * exactly this canonical digest, at most once across the whole Run, and
 * whether it can still be claimed is decided by the canonical
 * `ApprovedToolCallUse` record, never by the manifest (which every Attempt
 * receives unchanged) and never by adapter memory. It changes neither the
 * Agent Definition nor the effective Tool Policy, and it authorizes no
 * later or different call.
 */
export interface ApprovedToolCall {
  decisionId: DecisionId;
  tool: string;
  callDigest: string;
}

export const approvedToolCallSchema: z.ZodType<ApprovedToolCall> = z.strictObject({
  decisionId: idSchema("decision"),
  tool: nonEmptyString,
  callDigest: sha256Hex,
});

/**
 * An **approval use**: the canonical, append-only record that one
 * `approve_once` grant was claimed. Exactly one use may ever exist per
 * `side_effect_approval` Decision; it is written in its own short
 * transaction before the adapter may execute the call and is never rolled
 * back because the provider later fails, the Attempt is retried,
 * finalization fails, or the process crashes. It records authorization,
 * not completion: a crash after the claim and before the external call
 * conservatively consumes the approval, and executing the same call again
 * needs a new Decision.
 */
export interface ApprovedToolCallUse {
  id: ApprovedToolCallUseId;
  /** The resolved `approve_once` `side_effect_approval` Decision this use consumed. */
  decisionId: DecisionId;
  tool: string;
  callDigest: string;
  runId: RunId;
  planNodeId: PlanNodeId;
  /** The successor Invocation whose manifest carried the grant. */
  invocationId: InvocationId;
  /** The running Attempt of that Invocation that claimed the grant. */
  attemptId: AttemptId;
  claimedAt: Timestamp;
}

export const approvedToolCallUseSchema: z.ZodType<ApprovedToolCallUse> = z.strictObject({
  id: idSchema("approvedToolCallUse"),
  decisionId: idSchema("decision"),
  tool: nonEmptyString,
  callDigest: sha256Hex,
  runId: idSchema("run"),
  planNodeId: idSchema("planNode"),
  invocationId: idSchema("invocation"),
  attemptId: idSchema("attempt"),
  claimedAt: timestampSchema,
});

/** What a claim names; the Run and Plan Node derive from the Invocation and are never chosen by the caller. */
export interface ApprovedToolCallUseInput {
  decisionId: DecisionId;
  invocationId: InvocationId;
  attemptId: AttemptId;
  tool: string;
  callDigest: string;
}

export const approvedToolCallUseInputSchema: z.ZodType<ApprovedToolCallUseInput> = z.strictObject({
  decisionId: idSchema("decision"),
  invocationId: idSchema("invocation"),
  attemptId: idSchema("attempt"),
  tool: nonEmptyString,
  callDigest: sha256Hex,
});

/** The closed reasons a claim is refused; a refused claim writes no row and no Event. */
export const APPROVAL_CLAIM_REFUSAL_REASONS = [
  "not_side_effect_approval",
  "not_resolved",
  "not_approved",
  "call_mismatch",
  "run_mismatch",
  "plan_node_mismatch",
  "predecessor_mismatch",
  "not_in_manifest",
  "invocation_not_running",
  "attempt_mismatch",
  "attempt_not_running",
  "already_used",
] as const;
export type ApprovalClaimRefusalReason = (typeof APPROVAL_CLAIM_REFUSAL_REASONS)[number];

export type ApprovalClaimOutcome = { kind: "claimed"; use: ApprovedToolCallUse } | { kind: "refused"; reason: ApprovalClaimRefusalReason };
