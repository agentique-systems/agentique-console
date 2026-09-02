import type { Allocation, RunPhase, UsageTotals } from "@agentique-console/core";

export function timeAgo(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}

export function allocation(a: Allocation): string {
  return `${usd(a.costUsd)} · ${tokens(a.tokens)} tokens · ${a.attempts} attempts`;
}

export function usage(u: UsageTotals): string {
  return `${usd(u.costUsd)} · ${tokens(u.inputTokensUncached + u.cacheCreationTokens + u.cacheReadTokens)} in · ${tokens(u.outputTokens)} out`;
}

export function shortId(id: string): string {
  const underscore = id.indexOf("_");
  return underscore < 0 ? id.slice(0, 8) : `${id.slice(0, underscore + 1)}${id.slice(underscore + 1, underscore + 7)}`;
}

export const PHASE_LABELS: Record<RunPhase, string> = {
  created: "Created",
  running: "Running",
  waiting_decision: "Waiting for a decision",
  waiting_budget: "Waiting for budget",
  waiting_capacity: "Waiting for capacity",
  waiting_conflict: "Waiting for conflict resolution",
  paused: "Paused",
  verifying: "Verifying",
  awaiting_signoff: "Awaiting signoff",
  completed_unpublished: "Completed, not published",
  publishing: "Publishing",
  publish_failed: "Publication failed",
  publish_unsupported: "Completed (publication unsupported)",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
};

export type Tone = "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export function phaseTone(phase: RunPhase): Tone {
  switch (phase) {
    case "created":
      return "pending";
    case "running":
    case "verifying":
    case "publishing":
      return "running";
    case "waiting_decision":
    case "waiting_budget":
    case "waiting_capacity":
    case "waiting_conflict":
    case "paused":
    case "awaiting_signoff":
    case "completed_unpublished":
    case "publish_unsupported":
      return "waiting";
    case "published":
      return "completed";
    case "publish_failed":
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "running":
    case "verifying":
    case "applying":
    case "prepared":
    case "verified":
      return "running";
    case "waiting":
    case "blocked":
    case "open":
    case "ready":
    case "requested":
    case "proposed":
      return "waiting";
    case "succeeded":
    case "completed":
    case "passed":
    case "resolved":
    case "approved":
    case "integrated":
    case "delivered":
    case "satisfied":
      return "completed";
    case "failed":
    case "timed_out":
    case "violated":
    case "conflict":
    case "rejected":
      return "failed";
    case "cancelled":
    case "skipped":
    case "superseded":
    case "retired":
    case "interrupted":
      return "cancelled";
    default:
      return "pending";
  }
}

export const TONE_CLASS: Record<Tone, string> = {
  pending: "text-status-pending border-status-pending/40",
  running: "text-status-running border-status-running/40",
  waiting: "text-status-waiting border-status-waiting/40",
  completed: "text-status-completed border-status-completed/40",
  failed: "text-status-failed border-status-failed/40",
  cancelled: "text-status-cancelled border-status-cancelled/40",
};
