/**
 * The SDK injection seam. Production resolves the real
 * `@anthropic-ai/claude-agent-sdk` lazily (first turn pays the import);
 * CONSOLE_FAKE_SDK=1 swaps in the scripted dev fake. Tests construct services
 * with a `fakeSdk(...)` instance directly and never touch this file.
 */
import type { Config } from "../config.ts";
import { devProgram, fakeSdk, type FakeSdk } from "./fake.ts";
import type { ConsoleSdk } from "./types.ts";

let cached: Promise<ConsoleSdk> | null = null;

export function resolveSdk(config: Config): Promise<ConsoleSdk> {
  cached ??= config.fakeSdk ? Promise.resolve(devFake().sdk) : loadReal();
  return cached;
}

function devFake(): FakeSdk {
  // The program reads its own prompt back off the capture (recorded before
  // the program starts) — a late-bound box breaks the construction cycle.
  const box: { fake?: FakeSdk } = {};
  const fake = fakeSdk(
    devProgram(() => box.fake?.captured.prompts.at(-1) ?? ""),
  );
  box.fake = fake;
  return fake;
}

async function loadReal(): Promise<ConsoleSdk> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: (params) =>
      sdk.query(
        params as Parameters<typeof sdk.query>[0],
      ) as unknown as ReturnType<ConsoleSdk["query"]>,
    tool: (name, description, schema, handler) =>
      sdk.tool(
        name,
        description,
        schema as Parameters<typeof sdk.tool>[2],
        handler as unknown as Parameters<typeof sdk.tool>[3],
      ),
    createSdkMcpServer: (config) =>
      sdk.createSdkMcpServer(
        config as unknown as Parameters<typeof sdk.createSdkMcpServer>[0],
      ),
  };
}
