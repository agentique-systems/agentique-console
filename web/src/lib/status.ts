import type { TaskStatus } from "@agentique-console/shared";

/**
 * The console's visual status vocabulary. Domain statuses that use other words
 * (task `in_progress`, agent-session `working`) map onto these via the helpers
 * below rather than growing the vocabulary.
 */
export type AnyStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export const STATUS_DOT: Record<AnyStatus, string> = {
  pending: "bg-status-pending",
  running: "bg-status-running",
  waiting: "bg-status-waiting",
  completed: "bg-status-completed",
  failed: "bg-status-failed",
  cancelled: "bg-status-cancelled",
};

export const STATUS_TEXT: Record<AnyStatus, string> = {
  pending: "text-status-pending",
  running: "text-status-running",
  waiting: "text-status-waiting",
  completed: "text-status-completed",
  failed: "text-status-failed",
  cancelled: "text-status-cancelled",
};

export const STATUS_BORDER: Record<AnyStatus, string> = {
  pending: "border-status-pending/40",
  running: "border-status-running/60",
  waiting: "border-status-waiting/60",
  completed: "border-status-completed/40",
  failed: "border-status-failed/60",
  cancelled: "border-status-cancelled/40",
};

/** Task statuses fold onto the shared vocabulary; `deleted` reads as cancelled. */
export function taskStatusTone(status: TaskStatus): AnyStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "deleted":
      return "cancelled";
  }
}

export function isLive(status: AnyStatus): boolean {
  return status === "running" || status === "waiting" || status === "pending";
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
