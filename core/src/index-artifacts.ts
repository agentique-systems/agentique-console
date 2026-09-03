import { z } from "zod";
import type { ArtifactId, InvocationId, PlanEdgeId, PlanNodeId } from "./ids.ts";
import { INVOCATION_FAILURE_REASONS, type InvocationFailureReason } from "./invocations.ts";
import { idSchema, nonEmptyString, uniqueIds, canonicalJson, parseOrThrow } from "./validation.ts";

/**
 * The runtime's fan-in index Artifacts (execution-model §5.4, §4.3, §7.7):
 * versioned, provider-neutral, canonical JSON documents that a `parallel`
 * node writes over its items and a `join` node writes over its `fan_in`
 * predecessors. An index carries structured facts only — ids, closed
 * outcomes, output Artifact ids, edge positions — never a transcript,
 * provider message, prompt, worktree path, continuation, copied Artifact
 * content, or narrative summary. The bytes of an index are the canonical
 * JSON of its document, so equal facts produce equal Artifacts.
 */

export const PARALLEL_INDEX_MEDIA_TYPE = "application/vnd.agentique.parallel-index.v1+json";
export const JOIN_INDEX_MEDIA_TYPE = "application/vnd.agentique.join-index.v1+json";
export const INDEX_ARTIFACT_VERSION = 1;

/** The closed terminal outcomes an item of a parallel node can end in. */
export const PARALLEL_ITEM_OUTCOMES = ["succeeded", "failed", "cancelled"] as const;
export type ParallelItemOutcome = (typeof PARALLEL_ITEM_OUTCOMES)[number];

/** Why an item failed: its Invocation failed, or its Invocation returned a `failed` or `blocked` result. */
export const PARALLEL_ITEM_FAILURES = ["invocation_failed", "result_failed", "result_blocked"] as const;
export type ParallelItemFailure = (typeof PARALLEL_ITEM_FAILURES)[number];

export interface ParallelIndexEntry {
  /** The item's position in the node's immutable shape. */
  index: number;
  /** The Invocation that ended the item (the successor after an approval, never the blocked predecessor). */
  invocationId: InvocationId;
  outcome: ParallelItemOutcome;
  /** The item's result Artifacts; empty unless it succeeded. */
  outputArtifactIds: ArtifactId[];
  /** Bounded failure classification; `null` unless the item failed. */
  failure: { kind: ParallelItemFailure; invocationFailureReason: InvocationFailureReason | null } | null;
}

export interface ParallelIndex {
  version: typeof INDEX_ARTIFACT_VERSION;
  planNodeId: PlanNodeId;
  /** Every item in index order; the count is the shape's item count. */
  items: ParallelIndexEntry[];
}

const ordered = <T extends { [K in keyof T]: unknown }>(key: keyof T) => (items: T[]) => items.every((item, i) => i === 0 || (items[i - 1]![key] as number) < (item[key] as number));

export const parallelIndexSchema: z.ZodType<ParallelIndex> = z.strictObject({
  version: z.literal(INDEX_ARTIFACT_VERSION),
  planNodeId: idSchema("planNode"),
  items: z
    .array(
      z
        .strictObject({
          index: z.number().int().min(0),
          invocationId: idSchema("invocation"),
          outcome: z.enum(PARALLEL_ITEM_OUTCOMES),
          outputArtifactIds: uniqueIds(idSchema("artifact")),
          failure: z.strictObject({ kind: z.enum(PARALLEL_ITEM_FAILURES), invocationFailureReason: z.enum(INVOCATION_FAILURE_REASONS).nullable() }).nullable(),
        })
        .refine((e) => (e.outcome === "failed") === (e.failure !== null), { message: "a failed item carries its failure classification; no other item does", path: ["failure"] })
        .refine((e) => e.outcome === "succeeded" || e.outputArtifactIds.length === 0, { message: "only a succeeded item has output Artifacts", path: ["outputArtifactIds"] }),
    )
    .min(1)
    .refine(ordered("index"), { message: "items are in index order" })
    .refine((items) => items.every((item, i) => item.index === i), { message: "items cover every index from 0 without gaps" }),
});

/** The closed terminal statuses a join records for a fan-in predecessor. */
export const JOIN_SOURCE_STATUSES = ["succeeded", "failed", "cancelled", "skipped"] as const;
export type JoinSourceStatus = (typeof JOIN_SOURCE_STATUSES)[number];

export interface JoinIndexEntry {
  /** The `fan_in` edge's position into the join, the primary order. */
  position: number;
  /** The edge id, the deterministic tie-breaker. */
  edgeId: PlanEdgeId;
  sourceNodeId: PlanNodeId;
  status: JoinSourceStatus;
  /** The source's output Artifacts; empty unless it succeeded. */
  outputArtifactIds: ArtifactId[];
}

export interface JoinIndex {
  version: typeof INDEX_ARTIFACT_VERSION;
  planNodeId: PlanNodeId;
  /** Every current-revision `fan_in` predecessor, by edge position then edge id. */
  sources: JoinIndexEntry[];
}

export const joinIndexSchema: z.ZodType<JoinIndex> = z.strictObject({
  version: z.literal(INDEX_ARTIFACT_VERSION),
  planNodeId: idSchema("planNode"),
  sources: z
    .array(
      z
        .strictObject({
          position: z.number().int().min(0),
          edgeId: idSchema("planEdge"),
          sourceNodeId: idSchema("planNode"),
          status: z.enum(JOIN_SOURCE_STATUSES),
          outputArtifactIds: uniqueIds(idSchema("artifact")),
        })
        .refine((e) => e.status === "succeeded" || e.outputArtifactIds.length === 0, { message: "only a succeeded source has output Artifacts", path: ["outputArtifactIds"] }),
    )
    .min(1)
    .refine((sources) => sources.every((s, i) => i === 0 || sources[i - 1]!.position < s.position || (sources[i - 1]!.position === s.position && sources[i - 1]!.edgeId < s.edgeId)), {
      message: "sources are ordered by edge position, then edge id",
    }),
});

/** The canonical text of a parallel index: validated, then canonical JSON; the Artifact's bytes are its UTF-8 encoding. */
export function canonicalParallelIndex(index: ParallelIndex): string {
  return canonicalJson(parseOrThrow(parallelIndexSchema, index, "parallel index"));
}

/** The canonical text of a join index: validated, then canonical JSON; the Artifact's bytes are its UTF-8 encoding. */
export function canonicalJoinIndex(index: JoinIndex): string {
  return canonicalJson(parseOrThrow(joinIndexSchema, index, "join index"));
}

export function parseParallelIndex(text: string): ParallelIndex {
  return parseOrThrow(parallelIndexSchema, JSON.parse(text), "parallel index");
}

export function parseJoinIndex(text: string): JoinIndex {
  return parseOrThrow(joinIndexSchema, JSON.parse(text), "join index");
}

/** The title an index Artifact carries; a label, never a summary. */
export function indexArtifactTitle(kind: "parallel" | "join", planNodeId: PlanNodeId): string {
  return parseOrThrow(nonEmptyString, `${kind} index of ${planNodeId}`, "index title");
}
