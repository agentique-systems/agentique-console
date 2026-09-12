import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { AdapterAttempt, ProviderTranscript } from "./attempt-session.ts";
import { contractRequest } from "./adapter-test-support.ts";
import { startMcpBridge } from "./mcp-bridge.ts";
import { addMcpTools, mcpCatalogSchema } from "./mcp-tools.ts";
import { runToolProcess, workspacePath } from "./local-tools.ts";

const directories: string[] = [];
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentique-tool-boundary-")); directories.push(dir); return dir; }
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

it("rejects unauthenticated/browser-origin MCP requests and supports exact authorized remote MCP tools", async () => {
  const dir = await directory();
  const remote = new AdapterAttempt(contractRequest(dir).request);
  const executed: unknown[] = [];
  remote.add("lookup", { description: "Lookup", schema: z.object({ term: z.string() }), execute: async (input) => { executed.push(input); return { found: true }; } });
  const bridge = await startMcpBridge(remote);
  const calls: string[] = [];
  const local = new AdapterAttempt(contractRequest(dir, { capabilities: { tools: ["mcp__docs__lookup"], mcpServers: ["docs"] }, authorization: { authorize: ({ tool }) => { calls.push(tool); return { kind: "allowed", tool }; } } }).request);
  let close: (() => Promise<void>) | undefined;
  try {
    expect((await fetch(bridge.url, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, Origin: "https://untrusted.test" }, body: "{}" })).status).toBe(401);
    close = await addMcpTools(local, { docs: { url: bridge.url, headers: { Authorization: `Bearer ${bridge.token}` } } });
    expect(Object.keys(local.tools).sort()).toEqual(["mcp__docs__lookup", "return_result"]);
    await local.call("mcp__docs__lookup", { term: "one" });
    expect(executed).toEqual([{ term: "one" }]); expect(calls).toEqual(["mcp__docs__lookup"]);
    await local.call("mcp__docs__undeclared", {});
    expect(executed).toHaveLength(1);
  } finally { await close?.(); await bridge.close(); await local.finish(); await remote.finish(); }
});

it("rejects traversal and symlinks outside the assigned directory, including nonexistent nested writes", async () => {
  const root = await directory(); const outside = await directory();
  await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(workspacePath(root, "../outside", true)).rejects.toThrow(/outside/);
  await expect(workspacePath(root, "escape/new/deep/file.txt", true)).rejects.toThrow(/outside/);
  await expect(workspacePath(root, ".git/config", true)).rejects.toThrow(/control directories/);
  expect(await workspacePath(root, "new/file.txt", true)).toBe(path.join(await fs.realpath(root), "new/file.txt"));
});

it("cancels a live tool subprocess and bounds runaway output", async () => {
  const dir = await directory(); const controller = new AbortController();
  const pending = runToolProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], dir, controller.signal, 10_000, 1000);
  const timer = setTimeout(() => controller.abort("cancelled"), 50);
  try { await expect(pending).rejects.toBe("cancelled"); } finally { clearTimeout(timer); }
  const output = await runToolProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], dir, new AbortController().signal, 5000, 1000);
  expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(1000); expect(output.truncated).toBe(true);
}, 15_000);

it("bounds and redacts diagnostics without copying session or credential fields", () => {
  const transcript = new ProviderTranscript(200);
  transcript.append({ sessionId: "private-session", headers: { Authorization: "secret" }, text: "sk-contract-secret12345" });
  transcript.append({ text: "x".repeat(500) });
  expect(Buffer.from(transcript.bytes()!).toString()).not.toMatch(/private-session|secret12345|Authorization/);
  expect(transcript.truncated).toBe(true);
  expect(transcript.bytes()!.byteLength).toBeLessThanOrEqual(200);
});

it.each([[401, false], [400, false], [429, true], [503, true]] as const)("classifies HTTP %s from SDK error metadata, not just prose", async (statusCode, transient) => {
  const attempt = new AdapterAttempt(contractRequest(process.cwd()).request);
  attempt.fail(Object.assign(new Error("opaque upstream failure"), { statusCode }));
  expect((await attempt.finish()).completion).toMatchObject({ kind: "provider_error", transient });
});

it("validates explicit stdio/HTTP MCP configuration and refuses ambiguous transports and reserved names", () => {
  expect(mcpCatalogSchema.parse({ docs: { command: "node", args: ["with spaces/server.js"] }, remote: { url: "https://example.test/mcp" } })).toHaveProperty("docs");
  for (const value of [{ agentique: { command: "node" } }, { remote: { url: "file:///secret" } }, { remote: { url: "https://user:secret@example.test/mcp" } }, { docs: { url: "https://example.test", command: "node" } }]) expect(mcpCatalogSchema.safeParse(value).success).toBe(false);
});
