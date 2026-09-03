/**
 * The operator's Run launch over the real composition, through the public
 * API (execution-model §3, §8.1, §14): one root transaction and one
 * compensation boundary — a refusal because another Run is active (the
 * database's one-active-Run rule), a validation refusal, a failed Workspace
 * preparation, a failed Event, and a failed COMMIT each leave Requirements,
 * criteria, messages, Events, and Workspace state exactly as they were;
 * a deferred start (`start: false`) records the complete goal as the Run's
 * first operator message and delivers exactly it once, after a restart and
 * across lines; a replacement message is delivered instead; repeated and
 * concurrent starts follow the start contract without an extra message or
 * Invocation; and a second Run in the same Conversation appends its goal
 * while every kept Requirement keeps the Acceptance Criteria it holds at the
 * current revision. Nothing here seeds a row directly.
 *
 * §15 invariants exercised here: 2, 3, 5, 12.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody, ConversationMessage, InvocationResponse, Page, RequirementsResponse, RunOverview, Workspace } from "@agentique-console/core";
import { CompletionFacts } from "../execution/completion-requests.ts";
import { FakeClaudeSdk } from "../provider/claude-sdk-test-support.ts";
import { gitSync } from "../workspace-state/git.ts";
import { CHECK, initFixtureRepo, returned } from "../api/e2e-fixture.ts";
import { newAppDirectory, openTestApp, removeAppDirectory, type TestApp } from "../api/test-support.ts";

interface World {
  t: TestApp;
  dir: string;
  repo: string;
  workspace: Workspace;
  conversationId: string;
}

async function openWorld(dir = newAppDirectory("agentique-launch-"), sdk = new FakeClaudeSdk()): Promise<World> {
  const t = await openTestApp({ dir, sdk });
  const repo = fs.existsSync(path.join(dir, "repo")) ? path.join(dir, "repo") : initFixtureRepo(dir);
  const workspaces = await t.call<Page<{ workspace: Workspace }>>("listWorkspaces");
  let workspace = workspaces.body.items.find((w) => w.workspace.rootPath === repo)?.workspace ?? null;
  if (workspace === null) {
    const created = await t.call<{ workspace: Workspace }>("createWorkspace", { body: { rootPath: repo } });
    expect(created.status).toBe(201);
    workspace = created.body.workspace;
  }
  const conversations = await t.call<Page<{ conversation: { id: string } }>>("listWorkspaceConversations", { params: { workspaceId: workspace.id } });
  let conversationId = conversations.body.items[0]?.conversation.id ?? null;
  if (conversationId === null) {
    const conversation = await t.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId: workspace.id, title: "launch" } });
    expect(conversation.status).toBe(201);
    conversationId = conversation.body.conversation.id;
  }
  return { t, dir, repo, workspace, conversationId };
}

/** Everything a launch could leave behind, from the public reads and the Workspace state on disk. */
async function footprint(w: World) {
  const requirements = await w.t.call<RequirementsResponse>("listConversationRequirements", { params: { conversationId: w.conversationId } });
  const messages = await w.t.call<Page<ConversationMessage>>("listConversationMessages", { params: { conversationId: w.conversationId }, query: { limit: 200 } });
  const runs = await w.t.call<Page<{ id: string }>>("listConversationRuns", { params: { conversationId: w.conversationId } });
  const conversation = await w.t.call<{ conversation: { activeRunId: string | null } }>("getConversation", { params: { conversationId: w.conversationId } });
  const stateRoot = path.join(w.t.config.stateRoot, "workspaces");
  const runDirs = fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot, { recursive: true }).map(String).filter((p) => /[\\/]runs[\\/][^\\/]+$/.test(p)).sort() : [];
  const listed = gitSync(["worktree", "list", "--porcelain"], { cwd: w.repo, allowFailure: true });
  const worktrees = listed.exitCode === 0 ? listed.stdout.toString().split("\n").filter((line) => line.startsWith("worktree ")).length : 0;
  return { lastSeq: w.t.app.events.lastSeq(), revision: requirements.body.revision?.id ?? null, requirements: requirements.body.requirements.map((r) => [r.requirement.id, r.criteria.map((c) => c.id)]), messages: messages.body.items.map((m) => [m.id, m.runId, m.content]), runs: runs.body.items.map((r) => r.id), activeRunId: conversation.body.conversation.activeRunId, runDirs, worktrees };
}

