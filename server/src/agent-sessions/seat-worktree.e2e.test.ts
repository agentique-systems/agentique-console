/**
 * Per-assignment worktree isolation for write agents: default-on in git
 * workspaces, atomic merge-on-completion, per-turn snapshots, conflict
 * surfacing, and the CONSOLE_AGENT_WORKTREES=0 escape hatch.
 */
import { loadConfig } from "../config.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "../runtime/worktree-manager.ts";
import { errorMessage, initMessage, sendHandoffUse, successMessage, toolResultMessage, toolUseMessage } from "../sdk/fake.ts";
import { agentRoleOf, collectUntil, makeDelegationHarness, type DelegationHarness } from "../test-helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t.invalid", ...args], { cwd, encoding: "utf8" });

const handoff = (action: string, status: "pending" | "completed" | "failed") => ({ core: { schemaVersion: 1 as const, taskId: null, status, risk: "low" as const,
  action, state: { summary: action, evidence: [] }, result: { summary: status === "completed" ? action : null, artifacts: [] },
  uncertainty: [], nextAction: status === "completed" ? null : action, requestExpandedContext: false }, extension: { kind: "generic" as const, data: {} } });

const envelope = (action: string, status: "pending" | "completed" | "failed", category: string) =>
  JSON.stringify({ handoff: handoff(action, status), category, checkpointReadiness: "stable" });

function makeRepoDir(): { repo: string; dataDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-swt-"));
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init", "--no-gpg-sign");
  return { repo, dataDir: path.join(base, "data") };
}

/**
 * Coordinator assigns "dev" (implementer) once, then finals after dev's
 * report. Dev writes a file in its cwd and closes with the given status.
 */
function makeWorld(devStatus: "completed" | "failed", options: { conflict?: boolean } = {}) {
  const { repo, dataDir } = makeRepoDir();
  let coordinatorTurns = 0;
  const h = makeDelegationHarness(async function* (opts) {
    const append = typeof opts.systemPrompt === "object" && !Array.isArray(opts.systemPrompt) ? opts.systemPrompt.append ?? "" : "";
    if (append.includes("sole coordinator")) {
      coordinatorTurns += 1;
      yield initMessage(`coord-${coordinatorTurns}`);
      yield coordinatorTurns === 1
        ? sendHandoffUse("send-1", "dev", { action: "implement the widget", status: "pending", category: "assignment" })
        : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "wrapped", status: "completed", category: "final" });
      yield successMessage();
      return;
    }
    if (append.includes("exclusively own the assigned files")) {
      yield initMessage("dev-1");
      const cwd = opts.cwd ?? "";
      if (options.conflict) {
        // Advance main between worktree creation and the dev's report.
        fs.writeFileSync(path.join(repo, "widget.txt"), "diverged on main\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-m", "diverge", "--no-gpg-sign");
      }
      fs.writeFileSync(path.join(cwd, "widget.txt"), "implemented\n");
      yield toolUseMessage("w-1", "Write", { file_path: "widget.txt" });
      yield toolResultMessage("w-1", "ok");
      yield sendHandoffUse("dev-close", "coordinator", { action: "widget implemented", status: devStatus, category: "milestone" });
      yield successMessage();
      return;
    }
    yield initMessage("other-1");
    yield successMessage({});
  }, { workspaceRoot: repo, runtime: { worktrees: new WorktreeManager({ dataDir }) } });
  return { h, repo };
}

async function runFlow(h: DelegationHarness) {
  const userSessionId = h.addUserSession();
  const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 20_000);
  const created = h.host.createSession({ userSessionId, title: "swt", agents: [{ name: "dev", profileId: "implementer", owns: ["widget"] }], briefing: handoff("build widget", "pending") });
  return { created, events: await done };
}

