/**
 * The low-level git mechanics every Workspace provider shares (migration-
 * contract rule 7: extracted from the retired worktree manager where it
 * depended on nothing legacy). Every invocation is `execFile` with a
 * runtime-built argument list — no shell — under a fixed identity, a
 * timeout, bounded output, and an environment stripped of anything that
 * would redirect git to another repository. Nothing here knows about Runs,
 * Snapshots, or ports; it is a command wrapper.
 */
import { execFile, execFileSync } from "node:child_process";

export const GIT_TIMEOUT_MS = 120_000;
/** Output bound for commands whose output is a patch or listing. */
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** Every commit the runtime makes carries this identity, so machines without a git identity work and the author is never an operator. */
export const GIT_IDENTITY_ARGS: readonly string[] = ["-c", "user.name=Agentique Console", "-c", "user.email=console@agentique.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

/** Inherited variables that would point git at another repository, index, or object store than the one named by `cwd`. */
const REDIRECTING_VARIABLES: readonly string[] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"];

export function gitEnvironment(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || REDIRECTING_VARIABLES.includes(key)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  return { ...env, ...extra };
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly cwd: string,
  ) {
    super(`git ${args[0] ?? ""} failed${exitCode === null ? "" : ` (exit ${exitCode})`}: ${stderr.trim().split(/\r?\n/)[0] ?? ""}`);
    this.name = "GitError";
  }
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export interface GitOptions {
  cwd: string;
  /** Bytes written to the command's stdin. */
  input?: Uint8Array;
  timeoutMs?: number;
  /** Return a non-zero exit as a result instead of throwing. */
  allowFailure?: boolean;
  env?: Record<string, string>;
  /** Prepend the runtime identity (for commands that create commits). */
  identity?: boolean;
}

function argsOf(args: readonly string[], options: GitOptions): string[] {
  return options.identity ? [...GIT_IDENTITY_ARGS, ...args] : [...args];
}

/** Runs git synchronously; used only where a port contract requires a synchronous step (preparation inside a transaction). */
export function gitSync(args: readonly string[], options: GitOptions): GitResult {
  const argv = argsOf(args, options);
  try {
    const stdout = execFileSync("git", argv, { cwd: options.cwd, env: gitEnvironment(options.env), timeout: options.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"], input: options.input, windowsHide: true });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const failure = error as { status?: number | null; stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = failure.stderr === undefined ? (failure.message ?? String(error)) : failure.stderr.toString();
    const exitCode = typeof failure.status === "number" ? failure.status : null;
    if (options.allowFailure && exitCode !== null) return { stdout: failure.stdout === undefined ? Buffer.alloc(0) : Buffer.from(failure.stdout), stderr, exitCode };
    throw new GitError(argv, exitCode, stderr, options.cwd);
  }
}

/** Runs git asynchronously; every port step outside a transaction uses this. */
export function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const argv = argsOf(args, options);
  return new Promise<GitResult>((resolve, reject) => {
    const child = execFile("git", argv, { cwd: options.cwd, env: gitEnvironment(options.env), timeout: options.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "buffer", windowsHide: true }, (error, stdout, stderr) => {
      const err = stderr.toString();
      if (error === null) {
        resolve({ stdout, stderr: err, exitCode: 0 });
        return;
      }
      const exitCode = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code as number) : null;
      if (options.allowFailure && exitCode !== null) {
        resolve({ stdout, stderr: err, exitCode });
        return;
      }
      reject(new GitError(argv, exitCode, err === "" ? error.message : err, options.cwd));
    });
    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(options.input));
    } else child.stdin?.end();
  });
}

export function text(result: GitResult): string {
  return result.stdout.toString("utf8").trim();
}

/** The first bounded line of a git failure, for a conflict report or an error message; never a patch. */
export function boundedStderr(stderr: string, maxBytes = 16_384): string {
  const cleaned = stderr.replace(/\r/g, "").trim();
  const bytes = Buffer.from(cleaned, "utf8");
  return bytes.byteLength <= maxBytes ? cleaned : `${bytes.subarray(0, maxBytes - 1).toString("utf8")}…`;
}

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function isObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}
