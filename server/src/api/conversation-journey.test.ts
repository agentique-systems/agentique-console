import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { gitSync } from "../workspace-state/git.ts";
import type { ConversationResponse, MessagePostResponse, WorkspaceResponse } from "@agentique-console/core";
import { initFixtureRepo, returned, completionTurns, planTurn, workerTurn } from "./e2e-fixture.ts";
import { openTestApp, removeAppDirectory } from "./test-support.ts";

const dialogue = (reply: string, work: string | null = null) => ({ steps: [returned("Conversation reply", { conversation: { reply, work } })] });

describe("conversation-first operator journey", () => {
  it("answers, clarifies, dispatches once, preserves explicit signoff, and continues after completion and restart", async () => {
    let t = await openTestApp();
    const dir = t.dir;
    try {
      const repo = initFixtureRepo(dir);
      const workspace = await t.call<WorkspaceResponse>("createWorkspace", { body: { rootPath: repo, name: "Conversation workspace" } });
      expect(workspace.status, JSON.stringify(workspace.body)).toBe(201);
      const created = await t.call<ConversationResponse>("createConversation", { body: { workspaceId: workspace.body.workspace.id } });
      const conversationId = created.body.conversation.id;
      const params = { conversationId };
      t.sdk.script(dialogue("Hello. What would you like to do?"));
      const firstBody = { content: "Hello", requestId: "first" };
      const first = await t.call<MessagePostResponse>("postConversationMessage", { params, body: firstBody });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      await t.app.host.idle();
      const stores = t.app.runtime.stores;
      expect(stores.conversations.listMessages(conversationId).map((m) => m.content)).toEqual(["Hello", "Hello. What would you like to do?"]);
      expect(stores.conversations.get(conversationId).activeRunId).toBeNull();
      expect(stores.runs.listByConversation(conversationId)).toHaveLength(1);
      const context = t.app.conversations.context(conversationId)!;
      const manifest = stores.invocations.getManifest(stores.invocations.listByRun(context.id)[0]!.id);
      expect(manifest.content.capabilities).toEqual({ tools: [], mcpServers: [] });
      expect(manifest.content.runtimeTools).toEqual(["return_result"]);

      const replay = await t.call<MessagePostResponse>("postConversationMessage", { params, body: firstBody });
      expect(replay.body).toEqual(first.body);
      expect((await t.call("postConversationMessage", { params, body: { ...firstBody, content: "different" } })).status).toBe(409);
      t.sdk.script(dialogue("Which flag should the CLI support?"));
      await t.call("postConversationMessage", { params, body: { content: "Add a flag", requestId: "clarify" } });
      await t.app.host.idle();
      expect(stores.runs.listByConversation(conversationId)).toHaveLength(1);

      const loaded = t.app.runtime.agents.loader.loadCurrent(workspace.body.workspace.id, { kind: "branch", branch: "main" });
      const implementer = loaded.files.find((f) => f.kind === "loaded" && f.name === "implementer");
      if (!implementer || implementer.kind !== "loaded") throw new Error("Missing implementer");
      t.sdk.script(dialogue("I will add --version and check the result.", "Add a --version flag to the CLI."), { steps: [returned("I have the clarified request.")] });
      const workBody = { content: "Use --version", requestId: "work" };
      const sent = await t.call<MessagePostResponse>("postConversationMessage", { params, body: workBody });
      await t.app.host.idle();
      const work = stores.runs.listByConversation(conversationId).find((r) => r.mode !== "conversation")!;
      expect(work.status).toBe("running");
      // A follow-up reaches the same work with the original identity/content, even when the dispatcher paraphrases it.
      t.sdk.script(dialogue("I will implement that now.", "Implement the clarified flag and check it."), planTurn(implementer.revisionId, []), workerTurn(null), ...completionTurns());
      const followup = await t.call<MessagePostResponse>("postConversationMessage", { params, body: { content: "Yes, implement the clarified flag.", requestId: "followup" } });
      await t.app.host.idle();
      expect(stores.runs.get(work.id).status, JSON.stringify(t.app.diagnostics.list())).toBe("awaiting_signoff");
      const workInputs = stores.invocations.listByRun(work.id).flatMap((invocation) => stores.invocations.getManifest(invocation.id).content.inputs);
      expect(workInputs).toContainEqual({ kind: "operator_message", conversationMessageId: followup.body.message.id, content: followup.body.message.content });
      expect(stores.conversations.listMessages(conversationId).filter((m) => m.content === workBody.content)).toHaveLength(1);
      expect((await t.call("postConversationMessage", { params, body: workBody })).body).toEqual(sent.body);
      expect(stores.runs.listByConversation(conversationId).filter((r) => r.mode !== "conversation")).toHaveLength(1);

      // Even a provider incorrectly treating prose as authorization cannot resolve a signoff or launch competing work.
      t.sdk.script(dialogue("Use the review controls to accept and publish.", "Accept and publish this result"));
      await t.call("postConversationMessage", { params, body: { content: "yes, approve and publish", requestId: "not-approval" } });
      await t.app.host.idle();
      expect(stores.runs.get(work.id).status).toBe("awaiting_signoff");
      expect(stores.publications.listByRun(work.id)).toHaveLength(0);
      const signoff = t.app.runtime.signoff;
      const view = signoff.inspect(work.id);
      expect(view).toBeDefined();
      const gate = stores.gates.listByRun(work.id).find((g) => g.kind === "operator_signoff")!;
      const decision = stores.decisions.listByRun(work.id).find((d) => d.kind === "signoff")!;
      const accepted = await t.call("acceptSignoff", { params: { runId: work.id }, body: { gateId: gate.id, decisionId: decision.id } });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      t.sdk.script(dialogue("The CLI now supports --version. You're welcome."));
      await t.call("postConversationMessage", { params, body: { content: "Thanks, what changed?", requestId: "thanks" } });
      await t.app.host.idle();
      expect(stores.runs.listByConversation(conversationId).filter((r) => r.mode !== "conversation")).toHaveLength(1);
      const turns = stores.invocations.listByRun(context.id);
      const lastContext = stores.invocations.getManifest(turns.at(-1)!.id).content.conversationContext!;
      expect(lastContext).toContain("completed");
      expect(lastContext).toContain("Use --version");
      // A fresh work request after completion gets a second work Run in this same thread.
      t.sdk.script(dialogue("I will begin the next change.", "Add a help flag."), { steps: [returned("The next request is ready for planning.")] });
      await t.call("postConversationMessage", { params, body: { content: "Now add --help", requestId: "second-work" } });
      await t.app.host.idle();
      const workRuns = stores.runs.listByConversation(conversationId).filter((r) => r.mode !== "conversation");
      expect(workRuns).toHaveLength(2);
      const nextWork = workRuns.find((r) => r.id !== work.id)!;
      const nextManifest = stores.invocations.getManifest(stores.invocations.listByRun(nextWork.id)[0]!.id).content;
      expect(nextManifest.conversationContext).toContain("Use --version");
      expect(nextManifest.conversationContext).toContain("Now add --help");
      await t.call("cancelRun", { params: { runId: nextWork.id }, body: {} });
      const history = stores.conversations.listMessages(conversationId);
      await t.close();
      t = await openTestApp({ dir });
      expect((await t.call("postConversationMessage", { params, body: workBody })).body).toEqual(sent.body);
      await t.app.host.idle();
      expect(t.app.runtime.stores.conversations.listMessages(conversationId)).toEqual(history);
      expect(t.sdk.remainingTurns).toBe(0);
    } finally { await t.close(); removeAppDirectory(dir); }
  }, 120_000);

  it("chats before the first workspace commit, rejects oversized UTF-8 input, and admits concurrent retries once", async () => {
    const t = await openTestApp();
    try {
      const repo = path.join(t.dir, "empty-repo");
      fs.mkdirSync(repo);
      gitSync(["init", "--quiet", "--initial-branch=main"], { cwd: repo });
      const workspace = await t.call<WorkspaceResponse>("createWorkspace", { body: { rootPath: repo } });
      expect(workspace.status).toBe(201);
      const created = await t.call<ConversationResponse>("createConversation", { body: { workspaceId: workspace.body.workspace.id } });
      const params = { conversationId: created.body.conversation.id };
      expect((await t.call("postConversationMessage", { params, body: { content: "\u00e9".repeat(20_000) } })).status).toBe(400);
      t.sdk.script(dialogue("Hello. Let's talk through your idea."));
      const replies = await Promise.all(Array.from({ length: 4 }, () => t.call<MessagePostResponse>("postConversationMessage", { params, body: { content: "Hello", requestId: "concurrent" } })));
      for (const reply of replies) { expect(reply.status).toBe(201); expect(reply.body).toEqual(replies[0]!.body); }
      await t.app.host.idle();
      const stores = t.app.runtime.stores;
      const runs = stores.runs.listByConversation(created.body.conversation.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ mode: "conversation", baseSnapshotId: null, integrationWorkspacePath: null });
      expect(stores.invocations.listByRun(runs[0]!.id)).toHaveLength(1);
      expect(stores.conversations.listMessages(created.body.conversation.id).map((m) => m.content)).toEqual(["Hello", "Hello. Let's talk through your idea."]);
    } finally { await t.close(); removeAppDirectory(t.dir); }
  });

  it.each(["running", "paused", "cancelled"])("recovers a committed reply and work dispatch once, respecting controls before dispatch (%s)", async (status) => {
    let t = await openTestApp();
    const dir = t.dir;
    try {
      const repo = initFixtureRepo(dir);
      const workspace = await t.call<WorkspaceResponse>("createWorkspace", { body: { rootPath: repo } });
      const created = await t.call<ConversationResponse>("createConversation", { body: { workspaceId: workspace.body.workspace.id } });
      const params = { conversationId: created.body.conversation.id };
      // Simulate a process boundary after Attempt commit and before host result projection/dispatch.
      const reconcile = vi.spyOn(t.app.conversations, "reconcile").mockReturnValue([]);
      t.sdk.script(dialogue("I will start the work.", "Add --version."));
      const body = { content: "Add --version", requestId: "recover" };
      const sent = await t.call<MessagePostResponse>("postConversationMessage", { params, body });
      await t.app.host.idle();
      expect(t.app.runtime.stores.conversations.listMessages(created.body.conversation.id)).toHaveLength(1);
      const context = t.app.conversations.context(created.body.conversation.id)!;
      expect(t.app.runtime.stores.invocations.listByRun(context.id)[0]!.status).toBe("succeeded");
      if (status === "cancelled") await t.call("cancelRun", { params: { runId: context.id }, body: {} });
      if (status === "paused") await t.call("pauseRun", { params: { runId: context.id }, body: { mode: "soft" } });
      await t.close();
      reconcile.mockRestore();
      const sdk = t.sdk;
      if (status === "running") sdk.script({ steps: [returned("The work request is ready.")] });
      t = await openTestApp({ dir, sdk });
      await t.app.host.idle();
      expect((await t.call("postConversationMessage", { params, body })).body).toEqual(sent.body);
      t.app.conversations.recover();
      t.app.conversations.recover();
      const stores = t.app.runtime.stores;
      expect(stores.runs.listByConversation(created.body.conversation.id).filter((r) => !r.mode)).toHaveLength(status === "running" ? 1 : 0);
      if (status === "paused") {
        sdk.script({ steps: [returned("The resumed work request is ready.")] });
        await t.call("resumeRun", { params: { runId: context.id }, body: {} });
        await t.app.host.idle();
        expect(stores.runs.listByConversation(created.body.conversation.id).filter((r) => !r.mode)).toHaveLength(1);
      }
      const messages = stores.conversations.listMessages(created.body.conversation.id);
      expect(messages.filter((m) => m.author === "operator")).toHaveLength(1);
      expect(messages.filter((m) => m.invocationId === stores.invocations.listByRun(context.id)[0]!.id)).toHaveLength(1);
      if (status === "cancelled") expect(messages.at(-1)!.content).toContain("stopped before work could start");
    } finally { await t.close(); removeAppDirectory(dir); }
  }, 60_000);

});
