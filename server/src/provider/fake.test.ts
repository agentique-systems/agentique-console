/**
 * The scripted fake provider and the continuation payload stores: every
 * scripted outcome, request recording, cancellation, delayed completion,
 * and safe file handling — with no network, credentials, or timers.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "../persistence/blob-store.ts";
import type { AttemptExecutionRequest, ToolCallAuthorization, ToolCallAuthorizationPort } from "./adapter.ts";
import { assertStorageKey, FileContinuationPayloadStore, MemoryContinuationPayloadStore } from "./continuation-store.ts";
import { DEFAULT_USAGE, ScriptedProvider } from "./fake.ts";

/** A test authorization port answering by Tool Policy alone (no approval grants), recording every call it was asked about. */
function policyPort(toolPolicy: Record<string, "allowed" | "denied" | "approval_required">): ToolCallAuthorizationPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    authorize(call) {
      asked.push(call.tool);
      const disposition = toolPolicy[call.tool] ?? "denied";
      if (disposition === "allowed") return { kind: "allowed", tool: call.tool };
      if (disposition === "denied") return { kind: "denied", tool: call.tool };
      return { kind: "approval_required", tool: call.tool, callDigest: "0".repeat(64) };
    },
  };
}

function request(overrides: Partial<AttemptExecutionRequest> = {}): AttemptExecutionRequest {
  return {
    attemptId: "att_000000000000000000000001",
    invocationId: "inv_000000000000000000000001",
    runId: "run_000000000000000000000001",
    model: "claude-fable-5",
    effort: "high",
    input: { rendererVersion: 1, text: "# Context Manifest v1\n", digest: "a".repeat(64) },
    capabilities: { tools: ["read"], mcpServers: [] },
    toolPolicy: { read: "allowed", shell: "approval_required" },
    authorization: policyPort({ read: "allowed", shell: "approval_required" }),
    runtimeTools: { tools: [], call: async (call) => ({ kind: "not_callable", tool: call.tool }) },
    workingDirectory: "/tmp/wt",
    deadlineAt: null,
    signal: new AbortController().signal,
    continuation: null,
    output: () => {},
    ...overrides,
  };
}

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ++tick)).toISOString();

