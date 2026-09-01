/**
 * The runnable verification of the real coding path (migration-contract §8
 * layer C): the same fourteen steps the deterministic end-to-end test walks,
 * over the production composition and — by default — the real Claude Agent
 * SDK, against a disposable fixture repository created under the temporary
 * directory. It uses whatever credentials the Claude Code installation
 * already holds, never prints them, never changes login or billing state,
 * and publishes only to the fixture Target it created. Every step is
 * recorded as it completes; the report is printed as JSON and the process
 * exits non-zero when any step did not complete.
 *
 *   npm run verify:coding-run --workspace server
 *
 * Optional: `AGENTIQUE_LIVE_MODEL` (the model; a small one by default),
 * `AGENTIQUE_VERIFY_KEEP=1` (keep the temporary directory for inspection).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Invocation, ModelEffort, RunId } from "@agentique-console/core";
import type { ClaudeSdk } from "../provider/claude-sdk.ts";
import { gitSync } from "../workspace-state/git.ts";
import { advanceRunUntil, composeConsoleRuntime, type ConsoleRuntime } from "./console-runtime.ts";

export const VERIFICATION_STEPS = [
  "workspace_and_conversation",
  "agent_definitions_loaded",
  "requirement_and_criterion",
  "run_created",
  "run_started",
  "plan_revised_by_tool",
  "worker_changed_isolated_worktree",
  "changeset_integrated",
  "node_result_turn_requested_completion",
  "completion_check_passed",
  "final_synthesis",
  "operator_signoff_accepted",
  "publication_authorized",
  "target_published",
] as const;
export type VerificationStep = (typeof VERIFICATION_STEPS)[number];

export interface CodingRunVerificationOptions {
  sdk: ClaudeSdk;
  model: string;
  effort: ModelEffort;
  /** Where the fixture repository and the console state live; a fresh temporary directory by default. */
  directory?: string;
  /** Keep the directory after the verification (for inspection). */
  keep?: boolean;
  /** A bound on scheduler passes. */
  maxPasses?: number;
  log?: (line: string) => void;
}

export interface CodingRunVerificationReport {
  ok: boolean;
  directory: string;
  runId: RunId | null;
  completed: VerificationStep[];
  failedAt: VerificationStep | null;
  error: string | null;
  /** Bounded facts of the Run: root turn purposes, the Worker's tool executions the SDK reported, cost, and the Target commits. */
  facts: Record<string, unknown>;
}

// The fixture sources spell `require` through this constant so the boundary scanner never reads them as imports of this file.
const REQUIRE = "require";
const OLD_CLI = ["const args = process.argv.slice(2);", 'if (args[0] === "--help") {', '  console.log("usage: cli [--help]");', "  process.exit(0);", "}", 'console.log("hello");', ""].join("\n");
const TEST_JS = [
  `const { execFileSync } = ${REQUIRE}("node:child_process");`,
  `const path = ${REQUIRE}("node:path");`,
  `const { version } = ${REQUIRE}("./package.json");`,
  'const out = execFileSync(process.execPath, [path.join(__dirname, "src", "cli.js"), "--version"], { encoding: "utf8" }).trim();',
  "if (out !== version) {",
  "  console.error(`expected ${version}, got ${JSON.stringify(out)}`);",
  "  process.exit(1);",
  "}",
  'console.log("ok");',
  "",
].join("\n");
const IMPLEMENTER = [
  "---",
  "name: implementer",
  "description: Implements one bounded change in the working directory",
  "tools: Read, Grep, Glob, Edit, Write, Bash",
  "---",
  "You implement exactly the Task or plan step you are given, inside the working directory only.",
  "Read the relevant files first, make the smallest correct change, run `node test.js` with Bash to check it, and then return your result exactly once.",
  "",
].join("\n");

const rootTurns = (r: ConsoleRuntime, runId: RunId): Invocation[] => r.stores.invocations.listAtPosition(r.stores.plans.rootNode(runId).id, "orchestrator");

