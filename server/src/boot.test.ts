/**
 * Startup and shutdown (execution-model §14 "Server restart";
 * migration-contract §4, §9): recovery runs before admission and before any
 * work is driven; an incomplete pending-blob reconciliation leaves the
 * process refusing mutations; reconstruction re-drives nonterminal work
 * from rows; shutdown interrupts executing work through the lifecycle
 * without cancelling a Run or erasing a persisted pause; and the production
 * entrypoint refuses a legacy database with the reset-required message and
 * a non-zero exit without touching the file, while a fresh directory starts
 * and serves.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { HealthResponse, RunOverview } from "@agentique-console/core";
import { newAppDirectory, openTestApp, removeAppDirectory, testEnv } from "./api/test-support.ts";
import { gitSync } from "./workspace-state/git.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function initRepo(dir: string): string {
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  gitSync(["init", "--quiet", "--initial-branch=main"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  gitSync(["add", "-A"], { cwd: repo });
  gitSync(["commit", "--quiet", "--no-verify", "-m", "init"], { cwd: repo, identity: true });
  return repo;
}

interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the production entrypoint until it exits or until `until` sees its output, then ends it. */
function runMain(env: NodeJS.ProcessEnv, options: { until?: RegExp; timeoutMs?: number } = {}): Promise<ChildRun & { port: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", MAIN], { cwd: SERVER_ROOT, env: { ...process.env, ...env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let port: number | null = null;
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, port });
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`main.ts did not finish: ${stdout}\n${stderr}`));
    }, options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const listening = stdout.match(/on http:\/\/[^:]+:(\d+)/);
      if (listening) port = Number(listening[1]);
      if (options.until?.test(stdout)) {
        void fetchHealth(port).then((health) => {
          stdout += `\nHEALTH ${JSON.stringify(health)}\n`;
          child.kill("SIGINT");
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => finish(code));
  });
}

async function fetchHealth(port: number | null): Promise<unknown> {
  if (port === null) return null;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  return response.json();
}

