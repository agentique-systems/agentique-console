/**
 * forward_message: the supervisor "translation problem" fix. The coordinator
 * re-posts a specialist's report to main VERBATIM — same core, same extension
 * — so a forwarded final counts as the session's own report and the operator
 * reads the specialist's words, not a paraphrase.
 */
import { describe, expect, it } from "vitest";
import { initMessage, sendHandoffUse, successMessage, toolUseMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness } from "../test-helpers.ts";

const briefing = {
  core: { schemaVersion: 1 as const, taskId: null, status: "pending" as const, risk: "low" as const,
    action: "audit the build", state: { summary: "audit the build", evidence: [] }, result: { summary: null, artifacts: [] },
    uncertainty: [], nextAction: "audit the build", requestExpandedContext: false },
  extension: { kind: "generic" as const, data: {} },
};

const FINDINGS = "Collision tunneling at src/game.js:191 — obstacles step 2.4 units through a 2.0-unit window.";

describe("forward_message e2e (fake SDK)", () => {
  it("forwards verbatim, counts as reported, and dedupes a double forward", async () => {
    let reportId: string | undefined;
    let releaseForward: (() => void) | undefined;
    const reportReady = new Promise<void>((resolve) => { releaseForward = resolve; });
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (options) {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      yield initMessage();
      if (append.includes("sole coordinator")) {
        coordinatorTurns += 1;
        if (coordinatorTurns === 1) {
          yield sendHandoffUse("send-1", "scout", { action: "audit", status: "pending", category: "assignment" });
        } else if (coordinatorTurns === 2) {
          await reportReady;
          yield toolUseMessage("fwd-1", "mcp__console_agent__forward_message", { handoffId: reportId, category: "final" });
          // The double forward is a no-op thanks to the dedupe key.
          yield toolUseMessage("fwd-2", "mcp__console_agent__forward_message", { handoffId: reportId, category: "final" });
        }
      } else {
        yield sendHandoffUse("scout-1", "orchestrator", { action: "audit finished", stateSummary: FINDINGS, status: "completed", category: "milestone" });
      }
      yield successMessage();
    });
    const userSessionId = h.addUserSession();
    void (async () => {
      for await (const event of h.bus.readWithSeq({ fromSeq: 1, follow: true })) {
        if (event.type === "handoff.created" && event.payload.sender === "scout") {
          reportId = event.payload.handoff.id;
          releaseForward?.();
          return;
        }
      }
    })();
    const forwarded = collectUntil(h.bus, (event) => event.type === "handoff.forwarded", 10_000);
    const created = h.host.createSession({ userSessionId, title: "forward", mode: "execute",
      agents: [{ name: "scout", profileId: "explorer" }], briefing });
    const events = await forwarded;
    expect(events.at(-1)?.payload).toMatchObject({ agentSessionId: created.agentSessionId, sender: "orchestrator", originalId: reportId });

    await collectUntil(h.bus, (event) => event.type === "agent_session.turn.settled"
      && JSON.stringify(event.payload).includes("orchestrator"), 10_000);
    // Verbatim: the final to main carries the specialist's own words.
    const rows = h.repo.listMessages("agent", created.agentSessionId).filter((row) => row.kind === "message");
    const finals = rows.filter((row) => row.toName === "main"
      && ((row.payload?.handoff as { stateSummary?: string } | undefined)?.stateSummary ?? "").includes("Collision tunneling"));
    expect(finals).toHaveLength(1); // the double forward deduped
    expect(finals[0]?.speakerName).toBe("orchestrator");
    // A forwarded final IS the session's report.
    const row = h.repo.getAgentSession(created.agentSessionId);
    expect(row && h.host.statusOf(row)).toBe("reported");
  });
});
