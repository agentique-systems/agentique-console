/**
 * Publication races and death windows over a real repository, the real
 * SQLite file, and the production publication port (execution-model §9.4,
 * §14; invariant 16), driven by deterministic barriers and, where the claim
 * is about a process, a real child process killed with SIGKILL:
 *
 * 1. a later uncommitted edit on a published path, and a later commit
 *    between the atomic Target update and the checkout handling — the
 *    authoritative result is the candidate, the operator's work survives,
 *    and the checkout is reported as left unchanged;
 * 2. the Target moved before the compare-and-swap — a definite
 *    `target_changed`, nothing applied, no receipt;
 * 3. process death after the atomic Target update and receipt, before
 *    SQLite records success — recovery records success exactly once from
 *    the receipt, and a replay after the Target moved again changes
 *    nothing;
 * 4. an interrupted preparation (death before the marker) and a damaged
 *    marker — re-prepared to identical facts, verified, applied once;
 * 5. a staging cleanup failure — the committed outcome never changes and a
 *    later release succeeds.
 *
 * Process death only: nothing here proves power-loss durability.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PublicationId, RunId } from "@agentique-console/core";
import { RunPublicationService } from "../execution/publication.ts";
import { gitSync, text } from "../workspace-state/git.ts";
import { PUBLICATION_CANDIDATE_REF_PREFIX, PUBLICATION_RECEIPT_REF_PREFIX } from "../workspace-state/providers/git.ts";
import { WorkspacePublication, type PublicationHooks } from "../workspace-state/publish.ts";
import { readTree, writeFiles } from "../workspace-state/test-support.ts";
import type { ConsoleRuntime } from "./console-runtime.ts";
import type { PublicationCrashArgs, PublicationCrashSidecar, PublicationCrashWindow } from "./publication-crash-child-test-support.ts";
import { commitAll, completeRunOverRepository, headOf, initFixtureRepository, newWorldDirectory, openWorld, publicationRows, refExists, removeWorldDirectory, reportOf, statusOf, type CompletedFixtureRun } from "./publication-git-test-support.ts";

const CHILD = fileURLToPath(new URL("./publication-crash-child-test-support.ts", import.meta.url));
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASE_TIMEOUT_MS = 180_000;

const commitIdOf = (identity: { kind: string; commitId?: string }) => (identity.kind === "git" && identity.commitId !== undefined ? identity.commitId : "");

interface World {
  dir: string;
  repo: string;
  initialHead: string;
  run: CompletedFixtureRun;
}

/** A world whose first process completes the fixture Run; every later process reopens the same directory. */
async function newWorld(files?: Record<string, string | null>): Promise<World> {
  const dir = newWorldDirectory();
  const { repo, initialHead } = initFixtureRepository(dir);
  const runtime = openWorld(dir);
  try {
    const run = await completeRunOverRepository(runtime, repo, files);
    return { dir, repo, initialHead, run };
  } finally {
    runtime.close();
  }
}

async function withProcess<T>(w: World, body: (runtime: ConsoleRuntime) => Promise<T> | T, options: { recover?: boolean } = {}): Promise<T> {
  const runtime = openWorld(w.dir);
  try {
    if (options.recover !== false) {
      const report = runtime.recovery.recover();
      expect(report.blobs.complete).toBe(true);
    }
    return await body(runtime);
  } finally {
    runtime.close();
  }
}

/** Requests and resolves the publish Decision for the world's Run. */
function authorize(runtime: ConsoleRuntime, runId: RunId): PublicationId {
  const { decision } = runtime.publication.request({ runId, requestedStrategy: { kind: "automatic" } });
  const resolved = runtime.publication.resolve({ runId, decisionId: decision.id, option: "publish" });
  if (resolved.kind !== "publishing") throw new Error(resolved.kind);
  return resolved.publicationId;
}

/** A publication service over the runtime's rows and a port with test barriers. */
function hookedService(runtime: ConsoleRuntime, hooks: PublicationHooks): RunPublicationService {
  return new RunPublicationService({ ctx: runtime.ctx, stores: runtime.stores, port: new WorkspacePublication(runtime.layout, hooks), checks: runtime.checks, diagnostics: (d) => runtime.diagnostics.push(d) });
}

