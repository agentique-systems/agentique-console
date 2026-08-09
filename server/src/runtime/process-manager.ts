import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";

interface ManagedProcess {
  id: string;
  owner: string;
  child: ChildProcessWithoutNullStreams;
  chunks: { seq: number; stream: "stdout" | "stderr"; text: string }[];
  seq: number;
  exit: { code: number | null; signal: string | null } | null;
  waiters: Set<() => void>;
}

export interface RuntimeScope { workspaceRoot: string; userSessionId: string; agentSessionId: string; participant: string; }

/** Owns long-running children so agents wait on state changes instead of polling Bash. */
/**
 * Read-only binds a managed child genuinely needs, plus the workspace
 * read-write.
 *
 * The previous argv was `--ro-bind / /`, which handed every `process_start`
 * child read access to the entire filesystem — `~/.ssh`, `~/.claude`, the
 * operator's browser profiles, every other workspace on the machine. Combined
 * with `env: process.env` that was the widest containment gap in the codebase,
 * and nothing about running a dev server requires it.
 *
 * Deliberately conservative rather than minimal: a toolchain outside these
 * paths will fail loudly with a missing-binary error the operator can act on,
 * which is the right failure mode for a change like this.
 */
export function sandboxBinds(): string[] {
  const readOnly = [
    "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt",
    "/etc/resolv.conf", "/etc/ssl", "/etc/ca-certificates", "/etc/pki",
    "/etc/passwd", "/etc/group", "/etc/hosts", "/etc/nsswitch.conf",
    "/etc/alternatives", "/etc/localtime",
  ];
  const argv: string[] = [];
  for (const entry of readOnly) {
    // `--ro-bind-try` so a path this distribution does not have is not fatal.
    if (fs.existsSync(entry)) argv.push("--ro-bind-try", entry, entry);
  }
  return argv;
}

export function sandboxArgv(workspaceRoot: string, cwd: string): string[] {
  return [
    "--die-with-parent", "--unshare-all", "--share-net",
    ...sandboxBinds(),
    // BEFORE the workspace bind, not after. bwrap applies operations in order,
    // so a tmpfs mounted over /tmp afterwards would shadow a workspace that
    // lives under /tmp — which is where scratch workspaces usually live, and
    // where every test fixture does.
    "--tmpfs", "/tmp",
    "--bind", workspaceRoot, workspaceRoot,
    "--proc", "/proc", "--dev", "/dev",
    "--chdir", cwd,
  ];
}

/** The environment a managed child gets: enough to build, no credentials. */
export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "SHELL", "USER", "LOGNAME",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NODE_OPTIONS", "npm_config_cache", "PYTHONPATH", "JAVA_HOME", "GOPATH", "GOCACHE", "CARGO_HOME", "RUSTUP_HOME"];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  // Ports the seat is allowed to bind, when the caller assigned a block.
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("CONSOLE_PORT") && value !== undefined) env[key] = value;
  }
  return env;
}

export class ProcessManager {
  readonly #processes = new Map<string, ManagedProcess>();
  constructor(readonly bus: EventBus) {}

