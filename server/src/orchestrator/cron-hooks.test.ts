/** Cron mirror parsing and the minimal matcher. */
import { describe, expect, it } from "vitest";
import { cronDue } from "./cron-hooks.ts";

describe("cronDue", () => {
  const at = (h: number, m: number) => new Date(2026, 7, 8, h, m); // Sat Aug 8 2026
  it("matches wildcards and exact fields", () => {
    expect(cronDue("* * * * *", at(9, 30))).toBe(true);
    expect(cronDue("30 9 * * *", at(9, 30))).toBe(true);
    expect(cronDue("31 9 * * *", at(9, 30))).toBe(false);
  });
  it("matches steps, lists, and ranges", () => {
    expect(cronDue("*/15 * * * *", at(9, 45))).toBe(true);
    expect(cronDue("*/15 * * * *", at(9, 50))).toBe(false);
    expect(cronDue("0,30 9-17 * * *", at(12, 30))).toBe(true);
    expect(cronDue("0,30 9-17 * * *", at(19, 30))).toBe(false);
  });
  it("respects day-of-week (Aug 8 2026 is a Saturday = 6)", () => {
    expect(cronDue("30 9 * * 6", at(9, 30))).toBe(true);
    expect(cronDue("30 9 * * 1", at(9, 30))).toBe(false);
  });
  it("never matches malformed expressions", () => {
    expect(cronDue("whenever", at(9, 30))).toBe(false);
    expect(cronDue("* * * *", at(9, 30))).toBe(false);
  });
});
