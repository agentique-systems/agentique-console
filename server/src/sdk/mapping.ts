/**
 * Pure SDK-message → TurnEvent mapper (port of agentique-core's mapping.ts,
 * cut to what v2 consumes). One SDK message maps to zero or more events; the
 * consumer decides persistence. Subagent-parented blocks (A4, with
 * forwardSubagentText on) are TAGGED with their parentCallId rather than
 * dropped: the runner routes a bound coordinator's traffic into its agent
 * session's lane and drops the rest; the specialist consumer skips them all,
 * so seat transcripts still show the top-level thread only.
 */
import type { SdkMessage } from "./types.ts";
import { INLINE_JSON_CAP_BYTES as JSON_CAP_BYTES } from "../events/bus.ts";

export type TurnEvent =
  | { kind: "resume"; resumeId: string; modelId?: string }
  | { kind: "delta"; text: string; parentCallId?: string }
  | { kind: "reasoning-delta"; text: string; parentCallId?: string }
  | { kind: "message"; text: string; parentCallId?: string }
  /**
   * A provider retry, with its numbers intact. The console budgets on wall
   * clock rather than waiting for the CLI's own attempt count to run out —
   * db-live-2's observed schedule stopped growing after attempt 7, so attempts
   * 7-10 were ~34s each and bought nothing.
   */
  | { kind: "retry"; attempt?: number; maxRetries?: number; delayMs: number; status?: number }
  | {
      kind: "tool.call";
      callId: string;
      name: string;
      input: unknown;
      parentCallId?: string;
    }
  | {
      kind: "tool.result";
      callId: string;
      output: unknown;
      isError: boolean;
      /**
       * The SDK's tool_use_result — the tool's full structured Output object
       * (e.g. the Agent tool's {agentId, status} launch receipt), distinct
       * from the text content sent to the model.
       */
      structured?: unknown;
      parentCallId?: string;
    }
  /**
   * Liveness from the provider — what it is doing while nothing else is
   * happening (requesting, retrying, rate-limited, a long tool tick). Never
   * persisted; it exists so a slow turn reads as working rather than stuck.
   */
  | { kind: "notice"; text: string }
  /**
   * Context-window occupancy after one API call — `input + cache_creation +
   * cache_read` from an assistant message's own usage. The consumer keeps the
   * running max as the rotation signal. Emitted per assistant message, never
   * persisted.
   */
  | { kind: "context"; occupancyTokens: number }
  | { kind: "result"; output: unknown; resumeId?: string; cumulativeCostUsd?: number; inputTokens?: number; uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number; modelId?: string; cumulativeApiDurationMs?: number; sdkDurationMs?: number; stopReason?: string }
  | { kind: "error"; message: string; aborted: boolean; inputTokens?: number; uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number; cumulativeCostUsd?: number; modelId?: string; cumulativeApiDurationMs?: number; sdkDurationMs?: number; stopReason?: string }
  /**
   * The SDK's authoritative turn-over signal (session_state_changed → idle).
   * A persistent lane settles its open turn on this even when the result
   * message was lost or coalesced; single-shot consumers may ignore it.
   */
  | { kind: "turn-idle" }
  /**
   * A background task ended badly (A5). Completions are silent here — a
   * coordinator reports its results itself — but a failed or stopped task
   * would otherwise vanish without a trace, so the consumer persists these.
   */
  | {
      kind: "task-terminal";
      status: "failed" | "stopped";
      summary: string;
      /** The spawning Agent call — the seat registry's key, when present. */
      toolUseId?: string;
    };

