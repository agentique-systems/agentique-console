/**
 * Provider back-off is budgeted on WALL CLOCK, not on the CLI's attempt count.
 *
 * db-live-2 lost three turns to `getaddrinfo ENOTIMP api.anthropic.com`, each
 * running the schedule to 10/10 before dying:
 *
 *   renderer      181.0s of back-off  → turn destroyed after 542,967ms
 *   orchestrator  173.1s              → 275,371ms
 *   orchestrator  171.6s              → 275,309ms
 *
 * 18m14s — 55% of a 33-minute run — and the schedule stopped growing after
 * attempt 7, so attempts 7-10 were ~34s each and bought nothing. The console
 * had no way to notice, because `mapping.ts` parsed the numbers and threw them
 * into a display string.
 */
import { describe, expect, it } from "vitest";
import { apiRetryMessage, initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";
import { loadConfig } from "../config.ts";

const briefing = (action: string) => ({
  core: {
    schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action, state: { summary: action, evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: action, requestExpandedContext: false,
  },
  extension: { kind: "generic" as const, data: {} },
});

describe("retry budget", () => {
  it("interrupts a turn once back-off consumes the budget", async () => {
    // The observed db-live-2 schedule. Under a 20s budget the console gives up
    // at ~9s instead of riding it to 181s.
    const h = makeDelegationHarness(
      async function* () {
        yield initMessage();
        for (const delay of [610, 1142, 2493, 4928, 9369, 18403, 36478]) {
          yield apiRetryMessage(1, 10, delay, 529);
        }
        yield successMessage();
      },
      { hostOverrides: { config: { ...loadConfig({}), retryBudgetMs: 20_000 } } },
    );
    const userSessionId = h.addUserSession();
    h.host.createSession({
      userSessionId, title: "retry", agents: [{ name: "scout", profileId: "explorer" }], briefing: briefing("observe"),
    });

    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.watchdog", 10_000);
    const trip = events.find((event) => event.type === "agent_session.watchdog")!;
    expect((trip.payload as { kind: string }).kind).toBe("retry_budget");
    expect((trip.payload as { detail: string }).detail).toMatch(/consumed \d+s of back-off/);
  });

  it("does not trip below the budget", async () => {
    const h = makeDelegationHarness(
      async function* () {
        yield initMessage();
        yield apiRetryMessage(1, 10, 610, 529);
        yield apiRetryMessage(2, 10, 1142, 529);
        yield successMessage();
      },
      { hostOverrides: { config: { ...loadConfig({}), retryBudgetMs: 90_000 } } },
    );
    const userSessionId = h.addUserSession();
    h.host.createSession({
      userSessionId, title: "retry", agents: [{ name: "scout", profileId: "explorer" }], briefing: briefing("observe"),
    });
    const events = await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled", 10_000);
    expect(events.some((event) => event.type === "agent_session.watchdog")).toBe(false);
  });
});
