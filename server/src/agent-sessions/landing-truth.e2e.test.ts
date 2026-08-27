/**
 * Ownership-to-landing truth (real git, real stores): the three demonstrated
 * live-run failures, encoded.
 *
 * 1. Cross-scope edit — a seat's ACTUAL changed paths fall inside another
 *    active seat's declared write scope: landing is blocked BEFORE the merge
 *    with structured owner context and salvage, never silently accepted;
 *    explicit shared ownership allows the overlap, and git still decides
 *    textual mergeability (authorized overlap ≠ automatic merge success).
 * 2. Produced ≠ landed — a successful merge records a durable landing by
 *    immutable merge-commit id; a later canonical reset invalidates current
 *    landing truth visibly (event, salvage branch, wake note) while the
 *    historical fact and restart both preserve it, and reachability coming
 *    back restores it.
 * 3. Salvage-pointer honesty — re-provisioning over a dangling worktree
 *    archives the surviving work BEFORE the branch force-reset, so the
 *    recorded salvage pointer never names a branch the Console itself just
 *    emptied (the live run's dangling canon commits).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { events as eventsTable } from "../db/schema.ts";
import type { MessageRow } from "../db/repo.ts";
import { WorktreeManager } from "../runtime/worktree-manager.ts";
import { initMessage, successMessage } from "../sdk/fake.ts";
import { makeDelegationHarness, restartHarness, type DelegationHarness } from "../test-helpers.ts";
import { simpleHandoff } from "./mailroom.ts";
import { WorktreeBinding } from "./worktree-binding.ts";
import type { TransferInput } from "./seams.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t.invalid", ...args], { cwd, encoding: "utf8" }).trim();

function makeRepoDir(): { repo: string; dataDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-land-"));
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init", "--no-gpg-sign");
  return { repo, dataDir: path.join(base, "data") };
}

/**
 * A harness over a real git workspace, plus a WorktreeBinding sharing the
 * app's stores/bus/landing ledger — worktrees are provisioned and landed
 * directly, without scripting provider turns, so each test exercises exactly
 * the landing boundary.
 */