export function mapSdkMessage(message: SdkMessage): TurnEvent[] {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init" && message.session_id !== undefined) {
        return [{ kind: "resume", resumeId: message.session_id, ...(message.model ? { modelId: message.model } : {}) }];
      }
      if (message.subtype === "session_state_changed") {
        return message.state === "idle" ? [{ kind: "turn-idle" }] : [];
      }
      // A5: background-task lifecycle. Progress (with its ~30s AI summary
      // when enabled) is liveness; failures become persistent rows.
      if (message.subtype === "task_progress") {
        const summary = stringOf(message.summary);
        const description = stringOf(message.description) ?? "background task";
        return [
          {
            kind: "notice",
            text: summary === undefined ? description : `${description} · ${summary}`,
          },
        ];
      }
      if (message.subtype === "task_notification") {
        const status = stringOf(message.status);
        if (status !== "failed" && status !== "stopped") return [];
        const toolUseId = stringOf(message.tool_use_id);
        return [
          {
            kind: "task-terminal",
            status,
            summary: stringOf(message.summary) ?? "no details",
            ...(toolUseId === undefined ? {} : { toolUseId }),
          },
        ];
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
      const delta = message.event?.delta;
      if (message.event?.type !== "content_block_delta") return [];
      if (delta?.type === "text_delta") {
        return tagged(message, [{ kind: "delta", text: delta.text ?? "" }]);
      }
      if (delta?.type === "thinking_delta") {
        return tagged(message, [
          { kind: "reasoning-delta", text: delta.thinking ?? "" },
        ]);
      }
      return [];
    }

    case "assistant": {
      const events: TurnEvent[] = [];
      const usage = message.message?.usage;
      if (usage !== undefined) {
        const occupancyTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        if (occupancyTokens > 0) events.push({ kind: "context", occupancyTokens });
      }
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
      return tagged(message, events);
    }

    case "user": {
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
          ...(message.tool_use_result === undefined
            ? {}
            : { structured: message.tool_use_result }),
        });
      }
      return tagged(message, events);
    }

    case "result": {
      // A CLI-level failure is reported as subtype "success" with is_error set,
      // and carries zeroed usage. Treating it as a result recorded junk usage
      // rows and hid real failures behind a "completed" turn.
      if (message.subtype === "success" && message.is_error !== true) {
        return [
          {
            kind: "result",
            output: message.structured_output,
            ...(message.session_id === undefined
              ? {}
              : { resumeId: message.session_id }),
            ...(message.total_cost_usd === undefined
              ? {}
              : { cumulativeCostUsd: message.total_cost_usd }),
            ...((message.usage?.input_tokens ?? message.usage?.cache_creation_input_tokens ?? message.usage?.cache_read_input_tokens) === undefined ? {} : {
              inputTokens: (message.usage?.input_tokens ?? 0) + (message.usage?.cache_creation_input_tokens ?? 0) + (message.usage?.cache_read_input_tokens ?? 0),
              uncachedInputTokens: message.usage?.input_tokens ?? 0,
              cacheCreationInputTokens: message.usage?.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: message.usage?.cache_read_input_tokens ?? 0,
            }),
            ...(message.usage?.output_tokens === undefined ? {} : { outputTokens: message.usage.output_tokens }),
            ...resultTelemetry(message),
          },
        ];
      }
      return [
        {
          kind: "error",
          message: resultErrorMessage(message),
          aborted: message.terminal_reason === "interrupted",
          ...usageFields(message),
        },
      ];
    }

    default:
      return [];
  }
}

function usageFields(message: SdkMessage): { inputTokens?: number; uncachedInputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; outputTokens?: number; cumulativeCostUsd?: number; modelId?: string; cumulativeApiDurationMs?: number; sdkDurationMs?: number; stopReason?: string } {
  const hasInput = message.usage?.input_tokens !== undefined || message.usage?.cache_creation_input_tokens !== undefined || message.usage?.cache_read_input_tokens !== undefined;
  return {
    ...(hasInput ? { inputTokens: (message.usage?.input_tokens ?? 0) + (message.usage?.cache_creation_input_tokens ?? 0) + (message.usage?.cache_read_input_tokens ?? 0),
      uncachedInputTokens: message.usage?.input_tokens ?? 0, cacheCreationInputTokens: message.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage?.cache_read_input_tokens ?? 0 } : {}),
    ...(message.usage?.output_tokens === undefined ? {} : { outputTokens: message.usage.output_tokens }),
    ...(message.total_cost_usd === undefined ? {} : { cumulativeCostUsd: message.total_cost_usd }),
    ...resultTelemetry(message),
  };
}

/**
 * `total_cost_usd` and `duration_api_ms` are CUMULATIVE per provider session —
 * each result restates the running total. The names carry that so consumers
 * are forced to delta rather than sum (summing overstated db-live-1 by 25%).
 */
function resultTelemetry(message: SdkMessage): { modelId?: string; cumulativeApiDurationMs?: number; sdkDurationMs?: number; stopReason?: string } {
  const modelId = message.modelUsage ? Object.entries(message.modelUsage).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0] : message.model;
  return { ...(modelId ? { modelId } : {}), ...(message.duration_api_ms === undefined ? {} : { cumulativeApiDurationMs: message.duration_api_ms }), ...(message.duration_ms === undefined ? {} : { sdkDurationMs: message.duration_ms }), ...(message.stop_reason === undefined ? {} : { stopReason: message.stop_reason }) };
}

/** Stamps subagent-parented events with their parent tool_use id. */
function tagged(message: SdkMessage, events: TurnEvent[]): TurnEvent[] {
  const parentCallId = message.parent_tool_use_id;
  if (parentCallId == null) return events;
  return events.map((event) => ({ ...event, parentCallId }));
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
      // The STRUCTURE as well as the prose. Throwing the numbers away into a
      // string is why nothing could act on a retry storm: db-live-2 spent
      // 18m14s — 55% of the run — inside three bursts that each exhausted
      // 10/10 attempts, and the console had no way to notice or stop it.
      return [
        { kind: "notice", text: parts.join(" · ") },
        {
          kind: "retry",
          ...(attempt === undefined ? {} : { attempt }),
          ...(max === undefined ? {} : { maxRetries: max }),
          delayMs: delay ?? 0,
          ...(status === undefined ? {} : { status }),
        },
      ];
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
