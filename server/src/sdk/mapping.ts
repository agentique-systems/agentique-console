/**
 * Pure SDK-message → TurnEvent mapper (port of agentique-core's mapping.ts,
 * cut to what v2 consumes). One SDK message maps to zero or more events; the
 * consumer decides persistence. Subagent-parented blocks are skipped — the
 * transcript shows the top-level thread only.
 */
import type { SdkMessage } from "./types.ts";

export type TurnEvent =
  | { kind: "resume"; resumeId: string }
  | { kind: "delta"; text: string }
  | { kind: "reasoning-delta"; text: string }
  | { kind: "message"; text: string }
  | { kind: "tool.call"; callId: string; name: string; input: unknown }
  | { kind: "tool.result"; callId: string; output: unknown; isError: boolean }
  /**
   * Liveness from the provider — what it is doing while nothing else is
   * happening (requesting, retrying, rate-limited, a long tool tick). Never
   * persisted; it exists so a slow turn reads as working rather than stuck.
   */
  | { kind: "notice"; text: string }
  | { kind: "result"; output: unknown; resumeId?: string; costUsd?: number }
  | { kind: "error"; message: string; aborted: boolean };

export function mapSdkMessage(message: SdkMessage): TurnEvent[] {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init" && message.session_id !== undefined) {
        return [{ kind: "resume", resumeId: message.session_id }];
      }
      if (
        message.subtype === "permission_denied" &&
        message.tool_use_id !== undefined
      ) {
        return [
          {
            kind: "tool.result",
            callId: message.tool_use_id,
            output: `Denied ${message.tool_name ?? "a tool"} by permission rules.`,
            isError: true,
          },
        ];
      }
      return systemNotice(message);
    }

    // Long tool ticks: the only sign of life during a slow tool call.
    case "tool_progress": {
      if (message.parent_tool_use_id != null) return [];
      const seconds = numberOf(message.elapsed_time_seconds);
      const name = stringOf(message.tool_name) ?? "a tool";
      return [
        {
          kind: "notice",
          text:
            seconds === undefined
              ? `${name} running`
              : `${name} running · ${formatSeconds(seconds)}`,
        },
      ];
    }

    case "rate_limit_event":
      return [{ kind: "notice", text: "rate limited — waiting for capacity" }];

    case "stream_event": {
      // Subagent deltas would interleave with the main thread's text; skip them.
      if (message.parent_tool_use_id != null) return [];
      const delta = message.event?.delta;
      if (message.event?.type !== "content_block_delta") return [];
      if (delta?.type === "text_delta") {
        return [{ kind: "delta", text: delta.text ?? "" }];
      }
      if (delta?.type === "thinking_delta") {
        return [{ kind: "reasoning-delta", text: delta.thinking ?? "" }];
      }
      return [];
    }

    case "assistant": {
      if (message.parent_tool_use_id != null) return [];
      const events: TurnEvent[] = [];
      for (const block of message.message?.content ?? []) {
        if (
          block.type === "text" &&
          block.text !== undefined &&
          block.text.length > 0
        ) {
          events.push({ kind: "message", text: block.text });
        } else if (block.type === "tool_use") {
          events.push({
            kind: "tool.call",
            callId: block.id ?? "unknown",
            name: block.name ?? "unknown",
            input: block.input ?? null,
          });
        }
      }
      return events;
    }

    case "user": {
      if (message.parent_tool_use_id != null) return [];
      const events: TurnEvent[] = [];
      for (const block of message.message?.content ?? []) {
        if (block.type !== "tool_result" || block.tool_use_id === undefined) {
          continue;
        }
        events.push({
          kind: "tool.result",
          callId: block.tool_use_id,
          output: block.content ?? null,
          isError: block.is_error === true,
        });
      }
      return events;
    }

    case "result": {
      if (message.subtype === "success") {
        return [
          {
            kind: "result",
            output: message.structured_output,
            ...(message.session_id === undefined
              ? {}
              : { resumeId: message.session_id }),
            ...(message.total_cost_usd === undefined
              ? {}
              : { costUsd: message.total_cost_usd }),
          },
        ];
      }
      return [
        {
          kind: "error",
          message: resultErrorMessage(message),
          aborted: message.terminal_reason === "interrupted",
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * System messages that carry no content but say what the provider is doing.
 * v1 called these notices; without them a turn that spends minutes in retry
 * backoff looks identical to a hung one.
 */
function systemNotice(message: SdkMessage): TurnEvent[] {
  switch (message.subtype) {
    case "status": {
      const status = stringOf(message.status);
      if (status === "requesting") return [{ kind: "notice", text: "requesting…" }];
      if (status === "compacting") {
        return [{ kind: "notice", text: "compacting the context…" }];
      }
      return [];
    }
    case "api_retry": {
      const attempt = numberOf(message.attempt);
      const max = numberOf(message.max_retries);
      const delay = numberOf(message.retry_delay_ms);
      const status = numberOf(message.error_status);
      const parts = [
        status === 429 ? "rate limited" : `API error${status === undefined ? "" : ` ${status}`}`,
        attempt === undefined || max === undefined
          ? "retrying"
          : `retry ${attempt}/${max}`,
        delay === undefined ? undefined : `in ${formatSeconds(delay / 1000)}`,
      ].filter((part): part is string => part !== undefined);
      return [{ kind: "notice", text: parts.join(" · ") }];
    }
    case "informational": {
      const content = stringOf(message.content);
      const level = stringOf(message.level);
      if (content === undefined || level === "info") return [];
      return [{ kind: "notice", text: content }];
    }
    default:
      return [];
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function resultErrorMessage(message: SdkMessage): string {
  switch (message.subtype) {
    case "error_max_turns":
      return `The agent stopped after reaching the maximum number of turns (${message.num_turns ?? "?"}).`;
    case "error_max_budget_usd":
      return "The agent stopped after reaching the per-turn cost budget.";
    case "error_max_structured_output_retries":
      return `The agent could not produce output matching the schema: ${
        message.errors?.length ? message.errors.join("; ") : "no details"
      }`;
    default:
      if (message.terminal_reason === "interrupted") {
        return "The turn was interrupted.";
      }
      return `The turn failed (${message.subtype ?? "unknown"}).`;
  }
}

const JSON_CAP_BYTES = 16_384;

/**
 * Size-caps a JSON value for spine persistence. Values whose serialized form
 * exceeds the cap are replaced by a truncated-string stand-in.
 */
export function capJson(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    return null;
  }
  if (serialized.length <= JSON_CAP_BYTES) return value;
  return {
    truncated: true,
    preview: serialized.slice(0, JSON_CAP_BYTES),
  };
}