function initFixture(repo: string): string {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture-cli", version: "1.2.3", private: true }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "cli.js"), OLD_CLI, "utf8");
  fs.writeFileSync(path.join(repo, "test.js"), TEST_JS, "utf8");
  fs.writeFileSync(path.join(repo, ".claude", "agents", "implementer.md"), IMPLEMENTER, "utf8");
  gitSync(["init", "--quiet", "--initial-branch=main"], { cwd: repo });
  gitSync(["add", "-A"], { cwd: repo });
  gitSync(["commit", "--quiet", "--no-verify", "-m", "fixture"], { cwd: repo, identity: true });
  return gitSync(["rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
}

/** Runs the fourteen-step coding Run and reports what completed; throws nothing — every failure is in the report. */
export async function verifyCodingRun(options: CodingRunVerificationOptions): Promise<CodingRunVerificationReport> {
  const log = options.log ?? (() => {});
  const directory = options.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "agentique-verify-"));
  const repo = path.join(directory, "repo");
  const completed: VerificationStep[] = [];
  const facts: Record<string, unknown> = {};
  let runId: RunId | null = null;
  let runtime: ConsoleRuntime | null = null;
  let step: VerificationStep = VERIFICATION_STEPS[0];
  const done = (s: VerificationStep) => {
    completed.push(s);
    log(`done: ${s}`);
  };
  try {
    const initialHead = initFixture(repo);
    runtime = composeConsoleRuntime({
      databaseFile: path.join(directory, "state", "console.db"),
      blobRoot: path.join(directory, "state", "blobs"),
      continuations: { root: path.join(directory, "state", "continuations"), ttlMs: null },
      stateRoot: path.join(directory, "state"),
      provider: { sdk: options.sdk, continuation: true, limits: { maxTurns: 60 }, fallbackWorkingDirectory: path.join(directory, "fallback") },
      agents: { model: options.model, effort: options.effort, maxContextOccupancy: 0.8, allocation: { costUsd: 3, tokens: 600_000, attempts: 3 }, orchestratorAllocation: { costUsd: 6, tokens: 1_500_000, attempts: 6 }, maxWallClockMs: 900_000 },
      governor: { providers: { claude: { maxConcurrency: 2 } }, maxProcessConcurrency: 3, maxWorktrees: null },
      output: (chunk) => log(`[${chunk.attemptId}] ${chunk.kind}: ${chunk.text.slice(0, 200)}`),
    });
    const { stores } = runtime;
    step = "workspace_and_conversation";
    const workspace = stores.workspaces.create({ name: "verify-fixture", rootPath: repo, kind: "git" });
    const conversation = stores.conversations.create({ workspaceId: workspace.id, title: "Add --version" });
    done(step);
    step = "agent_definitions_loaded";
    const loaded = runtime.agents.loader.loadCurrent(workspace.id, { kind: "branch", branch: "main" });
    const implementerFile = loaded.files.find((f) => f.kind === "loaded" && f.name === "implementer");
    if (implementerFile?.kind !== "loaded") throw new Error(`the implementer definition was not loaded: ${JSON.stringify(loaded.files)}`);
    facts.implementerRevisionId = implementerFile.revisionId;
    done(step);
    step = "requirement_and_criterion";
    const requirementId = runtime.ctx.ids("requirement");
    const revision = stores.requirements.createRevision({ conversationId: conversation.id, approvedByDecisionId: null, tree: [{ id: requirementId, parentId: null, composition: null, statement: "The CLI prints the package version when invoked with --version", position: 0, acceptanceCriterionIds: [] }] });
    const criterion = stores.requirements.createAcceptanceCriterion({ conversationId: conversation.id, requirementId, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "node test.js", expectedExitCode: 0 } });
    done(step);
    step = "run_created";
    const created = runtime.runCreation.create({
      conversationId: conversation.id,
      kind: "code",
      target: { kind: "branch", branch: "main" },
      budget: { maxCostUsd: 40, maxTokens: 8_000_000, maxAttempts: 40, maxWallClockMs: null, maxConcurrency: 2 },
      orchestratorAgentDefinitionRevisionId: runtime.agents.builtins.orchestrator.id,
      // The final reserve funds the read-only synthesis turn: at least one Orchestrator allocation.
      finalReserve: { costUsd: 8, tokens: 2_000_000, attempts: 8 },
      verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [criterion.id] },
    });
    runId = created.run.id;
    done(step);
    step = "run_started";
    const message = stores.conversations.postMessage({
      conversationId: conversation.id,
      author: "operator",
      content: [
        "Add a `--version` flag to the CLI in src/cli.js that prints the version from package.json and exits 0.",
        `Plan exactly one single node that runs the Workspace Agent Definition revision ${implementerFile.revisionId} (the implementer) with an allocation of 3 USD, 600000 tokens, 3 attempts: call revise_execution_plan once with { version: 1, expressions: [{ pattern: "single", title: "Add --version", operation: { agentDefinitionRevisionId: "${implementerFile.revisionId}", title: "Implement --version" }, allocation: { costUsd: 3, tokens: 600000, attempts: 3 } }] }, then return your result at once. Create no Tasks.`,
        "When the node's result arrives in your next turn and it succeeded, call request_completion and return; the completion check is `node test.js`.",
      ].join("\n"),
      runId,
      invocationId: null,
    });
    runtime.runStart.start({ runId, conversationMessageId: message.id });
    done(step);

    const settled = await advanceRunUntil(runtime, runId, {
      until: () => {
        const status = stores.runs.get(runId!).status;
        return status === "awaiting_signoff" || status === "failed" || status === "cancelled";
      },
      maxPasses: options.maxPasses ?? 120,
      onPass: (pass) => log(`pass: ${pass.stop} ${pass.actions.map((a) => `${a.action.kind}:${a.outcome.kind}`).join(" ")}`),
    });
    facts.passes = settled.length;
    facts.rootTurns = rootTurns(runtime, runId).map((t) => [t.purpose, t.status]);
    facts.runtimeToolCalls = rootTurns(runtime, runId).flatMap((t) => stores.runtimeToolCalls.listByInvocation(t.id).map((c) => `${t.purpose}:${c.tool}`));
    const run = stores.runs.get(runId);
    facts.runStatus = run.status;
    facts.runFailure = run.failure;
    step = "plan_revised_by_tool";
    if (stores.plans.latestRevisionNumber(runId) < 2) throw new Error(`the Orchestrator revised no plan: ${JSON.stringify(facts)}`);
    const graph = stores.plans.currentGraph(runId);
    const node = graph.nodes.find((n) => n.kind === "pattern" && n.sourcePath !== "root");
    if (node === undefined) throw new Error("the plan has no executable node");
    done(step);
    step = "worker_changed_isolated_worktree";
    const worker = stores.invocations.listByPlanNode(node.id).find((i) => i.status === "succeeded");
    if (worker === undefined) throw new Error(`no Worker Invocation succeeded: ${JSON.stringify(stores.invocations.listByPlanNode(node.id).map((i) => [i.role, i.status, i.failureReason]))}`);
    if (fs.readFileSync(path.join(repo, "src", "cli.js"), "utf8") !== OLD_CLI) throw new Error("the repository checkout was modified during execution");
    done(step);
    step = "changeset_integrated";
    const changeset = stores.changesets.listByRun(runId).find((c) => c.invocationId === worker.id);
    if (changeset === undefined || changeset.integrationStatus !== "integrated") throw new Error(`the Worker's Changeset is ${changeset?.integrationStatus ?? "missing"}`);
    const integrationHead = gitSync(["rev-parse", `refs/heads/agentique/run/${runId}`], { cwd: repo }).stdout.toString().trim();
    if (integrationHead === initialHead) throw new Error("the integration branch did not move");
    facts.integrationHead = integrationHead;
    done(step);
    step = "node_result_turn_requested_completion";
    const resultTurn = rootTurns(runtime, runId).find((t) => t.purpose === "node_result");
    if (resultTurn === undefined) throw new Error("no node_result turn was created");
    if (!stores.runtimeToolCalls.listByInvocation(resultTurn.id).some((c) => c.tool === "request_completion") && stores.completionRequests.listByRun(runId).length === 0) throw new Error("completion was never requested");
    done(step);
    step = "completion_check_passed";
    const completionGate = stores.gates.listByKind(runId, "run_completion").at(-1);
    if (completionGate?.status !== "passed") throw new Error(`the run_completion Gate is ${completionGate?.status ?? "absent"}: ${JSON.stringify(completionGate?.failure ?? null)}`);
    facts.completionEvaluations = stores.evaluations.gateCriterionEvaluationsOf(completionGate.id).map((e) => [e.verdict, e.producedBy.kind]);
    done(step);
    step = "final_synthesis";
    if (run.status !== "awaiting_signoff") throw new Error(`the Run is ${run.status}`);
    done(step);
    step = "operator_signoff_accepted";
    const signoffGate = stores.gates.listByKind(runId, "operator_signoff").at(-1)!;
    const signoffDecision = stores.decisions.signoffOf(signoffGate.id)!;
    const accepted = await runtime.signoff.accept({ runId, gateId: signoffGate.id, decisionId: signoffDecision.id });
    if (accepted.kind !== "accepted" || stores.runs.get(runId).status !== "completed") throw new Error(`signoff did not complete the Run: ${JSON.stringify(accepted)}`);
    done(step);
    step = "publication_authorized";
    const { decision } = runtime.publication.request({ runId, requestedStrategy: { kind: "automatic" } });
    const resolved = runtime.publication.resolve({ runId, decisionId: decision.id, option: "publish" });
    if (resolved.kind !== "publishing") throw new Error(`the publish Decision resolved to ${resolved.kind}`);
    done(step);
    step = "target_published";
    for (let i = 0; i < 12; i += 1) {
      const outcome = await runtime.publication.advance(resolved.publicationId);
      if (outcome.kind === "quiescent" || outcome.kind === "released" || outcome.kind === "infrastructure_failure") break;
    }
    const publication = stores.publications.get(resolved.publicationId);
    if (publication.status !== "succeeded") throw new Error(`the Publication is ${publication.status}: ${JSON.stringify(publication.failure)} ${JSON.stringify(runtime.diagnostics)}`);
    const publishedHead = gitSync(["rev-parse", "main"], { cwd: repo }).stdout.toString().trim();
    if (publishedHead === initialHead) throw new Error("the Target branch did not move");
    facts.initialHead = initialHead;
    facts.publishedHead = publishedHead;
    facts.publishedCli = gitSync(["show", `${publishedHead}:src/cli.js`], { cwd: repo }).stdout.toString();
    done(step);
    facts.costUsd = stores.usage.totalsForRun(runId).costUsd;
    return { ok: true, directory, runId, completed, failedAt: null, error: null, facts };
  } catch (error) {
    return { ok: false, directory, runId, completed, failedAt: step, error: error instanceof Error ? error.message : String(error), facts };
  } finally {
    runtime?.close();
    if (options.keep !== true) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function main(): Promise<void> {
  const { CLAUDE_AGENT_SDK } = await import("../provider/claude-sdk-binding.ts");
  const report = await verifyCodingRun({
    sdk: CLAUDE_AGENT_SDK,
    model: process.env.AGENTIQUE_LIVE_MODEL ?? "claude-haiku-4-5-20251001",
    effort: "low",
    keep: process.env.AGENTIQUE_VERIFY_KEEP === "1",
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
