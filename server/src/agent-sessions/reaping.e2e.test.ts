/**
 * Runtime a seat holds must die with its lane.
 *
 * The db-live-2 regression this file is named for: `check` started
 * `node serve.mjs` on port 8173 at 23:47:00, its lane parked at 23:58:27, and
 * the process outlived the whole run — `agent_session.process.started` = 6 vs
 * `.exited` = 5. The consequences landed on the NEXT run, which found a foreign
 * app squatting the port it wanted, spent ~6 minutes diagnosing it, propagated
 * a 400-word contingency into another seat's assignment, and produced the only
 * `reference_warnings` entry in either database (a seat reading files out of
 * the previous run's workspace).
 *
 * `ProcessManager.stopSession` existed the whole time. Its only caller was
 * `archiveForUserSession`, reachable only from an operator archive action that
 * had no button in the UI. So the leak was structural, not accidental.
 */
import { describe, expect, it, vi } from "vitest";
import { initMessage, successMessage } from "../sdk/fake.ts";
import type { ProcessManager } from "../runtime/process-manager.ts";
import type { BrowserManager } from "../runtime/browser-manager.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { loadConfig } from "../config.ts";

const handoff = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

function stubRuntime() {
  const stopParticipant = vi.fn((_agentSessionId: string, _participant: string) => [{ processId: "task_stub", pid: 4242 }]);
  const closeParticipant = vi.fn(async (_key: string) => true);
  return {
    stopParticipant,
    closeParticipant,
    processes: { stopParticipant, stopSession: vi.fn(), closeAll: vi.fn() } as unknown as ProcessManager,
    browsers: { closeParticipant, closeSession: vi.fn(), closeAll: vi.fn() } as unknown as BrowserManager,
  };
}

describe("seat park reaps the seat's runtime", () => {
  it("stops the seat's managed processes and browser when its lane parks on idle", async () => {
    const runtime = stubRuntime();
    const h = makeDelegationHarness(
      async function* () {
        yield initMessage();
        yield successMessage();
      },
      {
        hostOverrides: {
          // A 20ms idle window so the park happens inside the test rather than
          // five minutes later.
          config: { ...loadConfig({}), seatIdleReapMs: 20 },
          processes: runtime.processes,
          browsers: runtime.browsers,
        },
      },
    );
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "reaping", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });

    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    // The park is what triggers the reap; wait for the runtime notice it emits.
    const events = await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.runtime" && String((event.payload as { detail?: string }).detail ?? "").includes("seat parked"),
      10_000,
    );

    expect(runtime.stopParticipant).toHaveBeenCalledWith(created.agentSessionId, "orchestrator");
    expect(runtime.closeParticipant).toHaveBeenCalledWith(`${created.agentSessionId}:orchestrator`);

    // The notice must name what died. A silent kill turns "my server vanished"
    // into the same forensic exercise the leak itself caused.
    const parked = events.find(
      (event) => event.type === "agent_session.runtime" && String((event.payload as { detail?: string }).detail ?? "").includes("seat parked"),
    );
    const detail = String((parked?.payload as { detail?: string }).detail ?? "");
    expect(detail).toContain("reaped 1 process(es)");
    expect(detail).toContain("pid 4242");
  });

  it("scopes the reap to the parking seat, never the whole session", async () => {
    const runtime = stubRuntime();
    const h = makeDelegationHarness(
      async function* () {
        yield initMessage();
        yield successMessage();
      },
      {
        hostOverrides: {
          config: { ...loadConfig({}), seatIdleReapMs: 20 },
          processes: runtime.processes,
          browsers: runtime.browsers,
        },
      },
    );
    const userSessionId = h.addUserSession();
    h.host.createSession({
      userSessionId, title: "reaping", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.runtime" && String((event.payload as { detail?: string }).detail ?? "").includes("seat parked"),
      10_000,
    );

    // A sibling seat's server must survive its neighbour parking — that is the
    // difference between reaping and `stopSession`.
    const processes = runtime.processes as unknown as { stopSession: ReturnType<typeof vi.fn> };
    expect(processes.stopSession).not.toHaveBeenCalled();
    for (const call of runtime.stopParticipant.mock.calls) {
      expect(call[1]).toBe("orchestrator");
    }
  });
});