/** Advances until `status` holds (or nothing durable can happen), returning every outcome kind. */
async function advanceUntil(service: RunPublicationService, publicationId: PublicationId, until: (kind: string) => boolean): Promise<string[]> {
  const kinds: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const outcome = await service.advance(publicationId);
    kinds.push(outcome.kind);
    if (until(outcome.kind) || outcome.kind === "quiescent" || outcome.kind === "infrastructure_failure" || outcome.kind === "stale") break;
  }
  return kinds;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  sidecar: PublicationCrashSidecar | null;
}

function runChild(w: World, publicationId: PublicationId, window: PublicationCrashWindow): Promise<ChildExit> {
  const stamp = `${window}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sidecar = path.join(w.dir, `${stamp}.json`);
  const stderrFile = path.join(w.dir, `${stamp}.stderr`);
  const stderrFd = fs.openSync(stderrFile, "w");
  const args: PublicationCrashArgs = { dir: w.dir, publicationId, sidecar, window };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", CHILD, JSON.stringify(args)], { cwd: SERVER_ROOT, stdio: ["ignore", "ignore", stderrFd], env: { ...process.env, NODE_OPTIONS: "" } });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      fs.closeSync(stderrFd);
      const record = fs.existsSync(sidecar) ? (JSON.parse(fs.readFileSync(sidecar, "utf8")) as PublicationCrashSidecar) : null;
      resolve({ code, signal, stderr: fs.readFileSync(stderrFile, "utf8"), sidecar: record });
    });
  });
}

async function crash(w: World, publicationId: PublicationId, window: PublicationCrashWindow): Promise<PublicationCrashSidecar> {
  const exit = await runChild(w, publicationId, window);
  expect(exit.stderr, exit.stderr).toBe("");
  expect(exit.code === 0).toBe(false);
  expect(exit.sidecar, "sidecar").not.toBeNull();
  expect(exit.sidecar!.window).toBe(window);
  expect(exit.sidecar!.inTransaction).toBe(false);
  return exit.sidecar!;
}

describe("publication over a real repository: races and process death (invariant 16)", () => {
  it("keeps a later uncommitted edit on a published path and a later commit made between the atomic update and the checkout handling; the Target result is the candidate and the checkout is reported unchanged", { timeout: CASE_TIMEOUT_MS }, async () => {
    const w = await newWorld();
    try {
      // (a) The operator edits the very file the Publication changes, after the candidate was verified and before the apply.
      await withProcess(w, async (runtime) => {
        const publicationId = authorize(runtime, w.run.runId);
        expect(await advanceUntil(runtime.publication, publicationId, (k) => k === "applying")).toEqual(["prepared", "verified", "applying"]);
        writeFiles(w.repo, { "src/app.js": "operator edit\n" });
        const outcome = await runtime.publication.advance(publicationId);
        expect(outcome).toMatchObject({ kind: "succeeded", alreadyApplied: false, checkout: { kind: "unchanged", reason: "local_changes" } });
        expect(headOf(w.repo, "refs/heads/main")).toBe(commitIdOf(w.run.final));
        expect(readTree(w.repo)["src/app.js"]).toBe("operator edit\n");
        expect(reportOf(runtime, publicationId)).toMatchObject({ outcome: "succeeded", checkout: { kind: "unchanged", reason: "local_changes" } });
        expect(await runtime.publication.advance(publicationId)).toMatchObject({ kind: "released" });
      });
      // The operator's edit is still there. The checkout was left exactly as it was: its index still holds the pre-publication tree, so
      // against the moved branch it shows the published paths as staged reversals plus the operator's own unstaged edit — truthfully
      // reported as `unchanged`, never silently "synchronized".
      expect(readTree(w.repo)["src/app.js"]).toBe("operator edit\n");
      expect(statusOf(w.repo)).toEqual(["D  docs/notes.md", "MM src/app.js"].sort());
    } finally {
      removeWorldDirectory(w.dir);
    }
    // (b) A later commit between the reference transaction and the checkout handling, through the deterministic barrier.
    const w2 = await newWorld();
    try {
      await withProcess(w2, async (runtime) => {
        let operatorCommit: string | null = null;
        const service = hookedService(runtime, {
          afterTargetUpdate: () => {
            // The Target already moved to the candidate: the operator commits on top of it from their (still old) working copy.
            writeFiles(w2.repo, { "operator.txt": "after\n" });
            operatorCommit = commitAll(w2.repo, "operator commit after the publication");
          },
        });
        const publicationId = authorize(runtime, w2.run.runId);
        expect(await advanceUntil(service, publicationId, (k) => k === "applying")).toEqual(["prepared", "verified", "applying"]);
        const outcome = await service.advance(publicationId);
        expect(outcome).toMatchObject({ kind: "succeeded", alreadyApplied: false, checkout: { kind: "unchanged", reason: "head_moved" } });
        // The authoritative result names the candidate; the receipt does too; the branch now holds the operator's later commit, whose parent is the candidate.
        expect(operatorCommit).not.toBeNull();
        expect(headOf(w2.repo, "refs/heads/main")).toBe(operatorCommit);
        expect(text(gitSync(["rev-parse", `${operatorCommit}^`], { cwd: w2.repo }))).toBe(commitIdOf(w2.run.final));
        expect(headOf(w2.repo, `${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId}`)).toBe(commitIdOf(w2.run.final));
        expect(runtime.stores.snapshots.get(runtime.stores.publications.get(publicationId).targetAfterSnapshotId!).identity).toEqual(w2.run.final);
        expect(readTree(w2.repo)["operator.txt"]).toBe("after\n");
        expect(reportOf(runtime, publicationId)).toMatchObject({ checkout: { kind: "unchanged", reason: "head_moved" } });
      });
    } finally {
      removeWorldDirectory(w2.dir);
    }
  });

  it("refuses definitely when the Target moved before the compare-and-swap: nothing applied, no receipt, a terminal target_changed, and the operator's commit untouched", { timeout: CASE_TIMEOUT_MS }, async () => {
    const w = await newWorld();
    try {
      await withProcess(w, async (runtime) => {
        const publicationId = authorize(runtime, w.run.runId);
        expect(await advanceUntil(runtime.publication, publicationId, (k) => k === "applying")).toEqual(["prepared", "verified", "applying"]);
        writeFiles(w.repo, { "operator.txt": "before\n" });
        const operatorCommit = commitAll(w.repo, "operator commit before the apply");
        const outcome = await runtime.publication.advance(publicationId);
        expect(outcome).toMatchObject({ kind: "failed", failure: { kind: "target_changed" } });
        expect(headOf(w.repo, "refs/heads/main")).toBe(operatorCommit);
        expect(refExists(w.repo, `${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId}`)).toBe(false);
        expect(runtime.stores.publications.get(publicationId)).toMatchObject({ status: "failed", failure: { kind: "target_changed" }, targetAfterSnapshotId: null });
        expect(reportOf(runtime, publicationId)).toMatchObject({ outcome: "failed", failure: { kind: "target_changed" }, checkout: null });
        expect(await runtime.publication.advance(publicationId)).toMatchObject({ kind: "released" });
        expect(refExists(w.repo, `${PUBLICATION_CANDIDATE_REF_PREFIX}${publicationId}`)).toBe(false);
        expect(runtime.stores.runs.get(w.run.runId).status).toBe("completed");
      });
    } finally {
      removeWorldDirectory(w.dir);
    }
  });

  it("survives process death after the atomic Target update and receipt, before SQLite records success: recovery records success exactly once from the receipt, and a replay after the Target moved again changes nothing", { timeout: CASE_TIMEOUT_MS }, async () => {
    const w = await newWorld();
    try {
      const publicationId = await withProcess(w, async (runtime) => {
        const id = authorize(runtime, w.run.runId);
        expect(await advanceUntil(runtime.publication, id, (k) => k === "applying")).toEqual(["prepared", "verified", "applying"]);
        return id;
      });
      const sidecar = await crash(w, publicationId, "after_target_update");
      expect(sidecar.status).toBe("applying");
      // Immediately after death: the Target holds the candidate, the receipt exists, SQLite still says applying, and no terminal Event exists.
      expect(headOf(w.repo, "refs/heads/main")).toBe(commitIdOf(w.run.final));
      expect(headOf(w.repo, `${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId}`)).toBe(commitIdOf(w.run.final));
      await withProcess(w, (runtime) => {
        expect(runtime.stores.publications.get(publicationId).status).toBe("applying");
        expect(publicationRows(runtime, w.run.runId).events).toEqual(["publication.requested", "publication.prepared", "publication.verified", "publication.applying"]);
      }, { recover: false });
      // The next process recovers: the retried apply finds the receipt and success is recorded once; the checkout was not handled by that call.
      const rows = await withProcess(w, async (runtime) => {
        const outcomes = await runtime.publication.reconcileOutstanding();
        expect(outcomes.map((o) => o.kind)).toEqual(["succeeded", "released"]);
        expect(outcomes[0]).toMatchObject({ kind: "succeeded", alreadyApplied: true, checkout: { kind: "unknown" } });
        expect(reportOf(runtime, publicationId)).toMatchObject({ outcome: "succeeded", checkout: { kind: "unknown" } });
        return publicationRows(runtime, w.run.runId);
      });
      expect(rows).toMatchObject({ run: "completed", publications: [["succeeded", "fast_forward", null, "released", true]], reports: 1, publishSnapshots: 2, events: ["publication.requested", "publication.prepared", "publication.verified", "publication.applying", "publication.succeeded", "run.published", "publication.workspace_released"] });
      expect(headOf(w.repo, "refs/heads/main")).toBe(commitIdOf(w.run.final));
      // The operator moves the Target again; a further process reconciles nothing, touches nothing, and the port's replay still answers from the receipt.
      writeFiles(w.repo, { "later.txt": "later\n" });
      const moved = commitAll(w.repo, "operator work after publication");
      await withProcess(w, async (runtime) => {
        const seq = runtime.ctx.journal.lastSeq();
        expect(await runtime.publication.reconcileOutstanding()).toEqual([]);
        expect(runtime.ctx.journal.lastSeq()).toBe(seq);
        const publication = runtime.stores.publications.get(publicationId);
        const expected = runtime.stores.snapshots.get(publication.targetBeforeSnapshotId!).identity;
        const candidate = runtime.stores.snapshots.get(publication.candidateSnapshotId!).identity;
        expect(await runtime.workspace.publication.apply({ publicationId, runId: w.run.runId, workspaceId: w.run.workspaceId, workspaceRootPath: w.repo, target: { kind: "branch", branch: "main" }, expectedTargetSnapshot: expected, candidateSnapshot: candidate, strategy: publication.strategy! })).toEqual({ kind: "applied", targetSnapshot: w.run.final, alreadyApplied: true, checkout: { kind: "unknown" } });
        expect(publicationRows(runtime, w.run.runId)).toEqual(rows);
      });
      expect(headOf(w.repo, "refs/heads/main")).toBe(moved);
      expect(readTree(w.repo)["later.txt"]).toBe("later\n");
    } finally {
      removeWorldDirectory(w.dir);
    }
  });

  it("recovers an interrupted preparation and a damaged marker: death before the marker leaves the Publication requested, the next process prepares identical facts, a damaged marker is discarded before verification, and the Target is updated exactly once", { timeout: CASE_TIMEOUT_MS }, async () => {
    // A diverged Target makes the candidate a merge commit: the case where a repeated construction must reproduce the same identity.
    const w = await newWorld();
    try {
      writeFiles(w.repo, { "docs/operator.md": "operator\n" });
      commitAll(w.repo, "operator work before the publication");
      const publicationId = await withProcess(w, (runtime) => authorize(runtime, w.run.runId));
      const sidecar = await crash(w, publicationId, "before_marker");
      expect(sidecar.status).toBe("requested");
      const stagingDir = await withProcess(w, async (runtime) => {
        expect(runtime.stores.publications.get(publicationId).status).toBe("requested");
        // The candidate ref survived the death; no marker exists; the next prepare constructs the same candidate.
        const candidateRef = `${PUBLICATION_CANDIDATE_REF_PREFIX}${publicationId}`;
        const firstCandidate = headOf(w.repo, candidateRef);
        expect(await runtime.publication.advance(publicationId)).toEqual({ kind: "prepared", publicationId });
        const publication = runtime.stores.publications.get(publicationId);
        expect(publication).toMatchObject({ status: "prepared", strategy: { kind: "merge" } });
        expect(runtime.stores.snapshots.get(publication.candidateSnapshotId!).identity).toMatchObject({ kind: "git", commitId: firstCandidate });
        expect(headOf(w.repo, candidateRef)).toBe(firstCandidate);
        return path.join(runtime.layout.stateRoot, "workspaces", w.run.workspaceId, "runs", w.run.runId, "publications", publicationId);
      });
      // The marker is damaged (a partial write) between processes: verification's replay discards it and re-prepares the identical candidate.
      const marker = path.join(stagingDir, "prepared.json");
      fs.writeFileSync(marker, fs.readFileSync(marker, "utf8").slice(0, 25));
      const rows = await withProcess(w, async (runtime) => {
        expect(await advanceUntil(runtime.publication, publicationId, (k) => k === "released")).toEqual(["verified", "applying", "succeeded", "released"]);
        expect(JSON.parse(fs.existsSync(marker) ? "null" : "null")).toBeNull();
        return publicationRows(runtime, w.run.runId);
      });
      expect(rows).toMatchObject({ publications: [["succeeded", "merge", null, "released", true]], reports: 1, publishSnapshots: 2 });
      expect(headOf(w.repo, "refs/heads/main")).toBe(headOf(w.repo, `${PUBLICATION_RECEIPT_REF_PREFIX}${publicationId}`));
      expect(readTree(w.repo)).toEqual({ "README.md": "# Fixture\n", "docs/notes.md": "notes\n", "docs/operator.md": "operator\n", "src/app.js": "v2\n" });
      expect(statusOf(w.repo)).toEqual([]);
    } finally {
      removeWorldDirectory(w.dir);
    }
  });

  it("keeps a committed outcome when the staging cleanup fails, and releases the staging on a later attempt", { timeout: CASE_TIMEOUT_MS }, async () => {
    const w = await newWorld();
    try {
      await withProcess(w, async (runtime) => {
        const publicationId = authorize(runtime, w.run.runId);
        expect(await advanceUntil(runtime.publication, publicationId, (k) => k === "succeeded")).toEqual(["prepared", "verified", "applying", "succeeded"]);
        const before = publicationRows(runtime, w.run.runId);
        const staging = path.join(runtime.layout.stateRoot, "workspaces", w.run.workspaceId, "runs", w.run.runId, "publications", publicationId, "staging");
        expect(fs.existsSync(staging)).toBe(true);
        // The staging cannot be removed: a process whose working directory is inside it on Windows, a read-only parent elsewhere.
        const obstruction = await obstruct(staging);
        try {
          const outcome = await runtime.publication.advance(publicationId);
          expect(outcome).toMatchObject({ kind: "infrastructure_failure", stage: "release" });
          expect(runtime.diagnostics.some((d) => d.kind === "publication_staging_release_failed")).toBe(true);
          expect(runtime.stores.publications.get(publicationId)).toMatchObject({ status: "succeeded", stagingCleanup: "pending" });
          expect(publicationRows(runtime, w.run.runId)).toEqual(before);
        } finally {
          await obstruction.clear();
        }
        expect((await runtime.publication.releaseOutstanding()).map((o) => o.kind)).toEqual(["released"]);
        expect(runtime.stores.publications.get(publicationId)).toMatchObject({ status: "succeeded", stagingCleanup: "released" });
        expect(fs.existsSync(staging)).toBe(false);
        expect(headOf(w.repo, "refs/heads/main")).toBe(commitIdOf(w.run.final));
      });
    } finally {
      removeWorldDirectory(w.dir);
    }
  });
});

/**
 * Makes `dir` unremovable for the duration. On Windows a directory that is the working directory of a live process cannot be
 * deleted (an open file handle does not obstruct: Node opens files with delete sharing); elsewhere a read-only parent refuses the
 * unlink of its entries.
 */
async function obstruct(dir: string): Promise<{ clear: () => Promise<void> }> {
  if (process.platform === "win32") {
    const holder = spawn(process.execPath, ["-e", "process.stdout.write('held\\n'); setInterval(() => {}, 1000);"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    return {
      clear: () =>
        new Promise<void>((resolve) => {
          holder.once("exit", () => resolve());
          holder.kill();
        }),
    };
  }
  const parent = path.dirname(dir);
  const mode = fs.statSync(parent).mode;
  fs.chmodSync(parent, 0o555);
  return { clear: async () => fs.chmodSync(parent, mode) };
}
