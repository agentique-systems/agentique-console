/**
 * The bounded, opt-in live verification of the real coding path over the
 * production composition and the real Claude Agent SDK (migration-contract
 * §8 layer C): the same fourteen steps as the deterministic end-to-end, on a
 * disposable fixture repository, with real Orchestrator and Worker Attempts.
 * It runs only with `AGENTIQUE_LIVE_SMOKE=1`, uses the credentials the
 * Claude Code installation already holds, prints none of them, changes no
 * login or billing state, and publishes only to the fixture Target it made.
 *
 *   AGENTIQUE_LIVE_SMOKE=1 npx vitest run src/composition/coding-run.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { verifyCodingRun } from "./verify-coding-run.ts";

const LIVE = process.env.AGENTIQUE_LIVE_SMOKE === "1";
const MODEL = process.env.AGENTIQUE_LIVE_MODEL ?? "claude-haiku-4-5-20251001";

describe.skipIf(!LIVE)("live coding Run", () => {
  it("completes the fourteen steps with real provider Attempts and publishes only to the fixture Target", { timeout: 1_500_000 }, async () => {
    const { CLAUDE_AGENT_SDK } = await import("../provider/claude-sdk-binding.ts");
    const lines: string[] = [];
    const report = await verifyCodingRun({ sdk: CLAUDE_AGENT_SDK, model: MODEL, effort: "low", log: (line) => lines.push(line) });
    expect(report.ok, `${report.failedAt}: ${report.error}\n${JSON.stringify(report.facts)}\n${lines.slice(-40).join("\n")}`).toBe(true);
    expect(report.completed).toHaveLength(14);
    expect(String(report.facts.publishedCli)).toMatch(/--version/);
    expect(JSON.stringify(report)).not.toMatch(/sk-ant-/);
  });
});
