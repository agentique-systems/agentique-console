import { z } from "zod";
import { SIGNOFF_OPTIONS, type SignoffOption } from "./decisions.ts";
import { DomainError } from "./errors.ts";
import type { ChangesetId, ConversationMessageId, DecisionId, GateId, InvocationId, RunId, SignoffResolutionId } from "./ids.ts";
import { idSchema, timestampSchema, type Timestamp } from "./validation.ts";

/**
 * Signoff resolution (execution-model §3, §9.3, §10 `operator_signoff`).
 * The operator resolves the one `signoff` Decision of a Run awaiting signoff
 * by exactly one of two closed operations: `accept`, which records the
 * verified integration Snapshot as the Run's final Snapshot, records the
 * Run's `final` Changeset, and completes the Run; or `request_changes`,
 * which returns the Run to `running` with one follow-up root Orchestrator
 * turn. Each outcome is one canonical **Signoff Resolution** row — the
 * record that makes the operator's decision idempotent and restart-safe.
 * Nothing infers a signoff outcome from Conversation text, an Orchestrator
 * result, a model summary, a manifest, or an unresolved Decision.
 */

/** The closed outcomes of a Signoff Resolution: exactly the `signoff` Decision's options. */
export const SIGNOFF_RESOLUTION_OUTCOMES = SIGNOFF_OPTIONS;
export type SignoffResolutionOutcome = SignoffOption;

/**
 * The canonical record of one resolved `operator_signoff` Gate: the Run, the
 * Gate, its `signoff` Decision, the outcome, the operator's Conversation
 * message for `request_changes` (by id — the prose is never copied), the
 * Run's `final` Changeset for `accept`, the one follow-up Orchestrator
 * Invocation a `request_changes` resolution prepared, and when it was
 * resolved. Exactly one exists per signoff Gate and per signoff Decision;
 * identity and outcome are immutable; rows are never deleted; the follow-up
 * link is recorded once, in the transaction that prepared the Invocation.
 */
export interface SignoffResolution {
  id: SignoffResolutionId;
  runId: RunId;
  gateId: GateId;
  decisionId: DecisionId;
  outcome: SignoffResolutionOutcome;
  /** The operator's message a `request_changes` resolution answers; `null` for `accept`. */
  operatorMessageId: ConversationMessageId | null;
  /** The Run's `final` Changeset an `accept` resolution recorded; `null` for `request_changes`. */
  finalChangesetId: ChangesetId | null;
  /** The follow-up root `decision_resolution` Orchestrator Invocation of a `request_changes` resolution; `null` for `accept`. */
  followUpInvocationId: InvocationId | null;
  resolvedAt: Timestamp;
}

type SignoffResolutionShape = Pick<SignoffResolution, "outcome" | "operatorMessageId" | "finalChangesetId" | "followUpInvocationId">;

function signoffResolutionShape(resolution: SignoffResolutionShape, ctx: z.RefinementCtx): void {
  if (resolution.outcome === "accept") {
    if (resolution.finalChangesetId === null) ctx.addIssue({ code: "custom", path: ["finalChangesetId"], message: "an accept resolution records the Run's final Changeset" });
    if (resolution.operatorMessageId !== null) ctx.addIssue({ code: "custom", path: ["operatorMessageId"], message: "an accept resolution answers no operator message" });
    if (resolution.followUpInvocationId !== null) ctx.addIssue({ code: "custom", path: ["followUpInvocationId"], message: "an accept resolution prepares no follow-up Invocation" });
  } else {
    if (resolution.operatorMessageId === null) ctx.addIssue({ code: "custom", path: ["operatorMessageId"], message: "a request_changes resolution names the operator's message" });
    if (resolution.finalChangesetId !== null) ctx.addIssue({ code: "custom", path: ["finalChangesetId"], message: "a request_changes resolution records no final Changeset" });
  }
}

export const signoffResolutionSchema: z.ZodType<SignoffResolution> = z
  .strictObject({
    id: idSchema("signoffResolution"),
    runId: idSchema("run"),
    gateId: idSchema("gate"),
    decisionId: idSchema("decision"),
    outcome: z.enum(SIGNOFF_RESOLUTION_OUTCOMES),
    operatorMessageId: idSchema("conversationMessage").nullable(),
    finalChangesetId: idSchema("changeset").nullable(),
    followUpInvocationId: idSchema("invocation").nullable(),
    resolvedAt: timestampSchema,
  })
  .superRefine(signoffResolutionShape);

/** What records a Signoff Resolution; the follow-up Invocation is linked afterwards, in the same transaction. */
export type SignoffResolutionInput =
  | { runId: RunId; gateId: GateId; decisionId: DecisionId; outcome: "accept"; finalChangesetId: ChangesetId }
  | { runId: RunId; gateId: GateId; decisionId: DecisionId; outcome: "request_changes"; operatorMessageId: ConversationMessageId };

export const signoffResolutionInputSchema: z.ZodType<SignoffResolutionInput> = z.discriminatedUnion("outcome", [
  z.strictObject({ runId: idSchema("run"), gateId: idSchema("gate"), decisionId: idSchema("decision"), outcome: z.literal("accept"), finalChangesetId: idSchema("changeset") }),
  z.strictObject({ runId: idSchema("run"), gateId: idSchema("gate"), decisionId: idSchema("decision"), outcome: z.literal("request_changes"), operatorMessageId: idSchema("conversationMessage") }),
]);

/**
 * Why the signoff service refuses an operation before writing anything, or
 * why acceptance could not be finalized. Every code names a canonical fact;
 * a refusal never resolves the Decision, closes the Gate, or moves the Run.
 */
export const SIGNOFF_REFUSAL_CODES = [
  /** The Run is not `awaiting_signoff`. */
  "run_not_awaiting_signoff",
  /** The operator paused the Run; signoff is resolved only once it is resumed (execution-model §14). */
  "run_paused",
  /** The Gate is not the Run's open `operator_signoff` Gate. */
  "gate_mismatch",
  /** The Decision is not the Gate's open, operator-required `signoff` Decision. */
  "decision_mismatch",
  /** The rows of the signoff boundary disagree with one another (Gate, Decision subject, completion Gate, request, Snapshot, report). */
  "boundary_inconsistent",
  /** The Gate was already resolved with the other outcome, or with other inputs. */
  "conflicting_resolution",
  /** Unexpected active state exists (an Invocation, Attempt, lease, reservation, cleanup obligation, Changeset, node Gate, remediation, Decision, request, Task, or Requirement); nothing is released or written. */
  "active_state",
  /** The Integration Workspace no longer holds exactly the verified Snapshot; acceptance stays retryable. */
  "workspace_drifted",
  /** The finalization Workspace port could not inspect the Integration Workspace; acceptance stays retryable. */
  "finalization_failed",
  /** The operator message does not belong to the Run's Conversation, is not the operator's, or was consumed by another resolution. */
  "operator_message_invalid",
  /** The root node's ordinary allocation cannot fund the follow-up Orchestrator turn; the final reserve is never a fallback. */
  "ordinary_capacity_insufficient",
] as const;
export type SignoffRefusalCode = (typeof SIGNOFF_REFUSAL_CODES)[number];

/** A refused signoff operation: the closed code and bounded details (ids and closed facts only). */
export class SignoffRefusedError extends DomainError {
  readonly refusal: SignoffRefusalCode;

  constructor(refusal: SignoffRefusalCode, message: string, details: Record<string, unknown> = {}) {
    super("conflict", message, { refusal, ...details });
    this.refusal = refusal;
  }
}