function makeWorld() {
  const { repo, dataDir } = makeRepoDir();
  const worktrees = new WorktreeManager({ dataDir });
  const h = makeDelegationHarness(async function* () {
    yield initMessage();
    yield successMessage();
  }, { workspaceRoot: repo, runtime: { worktrees } });
  const userSessionId = h.addUserSession();
  const transfers: TransferInput[] = [];
  const binding = new WorktreeBinding({
    repo: h.repo, bus: h.bus, artifacts: h.app.artifacts, config: h.config,
    worktrees, getWorkspaceRoot: () => repo,
    escalationTarget: () => "coordinator", isReviewRole: () => false,
    laneBusy: () => false, laneLive: () => false,
    transfer: (input) => { transfers.push(input); return {} as MessageRow; },
    simpleHandoff,
    landings: h.app.landings,
  });
  const provision = (agentSessionId: string, agent: string) => {
    const session = h.repo.getAgentSession(agentSessionId)!;
    const seat = binding.ensureAgentWorktree(session, h.repo.getAgent(agentSessionId, agent)!, repo);
    return seat;
  };
  const land = (agentSessionId: string, agent: string) => {
    const session = h.repo.getAgentSession(agentSessionId)!;
    binding.landOnReport(session, h.repo.getAgent(agentSessionId, agent)!, "completed");
  };
  const eventsOf = (type: string) => h.db.select().from(eventsTable).where(eq(eventsTable.type, type)).all();
  const write = (dir: string, rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  return { h, repo, worktrees, userSessionId, binding, provision, land, transfers, eventsOf, write };
}

describe("ownership-to-landing truth (real git)", () => {
  it("blocks an unplanned cross-scope write before landing, with owner context and salvage", () => {
    const w = makeWorld();
    const { agentSessionId } = w.h.host.createSession({
      userSessionId: w.userSessionId, title: "Measured responsiveness",
      agents: [
        { name: "pacing", profileId: "implementer", owns: ["xtask/src/pacing.rs"] },
        { name: "latency", profileId: "implementer", owns: ["platform/latency"] },
      ],
    });
    const seat = w.provision(agentSessionId, "latency");
    // The live shape: legitimate in-scope work PLUS one edit of pacing's file.
    w.write(seat.worktreePath!, "platform/latency/probe.rs", "// latency probe\n");
    w.write(seat.worktreePath!, "xtask/src/pacing.rs", "// latency's uncoordinated edit\n");
    w.land(agentSessionId, "latency");

    // Not silently landed: no merge, workspace untouched.
    expect(w.eventsOf("agent_session.worktree.merged")).toHaveLength(0);
    expect(fs.existsSync(path.join(w.repo, "xtask/src/pacing.rs"))).toBe(false);
    expect(fs.existsSync(path.join(w.repo, "platform/latency/probe.rs"))).toBe(false);
    expect(git(w.repo, "status", "--porcelain")).toBe("");
    // The structured violation names the path and its declared owner.
    const violations = w.eventsOf("agent_session.worktree.ownership_violation");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.payload).toMatchObject({
      agent: "latency", declaredScopes: ["platform/latency"],
      violations: [{ path: "xtask/src/pacing.rs", scope: "xtask/src/pacing.rs", ownerAgent: "pacing", ownerAgentSessionId: agentSessionId }],
    });
    const payload = violations[0]!.payload as { archivedBranch: string; artifactId: string };
    // The work survives: archived branch + diff artifact + seat salvage pointers.
    expect(git(w.repo, "show", `${payload.archivedBranch}:xtask/src/pacing.rs`)).toContain("uncoordinated");
    expect(w.h.app.artifacts.get(payload.artifactId)?.content).toContain("pacing.rs");
    const after = w.h.repo.getAgent(agentSessionId, "latency")!;
    expect(after.worktreePath).toBeNull();
    expect(after.salvageBranch).toBe(payload.archivedBranch);
    // The failure handoff teaches the resolution paths instead of "permission denied".
    expect(w.transfers).toHaveLength(1);
    const summary = w.transfers[0]!.handoff.core.state.summary!;
    expect(summary).toContain("xtask/src/pacing.rs — declared owner pacing");
    expect(w.transfers[0]!.handoff.core.nextAction).toMatch(/sharedOwns|route these files through their owner/);
    // Nothing was recorded as landed.
    expect(w.h.app.landings.list(w.userSessionId)).toEqual([]);
  });

  it("explicit shared ownership lands the overlap — and git, not ownership, still decides mergeability", () => {
    const w = makeWorld();
    const why = "pacing analyzer and latency accounting co-evolve the pacing tool";
    const { agentSessionId } = w.h.host.createSession({
      userSessionId: w.userSessionId, title: "Measured responsiveness",
      agents: [
        { name: "pacing", profileId: "implementer", owns: [], sharedOwns: [{ scope: "xtask/src/pacing.rs", why }] },
        { name: "latency", profileId: "implementer", owns: ["platform/latency"], sharedOwns: [{ scope: "xtask/src/pacing.rs", why }] },
      ],
    });
    // Both worktrees cut from the same base, BEFORE either lands.
    const latencySeat = w.provision(agentSessionId, "latency");
    const pacingSeat = w.provision(agentSessionId, "pacing");

    w.write(latencySeat.worktreePath!, "xtask/src/pacing.rs", "// latency's coordinated edit\n");
    w.land(agentSessionId, "latency");
    // Authorized overlap landed: merged event, file in the canonical workspace,
    // and a durable landing record whose merge commit IS the new HEAD.
    expect(w.eventsOf("agent_session.worktree.ownership_violation")).toHaveLength(0);
    expect(w.eventsOf("agent_session.worktree.merged")).toHaveLength(1);
    expect(fs.readFileSync(path.join(w.repo, "xtask/src/pacing.rs"), "utf8")).toContain("coordinated");
    const landing = w.h.app.landings.list(w.userSessionId)[0]!;
    expect(landing).toMatchObject({ agent: "latency", agentSessionId, invalidatedAt: null });
    expect(landing.mergeCommit).toBe(git(w.repo, "rev-parse", "HEAD"));

    // The second shared writer edited the same file from the old base: no
    // ownership violation, but a real git conflict — surfaced with the
    // declared owner named, not as a bare merge failure.
    w.write(pacingSeat.worktreePath!, "xtask/src/pacing.rs", "// pacing's divergent edit\n");
    w.land(agentSessionId, "pacing");
    expect(w.eventsOf("agent_session.worktree.ownership_violation")).toHaveLength(0);
    const failed = w.eventsOf("agent_session.worktree.merge_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ agent: "pacing", kind: "conflict", conflicts: ["xtask/src/pacing.rs"] });
    const conflictHandoff = w.transfers.find((t) => t.handoff.core.action === "Completed work failed to merge")!;
    expect(conflictHandoff.handoff.core.state.summary).toContain("declared-owned by latency");
  });

  it("a canonical reset invalidates landed truth visibly, preserves provenance and salvage, and restores when reachability returns", async () => {
    const w = makeWorld();
    const { agentSessionId } = w.h.host.createSession({
      userSessionId: w.userSessionId, title: "canon",
      agents: [{ name: "canon", profileId: "implementer", owns: ["docs/movement-canon.md"] }],
    });
    const seat = w.provision(agentSessionId, "canon");
    w.write(seat.worktreePath!, "docs/movement-canon.md", "# canon\n");
    w.land(agentSessionId, "canon");
    const landed = w.h.app.landings.list(w.userSessionId)[0]!;
    expect(landed.invalidatedAt).toBeNull();
    expect(w.h.app.landings.verify(w.userSessionId)).toMatchObject({ invalidated: [], restored: [] });

    // The live incident: the canonical branch is reset past the landing.
    git(w.repo, "reset", "--hard", seat.worktreeBaseCommit!);
    const outcome = w.h.app.landings.verify(w.userSessionId);
    expect(outcome.invalidated).toHaveLength(1);
    const row = w.h.app.landings.invalidated(w.userSessionId)[0]!;
    // Current truth: invalidated, with the reason and a minted salvage branch
    // pinning the exact merge commit. Historical truth: untouched.
    expect(row.invalidatedReason).toContain("no longer reachable");
    expect(row.salvageRef).toContain("agentique/archive/landing/");
    expect(git(w.repo, "rev-parse", row.salvageRef!)).toBe(landed.mergeCommit);
    expect(row).toMatchObject({ mergeCommit: landed.mergeCommit, landedAt: landed.landedAt });
    expect(w.eventsOf("agent_session.worktree.landing_invalidated")).toHaveLength(1);
    // Main is woken with the fact and the remedy, not left to notice.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(w.h.fake.captured.prompts.some((text) => text.includes("Landed work is no longer in the canonical workspace"))).toBe(true);
    // Verification is idempotent: a second pass changes nothing new.
    expect(w.h.app.landings.verify(w.userSessionId)).toMatchObject({ invalidated: [], restored: [] });

    // Restart preserves landing truth from durable rows alone.
    const restarted = await restartHarness(w.h, { runtime: { worktrees: w.worktrees } });
    expect(restarted.app.landings.invalidated(w.userSessionId)).toHaveLength(1);

    // Re-landing from the salvage branch restores current truth.
    git(w.repo, "merge", row.salvageRef!);
    const recovery = restarted.app.landings.verify(w.userSessionId);
    expect(recovery.restored).toHaveLength(1);
    expect(restarted.app.landings.invalidated(w.userSessionId)).toEqual([]);
    expect(fs.readFileSync(path.join(w.repo, "docs/movement-canon.md"), "utf8")).toBe("# canon\n");
  });

  it("re-provisioning over a dangling worktree archives surviving work BEFORE the branch reset", () => {
    const w = makeWorld();
    const { agentSessionId } = w.h.host.createSession({
      userSessionId: w.userSessionId, title: "movement",
      agents: [{ name: "canon", profileId: "implementer", owns: ["docs/movement-canon.md"] }],
    });
    const seat = w.provision(agentSessionId, "canon");
    w.write(seat.worktreePath!, "docs/movement-canon.md", "# criteria v1\n");
    w.binding.snapshot(agentSessionId, "canon", "turn snapshot");
    const workBranch = seat.worktreeBranch!;
    expect(git(w.repo, "show", `${workBranch}:docs/movement-canon.md`)).toBe("# criteria v1");

    // The worktree directory vanishes out-of-band (crash between removal and
    // release); the seat row still points at it.
    fs.rmSync(seat.worktreePath!, { recursive: true, force: true });
    const reprovisioned = w.provision(agentSessionId, "canon");

    // The fresh worktree branch is force-reset to base — and the commits
    // survived, on the archived branch the salvage pointer actually names.
    // (The old code pointed salvageBranch at the branch it then reset.)
    const after = w.h.repo.getAgent(agentSessionId, "canon")!;
    expect(after.salvageBranch).toContain("agentique/archive/");
    expect(git(w.repo, "show", `${after.salvageBranch}:docs/movement-canon.md`)).toBe("# criteria v1");
    expect(reprovisioned.worktreeBaseCommit).toBe(git(w.repo, "rev-parse", "HEAD"));
    expect(git(w.repo, "rev-parse", reprovisioned.worktreeBranch!)).toBe(reprovisioned.worktreeBaseCommit);
  });
});
