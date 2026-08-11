/**
 * Boot-time reconciliation, in a fixed order the steps depend on: stale
 * interaction rows go grey before turn recovery re-opens their sessions;
 * deliveries requeue before `host.boot()` redrives them; the completion pass
 * runs last so a run that finished while the process was down still gets its
 * card. `main.ts` runs this once at startup; tests run it through
 * `bootHarness`/`restartHarness`, so a restart in a test exercises the same
 * path production takes.
 */
import type { App } from "./app.ts";
import { reapOrphanedProcesses } from "./completion/orphans.ts";
import { reconcileDurableCommunication, recoverInterruptedTurns } from "./recovery.ts";

export interface BootReport {
  /** Turns that died mid-flight with the previous process, now closed. */
  recoveredTurns: number;
  /** Mailbox deliveries put back in `queued` for redelivery. */
  requeuedDeliveries: number;
  /** Durable communication events reconciled against the journal. */
  reconciledCommunications: number;
  /** Worktree directories whose session is gone or archived, removed. */
  orphanedWorktrees: number;
  /** Managed child processes of a previous run, killed. */
  reapedProcesses: number;
  /** Child sessions whose parent archived or vanished across the restart. */
  archivedOrphanChildren: number;
}

export async function bootApp(app: App): Promise<BootReport> {
  // In-flight promises died with the previous process; their rows go stale so
  // the UI renders greyed cards whose answers become revival turns.
  app.interactions.expirePendingOnBoot();
  const recoveredTurns = recoverInterruptedTurns({ repo: app.repo, bus: app.bus });
  const requeuedDeliveries = app.repo.requeueUnacknowledgedDeliveries();
  const reconciledCommunications = await reconcileDurableCommunication({ repo: app.repo, bus: app.bus });

  // Worktrees intentionally survive restarts (their agents resume in place);
  // only directories whose session is gone/archived are orphans.
  let orphanedWorktrees = 0;
  if (app.worktrees) {
    const liveWorktrees = new Set(app.repo.listWorktreeAgents().map((agent) => agent.worktreePath));
    orphanedWorktrees = app.worktrees.recoverOrphans(
      (agentSessionId, dirName) => {
        const session = app.repo.getAgentSession(agentSessionId);
        if (!session || session.lifecycle !== "open") return false;
        for (const path of liveWorktrees) if (path.endsWith(dirName)) return true;
        return false;
      },
      (agentSessionId) => {
        const session = app.repo.getAgentSession(agentSessionId);
        const user = session ? app.repo.getUserSession(session.userSessionId) : undefined;
        try { return user ? app.getWorkspaceRoot(user.workspaceId) : null; } catch { return null; }
      },
    );
  }

  // Managed children of a PREVIOUS process are unreachable by id but still
  // hold their ports; the next run would inherit them squatting the ports it
  // wants.
  const reapedProcesses = reapOrphanedProcesses({ repo: app.repo, bus: app.bus });

  app.host.boot();
  // Children whose parent archived or vanished across the restart can never
  // report to anyone — the one genuinely new orphan class nesting introduces.
  const archivedOrphanChildren = app.host.archiveOrphanChildren();

  app.runner.startCronFallback();
  for (const session of app.repo.listOpenWorkSessions()) app.completion.schedule(session.id);
  // Release `ask_operator` waits the operator has not come back to — the card
  // stays answerable; the timer only stops a human's absence from pinning a
  // seat process indefinitely.
  app.host.startGovernanceSweep();

  return {
    recoveredTurns,
    requeuedDeliveries,
    reconciledCommunications,
    orphanedWorktrees,
    reapedProcesses,
    archivedOrphanChildren,
  };
}

/** Everything app-owned, in reverse dependency order. The HTTP server and the
 * SQLite handle belong to `main.ts`, which closes them around this. */
export async function shutdownApp(app: App): Promise<void> {
  app.bus.closeSubscriptions();
  app.completion.stop();
  app.host.stopGovernanceSweep();
  // Persistent lanes are CLI subprocesses — none may outlive the server.
  await app.runner.closeAll().catch(() => undefined);
  await app.host.closeAll().catch(() => undefined);
  app.processes?.closeAll();
  await app.browsers?.closeAll().catch(() => undefined);
}
