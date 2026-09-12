import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallAuthorization } from "./adapter.ts";
import { contractAdapter, contractRequest, CONTRACT_RESULT } from "./adapter-test-support.ts";

describe.each(["codex", "ai-sdk"] as const)("%s ProviderAdapter contract", (provider) => {
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentique-adapter-")); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  it("streams, captures structured return_result exactly once, accounts cached tokens and cost, and retains an opaque continuation", async () => {
    const fixture = contractAdapter(provider, directory, [[{ name: "return_result", input: CONTRACT_RESULT }, { name: "return_result", input: { ...CONTRACT_RESULT, summary: "too late" } }]]);
    const { request, outputs } = contractRequest(directory);
    const result = await fixture.adapter.execute(request);
    expect(result.completion).toEqual({ kind: "completed" });
    expect(result.result).toEqual(CONTRACT_RESULT);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({ model: "test-model", inputTokensUncached: 70, cacheReadTokens: 20, cacheCreationTokens: 10, outputTokens: 50 });
    expect(result.usage[0]!.costUsd).toBeCloseTo(0.000334);
    expect(result.timing.endedAt >= result.timing.startedAt).toBe(true);
    expect(outputs.some((o) => o.kind === "text" && o.text === "working")).toBe(true);
    expect(result.continuation).not.toBeNull();
    expect(Buffer.from(result.transcript!).toString()).not.toContain("thread_contract_123");
    expect(JSON.stringify(result.diagnostics)).not.toContain("thread_contract_123");
  });

  it.each(["allowed", "approved_once", "denied", "approval_required", "failed", "invalid", "interrupted"] as const)("honors %s authorization before any filesystem side effect", async (kind) => {
    const input = { path: "created.txt", content: "authorized" };
    const authorizer = vi.fn(() => ({ kind, tool: "write", message: "authorization refused", cause: "cancelled", callDigest: "digest", decisionId: "dec_000000000000000000000001", useId: "atu_000000000000000000000001" }) as ToolCallAuthorization);
    const fixture = contractAdapter(provider, directory, [[{ name: "write", input }, { name: "return_result", input: CONTRACT_RESULT }]]);
    const { request } = contractRequest(directory, { capabilities: { tools: ["write"], mcpServers: [] }, toolPolicy: { write: kind === "denied" ? "allowed" : "approval_required" }, authorization: { authorize: authorizer } });
    const result = await fixture.adapter.execute(request);
    expect(authorizer).toHaveBeenCalledExactlyOnceWith({ tool: "write", input });
    if (kind === "allowed" || kind === "approved_once") expect(await fs.readFile(path.join(directory, "created.txt"), "utf8")).toBe("authorized");
    else await expect(fs.stat(path.join(directory, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "approval_required") expect(result.completion).toEqual({ kind: "approval_required", call: { tool: "write", input } });
    if (kind === "failed") expect(result.completion.kind).toBe("tool_failure");
    if (kind === "interrupted") expect(result.completion).toMatchObject({ kind: "interrupted", cause: "cancelled" });
  });

  it("executes runtime tools through their port and stops a parallel batch at a blocking Decision", async () => {
    const call = vi.fn(async () => ({ kind: "accepted" as const, result: { tool: "request_decision" as const, decisionId: "dec_000000000000000000000001" as never, blocksInvocation: true } }));
    const fixture = contractAdapter(provider, directory, [[{ name: "request_decision", input: { kind: "operator_choice", question: "Choose?", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] } }, { name: "return_result", input: CONTRACT_RESULT }]]);
    const { request } = contractRequest(directory, { runtimeTools: { tools: ["request_decision"], call: call as never } });
    const outcome = await fixture.adapter.execute(request);
    expect(call).toHaveBeenCalledTimes(1);
    expect(outcome.completion).toEqual({ kind: "decision_requested", decisionId: "dec_000000000000000000000001" });
    expect(outcome.result).toBeNull();
  });

  it.each(["cancelled", "operator_pause", "shutdown", "deadline"])("does no provider work when already interrupted with %s", async (cause) => {
    const fixture = contractAdapter(provider, directory);
    const { request, controller } = contractRequest(directory);
    controller.abort(cause);
    expect((await fixture.adapter.execute(request)).completion).toMatchObject({ kind: "interrupted", cause });
    expect(fixture.options).toHaveLength(0);
    expect(fixture.model.doStreamCalls).toHaveLength(0);
  });

  it("enforces an elapsed deadline itself", async () => {
    const fixture = contractAdapter(provider, directory);
    const { request } = contractRequest(directory, { deadlineAt: "2000-01-01T00:00:00.000Z" });
    expect((await fixture.adapter.execute(request)).completion).toMatchObject({ kind: "interrupted", cause: "deadline" });
  });

  it("classifies authentication permanently and transport failures transiently while redacting keys", async () => {
    for (const [message, transient] of [["401 invalid api key sk-secret-12345678901234567890", false], ["ECONNRESET", true]] as const) {
      const fixture = contractAdapter(provider, directory, [], new Error(message));
      const outcome = await fixture.adapter.execute(contractRequest(directory).request);
      expect(outcome.completion).toMatchObject({ kind: "provider_error", transient });
      expect(JSON.stringify(outcome)).not.toContain("sk-secret-12345678901234567890");
    }
  });

  it("rejects traversal and unsupported capability names instead of performing unintended work", async () => {
    const fixture = contractAdapter(provider, directory, [[{ name: "read", input: { path: "../outside" } }]]);
    const result = await fixture.adapter.execute(contractRequest(directory, { capabilities: { tools: ["read"], mcpServers: [] }, toolPolicy: { read: "allowed" } }).request);
    expect(result.completion.kind).toBe("tool_failure");
    const unsupported = contractAdapter(provider, directory);
    expect((await unsupported.adapter.execute(contractRequest(directory, { capabilities: { tools: ["spawn_agent"], mcpServers: [] } }).request)).completion).toMatchObject({ kind: "provider_error", transient: false });
  });

  it("resumes only matching model/provider payloads, with corrupt and mismatched payloads starting fresh", async () => {
    const first = await contractAdapter(provider, directory).adapter.execute(contractRequest(directory).request);
    const resumed = contractAdapter(provider, directory);
    const outcome = await resumed.adapter.execute(contractRequest(directory, { continuation: first.continuation }).request);
    expect(outcome.diagnostics.continuation).toBe("resumed");
    if (provider === "codex") expect(resumed.threads[0]!.resume).toBe("thread_contract_123");
    else expect(resumed.model.doStreamCalls[0]!.prompt.length).toBeGreaterThan(2);
    for (const payload of [Buffer.from("broken"), Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(first.continuation!).toString()), model: "other-model" }))]) {
      const fresh = contractAdapter(provider, directory);
      const result = await fresh.adapter.execute(contractRequest(directory, { continuation: payload }).request);
      expect(result.completion.kind).toBe("completed");
      expect(result.diagnostics.continuation).toBe("invalid_or_incompatible_fresh");
    }
  });
});
