/**
 * The application-level path (implementation-roadmap Phase 9): the
 * production composition over a disposable directory, driven only through
 * the public HTTP API and the host, with the SDK fixture standing in for the
 * provider and everything else real — SQLite, the blob store, git worktrees,
 * the real integration of the Worker's change, a real subprocess completion
 * check, and the atomic git publication of the accepted result.
 *
 * The normal flow adopts a repository as a Workspace, opens a Conversation,
 * creates a coding Run whose goal and completion check become the operator's
 * Requirement, lets the Orchestrator propose Requirements and request a
 * Decision (both resolved by the operator through the API), then author the
 * plan and the Task the Worker executes, watches the Worker's Task evidence
 * arrive through the runtime tools, the integration and the check run, the
 * completion and the final report, accepts the signoff, and only then
 * requests and confirms the publication: the receipt names the exact
 * candidate, the Target head is that candidate, and the checkout was brought
 * forward. Three file-backed restarts follow: at the blocked proposal-and-
 * Decision boundary, in the middle of a Worker Attempt (interrupted by the
 * shutdown, retried after the restart), and after a Target update that
 * committed before the SQLite record existed (the restart replays the
 * receipt and records success exactly once).
 *
 * §15 invariants exercised here: 2, 3, 5, 8, 9, 10, 12, 13, 14, 16, 22, 23, 26, 28.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Attempt, DecisionView, Invocation, Page, PlanResponse, PublicationsResponse, RequirementsResponse, RunOverview, SignoffResponse, TaskLedgerResponse, Workspace } from "@agentique-console/core";
import { FakeClaudeSdk } from "../provider/claude-sdk-test-support.ts";
import { gitSync } from "../workspace-state/git.ts";
import { CHECK, FINAL, NEW_CLI, OLD_CLI, completionTurns, initFixtureRepo, planSource, planTurn, returned, tool, workerTurn } from "./e2e-fixture.ts";
import { PUBLICATION_RECEIPT_REF_PREFIX } from "../workspace-state/providers/git.ts";
import type { PublicationHooks } from "../workspace-state/index.ts";
import { openTestApp, removeAppDirectory, newAppDirectory, type TestApp } from "./test-support.ts";

const git = (repo: string, args: string[]) => gitSync(args, { cwd: repo }).stdout.toString().trim();
const head = (repo: string) => git(repo, ["rev-parse", "HEAD"]);
const receipts = (repo: string) => git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", PUBLICATION_RECEIPT_REF_PREFIX]).split("\n").filter((line) => line !== "");

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, what: string, timeoutMs = 60_000, diagnose?: () => Promise<string>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}; last: ${describe_(last)}${diagnose === undefined ? "" : `; attempts: ${await diagnose()}`}`);
}

/** Every Invocation of the Run with its Attempts' outcomes: the failure detail a timeout needs. */
async function attemptsOf(w: World, runId: string): Promise<string> {
  const invocations = await w.t.call<Page<Invocation>>("listRunInvocations", { params: { runId } });
  const rows: unknown[] = [];
  for (const invocation of [...invocations.body.items].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
    const attempts = await w.t.call<Page<Attempt>>("listInvocationAttempts", { params: { invocationId: invocation.id } });
    const detail = await w.t.call<{ runtimeToolCalls: unknown[]; manifest: { content?: { inputs?: { kind: string }[] } } }>("getInvocation", { params: { invocationId: invocation.id } });
    rows.push({ id: invocation.id, createdAt: invocation.createdAt, role: invocation.role, purpose: invocation.purpose, status: invocation.status, continuedFrom: invocation.continuedFromInvocationId, inputs: (detail.body.manifest.content?.inputs ?? []).map((i) => i.kind), attempts: attempts.body.items.map((a) => ({ status: a.status, failureClass: a.failureClass, detail: a.failureDetail })), calls: detail.body.runtimeToolCalls.map((c) => JSON.stringify(c).slice(0, 300)) });
  }
  const inputs = await w.t.call<Page<{ kind: string; createdAt: string; deliveredByInvocationId: string | null }>>("listRunOrchestratorInputs", { params: { runId } });
  const gates = await w.t.call<Page<unknown>>("listRunGates", { params: { runId } });
  const completions = await w.t.call<Page<unknown>>("listRunCompletionRequests", { params: { runId } });
  return JSON.stringify({ invocations: rows, inputs: inputs.body.items, gates: gates.body.items.map((g) => JSON.stringify(g).slice(0, 1500)), completions: completions.body.items.map((c) => JSON.stringify(c).slice(0, 800)), sdkCalls: w.t.sdk.captured.mcpCalls.map((c) => [c.tool, c.isError, c.text.slice(0, 400)]), sdkRejected: w.t.sdk.captured.mcpRejected.map((c) => c.tool), remainingTurns: w.t.sdk.remainingTurns });
}

