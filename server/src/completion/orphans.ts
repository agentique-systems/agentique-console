/**
 * Processes that outlived the server that started them.
 *
 * `ProcessManager` is purely in-memory, so after a restart the previous
 * process's children are unreachable by id — but they are still running, and
 * still holding whatever ports they bound. db-live-2 left `node serve.mjs` on
 * :8173 and the NEXT run found a foreign app squatting the port it wanted,
 * spent ~6 minutes diagnosing it, and read files out of the previous run's
 * workspace. This closes that loop at boot.
 *
 * The PID-reuse guard is not optional. A recorded pid may belong to something
 * completely unrelated by the time we look, and killing a stranger's process
 * because we once used that number would be a far worse bug than the leak.
 */
import fs from "node:fs";
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";

export interface OrphanScanDeps {
  repo: Repo;
  bus: EventBus;
  /** Injectable for tests; defaults to the real syscalls. */
  isAlive?: (pid: number) => boolean;
  readCmdline?: (pid: number) => string | null;
  kill?: (pid: number) => void;
}

const defaultIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const defaultReadCmdline = (pid: number): string | null => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return null; }
};

/**
 * Kills processes the journal says started and never exited, and closes their
 * ledger entry either way so the next boot does not rescan them forever.
 * Returns how many were actually killed.
 */
export function reapOrphanedProcesses(deps: OrphanScanDeps): number {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const readCmdline = deps.readCmdline ?? defaultReadCmdline;
  const kill = deps.kill ?? ((pid: number) => { process.kill(pid, "SIGTERM"); });

  let killed = 0;
  for (const orphan of deps.repo.listOrphanedProcesses()) {
    const { pid, command, args, agentSessionId, userSessionId, participant, processId } = orphan;
    let outcome = "not running";
    if (pid !== null && isAlive(pid)) {
      // /proc/<pid>/cmdline is NUL-separated. A match on the recorded argv is
      // what distinguishes "our leaked server" from "a stranger who inherited
      // this pid".
      const cmdline = readCmdline(pid);
      const recorded = [command, ...args];
      const matches = cmdline !== null && recorded.every((part) => cmdline.includes(part));
      if (matches) {
        try { kill(pid); killed += 1; outcome = "SIGTERM"; }
        catch { outcome = "kill failed"; }
      } else {
        outcome = "pid reused by another process; left alone";
      }
    }
    // Close the ledger entry regardless: an unmatched start row would otherwise
    // be rescanned at every boot for the life of the database.
    deps.bus.append({
      type: "agent_session.process.exited",
      userSessionId, agentSessionId,
      payload: { agentSessionId, participant, processId, code: null, signal: outcome === "SIGTERM" ? "SIGTERM" : null },
    });
  }
  return killed;
}
