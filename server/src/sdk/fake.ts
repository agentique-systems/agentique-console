/**
 * Test double for the SDK module surface (port of agentique-core's fake-sdk).
 * Records the prompt, options, compiled tools, and interrupt calls; yields a
 * scripted message program. Programs receive the query options, so tests can
 * invoke `options.canUseTool` and `options.hooks` callbacks directly to
 * exercise interaction and task-mirror flows credential-free.
 */
import type {
  CompiledTool,
  ConsoleSdk,
  SdkMessage,
  SdkOptions,
  SdkToolResult,
} from "./types.ts";

export type FakeProgram = (
  options: SdkOptions,
  tools: CompiledTool[],
) => AsyncGenerator<SdkMessage, void, void>;

export interface FakeSdk {
  sdk: ConsoleSdk;
  captured: {
    /** Every prompt in arrival order (one per query() call). */
    prompts: string[];
    /** Options of every query() call, in order. */
    options: SdkOptions[];
    interrupted: boolean;
    closed: boolean;
    tools: CompiledTool[];
  };
  /** Resolves once `captured.prompts[index]` exists. */
  waitForPrompt(index: number): Promise<string>;
}

export function fakeSdk(program: FakeProgram): FakeSdk {
  const captured: FakeSdk["captured"] = {
    prompts: [],
    options: [],
    interrupted: false,
    closed: false,
    tools: [],
  };
  const waiters: { index: number; resolve: (text: string) => void }[] = [];

  const record = (text: string): void => {
    captured.prompts.push(text);
    for (const waiter of waiters.splice(0)) {
      const value = captured.prompts[waiter.index];
      if (value !== undefined) waiter.resolve(value);
      else waiters.push(waiter);
    }
  };

  const sdk: ConsoleSdk = {
    query({ prompt, options }) {
      if (typeof prompt === "string") record(prompt);
      else {
        void (async () => {
          try {
            for await (const message of prompt) {
              record(
                typeof message === "string" ? message : JSON.stringify(message),
              );
            }
          } catch {
            // Stream closing ends the drain.
          }
        })();
      }
      captured.options.push(options);
      const generator = program(options, captured.tools);
      return Object.assign(generator, {
        interrupt: async () => {
          captured.interrupted = true;
        },
        close: () => {
          captured.closed = true;
        },
      });
    },
    tool(name, description, _schema, handler) {
      const compiled: CompiledTool = {
        name,
        description,
        handler: handler as CompiledTool["handler"],
      };
      captured.tools.push(compiled);
      return compiled;
    },
    createSdkMcpServer(config) {
      return { type: "sdk", name: config.name, instance: config };
    },
  };

  return {
    sdk,
    captured,
    waitForPrompt(index: number): Promise<string> {
      const existing = captured.prompts[index];
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<string>((resolve) => {
        waiters.push({ index, resolve });
      });
    },
  };
}

let permissionSeq = 0;

/** A fully-shaped canUseTool context for driving permission flows from tests. */
export function permissionContext(): Parameters<
  NonNullable<SdkOptions["canUseTool"]>
>[2] {
  permissionSeq += 1;
  return {
    signal: new AbortController().signal,
    toolUseID: `tu_fake_${permissionSeq}`,
    requestId: `req_fake_${permissionSeq}`,
  } as Parameters<NonNullable<SdkOptions["canUseTool"]>>[2];
}

// --- Message builders -------------------------------------------------------

let fakeSession = 0;

export function initMessage(sessionId?: string): SdkMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId ?? `fake-session-${++fakeSession}`,
  };
}

export function deltaMessage(text: string): SdkMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

export function reasoningDeltaMessage(thinking: string): SdkMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking },
    },
  };
}

export function textMessage(text: string): SdkMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

export function toolUseMessage(
  id: string,
  name: string,
  input: unknown,
): SdkMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  };
}

export function toolResultMessage(
  toolUseId: string,
  content: unknown,
  isError = false,
): SdkMessage {
  return {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError },
      ],
    },
  };
}

export function successMessage(
  output?: unknown,
  extra: Partial<SdkMessage> = {},
): SdkMessage {
  return {
    type: "result",
    subtype: "success",
    ...(output === undefined ? {} : { structured_output: output }),
    ...extra,
  };
}

export function errorMessage(subtype: string, extra: Partial<SdkMessage> = {}): SdkMessage {
  return { type: "result", subtype, ...extra };
}

// --- Dev-mode demo program --------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function* streamText(
  text: string,
): AsyncGenerator<SdkMessage, void, void> {
  for (const word of text.split(" ")) {
    yield deltaMessage(`${word} `);
    await sleep(18);
  }
  yield textMessage(text);
}

type HookCallback = (input: unknown) => Promise<unknown>;

function hookCallbacks(
  hooks: SdkOptions["hooks"],
  event: string,
): HookCallback[] {
  const matchers = (hooks as
    | Record<string, { hooks: HookCallback[] }[]>
    | undefined)?.[event];
  return matchers?.flatMap((m) => m.hooks) ?? [];
}

/**
 * The CONSOLE_FAKE_SDK=1 program: a scripted orchestrator + specialists that
 * exercise the whole surface without credentials — chat, AskUserQuestion when
 * asked to, a two-seat delegation with tool traffic and task-mirror hook
 * calls, and wake-digest relays. `getPrompt` returns the current query's
 * prompt (the fake records it before the program starts).
 */
