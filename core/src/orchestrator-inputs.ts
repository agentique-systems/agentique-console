/**
 * Queued root inputs (execution-model §4.6, §8.1, §8.2): the operator's
 * steering and the operator's resolutions that reach the Orchestrator as
 * typed inputs of its next logical turn — never injected into an active
 * provider session. Each row is one typed `ManifestInput`, queued when the
 * operator acts and delivered by exactly one later Orchestrator Invocation,
 * whose manifest lists it.
 */
import { z } from "zod";
import type { InvocationId, OrchestratorInputId, RunId } from "./ids.ts";
import { manifestInputSchema, type InvocationPurpose, type ManifestInput } from "./invocations.ts";
import { idSchema, timestampSchema, type Timestamp } from "./validation.ts";

/** The input kinds a root queue carries: an operator message, an operator (or superseding) Decision resolution, a proposal resolution. */
export const ORCHESTRATOR_INPUT_KINDS = ["operator_message", "decision_resolution", "requirement_proposal_resolution"] as const;
export type OrchestratorInputKind = (typeof ORCHESTRATOR_INPUT_KINDS)[number];

export type QueuedOrchestratorInput = Extract<ManifestInput, { kind: OrchestratorInputKind }>;

export interface OrchestratorInput {
  id: OrchestratorInputId;
  runId: RunId;
  kind: OrchestratorInputKind;
  input: QueuedOrchestratorInput;
  createdAt: Timestamp;
  /** The Orchestrator Invocation whose manifest delivered the input; `null` while queued. */
  deliveredByInvocationId: InvocationId | null;
  deliveredAt: Timestamp | null;
}

export const orchestratorInputSchema: z.ZodType<OrchestratorInput> = z
  .strictObject({
    id: idSchema("orchestratorInput"),
    runId: idSchema("run"),
    kind: z.enum(ORCHESTRATOR_INPUT_KINDS),
    input: manifestInputSchema.refine((i): i is QueuedOrchestratorInput => (ORCHESTRATOR_INPUT_KINDS as readonly string[]).includes(i.kind), { message: "a queued root input is an operator message, a Decision resolution, or a proposal resolution" }),
    createdAt: timestampSchema,
    deliveredByInvocationId: idSchema("invocation").nullable(),
    deliveredAt: timestampSchema.nullable(),
  })
  .refine((row) => row.input.kind === row.kind, { message: "the input carries the row's kind", path: ["input"] })
  .refine((row) => (row.deliveredByInvocationId === null) === (row.deliveredAt === null), { message: "delivery names the delivering Invocation and its time together", path: ["deliveredAt"] });

/**
 * The purpose of the turn that delivers `inputs`: the first applicable row of the purpose table (execution-model §4.6) — an
 * operator message makes it an `operator_input` turn, otherwise a node's result a `node_result` turn, otherwise a
 * `decision_resolution` turn (a Decision's or a proposal's resolution).
 */
export function orchestratorInputPurposeOf(inputs: readonly ManifestInput[]): Extract<InvocationPurpose, "operator_input" | "node_result" | "decision_resolution"> {
  if (inputs.some((i) => i.kind === "operator_message")) return "operator_input";
  if (inputs.some((i) => i.kind === "node_result")) return "node_result";
  return "decision_resolution";
}
