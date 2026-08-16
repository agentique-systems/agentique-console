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
  /** Child sessions whose parent archived or vanished across the restart. */
  archivedOrphanChildren: number;
  /** Scheduled assignments found ready at boot and dispatched. */
  scheduledAssignmentsRedriven: number;
}

export async function bootApp(app: App): Promise<BootReport> {
  // In-flight promises died with the previous process; their rows go stale so
  // the UI renders greyed cards whose answers become revival turns.
  app.interactions.expirePendingOnBoot();
  // A persisted capacity/budget pause survives the restart: re-arm its
  // resume timer (or resume immediately when the window already reset).
  app.capacity.armFromBoot();
  const recovered = recoverInterruptedTurns({ db: app.db, repo: app.repo, bus: app.bus });
  const recoveredTurns = recovered.count;
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

  app.host.boot();
  // The resume digest: a restart that killed agent turns is a MATERIAL event
  // for main — what died, what is preserved, what redelivers — so IT decides
  // resume/steer/close instead of the run silently resuming (or silently
  // not). Deduped per (session, turn-set): a double boot posts once.
  const bySession = new Map<string, typeof recovered.agentTurns>();
  for (const turn of recovered.agentTurns) {
    bySession.set(turn.agentSessionId, [...(bySession.get(turn.agentSessionId) ?? []), turn]);
  }
  for (const [agentSessionId, turns] of bySession) {
    const session = app.repo.getAgentSession(agentSessionId);
    if (!session || session.lifecycle !== "open") continue;
    const queued = app.repo.listQueuedDeliveries(agentSessionId).length;
    const agents = [...new Set(turns.map((turn) => turn.agent))];
    try {
      app.host.post({
        agentSessionId,
        speaker: { kind: "system", name: "console" },
        to: "main",
        category: "milestone",
        dedupeKey: `restart:${agentSessionId}:${turns.map((turn) => turn.turnId).sort().join(",")}`,
        handoff: { core: { schemaVersion: 1, taskId: null, status: "needs_verification", risk: "medium",
          action: `Server restart interrupted ${agents.join(", ")} in "${session.title}"`,
          state: { summary: `The console process restarted. In this session, ${agents.length} agent turn(s) died mid-flight (${agents.join(", ")}); provider sessions and worktrees are preserved, and ${queued} queued deliver${queued === 1 ? "y" : "ies"} will redeliver now. Nothing was lost, but in-context reasoning from the dead turns was.`, evidence: [] },
          result: { summary: null, artifacts: [] },
          uncertainty: ["Work the interrupted turns had in flight may need re-deriving."],
          nextAction: "Decide: let redelivery resume the session, steer it with fresh context, or close it out.",
          requestExpandedContext: false },
          extension: { kind: "generic", data: { consoleSynthesized: true } } },
      });
    } catch { /* best effort — the transcripts already carry the notices */ }
  }
  // Children whose parent archived or vanished across the restart can never
  // report to anyone.
  const archivedOrphanChildren = app.host.archiveOrphanChildren();
  // After host.boot(): a redriven dispatch posts through the live transfer
  // path, and the post-level dedupe absorbs a crash between post and mark.
  const scheduledAssignmentsRedriven = app.scheduler.boot();

  app.runner.startCronFallback();
  for (const session of app.repo.listOpenWorkSessions()) app.completion.schedule(session.id);
  // Release `ask_operator` waits the operator has not come back to — the card
  // stays answerable; the timer only stops a human's absence from pinning an
  // agent process indefinitely.
  app.host.startGovernanceSweep();

  return {
    recoveredTurns,
    requeuedDeliveries,
    reconciledCommunications,
    orphanedWorktrees,
    archivedOrphanChildren,
    scheduledAssignmentsRedriven,
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
}
