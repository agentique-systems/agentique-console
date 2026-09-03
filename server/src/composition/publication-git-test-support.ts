/**
 * Real-git publication fixtures over the production composition: a
 * disposable fixture repository, the runtime composed over a directory
 * (SQLite file, file blob and continuation stores, the six real Workspace
 * ports, the SDK fixture), and one completed Run whose Snapshots, final
 * Changeset, and Integration Workspace are real git state produced through
 * the real preparation, execution, integration, and finalization ports —
 * the completion and signoff rows the completion engine and the signoff
 * service would leave are written through the persistence fixtures over
 * those real identities. Nothing here reads a transcript or runtime memory;
 * every process of a test opens the same directory the way a restarted
 * server would.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANGESET_DIFF_MEDIA_TYPE, type RunId, type SnapshotIdentity, type WorkspaceId } from "@agentique-console/core";
import type { ExecutionWorkspaceRequest } from "../execution/ports/execution-workspace.ts";
import { seedSignoffBoundary, type Harness, type Seeded } from "../persistence/test-support.ts";
import { FakeClaudeSdk } from "../provider/claude-sdk-test-support.ts";
import { gitSync, text } from "../workspace-state/git.ts";
import { contentSource, writeFiles } from "../workspace-state/test-support.ts";
import { composeConsoleRuntime, type ConsoleRuntime, type ConsoleRuntimeConfig } from "./console-runtime.ts";

export const CHECK_COMMAND = "node -e process.exit(0)";

const AGENT_DEFAULTS = { model: "claude-fable-5", effort: "medium" as const, maxContextOccupancy: 0.8, allocation: { costUsd: 2, tokens: 200_000, attempts: 3 }, orchestratorAllocation: { costUsd: 5, tokens: 500_000, attempts: 8 }, maxWallClockMs: 600_000 };

export function worldConfig(dir: string): ConsoleRuntimeConfig {
  return {
    databaseFile: path.join(dir, "state", "console.db"),
    blobRoot: path.join(dir, "state", "blobs"),
    continuations: { root: path.join(dir, "state", "continuations"), ttlMs: null },
    stateRoot: path.join(dir, "state"),
    provider: { sdk: new FakeClaudeSdk(), environment: { PATH: process.env.PATH ?? process.env.Path ?? "" }, continuation: false, fallbackWorkingDirectory: path.join(dir, "fallback") },
    agents: AGENT_DEFAULTS,
    governor: { providers: { claude: { maxConcurrency: 2 } }, maxProcessConcurrency: 3, maxWorktrees: null },
  };
}

/** One process over the world's directory. */
export function openWorld(dir: string): ConsoleRuntime {
  return composeConsoleRuntime(worldConfig(dir));
}