const create = (w: World, body: Record<string, unknown>) => w.t.call<RunOverview & ApiErrorBody>("createRun", { params: { conversationId: w.conversationId }, body: { goal: "Add --version.", completionCheck: CHECK, ...body } });
const start = (w: World, runId: string, body: Record<string, unknown> = {}) => w.t.call<RunOverview & ApiErrorBody>("startRun", { params: { runId }, body });

/** The inputs the Run's first Orchestrator Invocation received, from its immutable manifest. */
async function firstTurnInputs(w: World, runId: string) {
  const invocations = await w.t.call<Page<{ id: string; role: string; createdAt: string }>>("listRunInvocations", { params: { runId } });
  const roots = invocations.body.items.filter((i) => i.role === "orchestrator").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const first = roots[0];
  if (first === undefined) return { invocations: 0, inputs: [] as { kind: string; content?: string }[] };
  const detail = await w.t.call<InvocationResponse>("getInvocation", { params: { invocationId: first.id } });
  return { invocations: roots.length, inputs: detail.body.manifest.content.inputs as { kind: string; content?: string }[] };
}

const operatorMessagesOf = async (w: World, runId: string) => (await w.t.call<Page<ConversationMessage>>("listConversationMessages", { params: { conversationId: w.conversationId }, query: { limit: 200 } })).body.items.filter((m) => m.runId === runId && m.author === "operator");

