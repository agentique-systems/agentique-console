/** The one MCP tool-result shape, shared by the seat and main-lane tool sets. */
import type { SdkToolResult } from "./types.ts";

export function ok(value: unknown): SdkToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * The one error shape. A tool call the model genuinely got wrong — a bad
 * route, an unknown owner, invalid input — returns through here; deliberate
 * non-errors (operator silence, a withheld final) stay `ok(...)`, because
 * `isError` feeds the error-streak watchdog.
 */
export function fail(error: unknown): SdkToolResult {
  return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
}

/** Runs a handler; any throw becomes a `fail` with the error's message. */
export async function guarded(run: () => unknown | Promise<unknown>): Promise<SdkToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error);
  }
}
