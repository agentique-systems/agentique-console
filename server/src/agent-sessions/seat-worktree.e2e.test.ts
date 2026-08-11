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
import { initMessage, sendHandoffUse, successMessage, toolResultMessage, toolUseMessage } from "../sdk/fake.ts";
import { collectUntil, makeDelegationHarness, type DelegationHarness } from "../test-helpers.ts";

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