function describe_(value: unknown): string {
  if (typeof value === "object" && value !== null && "phase" in value && "run" in value) {
    const o = value as RunOverview;
    return JSON.stringify({ phase: o.phase, status: o.run.status, waitReason: o.run.waitReason, failure: o.run.failure, projection: o.projection === null ? null : { stop: o.projection.stop, waiting: o.projection.waiting, inFlight: o.projection.inFlight, nodes: o.projection.nodes, nextActions: o.projection.nextActions }, projectionError: o.projectionError, openProposal: o.openProposal?.status ?? null, openDecisions: o.openDecisions.map((d) => d.kind), pendingInputs: o.pendingInputs, completion: o.completion === null ? null : { status: o.completion.request.status, gate: o.completion.gate?.status ?? null } });
  }
  return JSON.stringify(value).slice(0, 2_000);
}

interface World {
  t: TestApp;
  dir: string;
  repo: string;
  workspace: Workspace;
  conversationId: string;
}

async function openWorld(dir = newAppDirectory("agentique-e2e-"), sdk = new FakeClaudeSdk(), extra: { hooks?: PublicationHooks } = {}): Promise<World> {
  const t = await openTestApp({ dir, sdk, ...(extra.hooks === undefined ? {} : { publicationHooks: extra.hooks }) });
  const repo = fs.existsSync(path.join(dir, "repo")) ? path.join(dir, "repo") : initFixtureRepo(dir);
  const workspaces = await t.call<Page<{ workspace: Workspace }>>("listWorkspaces");
  let workspace = workspaces.body.items.find((w) => w.workspace.rootPath === repo)?.workspace ?? null;
  if (workspace === null) {
    const created = await t.call<{ workspace: Workspace }>("createWorkspace", { body: { rootPath: repo } });
    expect(created.status).toBe(201);
    workspace = created.body.workspace;
    expect(workspace.kind).toBe("git");
  }
  const conversations = await t.call<Page<{ id?: string; conversation?: { id: string } }>>("listWorkspaceConversations", { params: { workspaceId: workspace.id } });
  const first = conversations.body.items[0];
  let conversationId = first === undefined ? null : (first.conversation?.id ?? first.id ?? null);
  if (conversationId === null) {
    const conversation = await t.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId: workspace.id, title: "version flag" } });
    expect(conversation.status).toBe(201);
    conversationId = conversation.body.conversation.id;
  }
  return { t, dir, repo, workspace, conversationId };
}

const overview = (w: World, runId: string) => w.t.call<RunOverview>("getRun", { params: { runId } }).then((r) => r.body);
const phaseIs = (w: World, runId: string, phases: string[], timeoutMs = 60_000) => until(() => overview(w, runId), (o) => phases.includes(o.phase), `phase in ${phases.join("|")}`, timeoutMs, () => attemptsOf(w, runId));
/** The Orchestrator has returned and nothing is in flight: the Run is running and idle until the operator's next input. */
const idle = (w: World, runId: string) => until(() => overview(w, runId), (o) => o.phase === "running" && o.projection !== null && o.projection.inFlight.length === 0 && w.t.sdk.remainingTurns === 0, "an idle Orchestrator", 60_000, () => attemptsOf(w, runId));

