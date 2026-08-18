import { z } from "zod";

export const EvidenceRefSchema = z.object({
  kind: z.enum(["file", "journal", "artifact", "task", "command", "url"]),
  ref: z.string().min(1),
  label: z.string().optional(),
  digest: z.string().optional(),
});

export const HandoffCoreSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  taskId: z.string().nullable().default(null),
  status: z.enum(["pending", "in_progress", "blocked", "needs_verification", "completed", "failed"]),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  action: z.string().min(1),
  state: z.object({ summary: z.string().min(1), evidence: z.array(EvidenceRefSchema).default([]) }),
  result: z.object({ summary: z.string().nullable().default(null), artifacts: z.array(EvidenceRefSchema).default([]) }),
  uncertainty: z.array(z.string()).default([]),
  nextAction: z.string().nullable().default(null),
  requestExpandedContext: z.boolean().default(false),
});

export const HandoffExtensionSchema = z.object({
  kind: z.enum(["generic", "coordination", "implementation", "investigation", "review"]).default("generic"),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const HandoffDraftSchema = z.object({
  core: HandoffCoreSchema,
  extension: HandoffExtensionSchema.optional(),
});

/** Provider-facing JSON schema mirrors the runtime Zod contract. */
export const HANDOFF_DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    core: {
      type: "object",
      properties: {
        schemaVersion: { const: 1 },
        taskId: { type: ["string", "null"] },
        status: { enum: ["pending", "in_progress", "blocked", "needs_verification", "completed", "failed"] },
        risk: { enum: ["low", "medium", "high"] },
        action: { type: "string" },
        state: { type: "object", properties: { summary: { type: "string" }, evidence: { type: "array", items: { $ref: "#/$defs/evidence" } } }, required: ["summary", "evidence"], additionalProperties: false },
        result: { type: "object", properties: { summary: { type: ["string", "null"] }, artifacts: { type: "array", items: { $ref: "#/$defs/evidence" } } }, required: ["summary", "artifacts"], additionalProperties: false },
        uncertainty: { type: "array", items: { type: "string" } },
        nextAction: { type: ["string", "null"] },
        requestExpandedContext: { type: "boolean" },
      },
      required: ["schemaVersion", "taskId", "status", "risk", "action", "state", "result", "uncertainty", "nextAction", "requestExpandedContext"],
      additionalProperties: false,
    },
    extension: { type: ["object", "null"], properties: { kind: { enum: ["generic", "coordination", "implementation", "investigation", "review"] }, data: { type: "object", additionalProperties: true } }, required: ["kind", "data"], additionalProperties: false },
  },
  required: ["core", "extension"],
  additionalProperties: false,
  $defs: { evidence: { type: "object", properties: { kind: { enum: ["file", "journal", "artifact", "task", "command", "url"] }, ref: { type: "string" }, label: { type: "string" }, digest: { type: "string" } }, required: ["kind", "ref"], additionalProperties: false } },
} as const;

/**
 * Every schema handed to `outputFormat` or `sdk.tool` becomes a provider tool's
 * `input_schema`, and the Messages API requires its root `type` to be the
 * literal string "object" — a `["object","null"]` union is legal JSON Schema,
 * passes the CLI's local Ajv check, and then 400s on the wire. The constraint
 * is asserted here rather than left to review.
 */
export function assertProviderToolSchema(name: string, schema: unknown): void {
  const root = schema as { type?: unknown; $defs?: unknown; anyOf?: unknown; oneOf?: unknown };
  if (root === null || typeof root !== "object") throw new Error(`${name}: provider tool schema must be an object`);
  if (root.type !== "object") throw new Error(`${name}: provider tool schema root type must be the string "object", got ${JSON.stringify(root.type)}`);
  if (root.anyOf !== undefined || root.oneOf !== undefined) throw new Error(`${name}: provider tool schema root must not use anyOf/oneOf`);
}
