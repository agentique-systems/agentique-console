/**
 * Byte-true, UTF-8-safe windowing shared by every model-facing "big payload"
 * surface. Storage stays lossless; delivery is bounded: tools return one
 * window plus cursors, and the caller pays another call for more. read_handoff
 * pages head-first; the surfaces built on pageTail default to the newest
 * window because recent output is what a seat usually needs next.
 */
import { InvalidInputError } from "./errors.ts";

export const PAGE_DEFAULT_BYTES = 8 * 1024;
export const PAGE_MAX_BYTES = 32 * 1024;

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString("base64url");
}

export function decodeCursor(cursor: string, what = "cursor"): number {
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidInputError(`invalid ${what}`);
  return value;
}

export function clampPageBytes(maxBytes: number | undefined): number {
  return Math.max(4, Math.min(PAGE_MAX_BYTES, Math.floor(maxBytes ?? PAGE_DEFAULT_BYTES)));
}

/**
 * Forward window from `offset`. The end backs off past UTF-8 continuation
 * bytes so a codepoint never splits; the start advances past continuation
 * bytes in case a caller-computed offset lands mid-codepoint.
 */
export function sliceUtf8Window(buffer: Buffer, offset: number, maxBytes: number): { content: string; start: number; end: number } {
  let start = Math.max(0, Math.min(buffer.length, Math.floor(offset)));
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
  let end = Math.min(buffer.length, start + maxBytes);
  while (end < buffer.length && end > start && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { content: buffer.subarray(start, end).toString("utf8"), start, end };
}

export interface TextPage {
  content: string;
  /** Continues forward from the end of this window; null at end-of-data. */
  nextCursor: string | null;
  /** The window immediately before this one; null at offset 0. */
  previousCursor: string | null;
  totalBytes: number;
  offset: number;
}

/**
 * Tail-first paging: without a cursor, returns the LAST `maxBytes` window
 * (newest content) with previousCursor pointing backward. With a cursor,
 * returns the forward window from that offset.
 */
export function pageTail(text: string, cursor?: string | null, maxBytes?: number): TextPage {
  const bounded = clampPageBytes(maxBytes);
  const buffer = Buffer.from(text, "utf8");
  const offset = cursor ? decodeCursor(cursor) : Math.max(0, buffer.length - bounded);
  if (offset > buffer.length) throw new InvalidInputError("cursor is past the end of the data");
  const { content, start, end } = sliceUtf8Window(buffer, offset, bounded);
  return {
    content,
    nextCursor: end < buffer.length ? encodeCursor(end) : null,
    previousCursor: start > 0 ? encodeCursor(Math.max(0, start - bounded)) : null,
    totalBytes: buffer.length,
    offset: start,
  };
}
