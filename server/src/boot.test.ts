import { describe, expect, it } from "vitest";
import { bootHarness, makeHarness } from "./test-helpers.ts";

describe("bootApp", () => {
  it("cold-boots the full graph over a fresh database and reports zeros", async () => {
    const h = makeHarness(async function* () { /* never spawned */ });
    const report = await bootHarness(h);
    expect(report).toEqual({
      recoveredTurns: 0,
      requeuedDeliveries: 0,
      reconciledCommunications: 0,
      orphanedWorktrees: 0,
      reapedProcesses: 0,
      archivedOrphanChildren: 0,
    });
  });

  it("counts what recovery actually did on a dirty database", async () => {
    const h = makeHarness(async function* () { /* never spawned */ });
    const userSessionId = h.addUserSession();
    // A turn that "died" with a previous process: started, never settled.
    h.bus.append({
      type: "user_session.turn.started",
      userSessionId,
      payload: { sessionId: userSessionId, turnId: "tu_dead", trigger: "operator" },
    });
    const report = await bootHarness(h);
    expect(report.recoveredTurns).toBe(1);
  });
});
