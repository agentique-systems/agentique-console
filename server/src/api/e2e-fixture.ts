/**
 * The coding fixture the application-level tests share: a small CLI
 * repository whose completion check is a real subprocess, an implementer
 * Agent Definition committed in the repository, and the scripted provider
 * turns that carry a Run from the operator's goal to the final report. The
 * SDK fixture stands in for the model; git, SQLite, the blob store, the
 * worktrees, the integration, and the check are real.
 */
import fs from "node:fs";
import path from "node:path";
import { RETURN_RESULT_TOOL, runtimeToolNativeName } from "../provider/claude-adapter.ts";
import type { FakeSdkCapture, FakeSdkTurn } from "../provider/claude-sdk-test-support.ts";
import { gitSync } from "../workspace-state/git.ts";

export const OLD_CLI = ["const args = process.argv.slice(2);", 'console.log("hello");', ""].join("\n");
export const NEW_CLI = ["const args = process.argv.slice(2);", 'if (args[0] === "--version") {', "  console.log(require(" + "'../package.json').version);", "  process.exit(0);", "}", 'console.log("hello");', ""].join("\n");
/** The completion check: a real subprocess that runs the CLI and compares its output with the package version. */
export const TEST_JS = [
  'const { execFileSync } = require("node:child_process");',
  'const out = execFileSync(process.execPath, ["src/cli.js", "--version"]).toString().trim();',
  'const version = require("./package.json").version;',
  "if (out !== version) { console.error(`expected ${version}, got ${out}`); process.exit(1); }",
  'console.log("ok");',
  "",
].join("\n");
export const IMPLEMENTER = ["---", "name: implementer", "description: Implements one bounded change", "tools: Read, Grep, Glob, Edit, Write, Bash", "---", "Implement exactly the Task you are given, then return your result.", ""].join("\n");
export const CHECK = { command: "node test.js" };
export const FINAL = { finalReport: { summary: "The CLI reports its version.", completed: ["Added --version"], verification: ["node test.js passed"], risks: [], followUps: [] } };

/** A repository on `main` with the CLI, the check, and the implementer definition committed. */
export function initFixtureRepo(dir: string): string {
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture-cli", version: "1.2.3", private: true }, null, 2) + "\n");
  fs.writeFileSync(path.join(repo, "src", "cli.js"), OLD_CLI);
  fs.writeFileSync(path.join(repo, "test.js"), TEST_JS);
  fs.writeFileSync(path.join(repo, ".claude", "agents", "implementer.md"), IMPLEMENTER);
  gitSync(["init", "--quiet", "--initial-branch=main"], { cwd: repo });
  gitSync(["config", "core.autocrlf", "false"], { cwd: repo });
  gitSync(["add", "-A"], { cwd: repo });
  gitSync(["commit", "--quiet", "--no-verify", "-m", "fixture"], { cwd: repo, identity: true });
  return repo;
}

export const tool = (name: string): string => runtimeToolNativeName(name);
export const result = (summary: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ status: "completed", artifactIds: [], tasks: [], evidence: [], summary, openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null, ...extra });
export const returned = (summary: string, extra: Record<string, unknown> = {}) => ({ kind: "tool_use" as const, name: tool(RETURN_RESULT_TOOL), input: result(summary, extra) });

/** One `single` node over the implementer, bound to the given Tasks. */
export const planSource = (revisionId: string, taskIds: string[]) => ({
  version: 1,
  expressions: [{ pattern: "single", title: "Add --version", operation: { agentDefinitionRevisionId: revisionId, title: "Implement --version", input: { taskIds, decisionIds: [], artifactIds: [] } }, allocation: { costUsd: 2, tokens: 200_000, attempts: 3 } }],
});

/** The Orchestrator turn that authors the plan. */
export const planTurn = (revisionId: string, taskIds: string[]): FakeSdkTurn => ({ steps: [{ kind: "tool_use", name: tool("revise_execution_plan"), input: { source: planSource(revisionId, taskIds) } }, returned("Planned one implementer node.")] });

/** The Artifact id the last accepted `write_artifact` call returned, read from the runtime's own result text. */
export function lastArtifactId(calls: FakeSdkCapture["mcpCalls"]): string {
  const call = [...calls].reverse().find((c) => c.tool.endsWith("write_artifact") && !c.isError);
  const match = call === undefined ? null : /"artifactId":"([^"]+)"/.exec(call.text);
  if (match === null) throw new Error(`no accepted write_artifact call yet: ${JSON.stringify(calls.map((c) => [c.tool, c.isError, c.text.slice(0, 200)]))}`);
  return match[1]!;
}

const URL_EVIDENCE = { kind: "url", url: "https://example.invalid/fixture-cli/--version" };

/**
 * The Worker turn: writes the change in its worktree and, when bound to a
 * Task, writes the change note Artifact, records it as the Task's output and
 * the evidence through `update_task`, and completes the Task in its result.
 */
export const workerTurn = (taskId: string | null): FakeSdkTurn => ({
  steps: [
    { kind: "tool_use", name: "Write", input: { file_path: "src/cli.js", content: NEW_CLI }, effect: ({ cwd }) => fs.writeFileSync(path.join(cwd, "src", "cli.js"), NEW_CLI) },
    ...(taskId === null
      ? [returned("Added --version to src/cli.js.")]
      : [
          { kind: "tool_use" as const, name: tool("write_artifact"), input: { title: "Change note", mediaType: "text/plain", encoding: "utf8", content: "src/cli.js handles --version by printing the package version and exiting 0." } },
          { kind: "tool_use" as const, name: tool("update_task"), input: {}, inputFrom: (calls: FakeSdkCapture["mcpCalls"]) => ({ taskId, update: { kind: "add_outputs", artifactIds: [lastArtifactId(calls)] } }) },
          { kind: "tool_use" as const, name: tool("update_task"), input: { taskId, update: { kind: "add_evidence", evidence: [URL_EVIDENCE] } } },
          { kind: "tool_use" as const, name: tool(RETURN_RESULT_TOOL), input: {}, inputFrom: (calls: FakeSdkCapture["mcpCalls"]) => result("Added --version to src/cli.js.", { artifactIds: [lastArtifactId(calls)], tasks: [{ taskId, status: "completed", evidence: [URL_EVIDENCE], blocker: null }] }) },
        ]),
  ],
});

/** The Orchestrator's completion request on the node's result, then the final synthesis. */
export const completionTurns = (): FakeSdkTurn[] => [{ steps: [{ kind: "tool_use", name: tool("request_completion"), input: {} }, returned("The work is done; requesting completion.")] }, { steps: [returned("Final report.", FINAL)] }];
