/**
 * Startup and shutdown (execution-model §14 "Server restart";
 * migration-contract §4): the fixed order every process follows.
 *
 * Boot: the database was opened under the reset-required check when the
 * app was composed; then recovery runs — the canonical transaction over
 * Attempts, leases, and Invocations, the worktree releases, the pending-blob
 * reconciliation — before anything is admitted; when the reconciliation left
 * an obligation unresolved (`blobs.complete === false`) the process stays in
 * `recovery_incomplete` and refuses every mutation (reads and the health
 * view work) until the operator restarts it; otherwise admission opens and
 * the host reconstructs the runnable work from rows — every outstanding
 * Publication re-driven, every nonterminal Run notified — without a browser
 * being open. The exclusive-owner assumption holds: one process opens a
 * database and blob store at a time, and nothing here claims otherwise.
 *
 * Shutdown: admission closes and the host stops starting passes; every
 * executing Attempt is interrupted with `shutdown` through the executor's
 * lifecycle (classified `interrupted`, retry permitted, Usage recorded once,
 * no Run cancelled or paused, no persisted pause erased); the passes and
 * finalizations settle within a bound; the event stream and the database
 * close. A Run continues in the next process from its rows.
 */
import type { App, BootReport } from "./app.ts";

export async function bootApp(app: App): Promise<BootReport> {
  app.admission.set("recovering");
  const recovery = app.runtime.recovery.recover();
  if (!recovery.blobs.complete) {
    app.admission.set("recovery_incomplete");
    app.log.error(`recovery left ${recovery.blobs.failureCount} pending-blob obligation(s) unresolved; the console admits no work until it is restarted`);
    const report: BootReport = { recovery, reconstructed: { runs: 0, publications: 0 } };
    app.boot = report;
    return report;
  }
  app.admission.set("ready");
  const reconstructed = await app.host.reconstruct();
  const report: BootReport = { recovery, reconstructed };
  app.boot = report;
  app.log.info(`recovered: ${recovery.interruptedAttemptIds.length} interrupted, ${recovery.cancelledAttemptIds.length} cancelled, ${recovery.retryEligible.length} retry-eligible, ${recovery.workspaceReleasedInvocationIds.length} worktrees released; reconstructed ${reconstructed.runs} Run(s), ${reconstructed.publications} Publication(s)`);
  return report;
}

/** The bound on waiting for interrupted Attempts and active passes to settle. */
export const SHUTDOWN_SETTLE_MS = 15_000;

export async function shutdownApp(app: App, options: { settleMs?: number } = {}): Promise<void> {
  app.admission.set("stopping");
  const stopping = app.host.stop();
  app.runtime.executor.interruptAll();
  const settled = Promise.all([stopping, app.runtime.executor.settled()]).then(() => true);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), options.settleMs ?? SHUTDOWN_SETTLE_MS);
    timer.unref?.();
  });
  const clean = await Promise.race([settled, bound]);
  if (timer !== null) clearTimeout(timer);
  if (!clean) app.log.warn("shutdown: executing work did not settle within the bound; recovery repairs it at the next start");
  await app.close();
}
