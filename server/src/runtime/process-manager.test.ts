/**
 * What a managed child can see, and what it must not.
 *
 * The previous argv was `--ro-bind / /` with `env: process.env`, which handed
 * every `process_start` child read access to the whole filesystem — `~/.ssh`,
 * `~/.claude`, every other workspace on the machine — plus every credential the
 * server holds. Nothing about running a dev server needs any of that.
 *
 * The last two cases run a REAL bubblewrap child, because an argv that
 * typechecks and cannot execute is worse than the hole it closed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { ArtifactStore } from "../events/artifact-store.ts";
import { EventBus } from "../events/bus.ts";
import { ProcessManager, childEnv, sandboxArgv } from "./process-manager.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const hasBwrap = fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/usr/local/bin/bwrap");

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-proc-"));
  dirs.push(dir);
  return fs.realpathSync(dir);
}

describe("sandbox argv", () => {
  it("never binds the whole filesystem", () => {
    const argv = sandboxArgv("/w", "/w");
    for (let i = 0; i < argv.length - 2; i += 1) {
      if (argv[i] === "--ro-bind" || argv[i] === "--ro-bind-try") {
        expect(argv[i + 1]).not.toBe("/");
      }
    }
  });

  it("binds the workspace read-write and gives the child its own /tmp", () => {
    const argv = sandboxArgv("/w", "/w/sub");
    expect(argv).toEqual(expect.arrayContaining(["--bind", "/w", "/w"]));
    expect(argv).toEqual(expect.arrayContaining(["--tmpfs", "/tmp"]));
    expect(argv).toEqual(expect.arrayContaining(["--chdir", "/w/sub"]));
    expect(argv).toContain("--die-with-parent");
  });
});

describe("child environment", () => {
  it("passes what a build needs", () => {
    const env = childEnv({ PATH: "/usr/bin", HOME: "/home/me", HTTPS_PROXY: "http://proxy:8080", NODE_OPTIONS: "--max-old-space-size=4096" });
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/me", HTTPS_PROXY: "http://proxy:8080", NODE_OPTIONS: "--max-old-space-size=4096" });
  });

  it("withholds every credential the server holds", () => {
    const env = childEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-test",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      AWS_SECRET_ACCESS_KEY: "secret",
      GITHUB_TOKEN: "ghp_x",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("passes the port block the seat is allowed to bind", () => {
    expect(childEnv({ PATH: "/usr/bin", CONSOLE_PORT_BASE: "8300" }).CONSOLE_PORT_BASE).toBe("8300");
  });
});

describe.skipIf(!hasBwrap)("a real sandboxed child", () => {
  const run = async (command: string, args: string[]) => {
    const { db } = openDb(":memory:");
    const manager = new ProcessManager(new EventBus(db, new ArtifactStore(db)));
    const root = workspace();
    fs.writeFileSync(path.join(root, "hello.txt"), "in the workspace");
    const { processId } = manager.start(
      { workspaceRoot: root, userSessionId: "us_1", agentSessionId: "as_1", agent: "dev" },
      command, args,
    );
    // `read` only waits when there is no NEW output, so poll on a real timer
    // rather than relying on its waitMs.
    for (let i = 0; i < 100; i += 1) {
      const state = await manager.read("as_1:dev", processId, 0, 0);
      if (state.exit !== null) return { ...state, root };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("child did not exit");
  };

  it("still executes, and can read its own workspace", async () => {
    // The point of the narrowing is containment, not breakage: if a plain
    // `cat` cannot run, the change is not shippable.
    const state = await run("cat", ["hello.txt"]);
    expect(state.exit?.code).toBe(0);
    expect(state.chunks.map((chunk) => chunk.text).join("")).toContain("in the workspace");
  });

  it("cannot see the operator's home directory", async () => {
    const state = await run("ls", [path.join(os.homedir(), ".ssh")]);
    expect(state.exit?.code).not.toBe(0);
    expect(state.chunks.map((chunk) => chunk.text).join("")).toMatch(/No such file or directory/);
  });

  it("cannot see the console's own config", async () => {
    const state = await run("ls", [path.join(os.homedir(), ".claude")]);
    expect(state.exit?.code).not.toBe(0);
  });
});