  start(scope: RuntimeScope, command: string, args: string[], cwd = "."): { processId: string; pid: number | undefined } {
    if (!fs.existsSync("/usr/bin/bwrap") && !fs.existsSync("/usr/local/bin/bwrap")) throw new Error("managed processes require bubblewrap; refusing to launch an unsandboxed child");
    const resolved = path.resolve(scope.workspaceRoot, cwd);
    if (resolved !== scope.workspaceRoot && !resolved.startsWith(`${scope.workspaceRoot}${path.sep}`)) throw new Error("process cwd must remain inside the workspace");
    const bwrap = fs.existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : "/usr/local/bin/bwrap";
    const child = spawn(bwrap, [...sandboxArgv(scope.workspaceRoot, resolved), "--", command, ...args],
      // NOT `process.env`. The server's environment holds every credential it
      // has — API keys, OAuth tokens, proxy settings — and a managed child is
      // arbitrary operator-authored code. `childEnv` passes what a build or a
      // dev server actually needs and nothing else.
      { cwd: resolved, env: childEnv(), stdio: "pipe", detached: false });
    const processId = newId("task");
    const managed: ManagedProcess = { id: processId, owner: `${scope.agentSessionId}:${scope.participant}`, child, chunks: [], seq: 0, exit: null, waiters: new Set() };
    this.#processes.set(processId, managed);
    const ingest = (stream: "stdout" | "stderr", data: Buffer) => {
      const text = data.toString("utf8"); managed.seq += 1; managed.chunks.push({ seq: managed.seq, stream, text });
      while (managed.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) > 262_144) managed.chunks.shift();
      this.bus.append({ type: "agent_session.process.output", userSessionId: scope.userSessionId, agentSessionId: scope.agentSessionId,
        payload: { agentSessionId: scope.agentSessionId, participant: scope.participant, processId, seq: managed.seq, stream, text: text.slice(0, 8_192) } });
      this.#wake(managed);
    };
    child.stdout.on("data", (data: Buffer) => ingest("stdout", data));
    child.stderr.on("data", (data: Buffer) => ingest("stderr", data));
    child.on("error", (error) => ingest("stderr", Buffer.from(error.message)));
    child.on("exit", (code, signal) => {
      managed.exit = { code, signal };
      this.bus.append({ type: "agent_session.process.exited", userSessionId: scope.userSessionId, agentSessionId: scope.agentSessionId,
        payload: { agentSessionId: scope.agentSessionId, participant: scope.participant, processId, code, signal } });
      this.#wake(managed);
    });
    this.bus.append({ type: "agent_session.process.started", userSessionId: scope.userSessionId, agentSessionId: scope.agentSessionId,
      payload: { agentSessionId: scope.agentSessionId, participant: scope.participant, processId, command, args, cwd: resolved, pid: child.pid } });
    return { processId, pid: child.pid };
  }

  async read(owner: string, processId: string, afterSeq = 0, waitMs = 0) {
    const process = this.#owned(owner, processId);
    if (waitMs > 0 && process.exit === null && !process.chunks.some((chunk) => chunk.seq > afterSeq)) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); process.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, Math.min(waitMs, 60_000)); process.waiters.add(done);
      });
    }
    return { chunks: process.chunks.filter((chunk) => chunk.seq > afterSeq), headSeq: process.seq, exit: process.exit };
  }

  stop(owner: string, processId: string): void { const process = this.#owned(owner, processId); if (process.exit === null) process.child.kill("SIGTERM"); }

  /**
   * Reap everything one seat still holds. A seat that forgets to clean up
   * survives its own lane: in db-live-2 `check` started `node serve.mjs` on
   * :8173, parked eleven minutes later, and the server outlived the run — so
   * the NEXT run found a foreign app on the port it wanted, spent six minutes
   * diagnosing it, and read files out of the previous run's workspace.
   *
   * Returns what it killed so the caller can say so out loud; a silent reap
   * just moves the mystery.
   */
  stopParticipant(agentSessionId: string, participant: string): { processId: string; pid: number | undefined }[] {
    const owner = `${agentSessionId}:${participant}`;
    const killed: { processId: string; pid: number | undefined }[] = [];
    for (const process of this.#processes.values()) {
      if (process.owner !== owner || process.exit !== null) continue;
      process.child.kill("SIGTERM");
      killed.push({ processId: process.id, pid: process.child.pid });
    }
    return killed;
  }

  stopSession(agentSessionId: string): void { for (const process of this.#processes.values()) if (process.owner.startsWith(`${agentSessionId}:`) && process.exit === null) process.child.kill("SIGTERM"); }
  closeAll(): void { for (const process of this.#processes.values()) if (process.exit === null) process.child.kill("SIGTERM"); }
  #owned(owner: string, id: string): ManagedProcess { const process = this.#processes.get(id); if (!process || process.owner !== owner) throw new Error(`no process ${id} owned by ${owner}`); return process; }
  #wake(process: ManagedProcess): void { for (const waiter of [...process.waiters]) waiter(); }
}