describe("boot and shutdown", () => {
  it("runs recovery before admission, refuses mutations until it completes, reconstructs runnable work from rows, and reports it in health", async () => {
    const dir = newAppDirectory();
    try {
      const t = await openTestApp({ dir, boot: false });
      expect(t.app.admission.state).toBe("starting");
      expect((await t.call("createConversation", { body: { workspaceId: "ws_000000000000000000000000" } })).status).toBe(503);
      const { bootApp } = await import("./boot.ts");
      const report = await bootApp(t.app);
      expect(report.recovery.blobs.complete).toBe(true);
      expect(t.app.admission.state).toBe("ready");
      expect((await t.call<HealthResponse>("health")).body).toMatchObject({ ok: true, admission: "ready", recovery: { blobsComplete: true, outstandingPublications: 0 } });
      await t.close();
    } finally {
      removeAppDirectory(dir);
    }
  });

  it("stays in recovery_incomplete when the pending-blob reconciliation left an obligation unresolved: reads served, every mutation refused, nothing driven", async () => {
    const dir = newAppDirectory();
    try {
      const t = await openTestApp({ dir, boot: false });
      // A marker the protocol cannot resolve: an unsafe entry in the pending area is reported and left in place.
      const pending = path.join(t.config.blobRoot, ".pending");
      fs.mkdirSync(pending, { recursive: true });
      fs.mkdirSync(path.join(pending, "a".repeat(64)), { recursive: true });
      const { bootApp } = await import("./boot.ts");
      const report = await bootApp(t.app);
      expect(report.recovery.blobs.complete).toBe(false);
      expect(t.app.admission.state).toBe("recovery_incomplete");
      expect((await t.call<HealthResponse>("health")).body).toMatchObject({ ok: false, admission: "recovery_incomplete", recovery: { blobsComplete: false } });
      expect((await t.call("listWorkspaces")).status).toBe(200);
      expect((await t.call("createWorkspace", { body: { rootPath: path.join(dir, "x"), create: true } })).status).toBe(503);
      expect(t.app.host.snapshot()).toMatchObject({ queued: [], active: [] });
      await t.close();
    } finally {
      removeAppDirectory(dir);
    }
  });

  it("interrupts executing work on shutdown through the lifecycle: the Attempt ends interrupted with a permitted retry, the Run is neither cancelled nor paused, a persisted pause survives, and the next process continues from rows", async () => {
    const dir = newAppDirectory();
    try {
      const repo = initRepo(dir);
      const t = await openTestApp({ dir });
      const workspace = await t.call<{ workspace: { id: string } }>("createWorkspace", { body: { rootPath: repo } });
      const conversation = await t.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId: workspace.body.workspace.id } });
      // The provider turn hangs until its abort signal fires: the shutdown must end it through the executor's interruption.
      t.sdk.script({ steps: [{ kind: "hang" }] });
      const created = await t.call<RunOverview>("createRun", { params: { conversationId: conversation.body.conversation.id }, body: { goal: "Add a --version flag", start: true } });
      expect(created.status).toBe(201);
      const runId = created.body.run.id;
      await waitFor(() => t.app.runtime.executor.inFlightOf(runId).length === 1);
      const attemptId = t.app.runtime.executor.inFlightOf(runId)[0]!;
      // A pause the operator persisted before the shutdown stays.
      const paused = await t.call("pauseRun", { params: { runId }, body: { mode: "soft" } });
      expect(paused.status).toBe(200);
      const { shutdownApp } = await import("./boot.ts");
      const shutdown = shutdownApp(t.app, { settleMs: 20_000 });
      await waitFor(() => t.app.admission.state === "stopping");
      await shutdown;
      // A fresh process over the same directory: the rows say interrupted, retry permitted, paused — not cancelled.
      const next = await openTestApp({ dir });
      try {
        const attempt = next.app.runtime.stores.invocations.getAttempt(attemptId as never);
        expect(attempt.status).toBe("interrupted");
        expect(attempt.retryDecision?.permitted).toBe(true);
        expect(attempt.failureDetail?.message).toMatch(/shutdown/);
        const run = next.app.runtime.stores.runs.get(runId);
        expect(run.status).toBe("waiting");
        expect(run.operatorPause).toBe("soft");
        expect(run.waitReason).toBe("operator");
        expect(next.app.boot?.recovery.interruptedAttemptIds).toEqual([]);
        expect(next.app.boot?.reconstructed.runs).toBe(1);
        await next.close();
      } finally {
        // nothing
      }
    } finally {
      removeAppDirectory(dir);
    }
  }, 60_000);

  it("the production entrypoint starts against an empty data directory and serves health, and refuses a legacy database with the reset-required message without modifying it", async () => {
    const dir = newAppDirectory();
    try {
      const env = testEnv(dir, { CONSOLE_PORT: "0" });
      const fresh = await runMain(env, { until: /agentique-console on http/ });
      expect(fresh.stderr, fresh.stderr).toBe("");
      expect(fresh.stdout).toMatch(/recovered: 0 interrupted/);
      expect(fresh.stdout).toMatch(/"admission":"ready"/);
      // Windows delivers no SIGINT to a child (`kill` terminates it outright), so the orderly signal path is proven on POSIX only;
      // the in-process shutdown above covers the lifecycle everywhere.
      if (process.platform !== "win32") {
        expect(fresh.stdout).toMatch(/shutting down/);
        expect(fresh.code).toBe(0);
      }
      expect(fs.existsSync(path.join(dir, "state", "console.db"))).toBe(true);
      // A legacy database: created by a previous, unsupported schema.
      const legacyDir = newAppDirectory();
      try {
        const file = path.join(legacyDir, "state", "console.db");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const legacy = new Database(file);
        legacy.exec("CREATE TABLE user_sessions (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT); INSERT INTO user_sessions VALUES ('us_1', 'old');");
        legacy.close();
        const before = fs.readFileSync(file);
        const refused = await runMain(testEnv(legacyDir), { timeoutMs: 60_000 });
        expect(refused.code).toBe(2);
        expect(refused.stderr).toMatch(/reset-required: .* was created by a previous, unsupported schema/);
        expect(refused.stderr).toMatch(/Delete the file or point CONSOLE_DATA_DIR at an empty directory/);
        expect(fs.readFileSync(file).equals(before)).toBe(true);
        expect(fs.existsSync(`${file}-wal`)).toBe(false);
      } finally {
        removeAppDirectory(legacyDir);
      }
      // An invalid configuration names its variable and exits non-zero.
      const invalid = await runMain(testEnv(dir, { CONSOLE_PORT: "abc" }), { timeoutMs: 60_000 });
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toMatch(/CONSOLE_PORT/);
    } finally {
      removeAppDirectory(dir);
    }
  }, 180_000);
});

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
