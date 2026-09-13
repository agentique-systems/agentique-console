import { canonicalJson, ConflictError, DomainError, RUN_MACHINE, ZERO_ALLOCATION, type ConversationId, type Invocation, type MessageBody, type MessagePostResponse, type Run, type RunId } from "@agentique-console/core";
import type { ConsoleRuntime } from "../composition/console-runtime.ts";
import type { Config } from "../config.ts";
import { sha256Hex } from "../persistence/blob-store.ts";
import type { RunLaunchService } from "./run-launch.ts";
import { defaultTargetOf } from "./workspaces.ts";

/** Conversation admission and projection over the one execution engine. No provider loop or execution policy lives here. */
export class ConversationService {
  constructor(private readonly runtime: ConsoleRuntime, private readonly launch: RunLaunchService, private readonly config: Config, private readonly workspaceSettings: (id: string) => import("@agentique-console/core").WorkspaceSettings = () => ({})) {}

  post(conversationId: ConversationId, body: MessageBody): MessagePostResponse {
    const { ctx, stores } = this.runtime;
    const digest = sha256Hex(new TextEncoder().encode(canonicalJson(body)));
    return ctx.tx.write(() => {
      if (body.requestId !== undefined) {
        const replay = stores.conversationOperations.replay(conversationId, body.requestId, digest);
        if (replay !== null) return replay;
      }
      const conversation = stores.conversations.get(conversationId);
      const overrides = this.workspaceSettings(conversation.workspaceId);
      const latestContext = stores.runs.listByConversation(conversationId).findLast((r) => r.mode === "conversation");
      const existing = latestContext !== undefined && !RUN_MACHINE.isTerminal(latestContext.status) ? latestContext : undefined;
      const selection = latestContext?.execution ?? this.runtime.providers?.select({ ...(overrides.provider ? { provider: overrides.provider } : {}), ...(overrides.model ? { model: overrides.model } : {}), ...(body.provider === undefined ? {} : { provider: body.provider }), ...(body.model === undefined ? {} : { model: body.model }) });
      if (latestContext !== undefined && ((body.provider !== undefined && body.provider !== selection?.provider) || (body.model !== undefined && body.model !== selection?.model))) throw new ConflictError("This conversation's model is already selected. Start a new conversation to change it.");
      const message = stores.conversations.postMessage({ conversationId, author: "operator", content: body.content, runId: null, invocationId: null });
      if (conversation.title === null) stores.conversations.update(conversationId, { title: body.content.slice(0, 80) });
      let queued: MessagePostResponse["queued"] = null;
      if (existing === undefined) {
        const target = defaultTargetOf(stores.workspaces.get(conversation.workspaceId)) ?? { kind: "directory" as const };
        const created = this.runtime.runCreation.create({ conversationId, mode: "conversation", kind: "other", target,
          budget: overrides.budget ?? this.config.defaults.budget, finalReserve: ZERO_ALLOCATION,
          orchestratorAllocation: this.config.defaults.orchestratorAllocation,
          orchestratorAgentDefinitionRevisionId: this.runtime.agents.builtins.orchestrator.id,
          ...(selection === undefined ? {} : { execution: selection }),
        });
        this.runtime.runStart.start({ runId: created.run.id, conversationMessageId: message.id });
      } else {
        queued = stores.orchestratorInputs.enqueue(existing.id, { kind: "operator_message", conversationMessageId: message.id, content: message.content });
      }
      const response = { message, queued };
      if (body.requestId !== undefined) stores.conversationOperations.record(conversationId, body.requestId, digest, response);
      return response;
    });
  }

  context(conversationId: ConversationId): Run | null {
    return this.runtime.stores.runs.listByConversation(conversationId).find((r) => r.mode === "conversation" && !RUN_MACHINE.isTerminal(r.status)) ?? null;
  }

  /** Replays projection/dispatch from committed results, including a process death after Attempt finalization. */
  reconcile(runId: RunId): RunId[] {
    const { stores, ctx } = this.runtime;
    const run = stores.runs.get(runId);
    const notifications = new Set<RunId>();
    for (const invocation of stores.invocations.listByRun(runId)) {
      if (invocation.role !== "orchestrator" || invocation.status !== "succeeded" || stores.conversations.messageOfInvocation(invocation.id) !== null) continue;
      const result = invocation.result!;
      // Keep a completed dispatch pending through a soft pause. Resume re-enters this same host projection.
      if (run.mode === "conversation" && run.operatorPause !== null && result.conversation?.work != null) continue;
      const report = result.finalReport;
      const reply = report === null ? (result.conversation?.reply ?? result.summary) || "The Orchestrator finished this step." : [report.summary, ...report.completed, ...report.verification, ...report.risks, ...report.followUps].join("\n\n");
      let error: string | null = null;
      try {
        ctx.tx.write(() => {
          if (run.mode === "conversation" && result.conversation?.work != null && !stores.conversationOperations.dispatched(invocation.id)) {
            const work = this.dispatch(run, invocation, result.conversation.work);
            stores.conversationOperations.dispatch(invocation.id, work, null);
            notifications.add(work);
          }
          stores.conversations.postMessage({ conversationId: run.conversationId, runId, invocationId: invocation.id, author: "orchestrator", content: reply });
        });
      } catch (cause) {
        if (!(cause instanceof DomainError)) throw cause;
        error = cause.message;
      }
      if (error !== null) ctx.tx.write(() => {
        stores.conversationOperations.dispatch(invocation.id, null, error);
        stores.conversations.postMessage({ conversationId: run.conversationId, runId, invocationId: invocation.id, author: "orchestrator", content: `${reply}\n\nExecution could not start: ${error}` });
      });
    }
    return [...notifications];
  }

  recover(): RunId[] {
    const notifications = new Set<RunId>();
    for (;;) {
      const pending = this.runtime.stores.conversationOperations.pendingRunIds();
      if (pending.length === 0) break;
      for (const runId of pending) for (const id of this.reconcile(runId)) notifications.add(id);
    }
    return [...notifications];
  }

  private dispatch(context: Run, invocation: Invocation, goal: string): RunId {
    const { stores } = this.runtime;
    const current = stores.runs.get(context.id);
    if (current.operatorPause !== null || RUN_MACHINE.isTerminal(current.status)) throw new ConflictError("This conversation was stopped before work could start. Resume it or send a new request.");
    // Only new operator input can request work. Replies and prior context cannot launch it.
    const inputs = stores.invocations.getManifest(invocation.id).content.inputs.filter((i) => i.kind === "operator_message");
    const input = inputs.at(-1);
    if (input === undefined) throw new ConflictError("Work requires a new operator request.");
    const message = stores.conversations.getMessage(input.conversationMessageId);
    const activeId = stores.conversations.get(context.conversationId).activeRunId;
    if (activeId !== null) {
      const active = stores.runs.get(activeId);
      if (active.operatorPause !== null || !["running", "waiting"].includes(active.status) || active.waitReason === "decision") throw new ConflictError("Resolve the required decision or resume using the controls in this conversation before continuing work.");
      for (const original of inputs) stores.orchestratorInputs.enqueue(activeId, original);
      return activeId;
    }
    return this.launch.launch(context.conversationId, { goal, ...context.execution }, message).run.id;
  }
}
