import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fixture workspaces ship their own node:test suites for the AGENTS to
    // run — they are eval material, not part of this package's suite.
    exclude: ["**/node_modules/**", "evals/orchestration/fixtures/**"],
  },
});
