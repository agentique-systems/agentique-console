import fs from "node:fs";
import type { Invocation, InvocationResponse, Page, RunOverview, WorkspaceResponse, ConversationResponse } from "@agentique-console/core";
import { expect, it } from "vitest";
import { openTestApp, newAppDirectory } from "./test-support.ts";
import { initFixtureRepo } from "./e2e-fixture.ts";
import { contractAdapter } from "../provider/adapter-test-support.ts";

it.each(["codex", "ai-sdk"] as const)("launches %s through production orchestration and preserves immutable selection on restart", async (provider) => {
  const dir = newAppDirectory("agentique-selection-");
  const fixture = contractAdapter(provider, dir);
  let t = await openTestApp({ dir, adapterOverrides: [fixture.adapter] });
  try {
    const repo = initFixtureRepo(dir);
    const workspace = await t.call<WorkspaceResponse>("createWorkspace", { body: { rootPath: repo } });
    const conversation = await t.call<ConversationResponse>("createConversation", { body: { workspaceId: workspace.body.workspace.id } });
    const model = provider === "codex" ? "gpt-5.6-sol" : "openai/gpt-5.6-terra";
    const params = { conversationId: conversation.body.conversation.id };
    const invalid = await t.call("createRun", { params, body: { goal: "Inspect the fixture", provider, model: "bad-model" } });
    expect(invalid.status).toBe(400);
    const created = await t.call<RunOverview>("createRun", { params, body: { goal: "Inspect the fixture", provider, model } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const runId = created.body.run.id;
    expect(created.body.run.execution).toEqual({ provider, model });
    let invocation: InvocationResponse | undefined;
    await expect.poll(async () => {
      const list = await t.call<Page<Invocation>>("listRunInvocations", { params: { runId } });
      if (!list.body.items[0]) return false;
      invocation = (await t.call<InvocationResponse>("getInvocation", { params: { invocationId: list.body.items[0].id } })).body;
      return invocation.attempts.some((attempt) => attempt.status === "succeeded");
    }, { timeout: 30_000 }).toBe(true);
    expect(invocation!.manifest.content.modelPolicy).toMatchObject({ provider, model });
    if (provider === "codex") expect(fixture.threads[0]?.options?.model).toBe(model);
    else expect(fixture.model.doStreamCalls.length).toBe(1);
    expect(t.sdk.captured.options).toHaveLength(0);
    await t.close();
    t = await openTestApp({ dir, env: { CONSOLE_PROVIDER: "claude" }, adapterOverrides: [fixture.adapter] });
    const restored = await t.call<RunOverview>("getRun", { params: { runId } });
    expect(restored.body.run.execution).toEqual({ provider, model });
    const pinned = await t.call<InvocationResponse>("getInvocation", { params: { invocationId: invocation!.invocation.id } });
    expect(pinned.body.manifest.content.modelPolicy).toMatchObject({ provider, model });
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}, 60_000);
