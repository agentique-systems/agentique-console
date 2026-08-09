/**
 * `browser_evaluate`'s in-page compiler.
 *
 * `runInPage` is the exact function Playwright serializes into the page, and
 * `new Function` behaves identically in Node and Chrome — so these run the real
 * code path without a browser.
 *
 * The regression: the old wrapper chose its strategy with
 * `source.includes("return")`, a substring test over the whole source. Every
 * fixture in the first describe block below is a pure expression that the old
 * rule mis-classified as a statement body, producing `{result: null}` with no
 * indication anything had gone wrong. db-live-2's renderer hit this twice and
 * concluded the evaluator "chokes on function expressions" — a reasonable but
 * wrong theory that cost it two rewrites.
 */
import { describe, expect, it } from "vitest";
import { runInPage } from "./browser-manager.ts";

describe("runInPage — expressions containing the word `return`", () => {
  it("evaluates a filter with a function callback (the db-live-2 probe)", async () => {
    (globalThis as unknown as { __probe: () => unknown[] }).__probe = () => [
      { kind: "obstacle", z: 1 },
      { kind: "player", z: 0 },
      { kind: "obstacle", z: 2 },
    ];
    const outcome = await runInPage("globalThis.__probe().filter(function(b){return b.kind==='obstacle'})");
    expect(outcome.result).toEqual([{ kind: "obstacle", z: 1 }, { kind: "obstacle", z: 2 }]);
    expect(outcome.undefined).toBeUndefined();
    expect(outcome.compileError).toBeUndefined();
  });

  it("evaluates an IIFE that returns a value", async () => {
    const outcome = await runInPage("(() => { const c = 6; return JSON.stringify({ c }); })()");
    expect(outcome.result).toBe('{"c":6}');
  });

  it("evaluates a map whose callback returns", async () => {
    const outcome = await runInPage("[1,2,3].map(function(n){ return n * 2 })");
    expect(outcome.result).toEqual([2, 4, 6]);
  });

  it("still evaluates a plain expression with no `return` anywhere", async () => {
    const outcome = await runInPage("JSON.stringify({ booted: true })");
    expect(outcome.result).toBe('{"booted":true}');
  });
});

describe("runInPage — statement bodies", () => {
  it("falls back to a statement body when the source is not an expression", async () => {
    const outcome = await runInPage("const a = 2; const b = 3; return a + b;");
    expect(outcome.result).toBe(5);
    expect(outcome.compileError).toBeUndefined();
  });

  it("handles a multi-statement body with control flow", async () => {
    const outcome = await runInPage("let total = 0; for (const n of [1,2,3]) { total += n; } return total;");
    expect(outcome.result).toBe(6);
  });

  it("awaits an async statement body", async () => {
    const outcome = await runInPage("const v = await Promise.resolve(41); return v + 1;");
    expect(outcome.result).toBe(42);
  });
});

describe("runInPage — the four outcomes stay distinguishable", () => {
  it("reports a genuine null as a result, not as an absence", async () => {
    const outcome = await runInPage("null");
    expect(outcome.result).toBeNull();
    expect(outcome.undefined).toBeUndefined();
    expect(outcome.threw).toBeUndefined();
  });

  it("marks `undefined` distinctly from null", async () => {
    const outcome = await runInPage("undefined");
    expect(outcome.result).toBeNull();
    expect(outcome.undefined).toBe(true);
  });

  it("names a page exception rather than swallowing it into null", async () => {
    const outcome = await runInPage("(() => { throw new TypeError('canvas is not ready') })()");
    expect(outcome.result).toBeNull();
    expect(outcome.threw).toBe("TypeError: canvas is not ready");
    // A thrown page error is a finding, not the seat's mistake.
    expect(outcome.compileError).toBeUndefined();
  });

  it("reports unparseable source as a compile error", async () => {
    const outcome = await runInPage("const = = ;;;");
    expect(outcome.compileError).toBeDefined();
    expect(outcome.compileError).toContain("SyntaxError");
    expect(outcome.threw).toBeUndefined();
  });

  it("surfaces a rejected promise as a throw", async () => {
    const outcome = await runInPage("Promise.reject(new Error('boom'))");
    expect(outcome.threw).toBe("Error: boom");
  });
});
