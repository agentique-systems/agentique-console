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

  it("skips subagent-parented deltas and blocks", () => {
    expect(
      mapSdkMessage({ ...deltaMessage("x"), parent_tool_use_id: "tu_1" }),
    ).toEqual([]);
    expect(
      mapSdkMessage({ ...textMessage("x"), parent_tool_use_id: "tu_1" }),
    ).toEqual([]);
    expect(
      mapSdkMessage({
        ...toolResultMessage("tu_2", "out"),
        parent_tool_use_id: "tu_1",
      }),
    ).toEqual([]);
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
        costUsd: 0.42,
      },
    ]);
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
    ).toEqual([{ kind: "notice", text: "rate limited · retry 2/5 · in 1m 30s" }]);
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
    ).toEqual([{ kind: "notice", text: "API error 529 · retry 1/3 · in 2s" }]);
  });

  it("reports rate-limit events", () => {
    expect(mapSdkMessage({ type: "rate_limit_event" })).toEqual([
      { kind: "notice", text: "rate limited — waiting for capacity" },
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
