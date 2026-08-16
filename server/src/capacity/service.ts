/**
 * Capacity pause/resume: the difference between a run that survives a
 * subscription usage window and one that dies of it. A plan limit is a
 * temporary resource condition — the straf3 live run instead hot-spun 14
 * zero-token failing turns in 75 seconds, archived a seat's finished work
 * off main, and left `run_state` lying `active` through a dead night.
 *
 * Process-wide, because the cap is per-account, not per-session. While
 * paused: the orchestrator drains nothing, deadlines do not fire, the seat
 * mailroom mints no turns. Nothing is cancelled and nothing is salvaged —
 * queued work stays queued and redelivers on resume. Persistence is two
 * columns on every open user session (`pausedUntil`, `pauseReason`) so a
 * server restart re-arms the resume timer instead of forgetting the pause.
 */
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { nowIso } from "../ids.ts";

/** When the provider gives no reset time, probe again after this long. */
const UNKNOWN_RESET_MS = 30 * 60_000;
/** Resume slightly after the advertised reset — clocks disagree. */
const RESUME_JITTER_MS = 15_000;
/** Utilization at which wake prompts start warning the orchestrator. */
const WARNING_THRESHOLD = 0.85;

export interface CapacityDeps {
  repo: Repo;
  bus: EventBus;
}

export interface LimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  limitType?: string;
  utilization?: number;
}

export class CapacityService {
  readonly #deps: CapacityDeps;
  #state: { reason: "capacity" | "budget"; untilMs: number | null; detail?: string } | null = null;
  #timer: NodeJS.Timeout | null = null;
  #warning: { utilization: number; resetsAt?: number } | null = null;
  #onResume: Array<() => void> = [];

  constructor(deps: CapacityDeps) {
    this.#deps = deps;
  }

  /** Registered by the composition root; called after every resume. */
  onResume(hook: () => void): void {
    this.#onResume.push(hook);
  }

  get paused(): boolean {
    if (this.#state === null) return false;
    // A capacity pause self-expires even if the timer misfired; a budget
    // pause holds until the operator acts.
    if (this.#state.untilMs !== null && Date.now() >= this.#state.untilMs) {
      this.resume({ manual: false });
      return false;
    }
    return true;
  }

  /** Structured rate-limit state from the SDK stream (both lane engines). */
  noteLimit(info: LimitInfo): void {
    if (info.status === "rejected") {
      this.pause("capacity", info.resetsAt === undefined ? undefined : info.resetsAt * 1000,
        info.limitType === undefined ? "provider usage limit" : `provider usage limit (${info.limitType})`);
      return;
    }
    this.#warning = info.status === "allowed_warning"
      ? { utilization: info.utilization ?? 1, ...(info.resetsAt === undefined ? {} : { resetsAt: info.resetsAt }) }
      : null;
  }

  /** A turn failed with capacity prose (no structured event reached us). */
  noteCapacityFailure(detail: string): void {
    this.pause("capacity", undefined, detail);
  }

  /**
   * The spend ceiling: called after usage rows land. SUM once per call is a
   * single indexed query; only sessions that SET a budget pay it.
   */
  checkBudget(userSessionId: string): void {
    const session = this.#deps.repo.getUserSession(userSessionId);
    if (!session || session.budgetUsd === null || this.#state !== null) return;
    const spent = this.#deps.repo.listUsage(userSessionId).reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    if (spent < session.budgetUsd) return;
    this.pause("budget", undefined, `spend $${spent.toFixed(2)} reached the $${session.budgetUsd.toFixed(2)} ceiling`);
  }

  pause(reason: "capacity" | "budget", untilMs?: number, detail?: string): void {
    const until = reason === "budget" ? null : (untilMs ?? Date.now() + UNKNOWN_RESET_MS);
    if (this.#state !== null) {
      // Idempotent under a storm of limit events; only a LATER reset extends.
      if (this.#state.reason === "budget") return;
      if (until === null || (this.#state.untilMs !== null && until <= this.#state.untilMs)) return;
    }
    this.#state = { reason, untilMs: until, ...(detail === undefined ? {} : { detail }) };
    const untilIso = until === null ? null : new Date(until).toISOString();
    for (const session of this.#deps.repo.listOpenUserSessions()) {
      this.#deps.repo.patchUserSession(session.id, { pausedUntil: untilIso, pauseReason: reason });
      this.#deps.bus.append({ type: "run.capacity.paused", userSessionId: session.id,
        payload: { userSessionId: session.id, reason, until: untilIso, ...(detail === undefined ? {} : { detail }) } });
      this.#deps.bus.append({ type: "user_session.runtime.noted", userSessionId: session.id,
        payload: { userSessionId: session.id,
          detail: reason === "capacity"
            ? `run paused — ${detail ?? "provider usage limit"}; resumes automatically at ${untilIso ?? "the next probe"} (nothing was cancelled)`
            : `run paused — ${detail ?? "budget ceiling reached"}; raise the budget or resume manually (nothing was cancelled)` } });
    }
    this.#armTimer();
  }

  resume(opts: { manual: boolean }): void {
    if (this.#state === null) return;
    this.#state = null;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    for (const session of this.#deps.repo.listOpenUserSessions()) {
      if (session.pauseReason === null && session.pausedUntil === null) continue;
      this.#deps.repo.patchUserSession(session.id, { pausedUntil: null, pauseReason: null });
      this.#deps.bus.append({ type: "run.capacity.resumed", userSessionId: session.id,
        payload: { userSessionId: session.id, manual: opts.manual } });
      this.#deps.bus.append({ type: "user_session.runtime.noted", userSessionId: session.id,
        payload: { userSessionId: session.id, detail: `capacity restored at ${nowIso()} — nothing was lost; queued work redelivers now` } });
    }
    for (const hook of this.#onResume) {
      try { hook(); } catch { /* one consumer's failure must not strand the rest */ }
    }
  }

  /**
   * One line for the orchestrator's wake prompts when the window is nearly
   * spent — so wrap-up stops racing the cap (the straf3 run got 2 minutes'
   * notice).
   */
  warningLine(): string | null {
    if (this.#warning === null || this.#warning.utilization < WARNING_THRESHOLD) return null;
    const resets = this.#warning.resetsAt === undefined ? "" : `, resets ${new Date(this.#warning.resetsAt * 1000).toISOString()}`;
    return `[Provider usage window at ${Math.round(this.#warning.utilization * 100)}%${resets} — sequence landing in-flight work before opening new scope.]`;
  }

  /** Boot: restore a persisted pause and re-arm (or expire) its timer. */
  armFromBoot(): void {
    for (const session of this.#deps.repo.listOpenUserSessions()) {
      if (session.pauseReason === null) continue;
      const untilMs = session.pausedUntil === null ? null : Date.parse(session.pausedUntil);
      this.#state = { reason: session.pauseReason, untilMs: untilMs !== null && Number.isNaN(untilMs) ? null : untilMs };
      break;
    }
    if (this.#state === null) return;
    if (this.#state.untilMs !== null && Date.now() >= this.#state.untilMs) {
      this.resume({ manual: false });
      return;
    }
    this.#armTimer();
  }

  #armTimer(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    const until = this.#state?.untilMs ?? null;
    if (until === null) return;
    this.#timer = setTimeout(() => { this.resume({ manual: false }); }, Math.max(0, until - Date.now()) + RESUME_JITTER_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
  }
}
