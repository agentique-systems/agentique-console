/**
 * The boot-time leak scan, and the guard that makes it safe.
 *
 * db-live-2 ended with `agent_session.process.started` = 6 and `.exited` = 5:
 * `check`'s `node serve.mjs` (pid 436589) outlived the whole run. The next run
 * found a foreign app on the port it wanted, spent ~6 minutes diagnosing it,
 * propagated a 400-word contingency into another seat's assignment, and
 * produced the only `reference_warnings` entry in either database.
 */
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db/client.ts";
import { ArtifactStore } from "../events/artifact-store.ts";
import { EventBus } from "../events/bus.ts";
import { listOrphanedProcesses } from "../events/projections.ts";
import { reapOrphanedProcesses } from "./orphans.ts";

function harness() {
  const { db } = openDb(":memory:");
  const bus = new EventBus(db, new ArtifactStore(db));
  const started = (processId: string, pid: number, command: string, args: string[]) =>
    bus.append({
      type: "agent_session.process.started", userSessionId: "us_1", agentSessionId: "as_1",
      payload: { agentSessionId: "as_1", agent: "check", processId, command, args, cwd: "/tmp", pid },
    });
  const exited = (processId: string) =>
    bus.append({
      type: "agent_session.process.exited", userSessionId: "us_1", agentSessionId: "as_1",
      payload: { agentSessionId: "as_1", agent: "check", processId, code: 0, signal: null },
    });
  return { db, bus, started, exited };
}

describe("orphaned process reaping", () => {
  it("kills a process the journal says never exited", () => {
    const { db, bus, started } = harness();
    started("task_serve", 436589, "node", ["serve.mjs"]);
    const kill = vi.fn();

    const killed = reapOrphanedProcesses({
      db, bus, kill,
      isAlive: () => true,
      readCmdline: () => "node\0serve.mjs\0",
    });

    expect(killed).toBe(1);
    expect(kill).toHaveBeenCalledWith(436589);
  });

  it("leaves a process whose pid was reused by something else", () => {
    // The guard that matters. A recorded pid may belong to a stranger by now,
    // and killing it would be a far worse bug than the leak.
    const { db, bus, started } = harness();
    started("task_serve", 436589, "node", ["serve.mjs"]);
    const kill = vi.fn();

    const killed = reapOrphanedProcesses({
      db, bus, kill,
      isAlive: () => true,
      readCmdline: () => "/usr/lib/firefox/firefox\0",
    });

    expect(killed).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("ignores a process that already exited", () => {
    const { db, bus, started, exited } = harness();
    started("task_serve", 436589, "node", ["serve.mjs"]);
    exited("task_serve");
    const kill = vi.fn();

    expect(reapOrphanedProcesses({ db, bus, kill, isAlive: () => true, readCmdline: () => "node\0serve.mjs\0" })).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("closes the ledger entry so the next boot does not rescan forever", () => {
    const { db, bus, started } = harness();
    started("task_serve", 436589, "node", ["serve.mjs"]);

    reapOrphanedProcesses({ db, bus, kill: vi.fn(), isAlive: () => false, readCmdline: () => null });

    // A dead pid still leaves an unmatched start row. Without the synthetic
    // exit it would be rescanned at every boot for the life of the database.
    expect(listOrphanedProcesses(db)).toHaveLength(0);
  });

  it("is a no-op on a clean journal", () => {
    const { db, bus } = harness();
    expect(reapOrphanedProcesses({ db, bus, kill: vi.fn() })).toBe(0);
  });
});