describe("scripted provider", () => {
  it("produces every scripted outcome in order and records each request exactly", async () => {
    const provider = new ScriptedProvider({ clock });
    provider.script(
      { kind: "succeed", result: { ok: true }, usage: [DEFAULT_USAGE, { ...DEFAULT_USAGE, outputTokens: 5 }], transcript: "t", continuation: "opaque", output: ["a", "b"], diagnostics: { turns: "2" } },
      { kind: "transient_error" },
      { kind: "permanent_error", message: "gone" },
      { kind: "tool_failure", tool: "shell" },
      { kind: "tool_calls", calls: [{ tool: "read", input: { path: "a" } }, { tool: "shell", input: { command: "rm -rf build" } }], then: { kind: "succeed", result: 1 } },
      { kind: "interrupted" },
    );
    const outputs: string[] = [];
    const first = await provider.execute(request({ output: (o) => outputs.push(o.text), continuation: new TextEncoder().encode("prior") }));
    expect(first.completion).toEqual({ kind: "completed" });
    expect(first.result).toEqual({ ok: true });
    expect(first.usage).toHaveLength(2);
    expect(new TextDecoder().decode(first.transcript!)).toBe("t");
    expect(new TextDecoder().decode(first.continuation!)).toBe("opaque");
    expect(first.diagnostics).toEqual({ turns: "2" });
    expect(first.timing.providerMs).toBe(16);
    expect(first.timing.startedAt < first.timing.endedAt).toBe(true);
    expect(outputs).toEqual(["a", "b"]);
    expect(provider.requests[0]).toMatchObject({ attemptId: "att_000000000000000000000001", aborted: false, inTransaction: false });
    expect(new TextDecoder().decode(provider.requests[0]!.continuation!)).toBe("prior");
    expect(provider.requests[0]!.request).toMatchObject({ model: "claude-fable-5", effort: "high", workingDirectory: "/tmp/wt", toolPolicy: { shell: "approval_required" } });
    expect((await provider.execute(request())).completion).toEqual({ kind: "provider_error", transient: true, message: "provider overloaded" });
    expect((await provider.execute(request())).completion).toEqual({ kind: "provider_error", transient: false, message: "gone" });
    expect((await provider.execute(request())).completion).toEqual({ kind: "tool_failure", tool: "shell", message: "shell failed" });
    expect((await provider.execute(request())).completion).toEqual({ kind: "approval_required", call: { tool: "shell", input: { command: "rm -rf build" } } });
    expect(provider.executed.map((e) => e.call.tool)).toEqual(["read"]);
    expect((await provider.execute(request())).completion).toEqual({ kind: "interrupted", cause: "provider", message: "provider stream ended" });
    // The script is exhausted; the default step succeeds with a typed completed result and default usage in the requested model.
    const fallback = await provider.execute(request({ model: "m2", effort: "low" }));
    expect(fallback.completion).toEqual({ kind: "completed" });
    expect(fallback.usage).toEqual([{ ...DEFAULT_USAGE, model: "m2", effort: "low" }]);
    expect(provider.pendingSteps).toBe(0);
  });

  it("hangs until aborted and reports the runtime's cause; a delayed step completes only when released", async () => {
    const provider = new ScriptedProvider({ clock });
    provider.script({ kind: "hang", continuation: "partial" }, { kind: "delay", key: "k", then: { kind: "succeed", result: 1 } }, { kind: "hang" });
    const controller = new AbortController();
    const hanging = provider.execute(request({ signal: controller.signal }));
    controller.abort("cancelled");
    const cancelled = await hanging;
    expect(cancelled.completion).toEqual({ kind: "interrupted", cause: "cancelled", message: "aborted: cancelled" });
    expect(new TextDecoder().decode(cancelled.continuation!)).toBe("partial");
    expect(provider.requests[0]).toMatchObject({ aborted: true, abortCause: "cancelled" });

    let settled = false;
    const delayed = provider.execute(request()).then((o) => {
      settled = true;
      return o;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(provider.delayedKeys).toEqual(["k"]);
    provider.release("k");
    expect((await delayed).result).toBe(1);
    expect(() => provider.release("k")).toThrow(/no delayed execution/);

    const deadline = new AbortController();
    const expiring = provider.execute(request({ signal: deadline.signal }));
    deadline.abort("deadline");
    expect((await expiring).completion).toEqual({ kind: "interrupted", cause: "deadline", message: "aborted: deadline" });
  });

  it("submits every proposed call to the runtime's authorization port and executes exactly what the port permits, holding no approval state of its own", async () => {
    const provider = new ScriptedProvider({ clock });
    const answers: ToolCallAuthorization[] = [];
    const asked: unknown[] = [];
    const port: ToolCallAuthorizationPort = {
      authorize(call) {
        asked.push(call);
        return answers.shift() ?? { kind: "denied", tool: call.tool };
      },
    };
    const approved = { tool: "shell", input: { command: "rm -rf build" } };
    // allowed and approved_once execute; a second approved_once for the same call executes again — the fake never decides "used" itself.
    answers.push({ kind: "allowed", tool: "read" }, { kind: "approved_once", tool: "shell", callDigest: "1".repeat(64), decisionId: "dec_000000000000000000000001", useId: "acu_000000000000000000000001" }, { kind: "approved_once", tool: "shell", callDigest: "1".repeat(64), decisionId: "dec_000000000000000000000001", useId: "acu_000000000000000000000002" });
    provider.script({ kind: "tool_calls", calls: [{ tool: "read", input: null }, approved, approved], then: { kind: "succeed", result: "ok" } });
    const first = await provider.execute(request({ authorization: port }));
    expect(first.completion).toEqual({ kind: "completed" });
    expect(asked).toEqual([{ tool: "read", input: null }, approved, approved]);
    expect(provider.executed.map((e) => e.authorization.kind)).toEqual(["allowed", "approved_once", "approved_once"]);
    expect(provider.requests[0]!.authorizations.map((a) => a.authorization.kind)).toEqual(["allowed", "approved_once", "approved_once"]);
    expect("authorization" in provider.requests[0]!.request).toBe(false);
    // approval_required ends the execution with the exact call and executes nothing further; denied, invalid, and failed are tool failures that execute nothing.
    answers.push({ kind: "approval_required", tool: "shell", callDigest: "1".repeat(64) });
    provider.script({ kind: "tool_calls", calls: [approved, { tool: "read", input: null }], then: { kind: "succeed", result: "never" } });
    expect((await provider.execute(request({ authorization: port }))).completion).toEqual({ kind: "approval_required", call: approved });
    answers.push({ kind: "denied", tool: "shell" });
    provider.script({ kind: "tool_calls", calls: [approved], then: { kind: "succeed", result: "never" } });
    expect((await provider.execute(request({ authorization: port }))).completion).toEqual({ kind: "tool_failure", tool: "shell", message: "tool shell is denied by the Tool Policy" });
    answers.push({ kind: "invalid", tool: null, message: "not a call" });
    provider.script({ kind: "tool_calls", calls: [approved], then: { kind: "succeed", result: "never" } });
    expect((await provider.execute(request({ authorization: port }))).completion).toEqual({ kind: "tool_failure", tool: "unknown", message: "not a call" });
    answers.push({ kind: "failed", tool: "shell", message: "disk I/O error" });
    provider.script({ kind: "tool_calls", calls: [approved], then: { kind: "succeed", result: "never" } });
    expect((await provider.execute(request({ authorization: port }))).completion).toEqual({ kind: "tool_failure", tool: "shell", message: "authorization failed: disk I/O error" });
    expect(provider.executed).toHaveLength(3);
    expect(asked).toHaveLength(7);
  });

  it("throws when scripted to, and reports a transaction that is open at call time", async () => {
    let open = true;
    const provider = new ScriptedProvider({ clock, inTransaction: () => open });
    provider.script({ kind: "throw", error: new Error("socket hang up") });
    await expect(provider.execute(request())).rejects.toThrow("socket hang up");
    expect(provider.requests[0]!.inTransaction).toBe(true);
    open = false;
    await provider.execute(request());
    expect(provider.requests[1]!.inTransaction).toBe(false);
  });
});

describe("continuation payload stores", () => {
  it("the file store writes atomically under hashed keys, tolerates missing payloads, and rejects unsafe keys", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-continuations-"));
    try {
      const store = new FileContinuationPayloadStore(root, sha256Hex);
      const bytes = new TextEncoder().encode("opaque");
      expect(await store.put("fake/att_1", bytes)).toBe(sha256Hex(bytes));
      expect(await store.get("fake/att_1")).toEqual(bytes);
      expect(await store.get("fake/att_2")).toBeNull();
      // Keys never become paths: no file named after the key exists, and traversal keys are refused.
      expect(fs.existsSync(path.join(root, "fake"))).toBe(false);
      expect(fs.readdirSync(root).every((d) => /^[0-9a-f]{2}$/.test(d))).toBe(true);
      expect(fs.readdirSync(root).flatMap((d) => fs.readdirSync(path.join(root, d))).some((f) => f.endsWith(".tmp"))).toBe(false);
      for (const bad of ["../x", "a/../b", "/abs", "", ".hidden", "a b", "x".repeat(300)]) {
        expect(() => assertStorageKey(bad), bad).toThrow(/invalid continuation storage key/);
        await expect(store.get(bad)).rejects.toThrow(/invalid continuation storage key/);
      }
      await store.delete("fake/att_1");
      await store.delete("fake/att_1");
      expect(await store.get("fake/att_1")).toBeNull();
      await store.put("fake/att_3", bytes);
      await store.truncate();
      expect(fs.existsSync(root)).toBe(false);
      expect(await store.get("fake/att_3")).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the memory store copies bytes in and out", async () => {
    const store = new MemoryContinuationPayloadStore(sha256Hex);
    const bytes = new TextEncoder().encode("x");
    await store.put("k", bytes);
    bytes[0] = 0;
    expect(new TextDecoder().decode((await store.get("k"))!)).toBe("x");
    expect(store.size).toBe(1);
  });
});
