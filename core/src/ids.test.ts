import { describe, expect, it } from "vitest";
import { assertId, ID_PREFIXES, idPrefixOf, isId, isIdOfKind, newId } from "./ids.ts";

describe("ids", () => {
  it("mints ids with the glossary prefix and 24 hex characters", () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      expect(id).toMatch(new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-f]{24}$`));
      expect(isIdOfKind(kind, id)).toBe(true);
    }
  });

  it("never reuses a prefix for a second kind", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("uses exactly the glossary prefixes", () => {
    expect(Object.values(ID_PREFIXES).sort()).toEqual(
      ["ws", "cv", "cvm", "run", "pn", "pe", "req", "reqr", "ac", "dec", "task", "art", "ho", "agd", "agdr", "inv", "att", "eval", "gate", "snap", "cs", "pub", "lease", "bres", "cm", "use", "acu", "rtc", "crq", "sres"].sort(),
    );
  });

  it("validates prefix and body strictly", () => {
    const id = newId("run");
    expect(isId("run", id)).toBe(true);
    expect(isId("inv", id)).toBe(false);
    expect(isId("run", "run_")).toBe(false);
    expect(isId("run", "run_ABCDEF0123456789abcdef01")).toBe(false);
    expect(isId("run", `run_${"a".repeat(23)}`)).toBe(false);
    expect(isId("run", 42)).toBe(false);
    expect(idPrefixOf(id)).toBe("run");
    expect(idPrefixOf("us_" + "a".repeat(24))).toBeNull();
    expect(idPrefixOf("not an id")).toBeNull();
  });

  it("is deterministic with an injected random source", () => {
    const fixed = () => "0123456789abcdef01234567";
    expect(newId("task", fixed)).toBe("task_0123456789abcdef01234567");
    expect(() => newId("task", () => "short")).toThrow(/24 lower-case hex/);
  });

  it("assertId throws a TypeError naming the expected prefix", () => {
    expect(() => assertId("pn", "task_0123456789abcdef01234567", "planNodeId")).toThrow(/planNodeId must be a pn_ id/);
    expect(assertId("pn", "pn_0123456789abcdef01234567")).toBe("pn_0123456789abcdef01234567");
  });
});
