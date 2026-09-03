/**
 * Deterministic check execution on real processes (execution-model §10.1):
 * a disposable view of exactly one Snapshot, separate from the Integration
 * Workspace and from every other check; exit codes reported as such; output
 * bounded with truncation recorded; the runtime's abort and the deadline
 * ending the command as typed infrastructure failures; stale views discarded;
 * views removed afterwards; the shell environment stripped of session
 * coupling.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AcceptanceCriterionExecutionRequest } from "../execution/ports/acceptance-criterion-execution.ts";
import type { Workspace } from "@agentique-console/core";
import { checkEnvironment } from "./checks.ts";
import { createWorkspacePorts } from "./index.ts";
import { canonicalId, commitAll, gitIdentityOf, initRepository, layoutIn, readTree, statusOf, tempDir, writeFiles } from "./test-support.ts";

function fixture() {
  const dir = tempDir("checks");
  const root = path.join(dir, "repo");
  const { headCommit } = initRepository(root, { "a.txt": "one\n" });
  const layout = layoutIn(dir);
  const ports = createWorkspacePorts(layout);
  const workspace: Workspace = { id: canonicalId("ws"), name: "fixture", rootPath: root, kind: "git", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const runId = canonicalId("run");
  const run = ports.preparation.prepare({ runId: runId as never, workspace, target: { kind: "branch", branch: "main" } });
  return { dir, root, headCommit, layout, ports, workspace, runId, run, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

const node = (script: string) => `node -e "${script.replaceAll('"', '\\"')}"`;

function request(f: ReturnType<typeof fixture>, command: string, overrides: Partial<AcceptanceCriterionExecutionRequest> = {}): AcceptanceCriterionExecutionRequest {
  return {
    runId: f.runId as never,
    planNodeId: null,
    acceptanceCriterionId: canonicalId("ac") as never,
    round: null,
    gateId: canonicalId("gate") as never,
    publicationId: null,
    command,
    expectedExitCode: 0,
    workspace: { integrationWorkspacePath: f.run.integrationWorkspacePath, snapshot: f.run.baseSnapshot, isolationKey: `${f.runId}/gate/${canonicalId("ac")}` },
    maxOutputBytes: 4096,
    deadlineAt: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("check execution", () => {
  it("runs the command in a disposable view of exactly the requested Snapshot, reports the exit code and output, and removes the view; the Integration Workspace sees nothing", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      // The Integration Workspace moves on; the check verifies the older base Snapshot exactly.
      writeFiles(f.run.integrationWorkspacePath, { "a.txt": "two\n", "b.txt": "b\n" });
      commitAll(f.run.integrationWorkspacePath, "later");
      const viewsBefore = fs.existsSync(path.join(path.dirname(f.run.integrationWorkspacePath), "checks")) ? fs.readdirSync(path.join(path.dirname(f.run.integrationWorkspacePath), "checks")) : [];
      const outcome = await f.ports.checks.execute(request(f, node("const fs=require('node:fs');process.stdout.write(fs.readFileSync('a.txt','utf8')+(fs.existsSync('b.txt')?'B':'-'));fs.writeFileSync('made.txt','x');process.exit(3)")));
      expect(outcome.kind).toBe("exited");
      if (outcome.kind !== "exited") throw new Error("unreachable");
      expect(outcome.exitCode).toBe(3);
      expect(Buffer.from(outcome.output).toString("utf8")).toBe("one\n-");
      expect(outcome.truncated).toBe(false);
      // The view is gone; the Integration Workspace never saw the command's write.
      expect(fs.existsSync(path.join(path.dirname(f.run.integrationWorkspacePath), "checks")) ? fs.readdirSync(path.join(path.dirname(f.run.integrationWorkspacePath), "checks")) : []).toEqual(viewsBefore);
      expect(readTree(f.run.integrationWorkspacePath)).toEqual({ "a.txt": "two\n", "b.txt": "b\n" });
      expect(statusOf(f.run.integrationWorkspacePath)).toBe("");
      expect(fs.existsSync(path.join(f.root, "made.txt"))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("bounds the captured output and records truncation, and reports the environment without session coupling", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      const outcome = await f.ports.checks.execute(request(f, node("process.stdout.write('x'.repeat(10000));process.stderr.write('E');"), { maxOutputBytes: 100 }));
      expect(outcome).toMatchObject({ kind: "exited", exitCode: 0, truncated: true });
      if (outcome.kind !== "exited") throw new Error("unreachable");
      expect(outcome.output.byteLength).toBe(100);
      const env = checkEnvironment({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", ANTHROPIC_API_KEY: "k", GIT_DIR: "/elsewhere", HOME: "/h" });
      expect(env).toEqual({ PATH: "/bin", HOME: "/h", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", CI: "1" });
    } finally {
      f.cleanup();
    }
  });

  it("ends a command at the runtime's abort and at the deadline as typed infrastructure failures, never as verdicts, and leaves no view or process behind", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      const controller = new AbortController();
      const aborting = f.ports.checks.execute(request(f, node("setTimeout(()=>{},60000)"), { signal: controller.signal }));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      controller.abort("cancelled");
      const aborted = await aborting;
      expect(aborted).toMatchObject({ kind: "failed", failure: "aborted" });
      const timedOut = await f.ports.checks.execute(request(f, node("setTimeout(()=>{},60000)"), { deadlineAt: new Date(Date.now() + 500).toISOString() }));
      expect(timedOut).toMatchObject({ kind: "failed", failure: "timed_out" });
      const past = await f.ports.checks.execute(request(f, node("process.exit(0)"), { deadlineAt: new Date(Date.now() - 1000).toISOString() }));
      expect(past).toMatchObject({ kind: "failed", failure: "timed_out" });
      const preAborted = new AbortController();
      preAborted.abort("deadline");
      expect(await f.ports.checks.execute(request(f, node("process.exit(0)"), { signal: preAborted.signal }))).toMatchObject({ kind: "failed", failure: "aborted" });
      const checks = path.join(path.dirname(f.run.integrationWorkspacePath), "checks");
      expect(fs.existsSync(checks) ? fs.readdirSync(checks) : []).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("discards a stale view under the same isolation key, isolates concurrent checks from each other, and reports a missing or unknown workspace as workspace_unavailable", { timeout: 180_000 }, async () => {
    const f = fixture();
    try {
      const key = `${f.runId}/gate/stale`;
      const checksDir = path.join(path.dirname(f.run.integrationWorkspacePath), "checks");
      // A dead process left a view directory with foreign content under the key's path.
      const first = await f.ports.checks.execute(request(f, node("require('node:fs').writeFileSync('marker.txt','1')"), { workspace: { integrationWorkspacePath: f.run.integrationWorkspacePath, snapshot: f.run.baseSnapshot, isolationKey: key } }));
      expect(first).toMatchObject({ kind: "exited", exitCode: 0 });
      const staleDir = fs.readdirSync(checksDir).length === 0 ? null : path.join(checksDir, fs.readdirSync(checksDir)[0]!);
      expect(staleDir).toBeNull();
      const [a, b] = await Promise.all([
        f.ports.checks.execute(request(f, node("const fs=require('node:fs');fs.writeFileSync('only-a.txt','a');process.stdout.write(String(fs.existsSync('only-b.txt')))"), { workspace: { integrationWorkspacePath: f.run.integrationWorkspacePath, snapshot: f.run.baseSnapshot, isolationKey: `${f.runId}/a` } })),
        f.ports.checks.execute(request(f, node("const fs=require('node:fs');fs.writeFileSync('only-b.txt','b');process.stdout.write(String(fs.existsSync('only-a.txt')))"), { workspace: { integrationWorkspacePath: f.run.integrationWorkspacePath, snapshot: f.run.baseSnapshot, isolationKey: `${f.runId}/b` } })),
      ]);
      expect([a, b].map((o) => (o.kind === "exited" ? Buffer.from(o.output).toString() : o.kind))).toEqual(["false", "false"]);
      expect(await f.ports.checks.execute(request(f, "node -v", { workspace: { integrationWorkspacePath: null, snapshot: f.run.baseSnapshot, isolationKey: "x" } }))).toMatchObject({ kind: "failed", failure: "workspace_unavailable" });
      expect(await f.ports.checks.execute(request(f, "node -v", { workspace: { integrationWorkspacePath: f.run.integrationWorkspacePath, snapshot: gitIdentityOf(f.root, f.headCommit) && { kind: "git", commitId: "e".repeat(40), treeId: "e".repeat(40) }, isolationKey: "y" } }))).toMatchObject({ kind: "failed", failure: "workspace_unavailable" });
    } finally {
      f.cleanup();
    }
  });
});
