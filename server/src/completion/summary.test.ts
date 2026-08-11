/**
 * "What was built" prefers the git fact over the model's claim.
 *
 * A handoff's changedPaths is whatever the model chose to say; the diff
 * against `run_base_commit` (captured at the first delegation) is what
 * actually changed. New files matter most — a run's usual product is files
 * that did not exist before, which `git diff` alone would not list.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeHarness } from "../test-helpers.ts";
import { buildRunSummary } from "./summary.ts";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const NO_REAP = { processes: [], browsers: 0, leakedBefore: 0 };

describe("run summary build source", () => {
  it("uses the git diff against run_base_commit, counting modified AND new files", () => {
    const h = makeHarness(async function* () { yield undefined as never; });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-git-"));
    git(dir, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(dir, "index.html"), "<html>v1</html>\n");
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base", "--no-gpg-sign"]);
    const base = git(dir, ["rev-parse", "HEAD"]);

    const userSessionId = h.addUserSession();
    h.repo.patchUserSession(userSessionId, { runBaseCommit: base });
    // The run modifies one tracked file and creates one new, uncommitted file.
    fs.writeFileSync(path.join(dir, "index.html"), "<html>v2</html>\n");
    fs.writeFileSync(path.join(dir, "src-game.js"), "export {};\n");

    const document = buildRunSummary({
      db: h.db, repo: h.repo, interactions: h.interactions,
      userSessionId, seqFrom: 0, reaped: NO_REAP,
      getWorkspaceRoot: () => dir,
    });

    expect(document.build.source).toBe("git");
    expect(document.build.files).toEqual(["index.html", "src-game.js"]);
    expect(document.build.filesChanged).toBe(2);
  });

  it("falls back to handoff claims when no base commit was captured", () => {
    const h = makeHarness(async function* () { yield undefined as never; });
    const userSessionId = h.addUserSession();
    const document = buildRunSummary({
      db: h.db, repo: h.repo, interactions: h.interactions,
      userSessionId, seqFrom: 0, reaped: NO_REAP,
      getWorkspaceRoot: () => "/tmp/does-not-exist",
    });
    expect(document.build.source).toBe("none");
  });
});

describe("run summary friction", () => {
  it("counts retries from structured retry events, never from runtime prose", () => {
    const h = makeHarness(async function* () { yield undefined as never; });
    const userSessionId = h.addUserSession();
    // Prose alone must count nothing — only `*.retry.recorded` is a retry fact.
    h.bus.append({ type: "user_session.runtime.noted", userSessionId,
      payload: { userSessionId, detail: "API error 529 · retry 1/3 · in 2s" } });
    h.bus.append({ type: "user_session.retry.recorded", userSessionId,
      payload: { userSessionId, agent: "orchestrator", kind: "api_error", attempt: 1, retryInMs: 2_000, detail: "API error 529 · retry 1/3 · in 2s" } });
    h.bus.append({ type: "agent_session.retry.recorded", userSessionId, agentSessionId: "as_1",
      payload: { userSessionId, agentSessionId: "as_1", agent: "scout", kind: "rate_limited", attempt: 2, retryInMs: 90_000, detail: "rate limited · retry 2/5 · in 1m 30s" } });
    const document = buildRunSummary({
      db: h.db, repo: h.repo, interactions: h.interactions,
      userSessionId, seqFrom: 0, reaped: NO_REAP,
      getWorkspaceRoot: () => "/tmp/does-not-exist",
    });
    expect(document.friction.apiRetries).toBe(1);
    expect(document.friction.rateLimited).toBe(1);
  });
});
