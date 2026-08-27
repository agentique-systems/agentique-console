/**
 * Project continuation checkpoints, end to end through the real composition
 * root: archiving a run records ONE immutable checkpoint (facts from durable
 * rows, synthesis from main's last recorded working state); a later session
 * on the same project inherits the latest prior checkpoint as a bounded,
 * advisory prompt block plus a read tool — and NOTHING from the prior run
 * resumes: knowledge crosses the boundary, execution does not.
 */
import { describe, expect, it } from "vitest";
import type { ConsoleEvent } from "@agentique-console/shared";
import { runSummaries } from "../db/schema.ts";
import type { AgentRow, AgentSessionRow } from "../db/repo.ts";
import { newId, nowIso } from "../ids.ts";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeHarness, restartHarness, type Harness } from "../test-helpers.ts";

const DOC = "## Requirements\n- It parses input files\n- It renders the report";

const settledFor = (userSessionId: string) => (event: ConsoleEvent): boolean =>
  event.type === "user_session.turn.settled"
  && (event.payload as { userSessionId?: string }).userSessionId === userSessionId;

/** The minimal main-lane program: every turn opens and immediately succeeds. */
async function* trivialProgram(options: unknown) {
  void options;
  yield initMessage();
  yield successMessage();
}

function addAgentSession(h: Harness, userSessionId: string, title: string): AgentSessionRow {
  const now = nowIso();
  const row: AgentSessionRow = {
    id: newId("as"), userSessionId, title, lifecycle: "open",
    pattern: "hub_and_spoke", topology: {}, parentAgentSessionId: null,
    parentControllerAgent: null, depth: 0, allowChildSessions: false,
    budgetUsd: null, createdAt: now, updatedAt: now,
  };
  h.repo.insertAgentSession(row);
  return row;
}

function addAgent(h: Harness, agentSessionId: string, name: string, overrides: Partial<AgentRow> = {}): AgentRow {
  const row: AgentRow = {
    agentSessionId, name, role: "specialist", instructions: "x", model: null,
    profileId: "explorer", profileSnapshot: {}, ownership: [], sharedOwnership: [],
    sdkSessionId: null, lastActiveAt: null, generation: 0, turnCount: 0,
    contextTokens: 0, latestHandoffId: null, cumulativeCostUsd: 0,
    cumulativeApiDurationMs: 0, lastDecisionAt: null, worktreePath: null,
    worktreeBaseCommit: null, worktreeBranch: null, salvageBranch: null,
    salvageArtifactId: null, ord: 1, createdAt: nowIso(), ...overrides,
  };
  h.repo.insertAgent(row);
  return row;
}

function approveRequirements(h: Harness, userSessionId: string, document: string, note?: string): void {
  const draft = h.app.requirements.propose(userSessionId, document, note);
  h.app.requirements.approve(draft.id, { document, edited: false });
}

/** A prior run with real operational residue: state, an unreported workstream, a coupling. */
function seedPriorRun(h: Harness): { userSessionId: string; projectId: string; unfinished: AgentSessionRow } {
  const userSessionId = h.addUserSession();
  const projectId = h.repo.getUserSession(userSessionId)!.projectId;
  const unfinished = addAgentSession(h, userSessionId, "payments-refactor");
  h.app.orchestrationState.update(userSessionId, {
    trigger: "commission",
    strategy: "Land the parser before any rendering work",
    strategyWhy: "every downstream stream consumes its output",
    uncertainties: ["large-file performance is unmeasured"],
    risks: ["the upstream API may change shape"],
  });
  return { userSessionId, projectId, unfinished };
}

