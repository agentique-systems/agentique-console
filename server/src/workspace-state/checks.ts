/**
 * The Acceptance Criterion execution port (execution-model §10.1; ports/
 * acceptance-criterion-execution.ts): one deterministic command against a
 * disposable view holding exactly one Snapshot. The view is a detached
 * worktree at the Snapshot's commit, derived from the Integration Workspace
 * (a round or Gate check) or from a Publication's staging area (a candidate
 * check), keyed by the request's isolation key so a stale view of a dead
 * process is discarded and never reused. The command runs as a child process
 * with bounded output capture and the runtime's abort signal. The request's
 * deadline is the one timer this module owns: it is bound to the child
 * process, cleared the moment the process exits, and terminates the whole
 * process tree while the shell is still alive (the process layer's own
 * timeout would kill the shell first and orphan the command it started). No
 * scheduler timer, poll, or sleep lives here. Exit results are verdict
 * inputs; anything that stops the command from running to an exit code is a
 * typed infrastructure failure. The view is removed afterwards and no process
 * the command started outlives the check.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { AcceptanceCriterionExecutionOutcome, AcceptanceCriterionExecutionPort, AcceptanceCriterionExecutionRequest } from "../execution/ports/acceptance-criterion-execution.ts";
import { boundedStderr, gitEnvironment } from "./git.ts";
import { checkViewDir, exists, runDirectoryOf, type WorkspaceStateLayout } from "./paths.ts";
import { commitOfIdentity } from "./snapshots.ts";
import { addWorktree, removeWorktree } from "./worktrees.ts";

/** Variables a check must not inherit: anything that couples it to a Claude Code session or redirects git. */
const STRIPPED = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$/;

export function checkEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = gitEnvironment({}, source);
  for (const key of Object.keys(env)) if (STRIPPED.test(key)) delete env[key];
  env.CI = env.CI ?? "1";
  return env;
}

class BoundedCapture {
  readonly #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.#size >= this.maxBytes) {
      this.truncated = this.truncated || chunk.byteLength > 0;
      return;
    }
    const room = this.maxBytes - this.#size;
    if (chunk.byteLength > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#size += room;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.byteLength;
  }

  bytes(): Uint8Array {
    return new Uint8Array(Buffer.concat(this.#chunks, this.#size));
  }
}

/** Ends the command's whole process tree: the shell and whatever it started. */
function terminateTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export class WorkspaceChecks implements AcceptanceCriterionExecutionPort {
  constructor(private readonly layout: WorkspaceStateLayout) {}

  async execute(request: AcceptanceCriterionExecutionRequest): Promise<AcceptanceCriterionExecutionOutcome> {
    const base = request.workspace.integrationWorkspacePath;
    if (base === null || !exists(base)) return { kind: "failed", failure: "workspace_unavailable", message: "the check has no workspace to derive its view of the Snapshot" };
    let view: string;
    try {
      view = checkViewDir(runDirectoryOf(this.layout, base), request.workspace.isolationKey);
      const commit = await commitOfIdentity(base, request.workspace.snapshot);
      await addWorktree(this.layout, { fromCwd: base, worktreePath: view, commit });
    } catch (error) {
      return { kind: "failed", failure: "workspace_unavailable", message: boundedStderr(error instanceof Error ? error.message : String(error), 500) };
    }
    try {
      return await runCommand(request, view);
    } finally {
      try {
        await removeWorktree(this.layout, base, view);
      } catch {
        // A view that could not be removed is discarded by the next check under the same key.
      }
    }
  }
}

function runCommand(request: AcceptanceCriterionExecutionRequest, cwd: string): Promise<AcceptanceCriterionExecutionOutcome> {
  return new Promise<AcceptanceCriterionExecutionOutcome>((resolve) => {
    if (request.signal.aborted) {
      resolve({ kind: "failed", failure: "aborted", message: "the check was aborted before it started" });
      return;
    }
    const remainingMs = request.deadlineAt === null ? null : Date.parse(request.deadlineAt) - Date.now();
    if (remainingMs !== null && remainingMs <= 0) {
      resolve({ kind: "failed", failure: "timed_out", message: "the check's deadline had passed before it started" });
      return;
    }
    const startedAt = Date.now();
    const output = new BoundedCapture(request.maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let deadline: NodeJS.Timeout | null = null;
    let outputFailed: string | null = null;
    const finish = (outcome: AcceptanceCriterionExecutionOutcome) => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      request.signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    let child: ChildProcess;
    try {
      child = spawn(request.command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: checkEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      finish({ kind: "failed", failure: "start_failed", message: boundedStderr(error instanceof Error ? error.message : String(error), 500) });
      return;
    }
    const onAbort = () => terminateTree(child);
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (remainingMs !== null) {
      // The deadline ends the whole tree while the shell is alive; it never outlives the process it is bound to.
      deadline = setTimeout(() => {
        timedOut = true;
        terminateTree(child);
      }, remainingMs);
      deadline.unref();
    }
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stdout?.on("error", (error) => {
      outputFailed = error.message;
    });
    child.stderr?.on("error", (error) => {
      outputFailed = error.message;
    });
    child.on("error", (error) => {
      terminateTree(child);
      finish({ kind: "failed", failure: "start_failed", message: boundedStderr(error.message, 500) });
    });
    child.on("exit", (code, signal) => {
      // The shell ended; whatever it left behind ends now, so no orphan outlives the check.
      terminateTree(child);
      const elapsed = Date.now() - startedAt;
      if (request.signal.aborted) {
        finish({ kind: "failed", failure: "aborted", message: "the check was aborted by the runtime" });
        return;
      }
      if (timedOut) {
        finish({ kind: "failed", failure: "timed_out", message: `the check exceeded its deadline after ${elapsed} ms` });
        return;
      }
      if (outputFailed !== null) {
        finish({ kind: "failed", failure: "output_unavailable", message: boundedStderr(outputFailed, 500) });
        return;
      }
      // A command ended by an external signal exited without a code: reported as an exit that matches no expected code.
      finish({ kind: "exited", exitCode: code ?? -1, output: output.bytes(), truncated: output.truncated });
    });
  });
}