/** The implementer Agent Definition revision the plan names: loaded from the Workspace's branch through the API. */
async function implementerRevision(w: World): Promise<string> {
  const load = await w.t.call<{ files: { kind: string; revisionId?: string; name?: string }[] }>("loadWorkspaceAgentDefinitions", { params: { workspaceId: w.workspace.id }, body: {} });
  expect(load.status).toBe(200);
  const loaded = load.body.files.find((f) => f.kind === "loaded" && f.name === "implementer");
  if (loaded === undefined) throw new Error(`implementer not loaded: ${JSON.stringify(load.body)}`);
  return loaded.revisionId!;
}

describe("the application path over HTTP", () => {
  const worlds: World[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) {
      await w.t.close().catch(() => undefined);
      removeAppDirectory(w.dir);
    }
  });

  it("carries a coding Run from the operator's goal to a published, receipted Target through the public API", async () => {
    const w = await openWorld();
    worlds.push(w);
    const { t, repo, conversationId } = w;
    const before = head(repo);

    // 1. The Run: goal and completion check become the operator's Requirement; nothing runs until the operator starts it.
    const created = await t.call<RunOverview>("createRun", { params: { conversationId }, body: { goal: "Add a --version flag to the CLI that prints the package version.", completionCheck: CHECK, start: false } });
    expect(created.status).toBe(201);
    const runId = created.body.run.id;
    expect(created.body.phase).toBe("created");
    const requirements = await t.call<RequirementsResponse>("listConversationRequirements", { params: { conversationId } });
    const goal = requirements.body.requirements.find((r) => r.criteria.some((c) => c.check.kind === "deterministic" && c.check.command === CHECK.command));
    if (goal === undefined) throw new Error("the goal Requirement carries the completion check");

    // 2. The Orchestrator's first turn: a Requirement proposal, then a blocking Decision for the operator.
    const proposal = {
      requirements: [
        // The kept goal becomes the parent; the proposed leaf carries its own deterministic criterion beside the Run's completion check.
        { key: "goal", parentKey: null, composition: "all", statement: goal.entry!.statement, requirementId: goal.requirement.id, acceptanceCriteria: [] },
        { key: "flag", parentKey: "goal", composition: null, statement: "`--version` prints the version from package.json and exits 0.", requirementId: null, acceptanceCriteria: [{ kind: "deterministic", command: "node src/cli.js --version", expectedExitCode: 0 }] },
      ],
      rationale: "Split the goal into the one testable behaviour.",
    };
    const decision = {
      kind: "operator_choice",
      question: "Which flag spelling?",
      options: [
        { key: "double_dash", label: "--version" },
        { key: "short", label: "-v", description: "the single-letter form" },
      ],
      recommendedOptionKey: "double_dash",
      rationale: "The goal names --version.",
      resolutionPolicy: { kind: "operator_required" },
      affects: { requirementIds: [goal.requirement.id], taskIds: [], planNodeIds: [] },
    };
    t.sdk.script({ steps: [{ kind: "tool_use", name: tool("propose_requirements"), input: proposal }, { kind: "tool_use", name: tool("request_decision"), input: decision }] });
    const started = await t.call<RunOverview>("startRun", { params: { runId }, body: {} });
    expect(started.status).toBe(200);
    const blocked = await phaseIs(w, runId, ["waiting_decision"]);
    expect(blocked.openProposal?.status).toBe("proposed");
    expect(blocked.openDecisions.map((d) => d.kind)).toEqual(["operator_choice"]);

    // 3. The operator approves the proposal verbatim and resolves the Decision through the API; the resolution continues the turn.
    const approved = await t.call<{ kind: string; requirementRevisionId: string | null }>("approveRequirementProposal", { params: { proposalId: blocked.openProposal!.id }, body: { rationale: "As proposed." } });
    expect(approved.status).toBe(200);
    expect(approved.body.kind).toBe("approved");
    // The approved revision: the goal is now a parent and the proposed leaf carries the work; Tasks bind to leaves.
    const revised = await t.call<RequirementsResponse>("listConversationRequirements", { params: { conversationId } });
    expect(revised.body.revision?.id).toBe(approved.body.requirementRevisionId);
    const leaf = revised.body.requirements.find((r) => r.entry !== null && r.entry.statement.startsWith("`--version`"));
    if (leaf === undefined) throw new Error(`the proposed leaf exists: ${JSON.stringify(revised.body.requirements.map((r) => r.entry?.statement))}`);
    expect(leaf.requirement.id).not.toBe(goal.requirement.id);
    // The resolution continues the blocked turn in its successor (the Decision's answer as input); the approved proposal, a queued
    // operator input, reaches the Orchestrator in the turn after that (execution-model §4.6).
    t.sdk.script(
      { steps: [{ kind: "tool_use", name: tool("create_tasks"), input: { tasks: [{ key: "impl", subject: "Implement --version in src/cli.js", requirementIds: [leaf.requirement.id], inputArtifactIds: [], requiredOutputs: ["src/cli.js handles --version"], dependsOnKeys: [], dependsOnTaskIds: [], replacesTaskId: null }] } }, returned("Created the implementation Task; awaiting the plan.")] },
      { steps: [returned("Noted the approved Requirements.")] },
    );
    const resolved = await t.call<{ kind: string; chosenOptionId: string | null; replayed: boolean }>("resolveDecision", { params: { decisionId: blocked.openDecisions[0]!.id }, body: { optionId: "double_dash" } });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ kind: "resolved", chosenOptionId: "double_dash", replayed: false });
    // A different second resolution of the same Decision is refused with the domain's typed reason, never applied twice.
    const again = await t.call<{ error: { code: string; details?: Record<string, unknown> } }>("resolveDecision", { params: { decisionId: blocked.openDecisions[0]!.id }, body: { optionId: "short" } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("refused");
    // The identical resolution replays.
    const replayed = await t.call<{ kind: string; replayed: boolean }>("resolveDecision", { params: { decisionId: blocked.openDecisions[0]!.id }, body: { optionId: "double_dash" } });
    expect(replayed.body).toMatchObject({ kind: "resolved", replayed: true });

    // 4. The Task exists in the ledger; the Orchestrator binds it into the plan on the operator's next message.
    const ledger = await until(() => t.call<TaskLedgerResponse>("listRunTasks", { params: { runId } }).then((r) => r.body), (l) => l.items.length === 1, "one Task", 60_000, () => attemptsOf(w, runId));
    const taskId = ledger.items[0]!.task.id;
    expect(ledger.items[0]!.task.status).toBe("pending");
    await idle(w, runId);
    const revisionId = await implementerRevision(w);
    t.sdk.script(planTurn(revisionId, [taskId]), workerTurn(taskId), ...completionTurns());
    const posted = await t.call<{ message: { id: string }; queued: unknown }>("postConversationMessage", { params: { conversationId }, body: { content: "Go ahead with the plan." } });
    expect(posted.status).toBe(201);
    expect(posted.body.queued).not.toBeNull();

    // 5. The Worker's change is integrated, the real check runs, the completion Gate passes, the final report is written.
    const awaiting = await phaseIs(w, runId, ["awaiting_signoff"], 120_000);
    expect(awaiting.finalReportArtifactId).not.toBeNull();
    expect(awaiting.completion?.gate?.status).toBe("passed");
    const plan = await t.call<PlanResponse>("getRunPlan", { params: { runId } });
    const implementerNode = plan.body.nodes.find((n) => n.node.kind === "pattern" && n.node.title === "Add --version");
    expect(implementerNode?.node.status).toBe("succeeded");
    const tasks = await t.call<TaskLedgerResponse>("listRunTasks", { params: { runId } });
    expect(tasks.body.items[0]!.task.status).toBe("completed");
    expect(tasks.body.items[0]!.task.evidence.map((e) => e.kind)).toContain("url");
    const invocations = await t.call<Page<Invocation>>("listRunInvocations", { params: { runId } });
    expect(invocations.body.items.filter((i) => i.role === "worker")).toHaveLength(1);
    const gates = await t.call<Page<{ kind: string; status: string }>>("listRunGates", { params: { runId } });
    expect(gates.body.items.map((g) => [g.kind, g.status])).toContainEqual(["run_completion", "passed"]);
    // The Target has not moved: signoff is not publication.
    expect(head(repo)).toBe(before);
    expect(fs.readFileSync(path.join(repo, "src", "cli.js"), "utf8")).toBe(OLD_CLI);

    // 6. Signoff: accept records the final Changeset and completes the Run; still unpublished.
    const signoff = await t.call<SignoffResponse>("getRunSignoff", { params: { runId } });
    expect(signoff.body.signoff?.allowedActions).toContain("accept");
    const accepted = await t.call<{ kind: string; replayed: boolean }>("acceptSignoff", { params: { runId }, body: { gateId: signoff.body.signoff!.gate.id, decisionId: signoff.body.signoff!.decision.id } });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ kind: "accepted", replayed: false });
    const replayAccept = await t.call<{ kind: string; replayed: boolean }>("acceptSignoff", { params: { runId }, body: { gateId: signoff.body.signoff!.gate.id, decisionId: signoff.body.signoff!.decision.id } });
    expect(replayAccept.body).toMatchObject({ kind: "accepted", replayed: true });
    const completed = await phaseIs(w, runId, ["completed_unpublished"]);
    expect(completed.run.status).toBe("completed");
    expect(head(repo)).toBe(before);

    // 7. Publication: a separate request and an explicit confirmation; the host advances it to the receipted Target update.
    const requested = await t.call<{ decision: { id: string }; replayed: boolean }>("requestPublication", { params: { runId }, body: { requestedStrategy: { kind: "automatic" } } });
    expect(requested.status).toBe(200);
    expect(requested.body.replayed).toBe(false);
    expect(head(repo)).toBe(before);
    const confirmed = await t.call<{ kind: string; publicationId: string | null }>("resolvePublication", { params: { runId, decisionId: requested.body.decision.id }, body: { option: "publish" } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.kind).toBe("publishing");
    const published = await phaseIs(w, runId, ["published", "publish_failed"], 60_000);
    expect(published.phase).toBe("published");
    const publications = await t.call<PublicationsResponse>("getRunPublications", { params: { runId } });
    expect(publications.body.publications).toHaveLength(1);
    const view = publications.body.publications[0]!;
    expect(view.publication.status).toBe("succeeded");
    expect(view.report?.outcome).toBe("succeeded");
    expect(view.report?.checkout).toEqual({ kind: "synchronized" });
    // The Target head is the exact candidate the receipt names; the working tree was brought forward; the fixture check holds on the Target.
    const after = head(repo);
    expect(after).not.toBe(before);
    expect(fs.readFileSync(path.join(repo, "src", "cli.js"), "utf8")).toBe(NEW_CLI);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
    expect(receipts(repo)).toEqual([`${PUBLICATION_RECEIPT_REF_PREFIX}${view.publication.id} ${after}`]);
    // Resolving the publish Decision again is a replay, not a second publication.
    const replayPublish = await t.call<{ kind: string; replayed: boolean }>("resolvePublication", { params: { runId, decisionId: requested.body.decision.id }, body: { option: "publish" } });
    expect(replayPublish.status).toBe(200);
    expect(replayPublish.body.replayed).toBe(true);
    expect((await t.call<PublicationsResponse>("getRunPublications", { params: { runId } })).body.publications).toHaveLength(1);
    expect(head(repo)).toBe(after);
    expect(t.sdk.remainingTurns).toBe(0);
    // The Decisions of the Run are all resolved and listed with their actions.
    const decisions = await t.call<Page<DecisionView>>("listRunDecisions", { params: { runId } });
    expect(decisions.body.items.every((d) => d.decision.status === "resolved")).toBe(true);
  }, 240_000);

  it("survives a restart at the blocked proposal and Decision boundary: nothing is lost, nothing is re-asked", async () => {
    const dir = newAppDirectory("agentique-e2e-");
    let w = await openWorld(dir);
    worlds.push(w);
    const created = await w.t.call<RunOverview>("createRun", { params: { conversationId: w.conversationId }, body: { goal: "Add --version.", completionCheck: CHECK, start: false } });
    expect(created.status).toBe(201);
    const runId = created.body.run.id;
    const requirements = await w.t.call<RequirementsResponse>("listConversationRequirements", { params: { conversationId: w.conversationId } });
    const goal = requirements.body.requirements[0]!;
    const proposal = { requirements: [{ key: "goal", parentKey: null, composition: null, statement: "The CLI prints its version.", requirementId: goal.requirement.id, acceptanceCriteria: [goal.criteria[0]!.check] }], rationale: "Sharpened." };
    const decision = { kind: "operator_choice", question: "Proceed?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], recommendedOptionKey: "yes", resolutionPolicy: { kind: "operator_required" }, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } };
    w.t.sdk.script({ steps: [{ kind: "tool_use", name: tool("propose_requirements"), input: proposal }, { kind: "tool_use", name: tool("request_decision"), input: decision }] });
    await w.t.call("startRun", { params: { runId }, body: {} });
    const blocked = await phaseIs(w, runId, ["waiting_decision"]);
    const proposalId = blocked.openProposal!.id;
    const decisionId = blocked.openDecisions[0]!.id;

    // The process ends and a new one opens the same directory: the boundary is intact and the phase is the same.
    await w.t.close();
    worlds.splice(0);
    w = await openWorld(dir, new FakeClaudeSdk());
    worlds.push(w);
    const reopened = await overview(w, runId);
    expect(reopened.phase).toBe("waiting_decision");
    expect(reopened.openProposal?.id).toBe(proposalId);
    expect(reopened.openDecisions.map((d) => d.id)).toEqual([decisionId]);
    expect(w.t.sdk.captured.prompts).toEqual([]);
    // The operator resolves both through the API; the successor turn runs in the new process with the resolution as its input.
    w.t.sdk.script({ steps: [returned("Acknowledged the resolution.")] }, { steps: [returned("Noted the rejected proposal.")] });
    const rejected = await w.t.call<{ kind: string }>("rejectRequirementProposal", { params: { proposalId }, body: { rationale: "Keep the original wording." } });
    expect(rejected.status).toBe(200);
    expect(rejected.body.kind).toBe("rejected");
    const resolved = await w.t.call("resolveDecision", { params: { decisionId }, body: { optionId: "yes" } });
    expect(resolved.status).toBe(200);
    await until(() => Promise.resolve(w.t.sdk.remainingTurns), (n) => n === 0, "the successor turn");
    await idle(w, runId);
    const inputs = await w.t.call<Page<{ kind: string }>>("listRunOrchestratorInputs", { params: { runId } });
    expect(inputs.body.items.map((i) => i.kind)).toContain("requirement_proposal_resolution");
  }, 240_000);

  it("survives a restart in the middle of a Worker Attempt: the shutdown interrupts it truthfully and the new process retries", async () => {
    const dir = newAppDirectory("agentique-e2e-");
    let w = await openWorld(dir);
    worlds.push(w);
    const created = await w.t.call<RunOverview>("createRun", { params: { conversationId: w.conversationId }, body: { goal: "Add --version.", completionCheck: CHECK, start: false } });
    const runId = created.body.run.id;
    const requirements = await w.t.call<RequirementsResponse>("listConversationRequirements", { params: { conversationId: w.conversationId } });
    const goalId = requirements.body.requirements[0]!.requirement.id;
    const revisionId = await implementerRevision(w);
    w.t.sdk.script({ steps: [{ kind: "tool_use", name: tool("create_tasks"), input: { tasks: [{ key: "impl", subject: "Implement --version", requirementIds: [goalId], inputArtifactIds: [], requiredOutputs: ["src/cli.js"], dependsOnKeys: [], dependsOnTaskIds: [], replacesTaskId: null }] } }, returned("Task created.")] });
    await w.t.call("startRun", { params: { runId }, body: {} });
    const ledger = await until(() => w.t.call<TaskLedgerResponse>("listRunTasks", { params: { runId } }).then((r) => r.body), (l) => l.items.length === 1, "one Task", 60_000, () => attemptsOf(w, runId));
    const taskId = ledger.items[0]!.task.id;
    await idle(w, runId);
    // The Worker hangs until it is interrupted: the shutdown is what ends it.
    w.t.sdk.script({ steps: [{ kind: "tool_use", name: tool("revise_execution_plan"), input: { source: planSource(revisionId, [taskId]) } }, returned("Planned.")] }, { steps: [{ kind: "hang" }] });
    await w.t.call("postConversationMessage", { params: { conversationId: w.conversationId }, body: { content: "Proceed." } });
    const running = await until(() => overview(w, runId), (o) => o.phase === "running" && (o.projection?.inFlight.length ?? 0) > 0 && w.t.sdk.remainingTurns === 0, "the Worker in flight");
    const workerInvocationId = running.projection!.inFlight[0]!;
    await w.t.close();
    worlds.splice(0);
    const attempts = (world: World) => world.t.call<Page<Attempt>>("listInvocationAttempts", { params: { invocationId: workerInvocationId } }).then((r) => r.body.items);
    // A new process: the interrupted Attempt is recorded as such, and the reconstruction retries the node.
    const sdk = new FakeClaudeSdk();
    sdk.script(workerTurn(taskId), ...completionTurns());
    w = await openWorld(dir, sdk);
    worlds.push(w);
    const first = (await attempts(w))[0]!;
    expect(first.status).toBe("interrupted");
    expect(first.retryDecision?.permitted).toBe(true);
    expect(first.failureDetail?.message).toMatch(/shutdown/);
    const awaiting = await phaseIs(w, runId, ["awaiting_signoff"], 120_000);
    expect(awaiting.completion?.gate?.status).toBe("passed");
    const all = await attempts(w);
    expect(all.map((a) => a.status)).toEqual(["interrupted", "succeeded"]);
    expect(sdk.remainingTurns).toBe(0);
  }, 240_000);

  it("survives a restart after the Target update committed but before the SQLite record existed: the receipt replays and success is recorded exactly once", async () => {
    const dir = newAppDirectory("agentique-e2e-");
    let died = false;
    let w = await openWorld(dir, new FakeClaudeSdk(), {
      hooks: {
        afterTargetUpdate: async () => {
          died = true;
          // The process dies here: the ref update is durable, the record never happens in this process.
          throw new Error("the process died after the Target update");
        },
      },
    });
    worlds.push(w);
    const runId = await completeThroughSignoff(w);
    const before = head(w.repo);
    const requested = await w.t.call<{ decision: { id: string } }>("requestPublication", { params: { runId }, body: {} });
    await w.t.call("resolvePublication", { params: { runId, decisionId: requested.body.decision.id }, body: { option: "publish" } });
    await until(() => Promise.resolve(died), (d) => d, "the Target update");
    // The publication stays `applying`: the record was never written; the Target and the receipt already moved.
    const stuck = await until(() => w.t.call<PublicationsResponse>("getRunPublications", { params: { runId } }).then((r) => r.body), (p) => p.publications[0]?.publication.status === "applying" && w.t.app.host.snapshot().active.length === 0, "the applying Publication");
    const publicationId = stuck.publications[0]!.publication.id;
    const after = head(w.repo);
    expect(after).not.toBe(before);
    expect(receipts(w.repo)).toEqual([`${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId} ${after}`]);
    expect((await overview(w, runId)).phase).toBe("publishing");
    await w.t.close();
    worlds.splice(0);
    // The new process reconstructs the outstanding Publication and replays the receipt: success recorded exactly once, no second update.
    w = await openWorld(dir, new FakeClaudeSdk());
    worlds.push(w);
    const done = await until(() => w.t.call<PublicationsResponse>("getRunPublications", { params: { runId } }).then((r) => r.body), (p) => p.publications[0]?.publication.status !== "applying", "the replayed Publication");
    expect(done.publications).toHaveLength(1);
    expect(done.publications[0]!.publication.status).toBe("succeeded");
    expect(done.publications[0]!.report?.checkout).toEqual({ kind: "unknown" });
    expect(head(w.repo)).toBe(after);
    expect(receipts(w.repo)).toEqual([`${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId} ${after}`]);
    expect((await overview(w, runId)).phase).toBe("published");
    // An operator-driven advance of a succeeded Publication is a no-op, never a second application.
    const advance = await w.t.call<{ kind: string }>("advancePublication", { params: { publicationId }, body: {} });
    expect(advance.status).toBe(200);
    expect(head(w.repo)).toBe(after);
  }, 240_000);
});

