/**
 * The application under test: the production composition over a disposable
 * directory, the SDK fixture as the provider, the configured browse roots
 * limited to that directory, and Fastify's in-process injection as the HTTP
 * client — the same service graph `main.ts` serves, minus the listener.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiErrorBody, ApiRouteName } from "@agentique-console/core";
import { apiPath } from "@agentique-console/core";
import { createApp, type App } from "../app.ts";
import type { SseOptions } from "./events.ts";
import { bootApp, shutdownApp } from "../boot.ts";
import { loadConfig, type Config } from "../config.ts";
import { FakeClaudeSdk } from "../provider/claude-sdk-test-support.ts";
import type { PublicationHooks } from "../workspace-state/index.ts";

export interface TestAppOptions {
  /** The directory the app's state and the browse roots live under; a fresh temporary one by default. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  sdk?: FakeClaudeSdk;
  /** Run `bootApp` (recovery, admission, reconstruction) before returning; true by default. */
  boot?: boolean;
  /** Test barriers of the publication port. */
  publicationHooks?: PublicationHooks;
  /** The event stream's outbound bounds. */
  events?: SseOptions;
  /** The serialized JSON response bound. */
  responseMaxBytes?: number;
}

export interface TestApp {
  app: App;
  dir: string;
  config: Config;
  sdk: FakeClaudeSdk;
  /** One HTTP call by route name. */
  call<T = unknown>(name: ApiRouteName, options?: { params?: Record<string, string>; query?: Record<string, string | number | undefined>; body?: unknown }): Promise<{ status: number; body: T }>;
  /** One raw HTTP call by method and path. */
  raw(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined>; text: string }>;
  /** Orderly shutdown and release; the directory stays for a later process. */
  close(): Promise<void>;
}

export function testEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CONSOLE_DATA_DIR: path.join(dir, "state"),
    CONSOLE_FS_ROOTS: dir,
    CONSOLE_PORT: "0",
    CONSOLE_DEFAULT_COMPLETION_CHECK: "node -e process.exit(0)",
    CONSOLE_DEFAULT_EVALUATOR: "none",
    CONSOLE_CONTINUATION: "0",
    CONSOLE_ORCHESTRATOR_COST_USD: "5",
    CONSOLE_ORCHESTRATOR_TOKENS: "500000",
    CONSOLE_ORCHESTRATOR_ATTEMPTS: "8",
    CONSOLE_NODE_COST_USD: "2",
    CONSOLE_NODE_TOKENS: "200000",
    CONSOLE_NODE_ATTEMPTS: "3",
    ...extra,
  };
}

export function newAppDirectory(prefix = "agentique-app-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function openTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dir = options.dir ?? newAppDirectory();
  const config = loadConfig(testEnv(dir, options.env ?? {}), dir);
  const sdk = options.sdk ?? new FakeClaudeSdk();
  const app = createApp({ config, sdk, ...(options.publicationHooks === undefined ? {} : { publicationHooks: options.publicationHooks }), ...(options.events === undefined ? {} : { events: options.events }), ...(options.responseMaxBytes === undefined ? {} : { responseMaxBytes: options.responseMaxBytes }) });
  if (options.boot !== false) await bootApp(app);
  await app.server.ready();
  const raw: TestApp["raw"] = async (method, url, body) => {
    const response = await app.server.inject({ method, url, ...(body === undefined ? {} : { payload: body as never }) });
    let parsed: unknown = null;
    try {
      parsed = response.body === "" ? null : (JSON.parse(response.body) as unknown);
    } catch {
      parsed = null;
    }
    return { status: response.statusCode, body: parsed, headers: response.headers as Record<string, string | string[] | undefined>, text: response.body };
  };
  return {
    app,
    dir,
    config,
    sdk,
    call: async (name, callOptions = {}) => {
      const route = (await import("@agentique-console/core")).API_ROUTES[name];
      const response = await raw(route.method, apiPath(name, callOptions.params ?? {}, callOptions.query ?? {}), callOptions.body);
      return { status: response.status, body: response.body as never };
    },
    raw,
    close: async () => {
      await shutdownApp(app, { settleMs: 5_000 });
    },
  };
}

export function isApiError(body: unknown): body is ApiErrorBody {
  return typeof body === "object" && body !== null && "error" in body;
}

export function removeAppDirectory(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
