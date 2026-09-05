import type { Allocation, Run, RunPhase, UsageTotals } from "@agentique-console/core";

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

/** A duration in the operator's terms: seconds under a minute, then minutes and hours. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The absolute local time, for titles and tooltips beside a relative time. */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function tokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}

export function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function percent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

export function allocation(a: Allocation): string {
  return `${usd(a.costUsd)} · ${tokens(a.tokens)} tokens · ${a.attempts} attempts`;
}

export function usageTokensIn(u: UsageTotals): number {
  return u.inputTokensUncached + u.cacheCreationTokens + u.cacheReadTokens;
}

export function usage(u: UsageTotals): string {
  return `${usd(u.costUsd)} · ${tokens(usageTokensIn(u))} in · ${tokens(u.outputTokens)} out`;
}

export function shortId(id: string): string {
  const underscore = id.indexOf("_");
  return underscore < 0 ? id.slice(0, 8) : `${id.slice(0, underscore + 1)}${id.slice(underscore + 1, underscore + 7)}`;
}

/** `snake_case_word` → `snake case word`. */
export function words(value: string): string {
  return value.replaceAll("_", " ");
}

/** `snake_case_word` → `Snake case word`. */
export function sentence(value: string): string {
  const w = words(value);
  return w.charAt(0).toUpperCase() + w.slice(1);
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

/** A short label for the tightest places (a list row, a chip). */
export const PHASE_SHORT_LABELS: Record<RunPhase, string> = {
  created: "Created",
  running: "Running",
  waiting_decision: "Needs decision",
  waiting_budget: "Needs budget",
  waiting_capacity: "Waiting for capacity",
  waiting_conflict: "Conflict",
  paused: "Paused",
  verifying: "Verifying",
  awaiting_signoff: "Needs signoff",
  completed_unpublished: "Ready to publish",
  publishing: "Publishing",
  publish_failed: "Publish failed",
  publish_unsupported: "Completed",
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

/** Whether the phase is one the operator must act on for the Run to move. */
export function phaseNeedsOperator(phase: RunPhase): boolean {
  switch (phase) {
    case "waiting_decision":
    case "waiting_budget":
    case "awaiting_signoff":
    case "completed_unpublished":
    case "publish_failed":
    case "paused":
      return true;
    default:
      return false;
  }
}

/** Whether the phase is a terminal one: nothing more will happen to the Run. */
export function phaseIsTerminal(phase: RunPhase): boolean {
  return phase === "published" || phase === "publish_unsupported" || phase === "failed" || phase === "cancelled";
}

/**
 * The phase a plain Run row implies, for lists that carry no publication facts:
 * everything but a `completed` Run maps exactly; a `completed` Run is reported
 * as `completed` (the Run's own view distinguishes published from unpublished).
 */
export type RowPhase = RunPhase | "completed";

export function rowPhaseOf(run: Pick<Run, "status" | "waitReason" | "operatorPause">): RowPhase {
  switch (run.status) {
    case "created":
      return "created";
    case "running":
      return "running";
    case "waiting":
      switch (run.waitReason) {
        case "decision":
          return "waiting_decision";
        case "budget":
          return "waiting_budget";
        case "provider_capacity":
          return "waiting_capacity";
        case "integration_conflict":
          return "waiting_conflict";
        default:
          return "paused";
      }
    case "verifying":
      return run.operatorPause !== null ? "paused" : "verifying";
    case "awaiting_signoff":
      return run.operatorPause !== null ? "paused" : "awaiting_signoff";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "completed":
      return "completed";
  }
}

export function rowPhaseLabel(phase: RowPhase): string {
  return phase === "completed" ? "Completed" : PHASE_SHORT_LABELS[phase];
}

export function rowPhaseTone(phase: RowPhase): Tone {
  return phase === "completed" ? "completed" : phaseTone(phase);
}

/** A Run row that needs the operator now, from its own facts alone. */
export function runNeedsOperator(run: Pick<Run, "status" | "waitReason" | "operatorPause">): boolean {
  if (run.status === "awaiting_signoff") return true;
  if (run.status === "waiting") return run.waitReason === "decision" || run.waitReason === "budget" || run.waitReason === "operator";
  return run.operatorPause !== null && run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled";
}

export function runIsActive(run: Pick<Run, "status">): boolean {
  return run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled";
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "running":
    case "verifying":
    case "applying":
    case "prepared":
    case "verified":
    case "publishing":
      return "running";
    case "waiting":
    case "blocked":
    case "open":
    case "requested":
    case "proposed":
    case "awaiting_signoff":
      return "waiting";
    case "succeeded":
    case "completed":
    case "passed":
    case "resolved":
    case "approved":
    case "integrated":
    case "delivered":
    case "satisfied":
    case "published":
    case "pass":
    case "loaded":
      return "completed";
    case "failed":
    case "timed_out":
    case "violated":
    case "conflict":
    case "rejected":
    case "infeasible":
    case "fail":
      return "failed";
    case "cancelled":
    case "skipped":
    case "superseded":
    case "retired":
    case "interrupted":
    case "waived":
      return "cancelled";
    default:
      return "pending";
  }
}

/** The classes of the (legacy) outlined badge: kept for the few places that want a bordered tone. */
export const TONE_CLASS: Record<Tone, string> = {
  pending: "text-status-pending border-status-pending/40",
  running: "text-status-running border-status-running/40",
  waiting: "text-status-waiting border-status-waiting/40",
  completed: "text-status-completed border-status-completed/40",
  failed: "text-status-failed border-status-failed/40",
  cancelled: "text-status-cancelled border-status-cancelled/40",
};

export const TONE_TEXT: Record<Tone, string> = {
  pending: "text-status-pending",
  running: "text-status-running",
  waiting: "text-status-waiting",
  completed: "text-status-completed",
  failed: "text-status-failed",
  cancelled: "text-status-cancelled",
};

export const TONE_BG: Record<Tone, string> = {
  pending: "bg-status-pending",
  running: "bg-status-running",
  waiting: "bg-status-waiting",
  completed: "bg-status-completed",
  failed: "bg-status-failed",
  cancelled: "bg-status-cancelled",
};

/** A soft tinted surface of the tone (a badge, a callout) with legible text on it. */
export const TONE_SOFT: Record<Tone, string> = {
  pending: "bg-status-pending/10 text-status-pending",
  running: "bg-status-running/12 text-status-running",
  waiting: "bg-status-waiting/14 text-status-waiting",
  completed: "bg-status-completed/12 text-status-completed",
  failed: "bg-status-failed/12 text-status-failed",
  cancelled: "bg-status-cancelled/12 text-status-cancelled",
};

export const TONE_BORDER: Record<Tone, string> = {
  pending: "border-status-pending/40",
  running: "border-status-running/50",
  waiting: "border-status-waiting/50",
  completed: "border-status-completed/50",
  failed: "border-status-failed/50",
  cancelled: "border-status-cancelled/40",
};
