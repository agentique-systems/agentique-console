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
export class ProcessManager {
  readonly #processes = new Map<string, ManagedProcess>();
  constructor(readonly bus: EventBus) {}

  start(scope: RuntimeScope, command: string, args: string[], cwd = "."): { processId: string; pid: number | undefined } {
    if (!fs.existsSync("/usr/bin/bwrap") && !fs.existsSync("/usr/local/bin/bwrap")) throw new Error("managed processes require bubblewrap; refusing to launch an unsandboxed child");
    const resolved = path.resolve(scope.workspaceRoot, cwd);
    if (resolved !== scope.workspaceRoot && !resolved.startsWith(`${scope.workspaceRoot}${path.sep}`)) throw new Error("process cwd must remain inside the workspace");
    const bwrap = fs.existsSync("/usr/bin/bwrap") ? "/usr/bin/bwrap" : "/usr/local/bin/bwrap";
    const child = spawn(bwrap, ["--die-with-parent", "--unshare-all", "--share-net", "--ro-bind", "/", "/", "--bind", scope.workspaceRoot, scope.workspaceRoot, "--proc", "/proc", "--dev", "/dev", "--chdir", resolved, "--", command, ...args],
      { cwd: resolved, env: process.env, stdio: "pipe", detached: false });
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
  stopSession(agentSessionId: string): void { for (const process of this.#processes.values()) if (process.owner.startsWith(`${agentSessionId}:`) && process.exit === null) process.child.kill("SIGTERM"); }
  closeAll(): void { for (const process of this.#processes.values()) if (process.exit === null) process.child.kill("SIGTERM"); }
  #owned(owner: string, id: string): ManagedProcess { const process = this.#processes.get(id); if (!process || process.owner !== owner) throw new Error(`no process ${id} owned by ${owner}`); return process; }
  #wake(process: ManagedProcess): void { for (const waiter of [...process.waiters]) waiter(); }
}
