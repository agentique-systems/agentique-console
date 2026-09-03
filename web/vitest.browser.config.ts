import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The driven-browser acceptance suite: a real browser (Playwright's
 * Chromium) against the built web application served by a real listening
 * server process. It runs in Node, not jsdom, and imports nothing from the
 * application: it drives the page as an operator would.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["tests/browser/**/*.browser.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