export function devProgram(getPrompt: () => string): FakeProgram {
  return async function* (options, tools): AsyncGenerator<SdkMessage, void, void> {
    const prompt = getPrompt();

    // --- Specialist turns (structured output configured) ---
    if (options.outputFormat !== undefined) {
      const seat = /You are \*\*(.+?)\*\*/.exec(prompt)?.[1] ?? "seat";
      const sessionId = options.resume ?? `fake-${seat}-${++fakeSession}`;
      yield initMessage(sessionId);
      const fire = async (event: string, input: Record<string, unknown>) => {
        for (const callback of hookCallbacks(options.hooks, event)) {
          await callback({ session_id: sessionId, ...input }).catch(() => undefined);
        }
      };
      yield reasoningDeltaMessage(`Reading the brief as ${seat}… `);
      await sleep(150);
      await fire("PostToolUse", {
        tool_name: "TaskCreate",
        tool_input: {
          subject: `${seat}: demo unit of work`,
          activeForm: `${seat} working`,
        },
        tool_response: { task: { id: `${seat}-t1`, subject: `${seat}: demo unit of work` } },
      });
      await fire("PostToolUse", {
        tool_name: "TaskUpdate",
        tool_input: { taskId: `${seat}-t1`, status: "in_progress", owner: seat },
        tool_response: { success: true, updatedFields: ["status", "owner"] },
      });
      yield toolUseMessage(`tu_${seat}_1`, "Grep", { pattern: "TODO", path: "." });
      await sleep(250);
      yield toolResultMessage(`tu_${seat}_1`, "src/main.ts:12: TODO demo");
      yield* streamText(
        seat === "scout"
          ? "Found it: the demo marker sits in src/main.ts. Handing the detail to coder."
          : "Confirmed and wrapped up on my side. Everything checks out.",
      );
      await fire("PostToolUse", {
        tool_name: "TaskUpdate",
        tool_input: { taskId: `${seat}-t1`, status: "completed" },
        tool_response: { success: true, updatedFields: ["status"] },
      });
      yield successMessage(
        seat === "scout"
          ? {
              message:
                "@coder the marker is in src/main.ts:12 — confirm nothing else references it",
              to: null,
            }
          : { message: "Confirmed: only src/main.ts:12 carries the marker.", to: null },
        { session_id: sessionId },
      );
      return;
    }

    // --- Orchestrator turns ---
    const sessionId = options.resume ?? `fake-orchestrator-${++fakeSession}`;
    yield initMessage(sessionId);

    if (prompt.includes("has gone quiet")) {
      yield* streamText(
        "The team settled. scout traced the demo marker to src/main.ts:12 and coder " +
          "confirmed it is the only reference. Their tasks are complete — anything else?",
      );
      yield successMessage(undefined, { session_id: sessionId });
      return;
    }

    if (/\b(ask|question|choose|decide)\b/i.test(prompt)) {
      const result = await options.canUseTool?.(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Fake SDK demo: how should I proceed?",
              options: [
                { label: "Delegate to a team", description: "Spin up scout + coder" },
                { label: "Just chat", description: "No delegation" },
              ],
            },
          ],
        },
        {
          signal: new AbortController().signal,
          toolUseID: `tu_ask_${++fakeSession}`,
        } as never,
      );
      const answer =
        result?.behavior === "allow"
          ? JSON.stringify(
              (result.updatedInput as { answers?: unknown }).answers ?? "",
            )
          : "";
      if (answer.includes("Delegate")) {
        yield* delegateBranch(tools);
      } else {
        yield* streamText(
          result?.behavior === "allow"
            ? "Understood — staying in chat mode. Ask me anything."
            : "No answer arrived, so I'll hold off. Ask again when ready.",
        );
      }
      yield successMessage(undefined, { session_id: sessionId });
      return;
    }

    if (/\b(delegate|investigate|explore|build|find|look)\b/i.test(prompt)) {
      yield* delegateBranch(tools);
      yield successMessage(undefined, { session_id: sessionId });
      return;
    }

    yield* streamText(
      "I hear you. This server runs against the fake SDK (CONSOLE_FAKE_SDK=1) — say " +
        "something with 'investigate' or 'delegate' to watch a demo delegation, or " +
        "'ask me' to see a question card. Everything flows through the real event spine.",
    );
    yield successMessage(undefined, { session_id: sessionId });
  };
}

async function* delegateBranch(
  tools: CompiledTool[],
): AsyncGenerator<SdkMessage, void, void> {
  const create = tools.find((t) => t.name === "create_agent_session");
  if (create) {
    yield toolUseMessage("tu_create", "mcp__console__create_agent_session", {
      title: "Demo investigation",
    });
    const result = await create.handler(
      {
        title: "Demo investigation",
        mode: "execute",
        agents: [
          { name: "scout", preset: "explorer" },
          { name: "coder", preset: "implementer" },
        ],
        briefing: "@scout find the demo marker in this workspace; loop in @coder to confirm",
      },
      {},
    );
    yield toolResultMessage("tu_create", result.content[0]?.text ?? "");
  }
  yield* streamText(
    "Delegated to scout and coder in a fresh agent session — watch the panel on the " +
      "right. I'll report back when they settle.",
  );
}
