import { z } from "zod";
import { ID_PREFIXES, type Id, type IdKind, isId } from "./ids.ts";
import { ValidationError } from "./errors.ts";

/** ISO 8601 UTC with millisecond precision: `2026-01-01T00:00:00.000Z`. */
export type Timestamp = string;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isTimestamp(value: unknown): value is Timestamp {
  return typeof value === "string" && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

export function timestampNow(now: Date = new Date()): Timestamp {
  return now.toISOString();
}

export const timestampSchema = z.string().refine(isTimestamp, {
  message: "expected an ISO 8601 UTC timestamp with millisecond precision",
});

export function idSchema<K extends IdKind>(kind: K): z.ZodType<Id<(typeof ID_PREFIXES)[K]>> {
  const prefix = ID_PREFIXES[kind];
  return z.custom<Id<(typeof ID_PREFIXES)[K]>>((value) => isId(prefix, value), {
    message: `expected a ${prefix}_ id`,
  });
}

export const nonEmptyString = z.string().trim().min(1);

/** A non-negative finite quantity (tokens, cost, counts). */
export const quantity = z.number().min(0);

/** A non-negative integer count. */
export const count = z.number().int().min(0);

/** A positive integer count. */
export const positiveCount = z.number().int().min(1);

/** Hex-encoded SHA-256 digest, as used for Artifact content and hashes. */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a hex SHA-256 digest");

export function uniqueIds<T extends string>(schema: z.ZodType<T>) {
  return z.array(schema).refine((items) => new Set(items).size === items.length, {
    message: "ids must be unique",
  });
}

/**
 * Parses with `schema` and converts a failure into a typed `ValidationError`
 * naming the value being validated.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const first = issues[0];
  const where = first && first.path ? ` at ${first.path}` : "";
  throw new ValidationError(`invalid ${what}${where}: ${first?.message ?? "unknown"}`, {
    what,
    issues,
  });
}

/** JSON values that survive canonical serialization unchanged. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` members
 * dropped. Two equal values always serialize to the same bytes, so digests
 * and equality checks over persisted JSON are stable.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member !== undefined) out[key] = sortValue(member);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ValidationError("canonical JSON cannot represent a non-finite number");
  }
  return value;
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`invalid ${what}: not JSON`, {
      what,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
