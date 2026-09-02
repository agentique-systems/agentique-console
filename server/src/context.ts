import type { App } from "./app.ts";

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * What the HTTP layer receives: the one application graph plus transport
 * concerns. Routes reach services as `ctx.app.<service>`; there is exactly
 * one graph and one place it is built (`createApp`).
 */
export interface AppContext {
  app: App;
  log: Logger;
}
