import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "./errors.ts";
import { canonicalJson, idSchema, isTimestamp, parseJson, parseOrThrow, timestampNow, timestampSchema } from "./validation.ts";

describe("timestamps", () => {
  it("accepts only ISO 8601 UTC with millisecond precision", () => {
    expect(isTimestamp("2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isTimestamp(timestampNow())).toBe(true);
    expect(isTimestamp("2026-01-01T00:00:00Z")).toBe(false);
    expect(isTimestamp("2026-01-01T00:00:00.000+01:00")).toBe(false);
    expect(isTimestamp("2026-13-01T00:00:00.000Z")).toBe(false);
    expect(isTimestamp(1700000000)).toBe(false);
    expect(timestampSchema.safeParse("2026-01-01 00:00:00").success).toBe(false);
  });
});

describe("parseOrThrow", () => {
  it("converts a zod failure into a ValidationError with the path", () => {
    const schema = z.strictObject({ id: idSchema("run"), n: z.number() });
    try {
      parseOrThrow(schema, { id: "run_x", n: 1 }, "thing");
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toMatch(/invalid thing at id/);
      expect((error as ValidationError).details.issues).toHaveLength(1);
    }
  });

  it("rejects unknown keys on strict objects", () => {
    const schema = z.strictObject({ a: z.number() });
    expect(() => parseOrThrow(schema, { a: 1, b: 2 }, "thing")).toThrow(ValidationError);
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("is stable for equal values regardless of insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("refuses non-finite numbers", () => {
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(ValidationError);
  });

  it("parseJson reports malformed text as a ValidationError", () => {
    expect(() => parseJson("{", "payload")).toThrow(ValidationError);
    expect(parseJson('{"a":1}', "payload")).toEqual({ a: 1 });
  });
});