export function newWorldDirectory(prefix = "agentique-publication-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeWorldDirectory(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** The fixture repository under `dir`: `files` committed on `main`; returns the initial head commit. */
export function initFixtureRepository(dir: string, files: Record<string, string> = { "README.md": "# Fixture\n", "src/app.js": "v1\n" }): { repo: string; initialHead: string } {
  const repo = path.join(dir, "repo");
  gitSync(["init", "--quiet", "--initial-branch=main", repo], { cwd: dir });
  gitSync(["config", "core.autocrlf", "false"], { cwd: repo });
  writeFiles(repo, files);
  gitSync(["add", "-A", "--", "."], { cwd: repo });
  gitSync(["commit", "--quiet", "--no-verify", "-m", "fixture"], { cwd: repo, identity: true });
  return { repo, initialHead: text(gitSync(["rev-parse", "HEAD"], { cwd: repo })) };
}

export function headOf(repo: string, ref = "HEAD"): string {
  return text(gitSync(["rev-parse", "--verify", ref], { cwd: repo }));
}

export function refExists(repo: string, ref: string): boolean {
  return gitSync(["rev-parse", "--verify", "-q", ref], { cwd: repo, allowFailure: true }).exitCode === 0;
}

export function commitAll(repo: string, message: string): string {
  gitSync(["add", "-A", "--", "."], { cwd: repo });
  gitSync(["commit", "--quiet", "--allow-empty", "--no-verify", "-m", message], { cwd: repo, identity: true });
  return headOf(repo);
}

/** The porcelain status lines, untrimmed (both status columns are significant), sorted; empty for a clean checkout. */
export function statusOf(repo: string): string[] {
  return gitSync(["status", "--porcelain", "--untracked-files=all"], { cwd: repo })
    .stdout.toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .sort();
}

export interface CompletedFixtureRun {
  runId: RunId;
  workspaceId: WorkspaceId;
  base: SnapshotIdentity;
  final: SnapshotIdentity;
  integrationWorkspacePath: string;
}

/**
 * A `completed` Run over the fixture repository: the Workspace and
 * Conversation, an operator Requirement with one deterministic completion
 * criterion, Run creation through the real preparation port (the base
 * Snapshot and the integration branch), one Worker's change collected from
 * a real worktree and integrated through the real integration port, the
 * exact base-to-final diff observed through the real finalization port,
 * and the completion and signoff rows over those real identities.
 */
export async function completeRunOverRepository(runtime: ConsoleRuntime, repo: string, files: Record<string, string | null> = { "src/app.js": "v2\n", "docs/notes.md": "notes\n" }): Promise<CompletedFixtureRun> {
  const { stores } = runtime;
  const h = { ctx: runtime.ctx, stores } as unknown as Harness;
  const workspace = stores.workspaces.create({ name: "fixture", rootPath: repo, kind: "git" });
  const conversation = stores.conversations.create({ workspaceId: workspace.id, title: "publication fixture" });
  const requirementId = runtime.ctx.ids("requirement");
  const revision = stores.requirements.createRevision({ conversationId: conversation.id, approvedByDecisionId: null, tree: [{ id: requirementId, parentId: null, composition: null, statement: "The fixture change is published", position: 0, acceptanceCriterionIds: [] }] });
  const criterion = stores.requirements.createAcceptanceCriterion({ conversationId: conversation.id, requirementId, requirementRevisionId: revision.id, taskId: null, check: { kind: "deterministic", command: CHECK_COMMAND, expectedExitCode: 0 } });
  const created = runtime.runCreation.create({
    conversationId: conversation.id,
    kind: "code",
    target: { kind: "branch", branch: "main" },
    budget: { maxCostUsd: 50, maxTokens: 5_000_000, maxAttempts: 40, maxWallClockMs: null, maxConcurrency: 2 },
    orchestratorAgentDefinitionRevisionId: runtime.agents.builtins.orchestrator.id,
    finalReserve: { costUsd: 10, tokens: 1_000_000, attempts: 10 },
    verificationPolicy: { evaluatorAgentDefinitionRevisionId: null, runCompletionAcceptanceCriterionIds: [criterion.id] },
  });
  const runId = created.run.id;
  let run = stores.runs.transition(runId, { to: "running" });
  const root = stores.plans.transitionNode(created.root.id, { to: "ready" });
  const integrationWorkspacePath = run.integrationWorkspacePath!;
  const base = created.baseSnapshot.identity;
  // A Worker's change in its own worktree, collected and integrated for real.
  const request: ExecutionWorkspaceRequest = { runId, invocationId: runtime.ctx.ids("invocation"), role: "worker", writes: true, integrationWorkspacePath, integrationSnapshot: base };
  const prepared = runtime.workspace.execution.prepare(request);
  writeFiles(prepared.worktreePath!, files);
  const collected = (await runtime.workspace.execution.collectChangeset(request, prepared))!;
  const integrated = await runtime.workspace.integration.apply({ runId, changesetId: runtime.ctx.ids("changeset"), integrationWorkspacePath, currentSnapshot: base, changeset: { beforeSnapshot: prepared.startingSnapshot!, afterSnapshot: collected.afterSnapshot, diff: contentSource(collected.diff) } });
  if (integrated.kind !== "integrated") throw new Error(`integration ${integrated.kind}`);
  runtime.workspace.execution.release(request, prepared);
  const integrationSnapshot = stores.snapshots.record({ workspaceId: workspace.id, runId, identity: integrated.snapshot, reason: "integration" });
  run = stores.runs.recordWorkspaceState(runId, { integrationSnapshotId: integrationSnapshot.id });
  const inspected = await runtime.workspace.finalization.inspect({ runId, workspaceId: workspace.id, integrationWorkspacePath, baseSnapshot: base, verifiedSnapshot: integrated.snapshot });
  if (inspected.kind !== "inspected") throw new Error(`finalization ${inspected.failure}`);
  // The completion and signoff rows over the real Snapshots, then acceptance with the exact final diff as the Run's final Changeset.
  const seeded: Seeded = { workspace, conversation, run, definition: runtime.agents.builtins.orchestrator, evaluator: runtime.agents.builtins.reviewer, root };
  const boundary = seedSignoffBoundary(h, seeded);
  runtime.ctx.tx.write(() => {
    const artifact = stores.artifacts.create({ runId, mediaType: CHANGESET_DIFF_MEDIA_TYPE, producer: { kind: "runtime", component: "changeset" }, taskId: null, title: `final changeset of ${runId}` }, inspected.diff);
    const changeset = stores.changesets.recordFinal({ runId, beforeSnapshotId: boundary.baseSnapshotId, afterSnapshotId: boundary.verifiedSnapshotId, diffArtifactId: artifact.id });
    stores.signoffResolutions.record({ runId, gateId: boundary.gate.id, decisionId: boundary.decision.id, outcome: "accept", finalChangesetId: changeset.id });
    stores.decisions.resolve(boundary.decision.id, { resolvedBy: "operator", chosenOptionId: "accept", rationale: null, artifactIds: [] });
    stores.gates.close(boundary.gate.id, "passed", null);
    stores.runs.transition(runId, { to: "completed", finalSnapshotId: boundary.verifiedSnapshotId, finalChangesetId: changeset.id });
  });
  return { runId, workspaceId: workspace.id, base, final: integrated.snapshot, integrationWorkspacePath };
}

/** Everything a repeated publication operation could duplicate, from rows alone. */
export function publicationRows(runtime: ConsoleRuntime, runId: RunId) {
  const run = runtime.stores.runs.get(runId);
  const publications = runtime.stores.publications.listByRun(runId);
  return {
    run: run.status,
    publications: publications.map((p) => [p.status, p.strategy?.kind ?? null, p.failure?.kind ?? null, p.stagingCleanup, p.targetAfterSnapshotId !== null]),
    reports: runtime.stores.artifacts.listByRun(runId).filter((a) => a.mediaType.includes("publication-report")).length,
    publishSnapshots: runtime.stores.snapshots.listByRun(runId).filter((s) => s.reason === "publish_before" || s.reason === "publish_candidate").length,
    events: runtime.ctx.journal
      .read({ runId })
      .map((e) => e.type)
      .filter((t) => t.startsWith("publication.") || t === "run.published" || t === "run.publish_failed"),
  };
}

/** The parsed publication report of a terminal Publication. */
export function reportOf(runtime: ConsoleRuntime, publicationId: string): Record<string, unknown> {
  const publication = runtime.stores.publications.get(publicationId as never);
  const { bytes } = runtime.stores.artifacts.read(publication.reportArtifactId!);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}
