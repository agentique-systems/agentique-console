import { describe, expect, it } from "vitest";
import {
  deltaMessage,
  errorMessage,
  initMessage,
  reasoningDeltaMessage,
  successMessage,
  textMessage,
  toolResultMessage,
  toolUseMessage,
} from "./fake.ts";
import { capJson, mapSdkMessage } from "./mapping.ts";

describe("mapSdkMessage", () => {
  it("maps system init to resume", () => {
    expect(mapSdkMessage(initMessage("sess-1"))).toEqual([
      { kind: "resume", resumeId: "sess-1" },
    ]);
  });

  it("maps text and thinking deltas", () => {
    expect(mapSdkMessage(deltaMessage("hel"))).toEqual([
      { kind: "delta", text: "hel" },
    ]);
    expect(mapSdkMessage(reasoningDeltaMessage("hmm"))).toEqual([
      { kind: "reasoning-delta", text: "hmm" },
    ]);
  });

  it("tags subagent-parented deltas and blocks with their parentCallId (A4)", () => {
    expect(
      mapSdkMessage({ ...deltaMessage("x"), parent_tool_use_id: "tu_1" }),
    ).toEqual([{ kind: "delta", text: "x", parentCallId: "tu_1" }]);
    expect(
      mapSdkMessage({ ...textMessage("x"), parent_tool_use_id: "tu_1" }),
    ).toEqual([{ kind: "message", text: "x", parentCallId: "tu_1" }]);
    expect(
      mapSdkMessage({
        ...toolResultMessage("tu_2", "out"),
        parent_tool_use_id: "tu_1",
      }),
    ).toEqual([
      {
        kind: "tool.result",
        callId: "tu_2",
        output: "out",
        isError: false,
        parentCallId: "tu_1",
      },
    ]);
  });

  it("maps the authoritative idle signal to turn-idle, other states to nothing", () => {
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
      }),
    ).toEqual([{ kind: "turn-idle" }]);
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "session_state_changed",
        state: "running",
      }),
    ).toEqual([]);
  });

  it("surfaces background-task lifecycle: progress as liveness, failure as terminal", () => {
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "task_progress",
        description: "recon session",
        summary: "Reading the auth module",
      }),
    ).toEqual([
      { kind: "notice", text: "recon session · Reading the auth module" },
    ]);
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "task_notification",
        status: "failed",
        summary: "API error",
      }),
    ).toEqual([{ kind: "task-terminal", status: "failed", summary: "API error" }]);
    // Completions are silent — the coordinator reports its own results.
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "task_notification",
        status: "completed",
        summary: "done",
      }),
    ).toEqual([]);
  });

  it("carries the structured tool_use_result on tool results", () => {
    expect(
      mapSdkMessage(
        toolResultMessage("tu_9", "launched", false, {
          agentId: "agent-42",
          status: "async_launched",
        }),
      ),
    ).toEqual([
      {
        kind: "tool.result",
        callId: "tu_9",
        output: "launched",
        isError: false,
        structured: { agentId: "agent-42", status: "async_launched" },
      },
    ]);
  });

  it("maps assistant text and tool_use blocks in order", () => {
    const combined = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Working on it." },
          { type: "tool_use", id: "tu_1", name: "Read", input: { file: "a" } },
        ],
      },
    };
    expect(mapSdkMessage(combined)).toEqual([
      { kind: "message", text: "Working on it." },
      { kind: "tool.call", callId: "tu_1", name: "Read", input: { file: "a" } },
    ]);
  });

  it("ignores empty text blocks", () => {
    expect(mapSdkMessage(textMessage(""))).toEqual([]);
  });

  it("maps tool results with error flag", () => {
    expect(mapSdkMessage(toolResultMessage("tu_1", "output"))).toEqual([
      { kind: "tool.result", callId: "tu_1", output: "output", isError: false },
    ]);
    expect(mapSdkMessage(toolResultMessage("tu_1", "boom", true))).toEqual([
      { kind: "tool.result", callId: "tu_1", output: "boom", isError: true },
    ]);
  });

  it("maps permission_denied to an error tool result", () => {
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "permission_denied",
        tool_use_id: "tu_9",
        tool_name: "Bash",
      }),
    ).toEqual([
      {
        kind: "tool.result",
        callId: "tu_9",
        output: "Denied Bash by permission rules.",
        isError: true,
      },
    ]);
  });

  it("maps success results with resume id and cost", () => {
    expect(
      mapSdkMessage(
        successMessage(
          { message: "done", to: null },
          { session_id: "sess-2", total_cost_usd: 0.42 },
        ),
      ),
    ).toEqual([
      {
        kind: "result",
        output: { message: "done", to: null },
        resumeId: "sess-2",
        // Named cumulative because it IS: the SDK restates the session's
        // running total on every result, so consumers must delta, not sum.
        cumulativeCostUsd: 0.42,
      },
    ]);
  });

  it("routes a CLI-level failure to the error branch despite subtype success", () => {
    const events = mapSdkMessage(successMessage(undefined, { is_error: true, session_id: "sess-3" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error" });
  });

  it("emits context occupancy from an assistant message's own usage", () => {
    // Per-call prompt size — the occupancy signal. The result message's usage is
    // the turn-wide sum and would overstate occupancy several-fold.
    const events = mapSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 41_000 } },
    });
    expect(events).toContainEqual({ kind: "context", occupancyTokens: 41_312 });
  });

  it("maps success without structured output (orchestrator turns)", () => {
    const events = mapSdkMessage(successMessage());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "result", output: undefined });
  });

  it("classifies error results", () => {
    expect(
      mapSdkMessage(errorMessage("error_max_turns", { num_turns: 50 })),
    ).toEqual([
      {
        kind: "error",
        message:
          "The agent stopped after reaching the maximum number of turns (50).",
        aborted: false,
      },
    ]);
    expect(
      mapSdkMessage(
        errorMessage("error_during_execution", {
          terminal_reason: "interrupted",
        }),
      ),
    ).toEqual([
      { kind: "error", message: "The turn was interrupted.", aborted: true },
    ]);
  });

  it("ignores unknown message types", () => {
    expect(mapSdkMessage({ type: "auth_status" })).toEqual([]);
    expect(mapSdkMessage({})).toEqual([]);
  });
});

