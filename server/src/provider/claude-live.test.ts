/**
 * The bounded, opt-in live smoke of the Claude adapter against the real SDK
 * (migration-contract §8 layer C). It runs only with
 * `AGENTIQUE_LIVE_SMOKE=1` and uses whatever credentials the Claude Code
 * installation already holds (an API key in the environment or the CLI's
 * own stored login); it never prints them, never changes billing or login
 * state, and works on a disposable temporary directory. Default suites skip
 * it: no live provider call is ever part of the default verification.
 *
 *   AGENTIQUE_LIVE_SMOKE=1 npx vitest run src/provider/claude-live.test.ts
 *
 * Optional: `AGENTIQUE_LIVE_MODEL` (the model; a small one by default).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutableRuntimeTool, RuntimeToolCallOutcome, RuntimeToolCallRequest } from "@agentique-console/core";
import type { AttemptExecutionRequest, TransientOutput } from "./adapter.ts";
import { ClaudeAgentSdkAdapter, RETURN_RESULT_TOOL, runtimeToolNativeName } from "./claude-adapter.ts";

const LIVE = process.env.AGENTIQUE_LIVE_SMOKE === "1";
const MODEL = process.env.AGENTIQUE_LIVE_MODEL ?? "claude-haiku-4-5-20251001";

describe.skipIf(!LIVE)("Claude adapter live smoke", () => {
  it("executes one bounded read-only Attempt through the real SDK: authorized reads, a returned typed result, measured Usage, a redacted transcript, no credential in any output", { timeout: 300_000 }, async () => {
    const { CLAUDE_AGENT_SDK } = await import("./claude-sdk-binding.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-live-smoke-"));
    try {
      fs.writeFileSync(path.join(dir, "NOTES.md"), "# Notes\nThe answer to the smoke question is: forty-two.\n", "utf8");
      const authorizations: { tool: string }[] = [];
      const outputs: TransientOutput[] = [];
      const portCalls: RuntimeToolCallRequest[] = [];
      const controller = new AbortController();
      const text = [
        "# Context Manifest (live smoke)",
        "Instructions: You are a read-only Worker. Read the file NOTES.md in the working directory and report the answer it contains.",
        `Then call ${runtimeToolNativeName(RETURN_RESULT_TOOL)} exactly once with: {"status":"completed","artifactIds":[],"tasks":[],"evidence":[],"summary":"<one sentence naming the answer>","openItems":[],"blocker":null,"runOutcome":null,"routeSelection":null,"evaluation":null,"finalReport":null}`,
        "Do not edit any file. Do not run shell commands.",
      ].join("\n");
      const request: AttemptExecutionRequest = {
        attemptId: "att_00000000000000000000live" as never,
        invocationId: "inv_00000000000000000000live" as never,
        runId: "run_00000000000000000000live" as never,
        model: MODEL,
        effort: "low",
        input: { rendererVersion: 1, text, digest: createHash("sha256").update(text).digest("hex") },
        capabilities: { tools: ["read", "search"], mcpServers: [] },
        toolPolicy: { read: "allowed", search: "allowed" },
        authorization: {
          authorize(call) {
            authorizations.push({ tool: call.tool });
            return call.tool === "read" || call.tool === "search" ? { kind: "allowed", tool: call.tool } : { kind: "denied", tool: call.tool };
          },
        },
        runtimeTools: {
          tools: ["read_tasks"] as ExecutableRuntimeTool[],
          async call(call: RuntimeToolCallRequest): Promise<RuntimeToolCallOutcome> {
            portCalls.push(call);
            return { kind: "read", tool: "read_tasks", result: { tool: "read_tasks", items: [], oversizedRecord: null, next: null } };
          },
        },
        workingDirectory: dir,
        deadlineAt: null,
        signal: controller.signal,
        continuation: null,
        output: (o) => outputs.push(o),
      };
      const adapter = new ClaudeAgentSdkAdapter({ sdk: CLAUDE_AGENT_SDK, continuation: false, limits: { maxTurns: 8 } });
      const outcome = await adapter.execute(request);
      expect(outcome.completion, JSON.stringify(outcome.diagnostics)).toEqual({ kind: "completed" });
      expect(outcome.result).toMatchObject({ status: "completed" });
      expect(String((outcome.result as { summary?: unknown }).summary)).toMatch(/forty|42/i);
      expect(authorizations.some((a) => a.tool === "read" || a.tool === "search")).toBe(true);
      expect(authorizations.every((a) => a.tool === "read" || a.tool === "search")).toBe(true);
      expect(outcome.usage.length).toBeGreaterThan(0);
      expect(outcome.usage.reduce((sum, u) => sum + u.costUsd, 0)).toBeGreaterThan(0);
      expect(outcome.usage.reduce((sum, u) => sum + u.inputTokensUncached + u.cacheReadTokens + u.cacheCreationTokens, 0)).toBeGreaterThan(0);
      expect(outcome.transcript).not.toBeNull();
      const transcript = new TextDecoder().decode(outcome.transcript!);
      expect(transcript).toMatch(/"type":"system","subtype":"init"/);
      expect(transcript).not.toMatch(/sk-ant-|"session_id":"[^[]/);
      expect(outcome.diagnostics.permissionMode).toBe("default");
      expect(outcome.diagnostics.promptDenials).toBe("0");
      expect(JSON.stringify(outcome.diagnostics)).not.toMatch(/sk-ant-/);
      // The working directory was not modified by a read-only Attempt.
      expect(fs.readdirSync(dir).sort()).toEqual(["NOTES.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
