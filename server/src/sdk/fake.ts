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

/**
 * The CONSOLE_FAKE_SDK=1 program: a canned orchestrator that streams a short
 * reply and settles. Enough to exercise the whole UI without credentials.
 */
export function devProgram(): FakeProgram {
  return async function* (options): AsyncGenerator<SdkMessage, void, void> {
    const sessionId = options.resume ?? `fake-session-${++fakeSession}`;
    yield initMessage(sessionId);
    const reply =
      "I hear you. This server is running against the fake SDK (CONSOLE_FAKE_SDK=1), " +
      "so I can't do real work — but everything you see is flowing through the real " +
      "event spine: streaming deltas, persisted messages, and turn lifecycle events.";
    for (const word of reply.split(" ")) {
      yield deltaMessage(`${word} `);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    yield textMessage(reply);
    yield successMessage(undefined, { session_id: sessionId });
  };
}
