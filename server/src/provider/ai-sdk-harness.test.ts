import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { HARNESS_V1_BUILTIN_TOOLS, type HarnessV1, type HarnessV1PromptTurnOptions, type HarnessV1StartOptions, type HarnessV1ResumeSessionState } from "@ai-sdk/harness";
import { afterEach, expect, it, vi } from "vitest";
import { AiSdkAdapter } from "./ai-sdk-adapter.ts";
import { CONTRACT_RESULT, contractRequest } from "./adapter-test-support.ts";

// Only the third-party runtime is scripted; HarnessAgent, its host-tool dispatch,
// filtering, virtual sandbox and session lifecycle are real SDK implementations.
const fixture = vi.hoisted(() => ({ harness: undefined as HarnessV1 | undefined, auth: {} as Record<string, string> }));
vi.mock("@ai-sdk/harness-pi", () => ({ createPi: (options: { auth: Record<string, string> }) => { fixture.auth = options.auth; return fixture.harness; } }));
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

function runtime(toolName = "return_result", input: unknown = CONTRACT_RESULT) {
  const starts: HarnessV1StartOptions[] = [];
  const prompts: HarnessV1PromptTurnOptions[] = [];
  const stopped = vi.fn();
  const destroyed = vi.fn();
  const state: HarnessV1ResumeSessionState = { type: "resume-session", harnessId: "pi", specificationVersion: "harness-v1", data: { history: "opaque", sessionFileName: "fixture.jsonl" } };
  const usage = { inputTokens: { total: 11, noCache: 10, cacheRead: 1, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };
  const harness: HarnessV1 = {
    specificationVersion: "harness-v1", harnessId: "pi", builtinTools: HARNESS_V1_BUILTIN_TOOLS, supportsBuiltinToolFiltering: true, supportsBuiltinToolApprovals: true,
    doStart: async (options) => {
      starts.push(options);
      const journal = `/agentique/.ai-sdk/harness-pi/${createHash("sha256").update(options.sessionId).digest("hex")}/fixture.jsonl`;
      if (options.resumeFrom) expect(Buffer.from((await options.sandboxSession.readBinaryFile({ path: journal }))!).toString()).toBe("native journal");
      return {
        sessionId: options.sessionId, isResume: options.resumeFrom !== undefined,
        doPromptTurn: async (turn) => {
          prompts.push(turn);
          let end!: () => void;
          const done = new Promise<void>((resolve) => { end = resolve; });
          turn.abortSignal?.addEventListener("abort", () => end(), { once: true });
          queueMicrotask(() => {
            turn.emit({ type: "stream-start", modelId: turn.model });
            turn.emit({ type: "text-start", id: "t" });
            turn.emit({ type: "text-delta", id: "t", delta: "harness working" });
            turn.emit({ type: "text-end", id: "t" });
            turn.emit({ type: "tool-call", toolCallId: "call1", toolName, input: JSON.stringify(input) });
          });
          return { done, submitToolResult: async () => {
            turn.emit({ type: "finish-step", finishReason: { unified: "stop", raw: "stop" }, usage });
            turn.emit({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, totalUsage: usage });
            end();
          } };
        },
        doCompact: async () => undefined,
        doContinueTurn: async () => { throw new Error("Unexpected unfinished turn"); },
        doSuspendTurn: async () => ({ ...state, type: "continue-turn" }),
        doDetach: async () => state,
        doStop: async () => { stopped(); await options.sandboxSession.writeBinaryFile({ path: journal, content: Buffer.from("native journal") }); return state; },
        doDestroy: async () => { destroyed(); },
      };
    },
  };
  fixture.harness = harness;
  return { starts, prompts, stopped, destroyed, harness };
}

it("runs the native HarnessAgent, filters native tools, streams usage, and resumes persisted session state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentique-harness-")); directories.push(dir);
  const fake = runtime();
  const adapter = new AiSdkAdapter({ fallbackWorkingDirectory: dir, harness: "pi", openai: { apiKey: "openai-fixture" }, gateway: { apiKey: "gateway-must-not-route" }, anthropic: { apiKey: "anthropic-must-not-leak" } });
  const { request, outputs } = contractRequest(dir, { model: "pi/openai/gpt-5.6-terra" });
  const first = await adapter.execute(request);
  expect(first.completion, JSON.stringify(first.diagnostics)).toEqual({ kind: "completed" });
  expect(first.result).toEqual(CONTRACT_RESULT);
  expect(fixture.auth).toEqual({ OPENAI_API_KEY: "openai-fixture" });
  expect(first.usage[0]).toMatchObject({ inputTokensUncached: 10, cacheReadTokens: 1, outputTokens: 4, costKnown: false });
  expect(outputs.some((output) => output.text.includes("harness working"))).toBe(true);
  expect(fake.starts[0]!.builtinToolFiltering).toEqual({ mode: "allow", toolNames: [] });
  expect(fake.prompts[0]!.tools.map((tool) => tool.name)).toEqual(["return_result"]);
  expect(fake.stopped).toHaveBeenCalledOnce();
  expect(first.continuation).not.toBeNull();
  const resumed = await adapter.execute({ ...request, continuation: first.continuation });
  expect(resumed.result, JSON.stringify({ completion: resumed.completion, diagnostics: resumed.diagnostics })).toEqual(CONTRACT_RESULT);
  expect(fake.starts[1]!.resumeFrom?.data).toEqual({ history: "opaque", sessionFileName: "fixture.jsonl" });
  expect(fake.stopped).toHaveBeenCalledTimes(2);
}, 15_000);

it("ends HarnessAgent on a runtime approval boundary without executing a write", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentique-harness-")); directories.push(dir);
  runtime("write", { path: "blocked.txt", content: "blocked" });
  const adapter = new AiSdkAdapter({ fallbackWorkingDirectory: dir, harness: "pi" });
  const { request } = contractRequest(dir, { model: "pi/openai/gpt-5.6-terra", capabilities: { tools: ["write"], mcpServers: [] }, authorization: { authorize: () => ({ kind: "approval_required", tool: "write", callDigest: "fixture" }) } });
  const outcome = await adapter.execute(request);
  expect(outcome.completion.kind).toBe("approval_required");
  await expect(fs.stat(path.join(dir, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
}, 15_000);

it("fails closed for a harness that cannot filter native tools", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentique-harness-")); directories.push(dir);
  const fake = runtime();
  fixture.harness = { ...fake.harness, supportsBuiltinToolFiltering: false };
  const adapter = new AiSdkAdapter({ fallbackWorkingDirectory: dir, harness: "pi" });
  const result = await adapter.execute(contractRequest(dir, { model: "pi/openai/gpt-5.6-terra" }).request);
  expect(result.completion).toMatchObject({ kind: "provider_error", transient: false });
  expect(fake.starts).toHaveLength(0);
});
