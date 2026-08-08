/**
 * Best-of-N over the fake SDK with real git: fan-out into isolated worktrees,
 * server-side diff capture, reviewer selection through the dedicated tool,
 * and winner-only merge-back.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HandoffService } from "../handoffs/service.ts";
import { WorktreeManager } from "../runtime/worktree-manager.ts";
import { initMessage, sendMessageUse, successMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness, type DelegationHarness } from "../test-helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t.invalid", ...args], { cwd, encoding: "utf8" });

const handoff = (action: string, status: "pending" | "completed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

const envelope = (action: string, status: "pending" | "completed", category: string) =>
  JSON.stringify({ handoff: handoff(action, status), category, checkpointReadiness: "stable" });

function makeRepoDir(): { repo: string; dataDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-bon-"));
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init", "--no-gpg-sign");
  return { repo, dataDir: path.join(base, "data") };
}

interface BonWorld {
  h: DelegationHarness;
  repo: string;
  selection: { winner?: string; rejectAll?: boolean };
  selectResults: unknown[];
}

/**
 * Program: coordinator idles until the reviewer reports; attempt seats write
 * a file named after their worktree dir and close completed; the reviewer
 * invokes select_attempt_winner through its compiled tool, then closes.
 */
function makeBonWorld(selection: { winner?: string; rejectAll?: boolean }): BonWorld {
  const { repo, dataDir } = makeRepoDir();
  const world = { selection, selectResults: [] as unknown[] } as BonWorld;
  const h = makeDelegationHarness(async function* (options, tools) {
    const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
    if (append.includes("selecting the winning attempt")) {
      yield initMessage("review-1");
      const select = tools.find((tool) => tool.name === "select_attempt_winner");
      if (select) {
        const result = await select.handler(world.selection.rejectAll === true
          ? { rejectAll: true, reason: "no attempt is sound" }
          : { winner: world.selection.winner, rejectAll: false, reason: "cleaner diff and passing shape" }, {});
        world.selectResults.push(JSON.parse((result as { content: { text?: string }[] }).content[0]?.text ?? "null"));
      }
      yield sendMessageUse("review-close", "orchestrator", envelope("selection recorded", "completed", "milestone"));
      yield successMessage();
      return;
    }
    if (append.includes("attempt seat of a best-of-N group")) {
      yield initMessage(`attempt-${path.basename(options.cwd ?? "")}`);
      const cwd = options.cwd ?? "";
      fs.writeFileSync(path.join(cwd, `out-${path.basename(cwd)}.txt`), "attempt work\n");
      yield sendMessageUse(`attempt-close-${path.basename(cwd)}`, "orchestrator", envelope("implemented my variant", "completed", "milestone"));
      yield successMessage();
      return;
    }
    if (append.includes("sole coordinator")) {
      yield initMessage(`coord-${Math.random().toString(36).slice(2, 8)}`);
      const latest = world.h?.fake.captured.prompts.at(-1) ?? "";
      if (latest.includes(".review → orchestrator")) {
        yield sendMessageUse("coord-final", "main", envelope("best-of-N landed", "completed", "final"));
      }
      yield successMessage();
      return;
    }
    yield initMessage("other-1");
    yield successMessage();
  }, {
    hostOverrides: {
      getWorkspaceRoot: () => repo,
      worktrees: new WorktreeManager({ dataDir }),
    },
  });
  // The harness wires its own HandoffService against /tmp/test-workspace;
  // repoint file-ref validation at the real temp repo.
  world.h = h;
  world.repo = repo;
  return world;
}

async function seedSession(world: BonWorld) {
  const userSessionId = world.h.addUserSession();
  const created = world.h.host.createSession({ userSessionId, title: "bon", mode: "execute",
    agents: [{ name: "scout", profileId: "explorer" }], briefing: handoff("stand by", "pending") });
  return { userSessionId, agentSessionId: created.agentSessionId };
}

