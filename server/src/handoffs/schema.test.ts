/**
 * Provider-tool schema conformance.
 *
 * Every JSON Schema the console hands to `outputFormat` or `sdk.tool` is
 * compiled by the CLI into a provider tool's `input_schema` and shipped
 * verbatim. The Messages API requires that schema's root `type` to be the
 * literal string "object" — but `["object","null"]` is legal JSON Schema and
 * passes the CLI's local Ajv validation, so the mistake only surfaces as a
 * runtime 400. That is exactly what happened in the db-live-1 run: 13 of 13
 * context rotations failed with
 *   `API Error: 400 tools.7.custom.input_schema.type: Input should be 'object'`
 * while `npm run verify` stayed green, because the fake SDK never inspects
 * outputFormat. These tests are the guard that makes green mean green.
 */
import { describe, expect, it } from "vitest";
import { assertProviderToolSchema, HANDOFF_DRAFT_JSON_SCHEMA } from "./schema.ts";

describe("provider tool schema conformance", () => {
  it("accepts the handoff draft schema the checkpoint path submits", () => {
    expect(() => assertProviderToolSchema("HANDOFF_DRAFT_JSON_SCHEMA", HANDOFF_DRAFT_JSON_SCHEMA)).not.toThrow();
    expect(HANDOFF_DRAFT_JSON_SCHEMA.type).toBe("object");
  });

  it("rejects the exact regression: a nullable union spread over the root", () => {
    const nullableRoot = { ...HANDOFF_DRAFT_JSON_SCHEMA, type: ["object", "null"] };
    expect(() => assertProviderToolSchema("checkpoint", nullableRoot))
      .toThrow(/root type must be the string "object"/);
  });

  it("rejects a missing root type and a root union", () => {
    expect(() => assertProviderToolSchema("no-type", { properties: {} })).toThrow(/root type/);
    expect(() => assertProviderToolSchema("union", { type: "object", anyOf: [{ type: "object" }] })).toThrow(/anyOf\/oneOf/);
    expect(() => assertProviderToolSchema("not-object", null)).toThrow(/must be an object/);
  });

  it("resolves every $ref the draft schema declares", () => {
    // A dangling $ref is the other way a schema passes review and 400s live.
    const defs = Object.keys(HANDOFF_DRAFT_JSON_SCHEMA.$defs);
    const refs = [...JSON.stringify(HANDOFF_DRAFT_JSON_SCHEMA).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(defs).toContain(ref);
  });
});
