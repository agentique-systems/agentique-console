import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { AdapterAttempt, AdapterTool } from "./attempt-session.ts";

/** File tools are restricted to the assigned worktree, including symlink resolution. */
export async function workspacePath(root: string, input: string, writing = false): Promise<string> {
  const base = await fs.realpath(root);
  const target = path.resolve(base, input);
  let resolved: string;
  try { resolved = await fs.realpath(target); }
  catch (error) {
    if (!writing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Resolve the closest existing parent before allowing creation of nested directories.
    let parent = path.dirname(target);
    const suffix = [path.basename(target)];
    for (;;) {
      try { resolved = path.join(await fs.realpath(parent), ...suffix.reverse()); break; }
      catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT" || parent === path.dirname(parent)) throw parentError;
        suffix.push(path.basename(parent)); parent = path.dirname(parent);
      }
    }
  }
  const relative = path.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Path is outside the Attempt working directory");
  if (relative.split(path.sep).some((p) => [".git", ".codex", ".claude", ".agentique"].includes(p))) throw new Error("Provider and repository control directories are not tool targets");
  return resolved;
}

/** A bounded, cancellable process. Cancellation terminates descendants before resolving. */
export function runToolProcess(command: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; truncated: boolean }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    let size = 0;
    let truncated = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    timer.unref();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const clean = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
    for (const stream of ["stdout", "stderr"] as const) child[stream].on("data", (data: Buffer) => {
      const remaining = Math.max(0, maxBytes - size);
      chunks[stream].push(data.subarray(0, remaining));
      size += Math.min(remaining, data.length);
      if (data.length > remaining) { truncated = true; stop(); }
    });
    child.on("error", (error) => { clean(); reject(error); });
    child.on("close", (exitCode) => {
      clean();
      if (signal.aborted) { reject(signal.reason); return; }
      resolve({ stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8"), exitCode, truncated: truncated || stopped });
    });
  });
}

export function addLocalTools(attempt: AdapterAttempt, fallbackDirectory: string): void {
  const cwd = attempt.request.workingDirectory ?? fallbackDirectory;
  const tools: Record<string, AdapterTool> = {
    read: {
      capability: "read", description: "Read a UTF-8 file range or list a directory within the assigned working directory. Offsets and lengths are bytes.",
      schema: z.strictObject({ path: z.string().min(1), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(65_536).default(32_768) }),
      execute: async (value) => {
        const input = value as { path: string; offset: number; length: number };
        const target = await workspacePath(cwd, input.path);
        const stat = await fs.stat(target);
        if (stat.isDirectory()) {
          const entries: string[] = [];
          for await (const entry of await fs.opendir(target)) {
            if (entries.length === 500) return { entries, truncated: true };
            entries.push(entry.name);
          }
          return { entries, truncated: false };
        }
        if (!stat.isFile()) throw new Error("Only regular files can be read");
        const handle = await fs.open(target, "r");
        try {
          const buffer = Buffer.alloc(input.length);
          const { bytesRead } = await handle.read(buffer, 0, input.length, input.offset);
          return { text: buffer.subarray(0, bytesRead).toString("utf8"), totalBytes: stat.size, nextOffset: input.offset + bytesRead };
        } finally { await handle.close(); }
      },
    },
    search: {
      capability: "search", description: "Search file contents using a literal string within the working directory. Results and runtime are bounded.",
      schema: z.strictObject({ pattern: z.string().min(1).max(2000), path: z.string().default(".") }),
      execute: async (value) => {
        const input = value as { pattern: string; path: string };
        const target = await workspacePath(cwd, input.path);
        return runToolProcess("rg", ["--line-number", "--fixed-strings", "--max-count", "100", "--glob", "!.git/**", "--", input.pattern, target], cwd, attempt.signal, attempt.limits.toolTimeoutMs, 65_536);
      },
    },
    write: {
      capability: "write", description: "Write a UTF-8 file in the assigned worktree. Supply expectedContent to make an exact guarded replacement of an existing file.",
      schema: z.strictObject({ path: z.string().min(1), content: z.string().max(131_072), expectedContent: z.string().max(131_072).optional() }),
      execute: async (value) => {
        const input = value as { path: string; content: string; expectedContent?: string };
        const target = await workspacePath(cwd, input.path, true);
        if (input.expectedContent !== undefined && await fs.readFile(target, "utf8") !== input.expectedContent) throw new Error("File contents changed; read the file again before writing");
        await fs.mkdir(path.dirname(target), { recursive: true });
        attempt.signal.throwIfAborted();
        await fs.writeFile(target, input.content, { signal: attempt.signal });
        return { written: true, bytes: Buffer.byteLength(input.content) };
      },
    },
    shell: {
      capability: "shell", description: "Execute one synchronous shell command in the assigned working directory. No background jobs. Output and duration are bounded.",
      schema: z.strictObject({ command: z.string().min(1).max(16_384) }),
      execute: async (value) => {
        const input = value as { command: string };
        return process.platform === "win32"
          ? runToolProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", input.command], cwd, attempt.signal, attempt.limits.toolTimeoutMs, 65_536)
          : runToolProcess("/bin/sh", ["-c", input.command], cwd, attempt.signal, attempt.limits.toolTimeoutMs, 65_536);
      },
    },
    web: {
      capability: "web", description: "Fetch an HTTP(S) URL as bounded text. Use configured MCP tools for web search.",
      schema: z.strictObject({ url: z.url().refine((v) => /^https?:\/\//.test(v)) }),
      execute: async (value) => {
        const { url } = value as { url: string };
        const response = await fetch(url, { signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(attempt.limits.toolTimeoutMs)]), redirect: "error" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader) return { text: "" };
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            chunks.push(next.value.subarray(0, Math.max(0, 65_536 - bytes)));
            bytes += next.value.length;
            if (bytes >= 65_536) break;
          }
        } finally { await reader.cancel(); }
        return { text: Buffer.concat(chunks).toString("utf8"), truncated: bytes >= 65_536 };
      },
    },
  };
  for (const capability of attempt.request.capabilities.tools) {
    if (capability.startsWith("mcp__")) continue;
    const tool = tools[capability];
    if (!tool) throw new Error(`invalid request: unsupported capability ${capability}`);
    if (attempt.request.toolPolicy[capability] !== "denied") attempt.add(capability, tool);
  }
}