describe("the operator's Run launch", () => {
  const worlds: World[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const w of worlds.splice(0)) {
      await w.t.close().catch(() => undefined);
      removeAppDirectory(w.dir);
    }
  });

  it("refuses a launch while another Run is active and leaves Requirements, criteria, messages, Events, and Workspace state unchanged", async () => {
    const w = await openWorld();
    worlds.push(w);
    const first = await create(w, { start: false });
    expect(first.status).toBe(201);
    const before = await footprint(w);
    expect(before.revision).not.toBeNull();
    const refused = await create(w, { goal: "A second goal while the first is active.", start: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("conflict");
    expect(await footprint(w)).toEqual(before);
  }, 120_000);

  it("creates nothing on a validation refusal, a failed Workspace preparation, a failed Event, or a failed COMMIT, and runs the preparation's compensation", async () => {
    const w = await openWorld();
    worlds.push(w);
    // A prior, ended Run gives the Conversation a revision to keep: every refusal below must leave it exactly as it is.
    const earlier = await create(w, { start: false });
    expect(earlier.status).toBe(201);
    expect((await w.t.call("cancelRun", { params: { runId: earlier.body.run.id }, body: {} })).status).toBe(200);
    const before = await footprint(w);
    expect(before.activeRunId).toBeNull();
    // Validation: a coding Run without a completion check.
    const invalid = await create(w, { goal: "No check.", completionCheck: null });
    expect(invalid.status).toBe(400);
    expect(await footprint(w)).toEqual(before);
    // The Event journal fails late in the operation (the Run start's own Event): the Requirement revision, the Run, the goal message, and
    // the Workspace preparation before it all roll back, and the preparation's compensation removes the integration checkout.
    const journal = w.t.app.runtime.ctx.journal;
    const append = journal.append.bind(journal);
    vi.spyOn(journal, "append").mockImplementation(((input: { type: string }) => {
      if (input.type === "run.started") throw new Error("injected: the journal is unavailable");
      return append(input as never);
    }) as never);
    const eventFailed = await create(w, { goal: "Event failure." });
    expect(eventFailed.status).toBe(500);
    vi.restoreAllMocks();
    expect(await footprint(w)).toEqual(before);
    // COMMIT fails: the same rollback and compensation.
    const sqlite = w.t.app.runtime.database.sqlite;
    const exec = sqlite.exec.bind(sqlite);
    vi.spyOn(sqlite, "exec").mockImplementation(((statement: string) => {
      if (statement === "COMMIT") throw new Error("injected: SQLITE_IOERR on COMMIT");
      return exec(statement);
    }) as never);
    const commitFailed = await create(w, { goal: "Commit failure." });
    expect(commitFailed.status).toBe(500);
    vi.restoreAllMocks();
    expect(await footprint(w)).toEqual(before);
    // The Workspace cannot be prepared (its repository is gone): refused, nothing written.
    fs.rmSync(path.join(w.repo, ".git"), { recursive: true, force: true });
    const unprepared = await create(w, { goal: "Unprepared." });
    expect(unprepared.status).toBeGreaterThanOrEqual(400);
    const after = await footprint(w);
    expect({ ...after, worktrees: 0 }).toEqual({ ...before, worktrees: 0 });
    // The Conversation still admits a launch afterwards: nothing half-launched blocks it.
    expect(after.activeRunId).toBeNull();
  }, 120_000);

  it("records the complete goal for a deferred start and delivers exactly it once, across lines and across a restart, never a placeholder", async () => {
    const dir = newAppDirectory("agentique-launch-");
    let w = await openWorld(dir);
    worlds.push(w);
    const goal = ["Add a --version flag to the CLI.", "", "It prints the version from package.json  (two spaces kept) and exits 0.", "  Indented last line."].join("\n");
    const created = await create(w, { goal, start: false });
    expect(created.status).toBe(201);
    expect(created.body.phase).toBe("created");
    const runId = created.body.run.id;
    // The goal is one operator message of the Run, in full; nothing else was posted and nothing was delivered yet.
    expect((await operatorMessagesOf(w, runId)).map((m) => m.content)).toEqual([goal]);
    expect(await firstTurnInputs(w, runId)).toEqual({ invocations: 0, inputs: [] });
    // Close and reopen: the start delivers the recorded goal — no second message, no "Proceed.".
    await w.t.close();
    worlds.splice(0);
    const sdk = new FakeClaudeSdk();
    sdk.script({ steps: [returned("Noted the goal.")] });
    w = await openWorld(dir, sdk);
    worlds.push(w);
    const started = await start(w, runId);
    expect(started.status).toBe(200);
    expect(started.body.run.status).toBe("running");
    const turn = await firstTurnInputs(w, runId);
    expect(turn.invocations).toBe(1);
    expect(turn.inputs.filter((i) => i.kind === "operator_message").map((i) => i.content)).toEqual([goal]);
    expect((await operatorMessagesOf(w, runId)).map((m) => m.content)).toEqual([goal]);
    const messages = await w.t.call<Page<ConversationMessage>>("listConversationMessages", { params: { conversationId: w.conversationId }, query: { limit: 200 } });
    expect(messages.body.items.some((m) => m.content === "Proceed.")).toBe(false);
    // The rendered manifest the provider received carries every line of the goal.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const prompt = sdk.captured.prompts[0] ?? "";
    for (const line of goal.split("\n").filter((l) => l.trim() !== "")) expect(prompt).toContain(line.trim());
    // A repeated start is refused by the start contract: no extra message, no second Invocation.
    const again = await start(w, runId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
    expect((await firstTurnInputs(w, runId)).invocations).toBe(1);
    expect(await operatorMessagesOf(w, runId)).toHaveLength(1);
  }, 120_000);

  it("delivers a replacement message instead of the goal, records it once, and refuses concurrent and conflicting starts without an extra message or Invocation", async () => {
    const sdk = new FakeClaudeSdk();
    const w = await openWorld(newAppDirectory("agentique-launch-"), sdk);
    worlds.push(w);
    const created = await create(w, { goal: "The original goal.", start: false });
    const runId = created.body.run.id;
    sdk.script({ steps: [returned("Noted.")] });
    // Two starts race: exactly one succeeds; the other is refused and writes nothing.
    const [a, b] = await Promise.all([start(w, runId, { message: "Start with this instead." }), start(w, runId, { message: "Or this." })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const turn = await firstTurnInputs(w, runId);
    expect(turn.invocations).toBe(1);
    expect(turn.inputs.filter((i) => i.kind === "operator_message").map((i) => i.content)).toEqual([a.status === 200 ? "Start with this instead." : "Or this."]);
    // The goal stays recorded; the one replacement is recorded; the refused start recorded nothing.
    expect((await operatorMessagesOf(w, runId)).map((m) => m.content)).toEqual(["The original goal.", a.status === 200 ? "Start with this instead." : "Or this."]);
    // A conflicting start after the fact is refused the same way.
    const later = await start(w, runId, { message: "Too late." });
    expect(later.status).toBe(409);
    expect(await operatorMessagesOf(w, runId)).toHaveLength(2);
    expect((await firstTurnInputs(w, runId)).invocations).toBe(1);
  }, 120_000);

  it("appends a second Run's goal to the Conversation's Requirements and keeps the first goal's Acceptance Criteria at the new revision", async () => {
    const w = await openWorld();
    worlds.push(w);
    const first = await create(w, { goal: "Add --version.", completionCheck: { command: "node test.js" }, start: false });
    expect(first.status).toBe(201);
    const initial = await w.t.call<RequirementsResponse>("listConversationRequirements", { params: { conversationId: w.conversationId } });
    const goal1 = initial.body.requirements[0]!;
    expect(goal1.criteria.map((c) => [c.check.kind === "deterministic" ? c.check.command : null, c.requirementRevisionId])).toEqual([["node test.js", initial.body.revision!.id]]);
    // The first Run ends; the second appends its goal.
    expect((await w.t.call("cancelRun", { params: { runId: first.body.run.id }, body: {} })).status).toBe(200);
    const second = await create(w, { goal: "Add --help.", completionCheck: { command: "node test.js --help" }, start: false });
    expect(second.status).toBe(201);
    const revised = await w.t.call<RequirementsResponse>("listConversationRequirements", { params: { conversationId: w.conversationId } });
    expect(revised.body.revision!.number).toBe(initial.body.revision!.number + 1);
    const entries = revised.body.revision!.tree;
    expect(entries.map((e) => e.statement)).toEqual(["Add --version.", "Add --help."]);
    // The kept goal keeps its id and its one criterion — listed by the new revision's entry, not re-authored, not dropped.
    const kept = entries.find((e) => e.id === goal1.requirement.id)!;
    expect(kept.acceptanceCriterionIds).toEqual(goal1.criteria.map((c) => c.id));
    const keptView = revised.body.requirements.find((r) => r.requirement.id === goal1.requirement.id)!;
    expect(keptView.criteria.map((c) => c.id)).toEqual(goal1.criteria.map((c) => c.id));
    expect(keptView.requirement.status).not.toBe("retired");
    // The completion criteria of the second Run at the pinned (current) revision: both goals' deterministic checks, each once.
    const facts = new CompletionFacts(w.t.app.runtime.stores);
    const run2 = w.t.app.runtime.stores.runs.get(second.body.run.id as never);
    const criteria = facts.criteriaOf(run2, facts.pinnedRevision(run2));
    expect(criteria.deterministic.map((c) => (c.check.kind === "deterministic" ? c.check.command : null)).sort()).toEqual(["node test.js", "node test.js --help"]);
    expect(criteria.all).toHaveLength(2);
    expect(facts.leafIds(facts.pinnedRevision(run2))).toHaveLength(2);
  }, 120_000);
});