describe("agent worktree isolation (fake SDK + real git)", () => {
  it("write agent is isolated; completed work merges atomically with a diff artifact and turn snapshot", async () => {
    const { h, repo } = makeWorld("completed");
    const { created, events } = await runFlow(h);
    const createdEvents = events.filter((event) => event.type === "agent_session.worktree.created");
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]?.payload).toMatchObject({ agent: "dev" });
    const devOptions = h.fake.captured.options.find((opts) => {
      const append = typeof opts.systemPrompt === "object" && !Array.isArray(opts.systemPrompt) ? opts.systemPrompt.append ?? "" : "";
      return append.includes("exclusively own the assigned files");
    });
    expect(devOptions?.cwd).toContain(path.join("worktrees", created.agentSessionId));
    expect((devOptions?.systemPrompt as { append?: string })?.append).toContain("isolated worktree");
    const merged = events.filter((event) => event.type === "agent_session.worktree.merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.payload).toMatchObject({ agent: "dev", filesChanged: 1 });
    expect(fs.readFileSync(path.join(repo, "widget.txt"), "utf8")).toBe("implemented\n");
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    const artifact = h.app.artifacts.get((merged[0]?.payload as { artifactId: string }).artifactId);
    expect(artifact?.content).toContain("widget.txt");
    // The merge commit's parent chain includes the turn-snapshot/report commits.
    expect(git(repo, "log", "--oneline")).toContain("Merge seat dev");
    const seat = h.repo.getAgent(created.agentSessionId, "dev");
    expect(seat?.worktreePath).toBeNull();
  });

  it("failed work is discarded with the diff retained; workspace untouched", async () => {
    const { h, repo } = makeWorld("failed");
    const { events } = await runFlow(h);
    const discarded = events.filter((event) => event.type === "agent_session.worktree.discarded");
    expect(discarded).toHaveLength(1);
    expect(discarded[0]?.payload).toMatchObject({ agent: "dev", reason: "seat reported failed" });
    expect(fs.existsSync(path.join(repo, "widget.txt"))).toBe(false);
    const artifact = h.app.artifacts.get((discarded[0]?.payload as { artifactId: string }).artifactId);
    expect(artifact?.content).toContain("widget.txt");
  });

  it("infra failure (console-synthesized) archives the branch with salvage pointers instead of deleting", async () => {
    // Dev writes real work, then its PROVIDER TURN dies — the console reports
    // the failure for it. The agent never judged its own work bad, so the
    // branch must archive, not `-D`.
    const { repo, dataDir } = makeRepoDir();
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (opts) {
      const append = typeof opts.systemPrompt === "object" && !Array.isArray(opts.systemPrompt) ? opts.systemPrompt.append ?? "" : "";
      if (append.includes("sole coordinator")) {
        coordinatorTurns += 1;
        yield initMessage(`coord-${coordinatorTurns}`);
        yield coordinatorTurns === 1
          ? sendHandoffUse("send-1", "dev", { action: "implement the widget", status: "pending", category: "assignment" })
          : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "wrapped after dev's turn died", status: "failed", category: "final" });
        yield successMessage();
        return;
      }
      if (append.includes("exclusively own the assigned files")) {
        yield initMessage("dev-1");
        fs.writeFileSync(path.join(opts.cwd ?? "", "widget.txt"), "half implemented\n");
        yield toolUseMessage("w-1", "Write", { file_path: "widget.txt" });
        yield toolResultMessage("w-1", "ok");
        yield errorMessage("error_during_execution");
        return;
      }
      yield initMessage("other-1");
      yield successMessage({});
    }, { workspaceRoot: repo, runtime: { worktrees: new WorktreeManager({ dataDir }) } });

    const { created, events } = await runFlow(h);
    const discarded = events.filter((event) => event.type === "agent_session.worktree.discarded");
    expect(discarded).toHaveLength(1);
    const payload = discarded[0]?.payload as { reason: string; artifactId: string; archivedBranch: string };
    expect(payload.reason).toBe("seat turn failed under the console; work archived");
    expect(payload.archivedBranch).toBe(`agentique/archive/seat/${created.agentSessionId}/dev-0`);
    // The branch survives in the repo; the workspace itself is untouched.
    expect(git(repo, "branch", "--list", payload.archivedBranch).trim()).not.toBe("");
    expect(fs.existsSync(path.join(repo, "widget.txt"))).toBe(false);
    // Salvage pointers on the seat make the work findable by checkpoints and sign-off.
    const seat = h.repo.getAgent(created.agentSessionId, "dev");
    expect(seat?.salvageBranch).toBe(payload.archivedBranch);
    expect(seat?.salvageArtifactId).toBe(payload.artifactId);
    const artifact = h.app.artifacts.get(payload.artifactId);
    expect(artifact?.content).toContain("widget.txt");
    // The console-synthesized failure handoff is flagged, so report scans skip it.
    const failureRow = h.sqlite.prepare(
      "SELECT synthetic FROM handoff_records WHERE sender = 'dev' AND trigger = 'failure'").get() as { synthetic: number } | undefined;
    expect(failureRow?.synthetic).toBe(1);
  });

  it("merge conflict posts a failure handoff and leaves the workspace clean", async () => {
    const { h, repo } = makeWorld("completed", { conflict: true });
    const { created, events } = await runFlow(h);
    const failedMerge = events.filter((event) => event.type === "agent_session.worktree.merge_failed");
    expect(failedMerge).toHaveLength(1);
    expect((failedMerge[0]?.payload as { conflicts: string[] }).conflicts).toContain("widget.txt");
    expect(fs.readFileSync(path.join(repo, "widget.txt"), "utf8")).toBe("diverged on main\n");
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    const failures = h.repo.listMessages("agent", created.agentSessionId)
      .filter((row) => row.speakerName === "dev" && (row.payload?.handoff as { action?: string } | undefined)?.action === "Completed work failed to merge");
    expect(failures).toHaveLength(1);
  });

  it("read-only agents never get worktrees; a workspace with isolation off runs direct", async () => {
    // Auto-init would normally make this directory a repo, so isolation is
    // explicitly disabled here — the genuine no-isolation path, which a nested
    // repo or CONSOLE_AUTO_INIT_GIT=0 also produces.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-plain-"));
    let coordinatorTurns = 0;
    const h = makeDelegationHarness(async function* (opts) {
      const append = typeof opts.systemPrompt === "object" && !Array.isArray(opts.systemPrompt) ? opts.systemPrompt.append ?? "" : "";
      if (append.includes("sole coordinator")) {
        coordinatorTurns += 1;
        yield initMessage(`coord-${coordinatorTurns}`);
        yield coordinatorTurns === 1
          ? sendHandoffUse("send-1", "dev", { action: "inspect the widget", status: "pending", category: "assignment" })
          : sendHandoffUse(`send-${coordinatorTurns}`, "main", { action: "done", status: "completed", category: "final" });
        yield successMessage();
        return;
      }
      yield initMessage("seat-1");
      yield sendHandoffUse("seat-close", "coordinator", { action: "looked around", status: "completed", category: "milestone" });
      yield successMessage();
    }, { workspaceRoot: plain, runtime: { worktrees: new WorktreeManager({ dataDir: path.join(plain, "data") }) },
      config: { infra: { autoInitGit: false } } });
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 20_000);
    h.host.createSession({ userSessionId, title: "plain", agents: [{ name: "dev", profileId: "implementer", owns: ["src/widget.ts"] }, { name: "scout", profileId: "explorer" }], briefing: handoff("go", "pending") });
    const events = await done;
    expect(events.some((event) => event.type === "agent_session.worktree.created")).toBe(false);
    const seatOptions = h.fake.captured.options.filter((opts) => {
      const append = typeof opts.systemPrompt === "object" && !Array.isArray(opts.systemPrompt) ? opts.systemPrompt.append ?? "" : "";
      return append.includes("exclusively own the assigned files") || append.includes("Inspect only the assigned scope");
    });
    expect(seatOptions.length).toBeGreaterThan(0);
    for (const opts of seatOptions) expect(opts.cwd).toBe(plain);
  });

  /**
   * The 2026-08-12 live run, reduced. An evaluator loop's generator reports
   * `needs_verification` to its evaluator — exactly what its brief instructs —
   * so it NEVER declares itself completed, and seat-level landing could never
   * fire. The run produced a working deliverable and left the operator's
   * workspace empty, the file stranded on an unmerged branch. Landing belongs
   * to the session's report, and the reviewer must be cut from the branch it is
   * reviewing rather than from a baseline that provably lacks the work.
   */
  it("lands a generator that never says 'completed', and seats the evaluator on its branch", async () => {
    const { repo, dataDir } = makeRepoDir();
    // Read INSIDE the judge's turn: its read-only snapshot is discarded the
    // moment it reports, so afterwards there is nothing left to inspect.
    let judgeSaw: string | null = null;
    const h = makeDelegationHarness(async function* (opts) {
      const role = agentRoleOf(opts).role;
      yield initMessage(`${role}-1`);
      if (role === "generator") {
        fs.writeFileSync(path.join(opts.cwd ?? "", "index.html"), "<!doctype html>\n");
        yield toolUseMessage("w-1", "Write", { file_path: "index.html" });
        yield toolResultMessage("w-1", "ok");
        // The pattern's own instruction: hand the draft over for judging.
        yield sendHandoffUse("gen-1", "judge", { action: "first playable build", status: "needs_verification", category: "milestone" });
      } else if (role === "evaluator") {
        const own = path.join(opts.cwd ?? "", "index.html");
        judgeSaw = fs.existsSync(own) ? fs.readFileSync(own, "utf8") : null;
        yield sendHandoffUse("judge-1", "main", { action: "Verdict: ACCEPT", status: "completed", category: "final" });
      }
      yield successMessage();
    }, { workspaceRoot: repo, runtime: { worktrees: new WorktreeManager({ dataDir }) } });

    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 20_000);
    h.host.createSession({ userSessionId, title: "loop", pattern: "evaluator_optimizer",
      agents: [{ name: "builder", profileId: "implementer", model: "model-a", owns: ["index.html"] }, { name: "judge", profileId: "reviewer", model: "model-b" }],
      briefing: handoff("build it", "pending") });
    await done;

    // The judge reviewed the actual work: its snapshot contained the file.
    expect(judgeSaw).toBe("<!doctype html>\n");
    // ...and the operator's workspace has it, from a seat that never once
    // reported itself completed.
    expect(fs.readFileSync(path.join(repo, "index.html"), "utf8")).toBe("<!doctype html>\n");
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("CONSOLE_AGENT_WORKTREES=0 disables isolation in a git workspace", async () => {
    const { repo, dataDir } = makeRepoDir();
    const h = makeDelegationHarness(async function* (opts) {
      const append = typeof opts.systemPrompt === "object" && !Array.isArray(opts.systemPrompt) ? opts.systemPrompt.append ?? "" : "";
      yield initMessage(append.includes("sole coordinator") ? "coord-1" : "dev-1");
      if (append.includes("sole coordinator")) {
        yield sendHandoffUse("send-1", "main", { action: "done", status: "completed", category: "final" });
      }
      yield successMessage();
    }, { workspaceRoot: repo, runtime: { worktrees: new WorktreeManager({ dataDir }) } });
    h.config.policy.agentWorktrees = false;
    const userSessionId = h.addUserSession();
    const done = collectUntil(h.bus, (event) => event.type === "agent_session.result.returned", 20_000);
    h.host.createSession({ userSessionId, title: "off", agents: [{ name: "dev", profileId: "implementer", owns: ["src/widget.ts"] }], briefing: handoff("go", "pending") });
    const events = await done;
    expect(events.some((event) => event.type === "agent_session.worktree.created")).toBe(false);
  });
});
