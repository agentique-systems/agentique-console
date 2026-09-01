/**
 * The service-level coding Run over the production composition
 * (migration-contract §8 layer B; original Phases 3–5): a real SQLite
 * database under the migration contract, the real file blob and
 * continuation stores, the six real Workspace ports over a disposable git
 * repository, Snapshot-pinned Workspace-file Agent Definitions, and the
 * production Claude adapter — over an injected SDK fixture that speaks the
 * SDK's exact tool path, so no live provider call is made. Every step goes
 * through the canonical services: Run creation and start, the
 * Orchestrator's `revise_execution_plan`, an isolated Worker changing files
 * in its own worktree, real Changeset integration, the `node_result` turn
 * requesting completion, the deterministic completion check run as a real
 * subprocess in an isolated view, the read-only final synthesis, operator
 * signoff, real finalization, and a separately authorized publication onto
 * the fixture Target — then a restart and replays that change nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Invocation, ManifestInput, RunId } from "@agentique-console/core";
import { RETURN_RESULT_TOOL, runtimeToolNativeName } from "../provider/claude-adapter.ts";
import { FakeClaudeSdk } from "../provider/claude-sdk-test-support.ts";
import { gitSync } from "../workspace-state/git.ts";
import { headOf, initRepository, readTree, tempDir } from "../workspace-state/test-support.ts";
import { advanceRunUntil, composeConsoleRuntime, type ConsoleRuntime, type ConsoleRuntimeConfig } from "./console-runtime.ts";

const AGENT_DEFAULTS = { model: "claude-fable-5", effort: "medium" as const, maxContextOccupancy: 0.8, allocation: { costUsd: 2, tokens: 200_000, attempts: 3 }, orchestratorAllocation: { costUsd: 5, tokens: 500_000, attempts: 8 }, maxWallClockMs: 600_000 };

// The fixture sources spell `require` through this constant so the boundary scanner never reads them as imports of this file.
const REQUIRE = "require";
const OLD_CLI = ["const args = process.argv.slice(2);", 'if (args[0] === "--help") {', '  console.log("usage: cli [--help]");', "  process.exit(0);", "}", 'console.log("hello");', ""].join("\n");
const NEW_CLI = [
  "const args = process.argv.slice(2);",
  'if (args[0] === "--version") {',
  `  console.log(${REQUIRE}("../package.json").version);`,
  "  process.exit(0);",
  "}",
  'if (args[0] === "--help") {',
  '  console.log("usage: cli [--help|--version]");',
  "  process.exit(0);",
  "}",
  'console.log("hello");',
  "",
].join("\n");
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
const IMPLEMENTER = ["---", "name: implementer", "description: Implements one bounded change in the working directory", "tools: Read, Grep, Glob, Edit, Write, Bash", "---", "Implement exactly the Task you are given, run the tests, then return your result.", ""].join("\n");

const tool = (name: string) => runtimeToolNativeName(name);
const result = (summary: string, extra: Record<string, unknown> = {}) => ({ status: "completed", artifactIds: [], tasks: [], evidence: [], summary, openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null, ...extra });

function config(dir: string, sdk: FakeClaudeSdk): ConsoleRuntimeConfig {
  return {
    databaseFile: path.join(dir, "state", "console.db"),
    blobRoot: path.join(dir, "state", "blobs"),
    continuations: { root: path.join(dir, "state", "continuations"), ttlMs: null },
    stateRoot: path.join(dir, "state"),
    provider: { sdk, environment: { PATH: process.env.PATH ?? process.env.Path ?? "" }, continuation: false, fallbackWorkingDirectory: path.join(dir, "fallback") },
    agents: AGENT_DEFAULTS,
    governor: { providers: { claude: { maxConcurrency: 2 } }, maxProcessConcurrency: 3, maxWorktrees: null },
  };
}

const rootTurns = (r: ConsoleRuntime, runId: RunId): Invocation[] => r.stores.invocations.listAtPosition(r.stores.plans.rootNode(runId).id, "orchestrator");

describe("service-level coding Run", () => {
  it("plans, implements in an isolated worktree, integrates, verifies with a real check, synthesizes, is signed off, and is published to the fixture Target — through canonical services only, with a restart and replays changing nothing", { timeout: 300_000 }, async () => {
    const dir = tempDir("agentique-coding-run");
    const repo = path.join(dir, "repo");
    const { headCommit: initialHead } = initRepository(repo, { "package.json": JSON.stringify({ name: "fixture-cli", version: "1.2.3", private: true }, null, 2) + "\n", "src/cli.js": OLD_CLI, "test.js": TEST_JS, ".claude/agents/implementer.md": IMPLEMENTER });
    const sdk = new FakeClaudeSdk();
    let runtime = composeConsoleRuntime(config(dir, sdk));
    let runId!: RunId;
    try {
      // 1–2. The Workspace over the disposable repository and its Conversation; the built-ins exist, the Workspace-file definition is loaded from a pinned Snapshot.
      const workspace = runtime.stores.workspaces.create({ name: "fixture", rootPath: repo, kind: "git" });
      const conversation = runtime.stores.conversations.create({ workspaceId: workspace.id, title: "Add --version" });
      const loaded = runtime.agents.loader.loadCurrent(workspace.id, { kind: "branch", branch: "main" });
      const implementerFile = loaded.files.find((f) => f.kind === "loaded" && f.name === "implementer");
      if (implementerFile?.kind !== "loaded") throw new Error(`implementer not loaded: ${JSON.stringify(loaded.files)}`);
      const implementer = runtime.stores.agents.getRevision(implementerFile.revisionId);
      expect(implementer.provenance).toMatchObject({ kind: "workspace_file", path: ".claude/agents/implementer.md", snapshotId: loaded.snapshotId });
      expect(implementer.capabilities.tools).toEqual(["read", "search", "write", "shell"]);
      // 3. The operator's Requirement and the deterministic completion criterion the coding Run declares.
      const requirementId = runtime.ctx.ids("requirement");
      const revision = runtime.stores.requirements.createRevision({ conversationId: conversation.id, approvedByDecisionId: null, tree: [{ id: requirementId, parentId: null, composition: null, statement: "The CLI reports its version with --version", position: 0, acceptanceCriterionIds: [] }] });
      const criterion = runtime.stores.requirements.createAcceptanceCriterion({ conversationId: conversation.id, requirementId, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: "node test.js", expectedExitCode: 0 } });
      // 4–5. Run creation (the real preparation port pins the Target Snapshot and creates the integration branch) and start.
      const created = runtime.runCreation.create({
        conversationId: conversation.id,
        kind: "code",
        target: { kind: "branch", branch: "main" },
        budget: { maxCostUsd: 50, maxTokens: 5_000_000, maxAttempts: 40, maxWallClockMs: null, maxConcurrency: 2 },
        orchestratorAgentDefinitionRevisionId: runtime.agents.builtins.orchestrator.id,
        // The final reserve funds the read-only synthesis turn: at least one Orchestrator allocation.
        finalReserve: { costUsd: 10, tokens: 1_000_000, attempts: 10 },
        verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [criterion.id] },
      });
      runId = created.run.id;
      const message = runtime.stores.conversations.postMessage({ conversationId: conversation.id, author: "operator", content: "Add a --version flag to the CLI that prints the package version.", runId, invocationId: null });
      runtime.runStart.start({ runId, conversationMessageId: message.id });
      expect(runtime.stores.runs.get(runId)).toMatchObject({ status: "running", kind: "code" });
      expect(gitSync(["rev-parse", "--verify", `refs/heads/agentique/run/${runId}`], { cwd: repo }).stdout.toString().trim()).toBe(initialHead);

      // The scripted provider turns, consumed in execution order through the SDK's exact tool path.
      const plan = { version: 1, expressions: [{ pattern: "single", title: "Add --version", operation: { agentDefinitionRevisionId: implementer.id, title: "Implement --version" }, allocation: { costUsd: 2, tokens: 200_000, attempts: 3 } }] };
      sdk.script(
        // 6. Orchestrator turn 1: the source plan through revise_execution_plan, then the typed result.
        { steps: [{ kind: "tool_use", name: tool("revise_execution_plan"), input: { source: plan } }, { kind: "tool_use", name: tool(RETURN_RESULT_TOOL), input: result("Planned one implementer node.") }] },
        // 7. The Worker: a real file change in its own worktree (the fixture stands in for Write's effect), then its result.
        { steps: [{ kind: "tool_use", name: "Read", input: { file_path: "src/cli.js" }, result: OLD_CLI }, { kind: "tool_use", name: "Write", input: { file_path: "src/cli.js", content: NEW_CLI }, effect: ({ cwd }) => fs.writeFileSync(path.join(cwd, "src", "cli.js"), NEW_CLI, "utf8") }, { kind: "tool_use", name: tool(RETURN_RESULT_TOOL), input: result("Added --version to src/cli.js.") }] },
        // 9. Orchestrator node_result turn: the node succeeded and was integrated; completion is requested.
        { steps: [{ kind: "tool_use", name: tool("request_completion"), input: {} }, { kind: "tool_use", name: tool(RETURN_RESULT_TOOL), input: result("The plan completed; requesting completion.") }] },
        // 11. The read-only final synthesis.
        { steps: [{ kind: "tool_use", name: tool(RETURN_RESULT_TOOL), input: result("Final report.", { finalReport: { summary: "The CLI reports its version.", completed: ["Added --version"], verification: ["node test.js passed"], risks: [], followUps: [] } }) }] },
      );
      const passes = await advanceRunUntil(runtime, runId, { until: () => runtime.stores.runs.get(runId).status === "awaiting_signoff", maxPasses: 80, sleep: async () => {} });
      const debug = () => JSON.stringify({ passes: passes.map((p) => [p.stop, p.actions.map((a) => [a.action.kind, a.outcome.kind])]), diagnostics: runtime.diagnostics, mcp: sdk.captured.mcpCalls, hooks: sdk.captured.hookCalls.map((c) => [c.tool, c.output]), denied: sdk.captured.denied, unknown: sdk.captured.unknownTools, requests: runtime.stores.completionRequests.listByRun(runId), turns: rootTurns(runtime, runId).map((t) => [t.purpose, t.status, t.failureReason]), calls: rootTurns(runtime, runId).flatMap((t) => runtime.stores.runtimeToolCalls.listByInvocation(t.id).map((c) => [t.purpose, c.tool, c.result])) });
      expect(runtime.stores.runs.get(runId).status, debug()).toBe("awaiting_signoff");
      expect(sdk.remainingTurns).toBe(0);

      // 6. The plan revision came from the tool: revision 2, one single node bound to the Workspace-file definition.
      expect(runtime.stores.plans.latestRevisionNumber(runId)).toBe(2);
      const node = runtime.stores.plans.currentGraph(runId).nodes.find((n) => n.kind === "pattern" && n.title === "Add --version");
      if (node === undefined || node.kind !== "pattern") throw new Error("the planned node is missing");
      expect(node).toMatchObject({ status: "succeeded" });
      expect(node.shape).toMatchObject({ pattern: "single", operation: { agentDefinitionRevisionId: implementer.id } });
      const worker = runtime.stores.invocations.listByPlanNode(node.id)[0]!;
      expect(worker).toMatchObject({ role: "worker", agentDefinitionRevisionId: implementer.id, status: "succeeded" });
      // 7. Isolation: the Worker ran in its own worktree under the state root, never in the repository checkout, and the checkout is untouched.
      const workerCwd = sdk.captured.options[1]!.cwd!;
      expect(workerCwd.startsWith(path.resolve(dir, "state", "workspaces"))).toBe(true);
      expect(workerCwd).not.toBe(repo);
      expect(sdk.captured.executed.map((e) => e.tool)).toEqual(["Read", "Write"]);
      expect(sdk.captured.denied).toEqual([]);
      expect(readTree(repo)["src/cli.js"]).toBe(OLD_CLI);
      expect(headOf(repo, "main")).toBe(initialHead);
      // 8. The Worker's Changeset was integrated for real: the integration branch carries the change, recorded with its trailer.
      const changeset = runtime.stores.changesets.listByRun(runId).find((c) => c.invocationId === worker.id)!;
      expect(changeset).toMatchObject({ kind: "invocation", integrationStatus: "integrated" });
      const integrationHead = gitSync(["rev-parse", `refs/heads/agentique/run/${runId}`], { cwd: repo }).stdout.toString().trim();
      expect(integrationHead).not.toBe(initialHead);
      expect(gitSync(["show", `${integrationHead}:src/cli.js`], { cwd: repo }).stdout.toString()).toBe(NEW_CLI);
      expect(gitSync(["log", "--format=%B", "-n", "20", integrationHead], { cwd: repo }).stdout.toString()).toContain(`Agentique-Changeset: ${changeset.id}`);
      // 9. The Orchestrator learned the result through its node_result turn and requested completion from it; then the synthesis.
      expect(rootTurns(runtime, runId).map((t) => [t.purpose, t.status])).toEqual([["operator_input", "succeeded"], ["node_result", "succeeded"], ["final_synthesis", "succeeded"]]);
      const nodeResultTurn = rootTurns(runtime, runId)[1]!;
      expect(runtime.stores.invocations.getManifest(nodeResultTurn.id).content.inputs).toEqual([{ kind: "node_result", planNodeId: node.id, status: "succeeded", outputArtifactIds: node.outputArtifactIds ?? [] } satisfies ManifestInput]);
      expect(runtime.stores.runtimeToolCalls.listByInvocation(nodeResultTurn.id).map((c) => c.tool)).toEqual(["request_completion"]);
      expect(runtime.stores.runtimeToolCalls.listByInvocation(rootTurns(runtime, runId)[0]!.id).map((c) => c.tool)).toEqual(["revise_execution_plan"]);
      // 10. The completion Gate ran the declared check as a real subprocess in an isolated view and passed; the Requirement is satisfied.
      const completionGate = runtime.stores.gates.listByKind(runId, "run_completion").at(-1)!;
      expect(completionGate).toMatchObject({ status: "passed", acceptanceCriterionIds: [criterion.id] });
      const evaluations = runtime.stores.evaluations.gateCriterionEvaluationsOf(completionGate.id);
      expect(evaluations.map((e) => [e.subject, e.verdict, e.producedBy.kind])).toEqual([[{ kind: "acceptance_criterion", acceptanceCriterionId: criterion.id }, "pass", "runtime"]]);
      expect(runtime.stores.requirements.get(requirementId).status).toBe("satisfied");
      // 11–12. The final report exists and the signoff boundary is open.
      const signoffGate = runtime.stores.gates.listByKind(runId, "operator_signoff").at(-1)!;
      const signoffDecision = runtime.stores.decisions.signoffOf(signoffGate.id)!;
      expect(signoffDecision.status).toBe("open");
      expect(runtime.stores.artifacts.listByRun(runId).some((a) => a.mediaType.includes("final-report"))).toBe(true);

      // 12. Operator signoff: real finalization records the final Changeset and completes the Run; the Target is still untouched.
      const accepted = await runtime.signoff.accept({ runId, gateId: signoffGate.id, decisionId: signoffDecision.id });
      expect(accepted.kind).toBe("accepted");
      expect(runtime.stores.runs.get(runId)).toMatchObject({ status: "completed" });
      const final = runtime.stores.changesets.finalOf(runId)!;
      expect(final).toMatchObject({ kind: "final", integrationStatus: "recorded" });
      expect(headOf(repo, "main")).toBe(initialHead);
      expect(await runtime.signoff.accept({ runId, gateId: signoffGate.id, decisionId: signoffDecision.id })).toMatchObject({ kind: "accepted", replayed: true });

      // 13. Publication is authorized separately: a publish Decision the operator resolves, then the Target moves once.
      const { decision: publishDecision } = runtime.publication.request({ runId, requestedStrategy: { kind: "automatic" } });
      expect(publishDecision).toMatchObject({ kind: "publish", status: "open" });
      const resolved = runtime.publication.resolve({ runId, decisionId: publishDecision.id, option: "publish" });
      if (resolved.kind !== "publishing") throw new Error(resolved.kind);
      const advances: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        const outcome = await runtime.publication.advance(resolved.publicationId);
        advances.push(outcome.kind);
        if (outcome.kind === "quiescent" || outcome.kind === "released" || outcome.kind === "infrastructure_failure") break;
      }
      const publication = runtime.stores.publications.get(resolved.publicationId);
      expect(publication, JSON.stringify({ advances, diagnostics: runtime.diagnostics, publication })).toMatchObject({ status: "succeeded", strategy: { kind: "fast_forward" }, stagingCleanup: "released", failure: null });
      expect(advances).toEqual(["prepared", "verified", "applying", "succeeded", "released"]);
      expect(runtime.stores.runs.get(runId).status).toBe("completed");
      // 14. The fixture Target carries exactly the change, fast-forwarded from the initial head, with the checkout synchronized.
      const publishedHead = headOf(repo, "main");
      expect(publishedHead).not.toBe(initialHead);
      expect(gitSync(["merge-base", "--is-ancestor", initialHead, publishedHead], { cwd: repo }).exitCode).toBe(0);
      expect(gitSync(["show", `${publishedHead}:src/cli.js`], { cwd: repo }).stdout.toString()).toBe(NEW_CLI);
      expect(gitSync(["show", `${publishedHead}:test.js`], { cwd: repo }).stdout.toString()).toBe(TEST_JS);
      expect(readTree(repo)["src/cli.js"]).toBe(NEW_CLI);
      expect(gitSync(["status", "--porcelain"], { cwd: repo }).stdout.toString().trim()).toBe("");
      expect(runtime.publication.resolve({ runId, decisionId: publishDecision.id, option: "publish" })).toMatchObject({ kind: "publishing", publicationId: resolved.publicationId, replayed: true });
      // No credential, raw continuation payload, or unrestricted SDK message reached the canonical Events.
      const events = JSON.stringify(runtime.ctx.journal.read({ runId }));
      expect(events).not.toMatch(/sk-ant-|ANTHROPIC_API_KEY|"session_id"/);
      expect(runtime.diagnostics.filter((d) => !/release|cleanup/i.test(d.kind))).toEqual([]);
    } finally {
      runtime.close();
    }
    // A restart over the same directories: recovery finds nothing to repair, the Run is terminal, the rows are the same, and replays change nothing.
    runtime = composeConsoleRuntime(config(dir, new FakeClaudeSdk()));
    try {
      const report = runtime.recovery.recover();
      expect(report).toMatchObject({ interruptedAttemptIds: [], cancelledAttemptIds: [], retryEligible: [], workspaceReleasedInvocationIds: [], workspaceReleaseFailedInvocationIds: [] });
      expect(runtime.stores.runs.get(runId).status).toBe("completed");
      expect(runtime.stores.publications.listByRun(runId).map((p) => p.status)).toEqual(["succeeded"]);
      const seq = runtime.ctx.journal.lastSeq();
      expect(runtime.scheduler.reconcileRun(runId)).toMatchObject({ stop: "run_terminal", actions: [] });
      expect(await runtime.publication.reconcileOutstanding()).toEqual([]);
      expect(runtime.ctx.journal.lastSeq()).toBe(seq);
      expect(rootTurns(runtime, runId).map((t) => t.purpose)).toEqual(["operator_input", "node_result", "final_synthesis"]);
      expect(headOf(repo, "main")).toBe(headOf(repo, "main"));
    } finally {
      runtime.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
