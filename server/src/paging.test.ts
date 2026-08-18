/** Byte-true UTF-8-safe windowing shared by model-facing payload tools. */
import { describe, expect, it } from "vitest";
import { PAGE_MAX_BYTES, decodeCursor, encodeCursor, pageTail, sliceUtf8Window } from "./paging.ts";

describe("pageTail", () => {
  it("returns the last window by default with a backward cursor", () => {
    const text = "a".repeat(10_000);
    const page = pageTail(text, undefined, 1024);
    expect(page.content).toBe("a".repeat(1024));
    expect(page.totalBytes).toBe(10_000);
    expect(page.offset).toBe(10_000 - 1024);
    expect(page.nextCursor).toBeNull();
    expect(page.previousCursor).not.toBeNull();
  });

  it("forward cursor walk from zero reassembles the exact original bytes", () => {
    const text = "héllo wörld — ".repeat(500);
    const pieces: string[] = [];
    let cursor: string | null = encodeCursor(0);
    while (cursor) {
      const page = pageTail(text, cursor, 512);
      pieces.push(page.content);
      cursor = page.nextCursor;
    }
    expect(pieces.join("")).toBe(text);
  });

  it("previousCursor chain reaches offset zero", () => {
    const text = "x".repeat(5_000);
    let page = pageTail(text, undefined, 1000);
    let hops = 0;
    while (page.previousCursor) {
      page = pageTail(text, page.previousCursor, 1000);
      hops += 1;
      expect(hops).toBeLessThan(20);
    }
    expect(page.offset).toBe(0);
  });

  it("never splits multi-byte characters at either boundary", () => {
    const text = "汉字漢字🦆".repeat(300);
    let cursor: string | null = encodeCursor(0);
    while (cursor) {
      const page = pageTail(text, cursor, 100);
      expect(page.content).not.toContain("�");
      cursor = page.nextCursor;
    }
    const tail = pageTail(text, undefined, 101);
    expect(tail.content).not.toContain("�");
  });

  it("clamps maxBytes to the maximum", () => {
    const text = "b".repeat(PAGE_MAX_BYTES * 2);
    const page = pageTail(text, undefined, PAGE_MAX_BYTES * 10);
    expect(Buffer.byteLength(page.content)).toBe(PAGE_MAX_BYTES);
  });

  it("rejects invalid and past-end cursors", () => {
    expect(() => pageTail("abc", "!!not-b64-int!!")).toThrow(/invalid cursor/);
    expect(() => pageTail("abc", encodeCursor(4))).toThrow(/past the end/);
  });
});

describe("sliceUtf8Window / cursors", () => {
  it("advances a mid-codepoint start to the next boundary", () => {
    const buffer = Buffer.from("🦆abc", "utf8");
    const window = sliceUtf8Window(buffer, 1, 100);
    expect(window.content).toBe("abc");
    expect(window.start).toBe(4);
  });

  it("round-trips cursor offsets", () => {
    expect(decodeCursor(encodeCursor(12345))).toBe(12345);
    expect(() => decodeCursor(encodeCursor(-1))).toThrow(/invalid cursor/);
  });
});
