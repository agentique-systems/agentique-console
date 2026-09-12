import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { contractAdapter, contractRequest, CONTRACT_RESULT } from "./adapter-test-support.ts";

const directories: string[] = [];
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentique-codex-semantics-")); directories.push(dir); return dir; }
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

it("falls back once when a native session disappeared, before doing any tool work", async () => {
  const dir = await directory();
  const fixture = contractAdapter("codex", dir, undefined, (resumed) => resumed ? new Error("Session not found") : undefined);
  const { request } = contractRequest(dir);
  const first = await fixture.adapter.execute(request);
  const second = await fixture.adapter.execute({ ...request, continuation: first.continuation });
  expect(second.result).toEqual(CONTRACT_RESULT);
  expect(second.diagnostics.continuation).toBe("missing_native_session_fresh");
  expect(fixture.threads.map((thread) => thread.resume)).toEqual([null, "thread_contract_123", null]);
});

it("does not retry a network failure as a fresh session", async () => {
  const dir = await directory();
  const fixture = contractAdapter("codex", dir, undefined, (resumed) => resumed ? new Error("ECONNRESET") : undefined);
  const { request } = contractRequest(dir);
  const first = await fixture.adapter.execute(request);
  const second = await fixture.adapter.execute({ ...request, continuation: first.continuation });
  expect(second.completion).toMatchObject({ kind: "provider_error", transient: true });
  expect(fixture.threads).toHaveLength(2);
});

it("passes the assigned directory and fail-closed settings without inheriting host credentials or sessions", async () => {
  const dir = await directory();
  const fixture = contractAdapter("codex", dir);
  await fixture.adapter.execute(contractRequest(dir).request);
  expect(fixture.threads[0]!.options).toMatchObject({ workingDirectory: dir, sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false, webSearchMode: "disabled" });
  expect(fixture.options[0]!.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(fixture.options[0]!.env).not.toHaveProperty("CODEX_THREAD_ID");
  expect(fixture.options[0]!.configOverrides![0]).toMatch(/^mcp_servers=\{agentique=/);
});

it.each(["codex", "ai-sdk"] as const)("%s rejects unsupported effort before SDK work", async (provider) => {
  const dir = await directory();
  const fixture = contractAdapter(provider, dir);
  expect((await fixture.adapter.execute(contractRequest(dir, { effort: "max" }).request)).completion).toMatchObject({ kind: "provider_error", transient: false });
  expect(fixture.threads).toHaveLength(0);
  expect(fixture.model.doStreamCalls).toHaveLength(0);
});
