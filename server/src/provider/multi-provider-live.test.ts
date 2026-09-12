import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AiSdkAdapter } from "./ai-sdk-adapter.ts";
import { CodexSdkAdapter } from "./codex-adapter.ts";
import { CONTRACT_RESULT, contractRequest } from "./adapter-test-support.ts";

for (const backend of ["codex", "ai-sdk", "pi"] as const) {
  const flag = backend === "codex" ? "AGENTIQUE_LIVE_CODEX" : backend === "pi" ? "AGENTIQUE_LIVE_PI" : "AGENTIQUE_LIVE_AI_SDK";
  const key = backend === "codex" ? process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY;
  it.skipIf(process.env[flag] !== "1" || !key)(`${backend} live: guarded file and runtime tools, return_result, usage, transcript and continuation`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentique-provider-live-"));
    try {
      const work = path.join(dir, "work"); await fs.mkdir(work);
      await fs.writeFile(path.join(work, "NOTES.md"), "The answer is forty-two.\n");
      const model = backend === "codex" ? process.env.AGENTIQUE_LIVE_CODEX_MODEL ?? "gpt-5.6-terra" : backend === "pi" ? process.env.AGENTIQUE_LIVE_PI_MODEL ?? "pi/openai/gpt-5.5" : process.env.AGENTIQUE_LIVE_AI_SDK_MODEL ?? "openai/gpt-5.6-sol";
      const config = { fallbackWorkingDirectory: work, limits: { maxTurns: 8 } };
      const adapter = backend === "codex" ? new CodexSdkAdapter({ ...config, home: path.join(dir, "codex"), apiKey: key! }) : new AiSdkAdapter({ ...config, openai: { apiKey: key! }, ...(backend === "pi" ? { harness: "pi" as const } : {}) });
      const calls: string[] = [];
      const authorized: string[] = [];
      const text = `Read NOTES.md with read, call read_tasks, then call return_result exactly once with ${JSON.stringify({ ...CONTRACT_RESULT, summary: "replace with the answer from NOTES.md" })}. Do not edit any files or run commands.`;
      const { request } = contractRequest(work, {
        model, effort: "low", input: { rendererVersion: 1, text, digest: createHash("sha256").update(text).digest("hex") },
        deadlineAt: new Date(Date.now() + 90_000).toISOString(), capabilities: { tools: ["read"], mcpServers: [] },
        authorization: { authorize: ({ tool }) => { authorized.push(tool); return { kind: "allowed", tool }; } },
        runtimeTools: { tools: ["read_tasks"], call: async ({ tool }) => { calls.push(tool); return { kind: "read", tool: "read_tasks", result: { tool: "read_tasks", items: [], oversizedRecord: null, next: null } }; } },
      });
      const outcome = await adapter.execute(request);
      expect(outcome.completion, JSON.stringify(outcome.diagnostics)).toEqual({ kind: "completed" });
      expect(outcome.result).toMatchObject({ status: "completed", summary: expect.stringMatching(/forty|42/i) });
      expect(authorized).toContain("read"); expect(calls).toContain("read_tasks");
      expect(outcome.usage.reduce((total, chunk) => total + chunk.inputTokensUncached + chunk.cacheReadTokens, 0)).toBeGreaterThan(0);
      expect(outcome.continuation).not.toBeNull(); expect(outcome.transcript).not.toBeNull();
      expect(new TextDecoder().decode(outcome.transcript!)).not.toContain(key!);
      expect(await fs.readdir(work)).toEqual(["NOTES.md"]);
    } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }, 110_000);
}
