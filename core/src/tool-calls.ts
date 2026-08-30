import { z } from "zod";
import type { DecisionId } from "./ids.ts";
import { canonicalJson, idSchema, nonEmptyString, sha256Hex, type JsonValue } from "./validation.ts";

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
 * One call the operator approved once, as the successor Invocation carries
 * it and the provider boundary enforces it: approval authorizes exactly
 * this tool with exactly this canonical digest, once; it changes neither
 * the Agent Definition nor the effective Tool Policy, and it authorizes no
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