// A turn can sit inside one provider call for minutes. These are the only
// signals that distinguish "waiting" from "hung", so they must survive.
describe("liveness notices", () => {
  it("maps the requesting and compacting statuses", () => {
    expect(
      mapSdkMessage({ type: "system", subtype: "status", status: "requesting" }),
    ).toEqual([{ kind: "notice", text: "requesting…" }]);
    expect(
      mapSdkMessage({ type: "system", subtype: "status", status: "compacting" }),
    ).toEqual([{ kind: "notice", text: "compacting the context…" }]);
    expect(
      mapSdkMessage({ type: "system", subtype: "status", status: null }),
    ).toEqual([]);
  });

  // Each retry now yields TWO events: the human-readable notice and the
  // structured numbers the console budgets on. Throwing the numbers away is
  // why nothing could notice a retry storm consuming 55% of a run.
  it("spells out rate-limit retries with the delay", () => {
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 90_000,
        error_status: 429,
      }),
    ).toEqual([
      { kind: "notice", text: "rate limited · retry 2/5 · in 1m 30s" },
      { kind: "retry", classification: "rate_limited", attempt: 2, maxRetries: 5, delayMs: 90_000, status: 429, detail: "rate limited · retry 2/5 · in 1m 30s" },
    ]);
  });

  it("names non-429 API errors by status", () => {
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 2_000,
        error_status: 529,
      }),
    ).toEqual([
      { kind: "notice", text: "API error 529 · retry 1/3 · in 2s" },
      { kind: "retry", classification: "api_error", attempt: 1, maxRetries: 3, delayMs: 2_000, status: 529, detail: "API error 529 · retry 1/3 · in 2s" },
    ]);
  });

  it("reports rate-limit events with the structured limit state", () => {
    expect(mapSdkMessage({ type: "rate_limit_event" })).toEqual([
      { kind: "notice", text: "rate limited — waiting for capacity" },
      { kind: "limit", status: "allowed" },
    ]);
    // The rejected form is the subscription-cap signal the capacity service
    // pauses on — a live run died because these fields were discarded.
    expect(mapSdkMessage({ type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1_700_000_000, rateLimitType: "five_hour", utilization: 1 } })).toEqual([
      { kind: "notice", text: "usage limit reached — pausing until capacity returns" },
      { kind: "limit", status: "rejected", resetsAt: 1_700_000_000, limitType: "five_hour", utilization: 1 },
    ]);
  });

  it("ticks long-running tools, ignoring subagent ticks", () => {
    expect(
      mapSdkMessage({
        type: "tool_progress",
        tool_name: "Bash",
        elapsed_time_seconds: 42,
      }),
    ).toEqual([{ kind: "notice", text: "Bash running · 42s" }]);
    expect(
      mapSdkMessage({
        type: "tool_progress",
        tool_name: "Bash",
        elapsed_time_seconds: 42,
        parent_tool_use_id: "tu_1",
      }),
    ).toEqual([]);
  });

  it("surfaces informational messages above the info level only", () => {
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "informational",
        level: "warning",
        content: "context is nearly full",
      }),
    ).toEqual([{ kind: "notice", text: "context is nearly full" }]);
    expect(
      mapSdkMessage({
        type: "system",
        subtype: "informational",
        level: "info",
        content: "chatter",
      }),
    ).toEqual([]);
  });
});

describe("capJson", () => {
  it("passes small values through", () => {
    expect(capJson({ a: 1 })).toEqual({ a: 1 });
  });

  it("truncates oversized values", () => {
    const big = "x".repeat(20_000);
    const capped = capJson(big) as { truncated: boolean; preview: string };
    expect(capped.truncated).toBe(true);
    expect(capped.preview.length).toBeLessThanOrEqual(16_384);
  });
});
