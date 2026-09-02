import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    // jsdom 29 and its encoding dependency require() ES modules, which Node unflagged in 22.12; this build's
    // declared engine is >= 22.22, and the flag makes a 22.11 host load them the same way.
    execArgv: ["--experimental-require-module"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