/** The shortest legitimate path to an accepted signoff: one Task, one Worker, the real check, the final report. */
async function completeThroughSignoff(w: World): Promise<string> {
  const created = await w.t.call<RunOverview>("createRun", { params: { conversationId: w.conversationId }, body: { goal: "Add --version.", completionCheck: CHECK, start: false } });
  expect(created.status).toBe(201);
  const runId = created.body.run.id;
  const requirements = await w.t.call<RequirementsResponse>("listConversationRequirements", { params: { conversationId: w.conversationId } });
  const goalId = requirements.body.requirements[0]!.requirement.id;
  const revisionId = await implementerRevision(w);
  w.t.sdk.script({ steps: [{ kind: "tool_use", name: tool("create_tasks"), input: { tasks: [{ key: "impl", subject: "Implement --version", requirementIds: [goalId], inputArtifactIds: [], requiredOutputs: ["src/cli.js"], dependsOnKeys: [], dependsOnTaskIds: [], replacesTaskId: null }] } }, returned("Task created.")] });
  await w.t.call("startRun", { params: { runId }, body: {} });
  const ledger = await until(() => w.t.call<TaskLedgerResponse>("listRunTasks", { params: { runId } }).then((r) => r.body), (l) => l.items.length === 1, "one Task", 60_000, () => attemptsOf(w, runId));
  const taskId = ledger.items[0]!.task.id;
  await idle(w, runId);
  w.t.sdk.script(planTurn(revisionId, [taskId]), workerTurn(taskId), ...completionTurns());
  await w.t.call("postConversationMessage", { params: { conversationId: w.conversationId }, body: { content: "Proceed." } });
  await phaseIs(w, runId, ["awaiting_signoff"], 120_000);
  const signoff = await w.t.call<SignoffResponse>("getRunSignoff", { params: { runId } });
  const accepted = await w.t.call<{ kind: string }>("acceptSignoff", { params: { runId }, body: { gateId: signoff.body.signoff!.gate.id, decisionId: signoff.body.signoff!.decision.id } });
  expect(accepted.body.kind).toBe("accepted");
  await phaseIs(w, runId, ["completed_unpublished"]);
  return runId;
}
