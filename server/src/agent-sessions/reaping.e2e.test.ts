/** Runtime an agent holds must die with its lane. */
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
  const stopAgent = vi.fn((_agentSessionId: string, _participant: string) => [{ processId: "task_stub", pid: 4242 }]);
  const closeAgent = vi.fn(async (_key: string) => true);
  return {
    stopAgent,
    closeAgent,
    processes: { stopAgent, stopSession: vi.fn(), closeAll: vi.fn() } as unknown as ProcessManager,
    browsers: { closeAgent, closeSession: vi.fn(), closeAll: vi.fn() } as unknown as BrowserManager,
  };
}

describe("agent park reaps the agent's runtime", () => {
  it("stops the agent's managed processes and browser when its lane parks on idle", async () => {
    const runtime = stubRuntime();
    const h = makeDelegationHarness(
      async function* () {
        yield initMessage();
        yield successMessage();
      },
      {
        // A 20ms idle window so the park happens inside the test rather than
        // five minutes later.
        config: { policy: { agentIdleReapMs: 20 } },
        runtime: { processes: runtime.processes, browsers: runtime.browsers },
      },
    );
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({
      userSessionId, title: "reaping", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });

    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    // The park is what triggers the reap; wait for the runtime notice it emits.
    const events = await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.runtime.noted" && String((event.payload as { detail?: string }).detail ?? "").includes("agent parked"),
      10_000,
    );

    expect(runtime.stopAgent).toHaveBeenCalledWith(created.agentSessionId, "coordinator");
    expect(runtime.closeAgent).toHaveBeenCalledWith(`${created.agentSessionId}:coordinator`);

    // The notice must name what died. A silent kill turns "my server vanished"
    // into the same forensic exercise the leak itself caused.
    const parked = events.find(
      (event) => event.type === "agent_session.runtime.noted" && String((event.payload as { detail?: string }).detail ?? "").includes("agent parked"),
    );
    const detail = String((parked?.payload as { detail?: string }).detail ?? "");
    expect(detail).toContain("reaped 1 process(es)");
    expect(detail).toContain("pid 4242");
  });

  it("scopes the reap to the parking agent, never the whole session", async () => {
    const runtime = stubRuntime();
    const h = makeDelegationHarness(
      async function* () {
        yield initMessage();
        yield successMessage();
      },
      {
        config: { policy: { agentIdleReapMs: 20 } },
        runtime: { processes: runtime.processes, browsers: runtime.browsers },
      },
    );
    const userSessionId = h.addUserSession();
    h.host.createSession({
      userSessionId, title: "reaping", agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("observe"),
    });
    await collectUntil(
      h.bus,
      (event) => event.type === "agent_session.runtime.noted" && String((event.payload as { detail?: string }).detail ?? "").includes("agent parked"),
      10_000,
    );

    // A sibling agent's server must survive its neighbour parking — that is the
    // difference between reaping and `stopSession`.
    const processes = runtime.processes as unknown as { stopSession: ReturnType<typeof vi.fn> };
    expect(processes.stopSession).not.toHaveBeenCalled();
    for (const call of runtime.stopAgent.mock.calls) {
      expect(call[1]).toBe("coordinator");
    }
  });
});