describe("continuation checkpoints (real composition root)", () => {
  it("archiving records exactly one checkpoint; retries, double-archive, and the backstop stay idempotent", () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId, projectId } = seedPriorRun(h);

    h.app.userSessions.patch(userSessionId, { lifecycle: "archived" });
    const first = h.app.continuation.latestForSession(h.addUserSession("execute", { projectId }));
    expect(first).not.toBeNull();
    expect(first!.sourceUserSessionId).toBe(userSessionId);

    // Retry the record, re-archive, and run the backstop: still one row.
    h.app.continuation.record(userSessionId);
    h.app.userSessions.patch(userSessionId, { lifecycle: "archived" });
    h.app.continuation.ensureForProject(projectId);
    const rows = h.sqlite.prepare("SELECT count(*) AS n FROM continuation_checkpoints").get() as { n: number };
    expect(rows.n).toBe(1);
    const recorded = h.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'project.continuation.recorded'").get() as { n: number };
    expect(recorded.n).toBe(1);
  });

  it("a continued session inherits the latest checkpoint as advisory context, while project truth flows unchanged", async () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA, projectId } = seedPriorRun(h);
    approveRequirements(h, runA, DOC, "initial");
    const decisionsBefore = h.decisions.list(runA).length;
    h.app.userSessions.patch(runA, { lifecycle: "archived" });

    const runB = h.addUserSession("execute", { projectId });
    // Requirements and decisions continue exactly as before the checkpoint existed.
    expect(h.app.requirements.derive(runB).map((node) => node.id)).toEqual(["r1", "r2"]);
    expect(h.decisions.list(runB).length).toBe(decisionsBefore);

    const digest = h.app.continuation.digest(runB);
    expect(digest).toContain("## Prior-run continuation checkpoint");
    expect(digest).toContain("requirements rev 1");
    // The synthesis is labeled as the previous model's context, never truth.
    expect(digest).toContain("not operator-approved meaning and not governing truth");
    expect(digest).toContain("Strategy then: Land the parser before any rendering work");
    expect(digest).toContain("Risk: the upstream API may change shape");
    expect(digest).toContain('"payments-refactor"');
    // The source session's own digest stays empty — a checkpoint never feeds its writer.
    expect(h.app.continuation.digest(runA)).toBe("");
  });

  it("unfinished workstreams, couplings, and salvage survive by reference — nothing archived resumes", async () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA, projectId, unfinished } = seedPriorRun(h);
    const producer = addAgentSession(h, runA, "schema-designer");
    addAgent(h, unfinished.id, "builder", { salvageBranch: "salvage/payments", salvageArtifactId: "artifact_diff1" });
    h.app.workstreams.link({
      userSessionId: runA, consumerAgentSessionId: unfinished.id,
      producerAgentSessionId: producer.id, subject: "the payments API schema", createdBy: "main",
    });
    h.tasks.upsertFromCreate({
      sdkSessionId: "sdk-a", sdkTaskId: "1", subject: "wire the ledger",
      attribution: { workspaceId: h.workspaceId, userSessionId: runA, agentSessionId: unfinished.id, agent: "builder" },
    });
    h.app.userSessions.patch(runA, { lifecycle: "archived" });

    const runB = h.addUserSession("execute", { projectId });
    const checkpoint = h.app.continuation.latestForSession(runB)!;
    expect(checkpoint.facts.unfinishedWorkstreams).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentSessionId: unfinished.id, title: "payments-refactor", openTasks: 1 }),
      expect.objectContaining({ agentSessionId: producer.id, title: "schema-designer" }),
    ]));
    expect(checkpoint.facts.pendingWorkstreamLinks).toEqual([
      expect.objectContaining({ subject: "the payments API schema", status: "pending" }),
    ]);
    expect(checkpoint.facts.salvage).toEqual([
      expect.objectContaining({ agent: "builder", branch: "salvage/payments", artifactId: "artifact_diff1" }),
    ]);

    // Knowledge crossed; execution did not: prior sessions stay archived, and
    // the new run starts with no scheduled assignments and no queued deliveries.
    for (const session of h.repo.listAgentSessions(runA)) expect(session.lifecycle).toBe("archived");
    expect(h.scheduler.countScheduled(runB)).toBe(0);
    expect(h.repo.listQueuedDeliveries(unfinished.id)).toEqual([]);
    expect(h.repo.listAgentSessions(runB)).toEqual([]);
  });

  it("standing suspect claims and open decision issues stay visible across the boundary", async () => {
    const h = makeHarness(trivialProgram);
    const runA = h.addUserSession();
    const projectId = h.repo.getUserSession(runA)!.projectId;
    addAgentSession(h, runA, "builder-stream");
    approveRequirements(h, runA, DOC);
    h.app.requirements.link({ userSessionId: runA, fromId: "r2", kind: "depends_on", toId: "r1", actor: "main" });
    h.app.requirements.reportStatus({ userSessionId: runA, requirementId: "r1", to: "satisfied",
      evidence: [{ kind: "file", ref: "src/parse.ts" }], claimant: { kind: "main" } });
    h.app.requirements.reportStatus({ userSessionId: runA, requirementId: "r2", to: "satisfied",
      evidence: [{ kind: "file", ref: "src/render.ts" }], claimant: { kind: "main" } });
    // Withdrawing r1 makes r2's terminal claim suspect — a durable change impact.
    h.app.requirements.reportStatus({ userSessionId: runA, requirementId: "r1", to: "open",
      evidence: [], claimant: { kind: "main" }, note: "parser regressed" });
    expect(h.app.changeImpacts.listOpen(runA).length).toBe(1);
    h.app.decisionIssues.openForAsk({ userSessionId: runA, issueKey: "renderer-choice",
      subject: "Canvas or WebGL renderer?", requirementIds: ["r2"], createdBy: "scout" });
    // The withdrawal wake queued a main turn; let it settle before archiving.
    await collectUntil(h.bus, settledFor(runA));
    h.app.userSessions.patch(runA, { lifecycle: "archived" });

    const runB = h.addUserSession("execute", { projectId });
    const checkpoint = h.app.continuation.latestForSession(runB)!;
    expect(checkpoint.facts.openChangeImpacts).toEqual([
      expect.objectContaining({ sourceKind: "claim_withdrawn", suspectClaims: ["r2"] }),
    ]);
    expect(checkpoint.facts.openDecisionIssues).toEqual([
      expect.objectContaining({ subject: "Canvas or WebGL renderer?" }),
    ]);
    const digest = h.app.continuation.digest(runB);
    expect(digest).toContain("Unreconciled change impacts");
    expect(digest).toContain("suspect claims: r2");
    expect(digest).toContain("Canvas or WebGL renderer?");
  });

  it("accepted waivers, known gaps, and non-goals are carried as accepted-then facts", () => {
    const h = makeHarness(trivialProgram);
    const runA = h.addUserSession();
    const projectId = h.repo.getUserSession(runA)!.projectId;
    addAgentSession(h, runA, "tracker-build");
    approveRequirements(h, runA, DOC);
    h.app.orchestrationState.recordCompletion(runA, {
      criteria: [{ requirement: "r1", met: true, evidence: [{ kind: "file", ref: "src/parse.ts" }] }],
      knownGaps: ["no dark mode yet"], nonGoals: ["a mobile app"], requirementsRevision: 1,
    });
    const now = nowIso();
    h.db.insert(runSummaries).values({
      id: newId("run"), userSessionId: runA, seqFrom: 0, seqTo: 10,
      verdict: "completed_with_caveats",
      document: { headline: "Shipped the tracker with caveats" } as unknown as Record<string, unknown>,
      status: "accepted",
      waivers: [{ kind: "requirement_unsatisfied", ref: "r2", detail: "r2 is open", revision: 1,
        policy: "waiver_required", decidedBy: "operator", at: now, note: "renderer lands next run" }],
      note: null, createdAt: now, resolvedAt: now,
    }).run();
    h.app.userSessions.patch(runA, { lifecycle: "archived" });

    const runB = h.addUserSession("execute", { projectId });
    const checkpoint = h.app.continuation.latestForSession(runB)!;
    expect(checkpoint.facts.completion).toMatchObject({ status: "accepted", verdict: "completed_with_caveats",
      headline: "Shipped the tracker with caveats" });
    expect(checkpoint.facts.waivers).toEqual([
      expect.objectContaining({ kind: "requirement_unsatisfied", ref: "r2", note: "renderer lands next run" }),
    ]);
    expect(checkpoint.facts.knownGaps).toEqual(["no dark mode yet"]);
    expect(checkpoint.facts.nonGoals).toEqual(["a mobile app"]);
    const digest = h.app.continuation.digest(runB);
    expect(digest).toContain("waived at sign-off: requirement_unsatisfied r2");
    expect(digest).toContain("accepted THEN");
  });

  it("the checkpoint and its digest stay bounded when the prior run was large", () => {
    const h = makeHarness(trivialProgram);
    const runA = h.addUserSession();
    const projectId = h.repo.getUserSession(runA)!.projectId;
    for (let index = 0; index < 55; index += 1) {
      const session = addAgentSession(h, runA, `stream-${index} with a fairly long descriptive title about its scope`);
      h.tasks.upsertFromCreate({
        sdkSessionId: "sdk-big", sdkTaskId: String(index), subject: `unit ${index}`,
        attribution: { workspaceId: h.workspaceId, userSessionId: runA, agentSessionId: session.id, agent: "builder" },
      });
    }
    h.app.orchestrationState.update(runA, { trigger: "commission", strategy: "fan wide", strategyWhy: "many independent streams" });
    h.app.userSessions.patch(runA, { lifecycle: "archived" });

    const runB = h.addUserSession("execute", { projectId });
    const checkpoint = h.app.continuation.latestForSession(runB)!;
    expect(checkpoint.facts.unfinishedWorkstreams.length).toBe(40);
    const digest = h.app.continuation.digest(runB);
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(digest).toContain("…(truncated — read_continuation has the rest)");
  });

  it("a fresh project has an empty digest, and an empty prior run declines a checkpoint without blocking continuation", async () => {
    const h = makeHarness(trivialProgram);
    const fresh = h.addUserSession();
    expect(h.app.continuation.digest(fresh)).toBe("");
    expect(h.app.continuation.latestForSession(fresh)).toBeNull();

    // An archived run with nothing to hand off: continuation still works, no
    // checkpoint row, no continuation notice.
    const emptyA = h.addUserSession();
    const projectId = h.repo.getUserSession(emptyA)!.projectId;
    h.app.userSessions.patch(emptyA, { lifecycle: "archived" });
    const created = h.app.userSessions.create({ workspaceId: h.workspaceId, mode: "execute", message: "continue it", projectId });
    await collectUntil(h.bus, settledFor(created.id));
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM continuation_checkpoints").get()).toMatchObject({ n: 0 });
    expect(h.app.continuation.digest(created.id)).toBe("");
    const notices = h.repo.listMessages("user", created.id).filter((row) => row.kind === "notice");
    expect(notices.some((row) => row.text.includes("Continuing this project"))).toBe(false);
  });

  it("requirement amendments after the checkpoint make its currency visibly stale", () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA, projectId } = seedPriorRun(h);
    approveRequirements(h, runA, DOC);
    h.app.userSessions.patch(runA, { lifecycle: "archived" });

    const runB = h.addUserSession("execute", { projectId });
    expect(h.app.continuation.digest(runB)).not.toContain("STALE:");
    approveRequirements(h, runB, "## Requirements\n- r1: It parses input files\n- r2: It renders the report\n- It exports to CSV", "add export");
    const digest = h.app.continuation.digest(runB);
    expect(digest).toContain("STALE: written at requirements rev 1; rev 2 now governs");
  });

  it("three sequential runs: only the latest prior checkpoint enters the next prompt", () => {
    const h = makeHarness(trivialProgram);
    const runA = h.addUserSession();
    const projectId = h.repo.getUserSession(runA)!.projectId;
    addAgentSession(h, runA, "alpha-stream");
    h.app.orchestrationState.update(runA, { trigger: "commission", strategy: "ALPHA-STRATEGY" });
    h.app.userSessions.patch(runA, { lifecycle: "archived" });

    const runB = h.addUserSession("execute", { projectId });
    addAgentSession(h, runB, "beta-stream");
    h.app.orchestrationState.update(runB, { trigger: "direction_change", strategy: "BETA-STRATEGY" });
    h.app.userSessions.patch(runB, { lifecycle: "archived" });

    const runC = h.addUserSession("execute", { projectId });
    const latest = h.app.continuation.latestForSession(runC)!;
    expect(latest.sourceUserSessionId).toBe(runB);
    const digest = h.app.continuation.digest(runC);
    expect(digest).toContain("BETA-STRATEGY");
    expect(digest).not.toContain("ALPHA-STRATEGY");
    // History keeps both, run-ordered, for the read tool.
    expect(h.app.continuation.listForSession(runC).map((entry) => entry.sourceUserSessionId)).toEqual([runA, runB]);
  });

  it("the checkpoint is injected into the continued lane's prompt below project truth, and read_continuation returns the full record", async () => {
    const appends: string[] = [];
    const h = makeHarness(async function* (options) {
      const systemPrompt = (options as { systemPrompt?: unknown }).systemPrompt;
      const append = typeof systemPrompt === "object" && systemPrompt !== null && !Array.isArray(systemPrompt)
        ? ((systemPrompt as { append?: string }).append ?? "") : "";
      appends.push(append);
      yield initMessage();
      yield successMessage();
    });
    const { userSessionId: runA, projectId } = seedPriorRun(h);
    approveRequirements(h, runA, DOC);
    h.app.userSessions.patch(runA, { lifecycle: "archived" });

    const created = h.app.userSessions.create({ workspaceId: h.workspaceId, mode: "execute", message: "keep going", projectId });
    await collectUntil(h.bus, settledFor(created.id));

    // The transcript shows the operator the boundary crossing.
    const notices = h.repo.listMessages("user", created.id).filter((row) => row.kind === "notice");
    expect(notices.some((row) => row.text.includes("Continuing this project from the previous run"))).toBe(true);

    // The lane's system prompt carries requirements (authoritative) ABOVE the
    // checkpoint (advisory) — placement mirrors authority.
    const append = appends.find((entry) => entry.includes("## Prior-run continuation checkpoint"));
    expect(append).toBeDefined();
    expect(append!.indexOf("## Requirements")).toBeGreaterThanOrEqual(0);
    expect(append!.indexOf("## Requirements")).toBeLessThan(append!.indexOf("## Prior-run continuation checkpoint"));

    // The read tool returns the full checkpoint, history, and currency.
    const tool = h.fake.captured.tools.find((entry) => (entry as { name: string }).name === "read_continuation") as
      { handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<{ content: { text?: string }[] }> } | undefined;
    expect(tool).toBeDefined();
    const result = JSON.parse((await tool!.handler({}, {})).content[0]?.text ?? "null") as {
      checkpoint: { sourceUserSessionId: string; synthesis: { strategy: string } | null } | null;
      history: unknown[]; currency: string; note: string;
    };
    expect(result.checkpoint?.sourceUserSessionId).toBe(runA);
    expect(result.checkpoint?.synthesis?.strategy).toBe("Land the parser before any rendering work");
    expect(result.history.length).toBe(1);
    expect(result.note).toContain("model-authored");
  });

  it("a run archived without a checkpoint (pre-checkpoint database, crash) is backfilled at attach", async () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA, projectId } = seedPriorRun(h);
    // Archive around the service — the shape a crash or a legacy database leaves.
    h.repo.patchUserSession(runA, { lifecycle: "archived" });
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM continuation_checkpoints").get()).toMatchObject({ n: 0 });

    const created = h.app.userSessions.create({ workspaceId: h.workspaceId, mode: "execute", message: "continue", projectId });
    await collectUntil(h.bus, settledFor(created.id));
    const checkpoint = h.app.continuation.latestForSession(created.id);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.sourceUserSessionId).toBe(runA);
    expect(checkpoint!.synthesis?.strategy).toBe("Land the parser before any rendering work");
  });

  it("the live-run regression: a quota-paused run is handed off into a fresh session on the same project", async () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA, projectId, unfinished } = seedPriorRun(h);
    approveRequirements(h, runA, DOC);
    h.tasks.upsertFromCreate({
      sdkSessionId: "sdk-a", sdkTaskId: "1", subject: "finish the parser",
      attribution: { workspaceId: h.workspaceId, userSessionId: runA, agentSessionId: unfinished.id, agent: "builder" },
    });
    // The provider's usage window closes on the run — the straf3 live ending.
    h.app.capacity.noteLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, limitType: "five_hour" });
    expect(h.repo.getUserSession(runA)?.pauseReason).toBe("capacity");

    const runB = h.app.userSessions.continueFrom(runA, { message: "continue the unfinished parser work" });

    // The handoff is a real ownership transfer: the old session is archived,
    // cannot take messages, and its agents are archived — never reopened.
    const oldRow = h.repo.getUserSession(runA)!;
    expect(oldRow.lifecycle).toBe("archived");
    // Honest lifecycle: an interrupted run is NOT completed.
    expect(oldRow.runState).toBe("active");
    expect(() => h.app.userSessions.postMessage(runA, "hello?")).toThrow(/archived/);
    for (const session of h.repo.listAgentSessions(runA)) expect(session.lifecycle).toBe("archived");
    expect(h.repo.listAgentSessions(runB.id)).toEqual([]);
    expect(h.scheduler.countScheduled(runB.id)).toBe(0);

    // The successor is a fresh session on the SAME project, sequentially legal.
    expect(runB.projectId).toBe(projectId);
    expect(h.repo.listOpenUserSessionsForProject(projectId).map((row) => row.id)).toEqual([runB.id]);

    // Project truth flows: the same requirement graph governs the successor.
    expect(h.app.requirements.derive(runB.id).map((node) => node.id)).toEqual(["r1", "r2"]);

    // The checkpoint records the boundary WITH its stopping reason, derived
    // from the archived row's frozen pause columns.
    const checkpoint = h.app.continuation.latestForSession(runB.id)!;
    expect(checkpoint.sourceUserSessionId).toBe(runA);
    expect(checkpoint.sourcePauseReason).toBe("capacity");
    expect(checkpoint.facts.unfinishedWorkstreams).toEqual([
      expect.objectContaining({ agentSessionId: unfinished.id, openTasks: 1 }),
    ]);
    const digest = h.app.continuation.digest(runB.id);
    expect(digest).toContain("stopped by a provider-capacity pause before completion");
    expect(digest).toContain("Strategy then: Land the parser before any rendering work");

    // Quota is account-wide, not per-session: the successor inherits the live
    // pause stamp, so it waits like everything else and a restart remembers.
    const newRow = h.repo.getUserSession(runB.id)!;
    expect(newRow.pauseReason).toBe("capacity");
    expect(newRow.pausedUntil).not.toBeNull();

    // The operator-facing traces on both sides of the boundary.
    const oldNotices = h.repo.listMessages("user", runA).filter((row) => row.kind === "notice");
    expect(oldNotices.some((row) => row.text.includes("Handed off: this project continues"))).toBe(true);
    const newNotices = h.repo.listMessages("user", runB.id).filter((row) => row.kind === "notice");
    expect(newNotices.some((row) => row.text.includes("Continuing this project from the previous run"))).toBe(true);

    // A duplicate continue (double-click, API retry) cannot mint a second
    // successor: the sequential gate rejects it, naming the open session.
    expect(() => h.app.userSessions.continueFrom(runA, { message: "continue again" }))
      .toThrow(new RegExp(`continuation is sequential`));
    expect(h.repo.listOpenUserSessionsForProject(projectId).length).toBe(1);
  });

  it("a crash between handoff and successor recovers: continue from the already-archived source just creates", () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA, projectId } = seedPriorRun(h);
    // The crash shape: the archive transition committed (checkpoint recorded),
    // the process died before the successor row existed.
    h.app.userSessions.patch(runA, { lifecycle: "archived" });
    expect(h.repo.listOpenUserSessionsForProject(projectId)).toEqual([]);

    const runB = h.app.userSessions.continueFrom(runA, { message: "pick it back up" });
    expect(runB.projectId).toBe(projectId);
    expect(h.app.continuation.latestForSession(runB.id)!.sourceUserSessionId).toBe(runA);
    // Still exactly one checkpoint: the retry converged on the archived record.
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM continuation_checkpoints").get()).toMatchObject({ n: 1 });
  });

  it("a bad continue request archives nothing, and a non-work source is rejected", () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA } = seedPriorRun(h);
    expect(() => h.app.userSessions.continueFrom(runA, { message: "   " })).toThrow(/first message/);
    expect(h.repo.getUserSession(runA)?.lifecycle).toBe("open");
    expect(() => h.app.userSessions.continueFrom("us_missing", { message: "go" })).toThrow(/no user session/);
  });

  it("a restart mid-pause after the handoff still knows the system is paused", async () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA } = seedPriorRun(h);
    h.app.capacity.noteLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 });
    const runB = h.app.userSessions.continueFrom(runA, { message: "continue" });
    // The handoff archived the only previously-stamped open session; the
    // successor's inherited stamp is what survives the restart.
    const restarted = await restartHarness(h);
    expect(restarted.app.capacity.paused).toBe(true);
    expect(restarted.app.capacity.snapshot().reason).toBe("capacity");
    expect(restarted.repo.getUserSession(runB.id)?.pauseReason).toBe("capacity");
  });

  it("ordinary same-session resume is untouched: a pause without a handoff clears in place", () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA } = seedPriorRun(h);
    h.app.capacity.noteLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 });
    expect(h.repo.getUserSession(runA)?.pauseReason).toBe("capacity");
    h.app.capacity.resume({ manual: true });
    const row = h.repo.getUserSession(runA)!;
    expect(row.lifecycle).toBe("open");
    expect(row.pauseReason).toBeNull();
    expect(row.pausedUntil).toBeNull();
  });

  it("the sequential invariant is durable: the database itself rejects a second open session on one project", () => {
    const h = makeHarness(trivialProgram);
    const runA = h.addUserSession();
    const projectId = h.repo.getUserSession(runA)!.projectId;
    // Bypass the service's check-first path — this is the raced-writer shape.
    // (SQLite names the column, not the index, in the violation message.)
    expect(() => h.addUserSession("execute", { projectId })).toThrow(/UNIQUE constraint failed: user_sessions\.project_id/);
    // Archived rows never collide: history accumulates freely.
    h.repo.patchUserSession(runA, { lifecycle: "archived" });
    expect(() => h.addUserSession("execute", { projectId })).not.toThrow();
  });

  it("restart preserves checkpoint creation and selection", async () => {
    const h = makeHarness(trivialProgram);
    const { userSessionId: runA, projectId } = seedPriorRun(h);
    h.app.userSessions.patch(runA, { lifecycle: "archived" });
    const runB = h.addUserSession("execute", { projectId });
    const before = h.app.continuation.digest(runB);
    expect(before).toContain("## Prior-run continuation checkpoint");

    const restarted = await restartHarness(h);
    expect(restarted.app.continuation.digest(runB)).toBe(before);
    expect(restarted.app.continuation.latestForSession(runB)!.sourceUserSessionId).toBe(runA);

    // A boundary crossed after the restart still records.
    addAgentSession(restarted, runB, "gamma-stream");
    restarted.app.userSessions.patch(runB, { lifecycle: "archived" });
    const runC = restarted.addUserSession("execute", { projectId });
    expect(restarted.app.continuation.latestForSession(runC)!.sourceUserSessionId).toBe(runB);
  });
});
