import { z } from "zod";
import type { ArtifactId, HandoffId, InvocationId, PlanNodeId, RunId, TaskId } from "./ids.ts";
import { defineStateMachine } from "./transitions.ts";
import { idSchema, timestampSchema, uniqueIds, type Timestamp } from "./validation.ts";

/** A Handoff endpoint: a Plan Node or an Invocation. */
export type HandoffEndpoint =
  | { kind: "plan_node"; planNodeId: PlanNodeId }
  | { kind: "invocation"; invocationId: InvocationId };

export const handoffEndpointSchema: z.ZodType<HandoffEndpoint> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan_node"), planNodeId: idSchema("planNode") }),
  z.strictObject({ kind: z.literal("invocation"), invocationId: idSchema("invocation") }),
]);

export const HANDOFF_STATUSES = ["pending", "delivered", "cancelled"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const HANDOFF_MAX_SUMMARY_LENGTH = 500;

/**
 * Routing metadata only: source, target, Task ids, Artifact ids, a bounded
 * summary, and a status. No free-form state and no instructions.
 */
export interface Handoff {
  id: HandoffId;
  runId: RunId;
  source: HandoffEndpoint;
  target: HandoffEndpoint;
  taskIds: TaskId[];
  artifactIds: ArtifactId[];
  summary: string;
  status: HandoffStatus;
  createdAt: Timestamp;
  deliveredAt: Timestamp | null;
}

export const HANDOFF_MACHINE = defineStateMachine<HandoffStatus>("Handoff", HANDOFF_STATUSES, {
  pending: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
});

export const handoffSchema: z.ZodType<Handoff> = z
  .strictObject({
    id: idSchema("handoff"),
    runId: idSchema("run"),
    source: handoffEndpointSchema,
    target: handoffEndpointSchema,
    taskIds: uniqueIds(idSchema("task")),
    artifactIds: uniqueIds(idSchema("artifact")),
    summary: z.string().max(HANDOFF_MAX_SUMMARY_LENGTH),
    status: z.enum(HANDOFF_STATUSES),
    createdAt: timestampSchema,
    deliveredAt: timestampSchema.nullable(),
  })
  .refine((h) => (h.status === "delivered") === (h.deliveredAt !== null), {
    message: "deliveredAt is set exactly when the Handoff is delivered",
    path: ["deliveredAt"],
  });

export interface HandoffInput {
  runId: RunId;
  source: HandoffEndpoint;
  target: HandoffEndpoint;
  taskIds: TaskId[];
  artifactIds: ArtifactId[];
  summary: string;
}

export const handoffInputSchema: z.ZodType<HandoffInput> = z.strictObject({
  runId: idSchema("run"),
  source: handoffEndpointSchema,
  target: handoffEndpointSchema,
  taskIds: uniqueIds(idSchema("task")),
  artifactIds: uniqueIds(idSchema("artifact")),
  summary: z.string().max(HANDOFF_MAX_SUMMARY_LENGTH),
});