describe("best-of-N worktree execution (fake SDK + real git)", () => {
  it("runs the full flow: fan-out, capture, review, winner-only merge", async () => {
    const world = makeBonWorld({ winner: "" });
    const { agentSessionId } = await seedSession(world);
    const done = collectUntil(world.h.bus, (event) => event.type === "agent_session.attempt_group.closed", 20_000);
    const started = world.h.host.startAttempts({ agentSessionId, assignment: handoff("build the feature", "pending"), owns: ["src/feature"] });
    world.selection.winner = started.seats[0]!;
    const events = await done;

    const startEvents = events.filter((event) => event.type === "agent_session.attempt_group.started");
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]?.payload).toMatchObject({ attempts: 2, dirtyWorkspace: false });
    expect(started.seats).toHaveLength(2);

    const attemptOptions = world.h.fake.captured.options.filter((options) => {
      const append = typeof options.systemPrompt === "object" && !Array.isArray(options.systemPrompt) ? options.systemPrompt.append ?? "" : "";
      return append.includes("attempt seat of a best-of-N group");
    });
    expect(attemptOptions).toHaveLength(2);
    for (const options of attemptOptions) {
      expect(options.cwd).toContain(path.join("worktrees", agentSessionId));
      const sandbox = options.sandbox as { filesystem: { allowWrite: string[]; allowRead: string[] } };
      expect(sandbox.filesystem.allowWrite).toEqual([options.cwd]);
      expect(sandbox.filesystem.allowRead).toContain(world.repo);
      expect(options.allowedTools).not.toContain("mcp__console_agent__select_attempt_winner");
    }

    const completed = events.filter((event) => event.type === "agent_session.attempt.completed");
    expect(completed).toHaveLength(2);
    for (const event of completed) {
      expect(event.payload).toMatchObject({ status: "completed", filesChanged: 1 });
      const artifact = world.h.bus.getArtifact((event.payload as { artifactId: string }).artifactId);
      expect(artifact?.content).toContain("out-");
    }

    expect(events.filter((event) => event.type === "agent_session.attempt_group.review_started")).toHaveLength(1);
    const reviewerAssignment = world.h.repo.latestHandoff({ userSessionId: (await Promise.resolve(events[0]?.userSessionId)) as string, agentSessionId, participant: `${started.seats[0]!.split(".")[0]}.review` });
    expect(reviewerAssignment?.referenceWarnings).toEqual([]);
    expect(reviewerAssignment?.core.state.evidence).toHaveLength(2);

    expect(world.selectResults).toHaveLength(1);
    expect(world.selectResults[0]).toMatchObject({ merged: true, winner: started.seats[0] });
    expect(events.filter((event) => event.type === "agent_session.attempt_group.merged")).toHaveLength(1);
    expect(events.filter((event) => event.type === "agent_session.attempt_group.closed")[0]?.payload).toMatchObject({ status: "merged" });

    const files = fs.readdirSync(world.repo);
    expect(files.some((file) => file.endsWith("-1.txt"))).toBe(true);
    expect(files.some((file) => file.endsWith("-2.txt"))).toBe(false);
    expect(git(world.repo, "status", "--porcelain").trim()).toBe("");

    const group = world.h.repo.getAttemptGroup(started.groupId);
    expect(group?.status).toBe("merged");
    for (const attempt of Object.values(group?.attemptsState ?? {})) {
      expect(fs.existsSync(attempt.worktreePath)).toBe(false);
      expect(world.h.bus.getArtifact(attempt.artifactId ?? "")).toBeDefined();
    }
  });

  it("refuses fan-out in a non-git workspace with an explanatory error", async () => {
    const world = makeBonWorld({ winner: "impl.1" });
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-plain-"));
    const h = makeDelegationHarness(async function* () {
      yield initMessage("idle-1");
      yield successMessage();
    }, { hostOverrides: { getWorkspaceRoot: () => plainDir, worktrees: new WorktreeManager({ dataDir: path.join(plainDir, "data") }) } });
    const userSessionId = h.addUserSession();
    const created = h.host.createSession({ userSessionId, title: "no-git", mode: "execute", agents: [{ name: "scout", profileId: "explorer" }] });
    expect(() => h.host.startAttempts({ agentSessionId: created.agentSessionId, assignment: handoff("go", "pending"), owns: ["x"] }))
      .toThrow(/require the workspace to be a git repository/);
    expect(h.repo.listParticipants(created.agentSessionId).some((p) => p.attemptRole === "attempt")).toBe(false);
    expect(h.repo.findOpenAttemptGroup(created.agentSessionId)).toBeUndefined();
    void world;
  });

  it("reject-all closes the group, keeps diffs, and allows a fresh group", async () => {
    const world = makeBonWorld({ rejectAll: true });
    const { agentSessionId } = await seedSession(world);
    const done = collectUntil(world.h.bus, (event) => event.type === "agent_session.attempt_group.closed", 20_000);
    const started = world.h.host.startAttempts({ agentSessionId, assignment: handoff("build", "pending"), owns: ["src"] });
    const events = await done;
    const selected = events.filter((event) => event.type === "agent_session.attempt_group.selected");
    expect(selected[0]?.payload).toMatchObject({ rejectedAll: true, winner: null });
    expect(world.h.repo.getAttemptGroup(started.groupId)?.status).toBe("rejected");
    expect(fs.readdirSync(world.repo).some((file) => file.startsWith("out-"))).toBe(false);
    for (const attempt of Object.values(world.h.repo.getAttemptGroup(started.groupId)?.attemptsState ?? {})) {
      expect(world.h.bus.getArtifact(attempt.artifactId ?? "")).toBeDefined();
    }
    const again = world.h.host.startAttempts({ agentSessionId, assignment: handoff("retry", "pending"), owns: ["src"], baseSeatName: "retry" });
    expect(again.seats).toHaveLength(2);
  });

  it("surfaces a merge conflict, fails the group, workspace stays clean", async () => {
    const world = makeBonWorld({ winner: "" });
    const { agentSessionId } = await seedSession(world);
    let conflictPlanted = false;
    const seen = collectUntil(world.h.bus, (event) => {
      if (event.type === "agent_session.attempt_group.started" && !conflictPlanted) {
        conflictPlanted = true;
      }
      return event.type === "agent_session.attempt_group.closed";
    }, 20_000);
    const started = world.h.host.startAttempts({ agentSessionId, assignment: handoff("build", "pending"), owns: ["src"] });
    world.selection.winner = started.seats[0]!;
    // Advance main so the winner's out-*.txt collides at merge time.
    const collidingName = `out-${started.groupId}-1.txt`;
    fs.writeFileSync(path.join(world.repo, collidingName), "diverged on main\n");
    git(world.repo, "add", "-A");
    git(world.repo, "commit", "-m", "diverge", "--no-gpg-sign");
    const events = await seen;
    expect(world.selectResults[0]).toMatchObject({ merged: false });
    expect(events.filter((event) => event.type === "agent_session.attempt_group.merge_failed")).toHaveLength(1);
    expect(world.h.repo.getAttemptGroup(started.groupId)?.status).toBe("failed");
    expect(git(world.repo, "status", "--porcelain").trim()).toBe("");
    expect(fs.readFileSync(path.join(world.repo, collidingName), "utf8")).toBe("diverged on main\n");
  });

  it("records a dirty-workspace warning at fan-out", async () => {
    const world = makeBonWorld({ winner: "" });
    const { agentSessionId } = await seedSession(world);
    fs.writeFileSync(path.join(world.repo, "uncommitted.txt"), "local edit\n");
    const done = collectUntil(world.h.bus, (event) => event.type === "agent_session.attempt_group.started", 20_000);
    const started = world.h.host.startAttempts({ agentSessionId, assignment: handoff("build", "pending"), owns: ["src"] });
    world.selection.winner = started.seats[0]!;
    expect(started.dirtyWorkspace).toBe(true);
    const events = await done;
    expect(events.filter((event) => event.type === "agent_session.attempt_group.started")[0]?.payload).toMatchObject({ dirtyWorkspace: true });
    await collectUntil(world.h.bus, (event) => event.type === "agent_session.attempt_group.closed", 20_000);
  });
});
