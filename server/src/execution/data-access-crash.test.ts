/**
 * Abrupt-crash windows of `write_artifact` over a real SQLite file and a
 * `FileBlobStore`, with the crashing side a real child OS process that
 * terminates itself with SIGKILL mid-call (no COMMIT, no rollback hook, no
 * close) — as opposed to the in-process suites, which inject exceptions
 * (ordinary rollback), reopen a file (restart), or run concurrent calls in
 * one owner process. The parent waits on the child's exit notification and
 * a sidecar the child wrote synchronously before dying, then inspects rows,
 * the blob directory, and the pending area three times: immediately after
 * death, after a fresh process's startup recovery, and after a further
 * process's repeated recovery.
 *
 * The guarantee these tests state (execution-model §2.1): metadata never
 * commits before its blob exists; an abrupt death can leave a marker, a
 * temporary file, or an unreferenced blob behind; a successful exclusive
 * recovery removes every unreferenced blob and temporary the protocol
 * published, keeps every blob a committed Artifact references (in any
 * Run), and removes the resolved markers; a blob the protocol never marked
 * is outside its scope. Process death only — nothing here proves power-loss
 * durability.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactId, InvocationId, RunId } from "@agentique-console/core";
import { describe, expect, it, vi } from "vitest";
import { FileBlobStore, sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { emptyPendingBlobReconciliation, type PendingBlobReconciliation } from "../persistence/stores/artifacts.ts";
import { openHarness } from "../persistence/test-support.ts";
import { portFor, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import type { CrashChildArgs, CrashSidecar, CrashWindow } from "./data-access-crash-child-test-support.ts";
import { passRetryBackoff, readArtifact, readResult, rejectionCodes, writeArtifact, writtenArtifact } from "./data-access-test-support.ts";
import type { RecoveryReport } from "./recovery-service.ts";
import { RecoveredIncompleteError, recoverOrRefuse } from "./recovery-test-support.ts";
import { openRuntimeHarness, seedRuntime, startRun, type RuntimeHarness } from "./test-support.ts";

const CHILD = fileURLToPath(new URL("./data-access-crash-child-test-support.ts", import.meta.url));
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface CrashWorld {
  dir: string;
  db: string;
  blobs: string;
  runId: RunId;
  invocationId: InvocationId;
}

type Process = RuntimeHarness & { recovered: RecoveryReport | null };

/** A process of this test over the world's files: recovery first, like a restarted server, which admits no work after an incomplete recovery. */
function openProcess(w: CrashWorld, options: { recover?: boolean; allowIncomplete?: boolean } = {}): Process {
  const store = new FileBlobStore(w.blobs);
  const h = openRuntimeHarness({ base: openHarness(w.db, { blobs: store as unknown as MemoryBlobStore }), governor: WIDE_GOVERNOR });
  let recovered: RecoveryReport | null = null;
  if (options.recover !== false) {
    try {
      recovered = recoverOrRefuse(h, options.allowIncomplete === true);
    } catch (error) {
      h.close();
      throw error;
    }
  }
  return Object.assign(h, { recovered });
}

function newWorld(): CrashWorld {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-crash-"));
  const w: CrashWorld = { dir, db: path.join(dir, "console.db"), blobs: path.join(dir, "blobs"), runId: undefined as never, invocationId: undefined as never };
  const h = openProcess(w, { recover: false });
  try {
    // Every process of a test prepares one more Attempt of the same root turn: the turn is allocated enough of them.
    const s = seedRuntime(h, { orchestratorAllocation: { costUsd: 10, tokens: 100_000, attempts: 10 } });
    w.runId = s.created.run.id;
    w.invocationId = startRun(h, s).prepared.invocation.id;
  } finally {
    h.close();
  }
  return w;
}

/** Every file under the store as `<2 hex>/<digest>` or `.pending/<name>`, so a leftover marker or temporary shows. */
function blobFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out.sort();
}

const blobPath = (digest: string) => `${digest.slice(0, 2)}/${digest}`;
const markerPath = (digest: string) => `.pending/${digest}`;

/** The store's state for one digest: whether its blob, its marker, and any temporary of it exist. */
function storeState(root: string, digest: string) {
  const files = blobFiles(root);
  return { blob: files.includes(blobPath(digest)), marker: files.includes(markerPath(digest)), temporaries: files.filter((f) => f.startsWith(`.pending/${digest}.`) && f.endsWith(".tmp")).length };
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  sidecar: CrashSidecar | null;
  messages: unknown[];
}

type ChildRequest = { kind: "read"; artifactId: ArtifactId } | { kind: "exit" };

/**
 * Runs the child to completion (its exit notification), collecting its IPC messages, stderr, and the sidecar it wrote before
 * dying. A `read` window's process stays alive between reads: `onMessage` receives each outcome and answers with the next request.
 */
function runChild(w: CrashWorld, args: Omit<CrashChildArgs, "db" | "blobs" | "sidecar" | "runId">, onMessage?: (message: unknown, send: (request: ChildRequest) => void) => void): Promise<ChildExit> {
  const stamp = `${args.window}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sidecar = path.join(w.dir, `${stamp}.json`);
  const full: CrashChildArgs = { db: w.db, blobs: w.blobs, sidecar, runId: w.runId, ...args };
  // The child's stderr goes to a file (complete whenever the process is gone, however it died), never a pipe that may still be draining.
  const stderrFile = path.join(w.dir, `${stamp}.stderr`);
  const stderrFd = fs.openSync(stderrFile, "w");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", CHILD, JSON.stringify(full)], { cwd: SERVER_ROOT, stdio: ["ignore", "ignore", stderrFd, "ipc"], env: { ...process.env, NODE_OPTIONS: "" } });
    const messages: unknown[] = [];
    child.on("message", (message) => {
      messages.push(message);
      // A `read` window is driven step by step: the parent's `onMessage` answers each outcome with the next request.
      onMessage?.(message, (request) => child.send(request));
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      fs.closeSync(stderrFd);
      const record = fs.existsSync(sidecar) ? (JSON.parse(fs.readFileSync(sidecar, "utf8")) as CrashSidecar) : null;
      resolve({ code, signal, stderr: fs.readFileSync(stderrFile, "utf8"), sidecar: record, messages });
    });
  }, CASE_TIMEOUT_MS);
}

/** Runs a crashing child and asserts it died by its own hand after writing the sidecar. */
async function crash(w: CrashWorld, args: Omit<CrashChildArgs, "db" | "blobs" | "sidecar" | "runId">): Promise<CrashSidecar> {
  const exit = await runChild(w, args);
  expect(exit.stderr, exit.stderr).toBe("");
  expect(exit.code === 0).toBe(false);
  expect(exit.sidecar, "sidecar").not.toBeNull();
  expect(exit.sidecar!.window).toBe(args.window);
  return exit.sidecar!;
}

/** The canonical rows a crash could leave behind, from a fresh process. */
function rows(h: RuntimeHarness, runId: RunId) {
  const invocations = h.stores.invocations.listByRun(runId);
  return {
    artifacts: h.stores.artifacts.listByRun(runId).map((a) => ({ id: a.id, digest: a.digest, byteSize: a.byteSize, producer: a.producer.kind })),
    calls: invocations.flatMap((i) => h.stores.runtimeToolCalls.listByInvocation(i.id).filter((c) => c.tool === "write_artifact").map((c) => ({ invocationId: i.id, attemptId: c.attemptId, artifactId: c.result.tool === "write_artifact" ? c.result.artifactId : null }))),
    events: h.ctx.journal.read({ runId }).map((e) => e.type).filter((t) => t === "artifact.created" || t === "runtime_tool_call.committed"),
    attempts: h.stores.invocations.listAttempts(invocations[0]!.id).map((a) => ({ number: a.number, status: a.status })),
  };
}

const removeWorld = (w: CrashWorld) => fs.rmSync(w.dir, { recursive: true, force: true });

/** Each case runs several real processes (children and reopens), which the full suite's load slows well beyond the default budget. */
const CASE_TIMEOUT_MS = 60_000;

/** The next Attempt of the root turn in a fresh process, with its port. */
async function nextAttempt(h: RuntimeHarness, w: CrashWorld) {
  passRetryBackoff(h, w.invocationId);
  const prepared = await h.executor.prepareNextAttempt(w.invocationId);
  if (prepared.kind !== "prepared") throw new Error(`not prepared: ${prepared.kind}`);
  return { attempt: prepared.attempt, port: portFor(h, prepared.invocation, prepared.attempt) };
}

const report = (partial: Partial<PendingBlobReconciliation>): PendingBlobReconciliation => ({ ...emptyPendingBlobReconciliation(), ...partial });

/** A world plus what its seed committed before the crash, and the store state a window must leave. */
interface DeathCase {
  window: Extract<CrashWindow, "after_marker" | "partial_temporary" | "after_blob_put" | "after_artifact_insert" | "after_commit_before_marker_removal">;
  title: string;
  /** Store state immediately after death, for the digest of the crashing write. */
  afterDeath: { blob: boolean; marker: boolean; temporaries: number };
  /** Whether the crashing write's rows survived (only a death after COMMIT). */
  committed: boolean;
  /** What the first recovery resolves. */
  recovery: Partial<PendingBlobReconciliation>;
  /** Sidecar facts of the window. */
  sidecar: Partial<CrashSidecar>;
}

const DEATH_CASES: DeathCase[] = [
  {
    window: "after_marker",
    title: "marker published, before the temporary file",
    afterDeath: { blob: false, marker: true, temporaries: 0 },
    committed: false,
    recovery: { resolvedMarkers: 1 },
    sidecar: { inTransaction: true, artifactId: null },
  },
  {
    window: "partial_temporary",
    title: "partial temporary blob write",
    afterDeath: { blob: false, marker: true, temporaries: 1 },
    committed: false,
    recovery: { resolvedMarkers: 1, removedTemporaries: 1 },
    sidecar: { inTransaction: true, artifactId: null },
  },
  {
    window: "after_blob_put",
    title: "final blob published, before the metadata insert",
    afterDeath: { blob: true, marker: true, temporaries: 0 },
    committed: false,
    recovery: { resolvedMarkers: 1, removedBlobs: 1 },
    sidecar: { inTransaction: true, artifactId: null, blobWritten: true, blobPending: true },
  },
  {
    window: "after_artifact_insert",
    title: "Artifact row and Event in the open transaction, before the call row and COMMIT",
    afterDeath: { blob: true, marker: true, temporaries: 0 },
    committed: false,
    recovery: { resolvedMarkers: 1, removedBlobs: 1 },
    sidecar: { inTransaction: true },
  },
  {
    window: "after_commit_before_marker_removal",
    title: "COMMIT succeeded, before the marker removal",
    afterDeath: { blob: true, marker: true, temporaries: 0 },
    committed: true,
    recovery: { resolvedMarkers: 1 },
    sidecar: { inTransaction: false },
  },
];

describe("abrupt process death around write_artifact (real SQLite file, FileBlobStore, child process)", () => {
  for (const c of DEATH_CASES) {
    it(`${c.window}: killed with ${c.title} — after death the protocol's leftovers are exactly as stated; recovery resolves them; a repeated recovery finds nothing; the retried call converges`, async () => {
      const w = newWorld();
      try {
        const content = `window ${c.window}: ${c.title}`;
        const digest = sha256Hex(new TextEncoder().encode(content));
        const before = blobFiles(w.blobs);
        expect(before).toEqual([]);
        const sidecar = await crash(w, { window: c.window, invocationId: w.invocationId, title: c.window, content });
        expect(sidecar).toMatchObject({ digest, ...c.sidecar });
        if (c.window === "after_artifact_insert") expect(sidecar.artifactId).toMatch(/^art_/);

        // 1. Immediately after death: the files the window leaves, and either no row of any kind or the committed rows.
        expect(storeState(w.blobs, digest)).toEqual(c.afterDeath);
        const g = openProcess(w, { recover: false });
        try {
          const dead = rows(g, w.runId);
          if (c.committed) {
            expect(dead).toMatchObject({ artifacts: [{ digest }], calls: [{ attemptId: sidecar.attemptId }], events: ["artifact.created", "runtime_tool_call.committed"] });
          } else {
            expect(dead).toMatchObject({ artifacts: [], calls: [], events: [] });
            if (sidecar.artifactId !== null) expect(() => g.stores.artifacts.get(sidecar.artifactId as ArtifactId)).toThrow();
          }
          expect(g.stores.artifacts.findByDigest(w.runId, digest)).toHaveLength(c.committed ? 1 : 0);
        } finally {
          g.close();
        }

        // 2. After reopen and recovery: the Attempt is interrupted, the marker and every temporary are gone, and the blob exists exactly when committed metadata references it.
        const h = openProcess(w);
        try {
          expect(h.recovered!.blobs).toEqual(report(c.recovery));
          expect(rows(h, w.runId).attempts.at(-1)).toMatchObject({ status: "interrupted" });
          expect(storeState(w.blobs, digest)).toEqual({ blob: c.committed, marker: false, temporaries: 0 });
          expect(blobFiles(w.blobs).filter((f) => f.startsWith(".pending/"))).toEqual([]);
          const recovered = rows(h, w.runId);
          if (c.committed) {
            // Lost response: the retry replays the same Artifact id and creates nothing twice.
            const artifactId = recovered.artifacts[0]!.id;
            const { attempt, port } = await nextAttempt(h, w);
            expect(attempt.id).not.toBe(sidecar.attemptId);
            expect(writtenArtifact(await port.call(writeArtifact({ title: c.window, content })))).toMatchObject({ artifactId, digest, replayed: true });
            expect(rows(h, w.runId)).toMatchObject({ artifacts: [{ id: artifactId }], calls: [{ attemptId: sidecar.attemptId, artifactId }], events: ["artifact.created", "runtime_tool_call.committed"] });
            expect(readResult(await port.call(readArtifact({ artifactId })), "read_artifact").content).toBe(content);
          } else {
            // Nothing to replay: the retried identical call commits from scratch, publishing the blob anew under a marker it clears.
            expect(recovered).toMatchObject({ artifacts: [], calls: [] });
            const { port } = await nextAttempt(h, w);
            const written = writtenArtifact(await port.call(writeArtifact({ title: c.window, content })));
            expect(written).toMatchObject({ digest, replayed: false });
            if (sidecar.artifactId !== null) expect(written.artifactId).not.toBe(sidecar.artifactId);
            expect(rows(h, w.runId)).toMatchObject({ artifacts: [{ digest }], calls: [{ artifactId: written.artifactId }], events: ["artifact.created", "runtime_tool_call.committed"] });
            expect(readResult(await port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact").content).toBe(content);
          }
          expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: false, temporaries: 0 });
          expect(h.diagnostics).toEqual([]);
        } finally {
          h.close();
        }

        // 3. Repeated recovery: a further process finds the same committed state, resolves nothing, and removes nothing.
        const files = blobFiles(w.blobs);
        const again = openProcess(w);
        try {
          expect(again.recovered!.blobs).toEqual(emptyPendingBlobReconciliation());
          expect(rows(again, w.runId)).toMatchObject({ artifacts: [{ digest }], events: ["artifact.created", "runtime_tool_call.committed"] });
          expect(rows(again, w.runId).artifacts).toHaveLength(1);
          expect(rows(again, w.runId).calls).toHaveLength(1);
          expect(blobFiles(w.blobs)).toEqual(files);
          expect(again.recovery.recover().blobs).toEqual(emptyPendingBlobReconciliation());
        } finally {
          again.close();
        }
      } finally {
        removeWorld(w);
      }
    }, CASE_TIMEOUT_MS);
  }

  it("after_commit: killed after the commit hooks ran with the response lost — no marker survives; a fresh process's retry replays the same Artifact id and creates nothing twice", async () => {
    const w = newWorld();
    try {
      const content = "window after_commit: committed, response lost";
      const digest = sha256Hex(new TextEncoder().encode(content));
      const sidecar = await crash(w, { window: "after_commit", invocationId: w.invocationId, title: "w-commit", content });
      expect(sidecar).toMatchObject({ digest, inTransaction: false, artifactId: expect.stringMatching(/^art_/) });
      const artifactId = sidecar.artifactId as ArtifactId;
      expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: false, temporaries: 0 });
      const g = openProcess(w, { recover: false });
      try {
        expect(rows(g, w.runId)).toMatchObject({ artifacts: [{ id: artifactId, digest }], calls: [{ attemptId: sidecar.attemptId, artifactId }], events: ["artifact.created", "runtime_tool_call.committed"] });
      } finally {
        g.close();
      }
      const h = openProcess(w);
      try {
        expect(h.recovered!.blobs).toEqual(emptyPendingBlobReconciliation());
        const { attempt, port } = await nextAttempt(h, w);
        expect(attempt.id).not.toBe(sidecar.attemptId);
        expect(writtenArtifact(await port.call(writeArtifact({ title: "w-commit", content })))).toMatchObject({ artifactId, digest, replayed: true });
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [{ id: artifactId }], calls: [{ attemptId: sidecar.attemptId, artifactId }], events: ["artifact.created", "runtime_tool_call.committed"] });
        expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: false, temporaries: 0 });
        expect(readResult(await port.call(readArtifact({ artifactId })), "read_artifact").content).toBe(content);
      } finally {
        h.close();
      }
      const again = openProcess(w);
      try {
        expect(again.recovered!.blobs).toEqual(emptyPendingBlobReconciliation());
        expect(rows(again, w.runId).artifacts).toHaveLength(1);
      } finally {
        again.close();
      }
    } finally {
      removeWorld(w);
    }
  }, CASE_TIMEOUT_MS);

  it("recovery_after_blob_removal: the recovering process dies after removing an orphan and before its marker — the marker alone survives; the next recovery removes it and nothing else", async () => {
    const w = newWorld();
    try {
      const content = "window recovery death: orphan removed, marker kept";
      const digest = sha256Hex(new TextEncoder().encode(content));
      await crash(w, { window: "after_blob_put", invocationId: w.invocationId, title: "w-cleanup", content });
      expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: true, temporaries: 0 });
      // The recovering child dies inside its own cleanup.
      const sidecar = await crash(w, { window: "recovery_after_blob_removal", invocationId: w.invocationId, title: "w-cleanup", content });
      expect(sidecar).toMatchObject({ digest, blobWritten: true, inTransaction: false, attemptId: null });
      expect(storeState(w.blobs, digest)).toEqual({ blob: false, marker: true, temporaries: 0 });
      const g = openProcess(w, { recover: false });
      try {
        expect(rows(g, w.runId)).toMatchObject({ artifacts: [], calls: [], events: [] });
      } finally {
        g.close();
      }
      const h = openProcess(w);
      try {
        expect(h.recovered!.blobs).toEqual(report({ resolvedMarkers: 1 }));
        expect(storeState(w.blobs, digest)).toEqual({ blob: false, marker: false, temporaries: 0 });
        expect(blobFiles(w.blobs)).toEqual([]);
        const { port } = await nextAttempt(h, w);
        const written = writtenArtifact(await port.call(writeArtifact({ title: "w-cleanup", content })));
        expect(written).toMatchObject({ digest, replayed: false });
        expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: false, temporaries: 0 });
      } finally {
        h.close();
      }
      const again = openProcess(w);
      try {
        expect(again.recovered!.blobs).toEqual(emptyPendingBlobReconciliation());
        expect(rows(again, w.runId).artifacts).toHaveLength(1);
      } finally {
        again.close();
      }
    } finally {
      removeWorld(w);
    }
  }, CASE_TIMEOUT_MS);

  it("same-digest content committed by another Run: a reuse crash publishes no marker, and a marked orphan that another Run references before recovery is kept for it", async () => {
    const w = newWorld();
    try {
      const content = "shared across runs";
      const bytes = new TextEncoder().encode(content);
      const digest = sha256Hex(bytes);
      // A. A committed Artifact of another Run already references the digest: the crashing write reuses the blob and marks nothing.
      let foreign: { runId: RunId; artifactId: ArtifactId };
      const seed = openProcess(w, { recover: false });
      try {
        const other = seedRuntime(seed);
        foreign = { runId: other.created.run.id, artifactId: seed.stores.artifacts.create({ runId: other.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "committed earlier" }, bytes).id };
      } finally {
        seed.close();
      }
      expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: false, temporaries: 0 });
      const reuse = await crash(w, { window: "after_blob_put", invocationId: w.invocationId, title: "w-shared", content });
      expect(reuse).toMatchObject({ digest, blobWritten: false, blobPending: false, inTransaction: true });
      expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: false, temporaries: 0 });
      const h = openProcess(w);
      try {
        expect(h.recovered!.blobs).toEqual(emptyPendingBlobReconciliation());
        expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: false, temporaries: 0 });
        expect(Uint8Array.from(h.stores.artifacts.read(foreign.artifactId).bytes)).toEqual(bytes);
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [], calls: [] });
        const { port } = await nextAttempt(h, w);
        const written = writtenArtifact(await port.call(writeArtifact({ title: "w-shared", content })));
        expect(written).toMatchObject({ digest, replayed: false });
        expect(written.artifactId).not.toBe(foreign.artifactId);
        expect(Uint8Array.from(h.stores.artifacts.read(foreign.artifactId).bytes)).toEqual(bytes);
      } finally {
        h.close();
      }

      // B. A marked orphan of a death in this Run is referenced by another Run's commit before recovery runs: recovery keeps it for that Run.
      const w2 = newWorld();
      try {
        const content2 = "orphan adopted by another run";
        const bytes2 = new TextEncoder().encode(content2);
        const digest2 = sha256Hex(bytes2);
        await crash(w2, { window: "after_blob_put", invocationId: w2.invocationId, title: "w-adopted", content: content2 });
        expect(storeState(w2.blobs, digest2)).toEqual({ blob: true, marker: true, temporaries: 0 });
        let adopter: ArtifactId;
        const between = openProcess(w2, { recover: false });
        try {
          const other = seedRuntime(between);
          adopter = between.stores.artifacts.create({ runId: other.created.run.id, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "adopter" }, bytes2).id;
        } finally {
          between.close();
        }
        // The reuse published no marker of its own; the crashed write's marker still stands.
        expect(storeState(w2.blobs, digest2)).toEqual({ blob: true, marker: true, temporaries: 0 });
        const h2 = openProcess(w2);
        try {
          expect(h2.recovered!.blobs).toEqual(report({ resolvedMarkers: 1 }));
          expect(storeState(w2.blobs, digest2)).toEqual({ blob: true, marker: false, temporaries: 0 });
          expect(Uint8Array.from(h2.stores.artifacts.read(adopter).bytes)).toEqual(bytes2);
          expect(rows(h2, w2.runId)).toMatchObject({ artifacts: [], calls: [] });
          expect(h2.recovery.recover().blobs).toEqual(emptyPendingBlobReconciliation());
          expect(storeState(w2.blobs, digest2)).toEqual({ blob: true, marker: false, temporaries: 0 });
        } finally {
          h2.close();
        }
      } finally {
        removeWorld(w2);
      }
    } finally {
      removeWorld(w);
    }
  }, CASE_TIMEOUT_MS);

  it("restoration of a missing committed blob: the restoring write crashes after publishing under a marker — recovery keeps the restored blob for the committed Artifact and removes the marker", async () => {
    const w = newWorld();
    try {
      const content = "lost and restored";
      const bytes = new TextEncoder().encode(content);
      const digest = sha256Hex(bytes);
      let committed: ArtifactId;
      const seed = openProcess(w, { recover: false });
      try {
        committed = seed.stores.artifacts.create({ runId: w.runId, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "committed" }, bytes).id;
      } finally {
        seed.close();
      }
      fs.rmSync(path.join(w.blobs, blobPath(digest)));
      expect(storeState(w.blobs, digest)).toEqual({ blob: false, marker: false, temporaries: 0 });
      const sidecar = await crash(w, { window: "after_blob_put", invocationId: w.invocationId, title: "w-restore", content });
      expect(sidecar).toMatchObject({ digest, blobWritten: true, blobPending: true });
      expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: true, temporaries: 0 });
      const h = openProcess(w);
      try {
        expect(h.recovered!.blobs).toEqual(report({ resolvedMarkers: 1 }));
        expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: false, temporaries: 0 });
        expect(Uint8Array.from(h.stores.artifacts.read(committed).bytes)).toEqual(bytes);
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [{ id: committed, producer: "runtime" }], calls: [] });
        expect(h.recovery.recover().blobs).toEqual(emptyPendingBlobReconciliation());
        expect(Uint8Array.from(h.stores.artifacts.read(committed).bytes)).toEqual(bytes);
      } finally {
        h.close();
      }
    } finally {
      removeWorld(w);
    }
  }, CASE_TIMEOUT_MS);

  it("two same-digest creates in one uncommitted transaction share one marker and one blob — after death exactly those; recovery removes both and repeats nothing", async () => {
    const w = newWorld();
    try {
      const content = "written twice in one transaction";
      const digest = sha256Hex(new TextEncoder().encode(content));
      const sidecar = await crash(w, { window: "two_creates_uncommitted", invocationId: w.invocationId, title: "twice", content });
      expect(sidecar).toMatchObject({ digest, inTransaction: true, attemptId: null });
      expect(sidecar.artifactId!.split(",")).toHaveLength(2);
      expect(blobFiles(w.blobs)).toEqual([markerPath(digest), blobPath(digest)]);
      const g = openProcess(w, { recover: false });
      try {
        expect(rows(g, w.runId)).toMatchObject({ artifacts: [], events: [] });
      } finally {
        g.close();
      }
      const h = openProcess(w);
      try {
        expect(h.recovered!.blobs).toEqual(report({ resolvedMarkers: 1, removedBlobs: 1 }));
        expect(blobFiles(w.blobs)).toEqual([]);
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [], events: [] });
        expect(h.recovery.recover().blobs).toEqual(emptyPendingBlobReconciliation());
      } finally {
        h.close();
      }
    } finally {
      removeWorld(w);
    }
  }, CASE_TIMEOUT_MS);

  it("pre-existing unmarked content is outside the protocol: recovery never enumerates or removes it, and a crashing reuse of it marks nothing", async () => {
    const w = newWorld();
    try {
      const content = "historical orphan";
      const bytes = new TextEncoder().encode(content);
      const digest = sha256Hex(bytes);
      fs.mkdirSync(path.join(w.blobs, digest.slice(0, 2)), { recursive: true });
      fs.writeFileSync(path.join(w.blobs, blobPath(digest)), bytes);
      const h = openProcess(w);
      try {
        expect(h.recovered!.blobs).toEqual(emptyPendingBlobReconciliation());
        expect(blobFiles(w.blobs)).toEqual([blobPath(digest)]);
      } finally {
        h.close();
      }
      const sidecar = await crash(w, { window: "after_blob_put", invocationId: w.invocationId, title: "w-historical", content });
      expect(sidecar).toMatchObject({ digest, blobWritten: false, blobPending: false });
      expect(blobFiles(w.blobs)).toEqual([blobPath(digest)]);
      const again = openProcess(w);
      try {
        expect(again.recovered!.blobs).toEqual(emptyPendingBlobReconciliation());
        expect(blobFiles(w.blobs)).toEqual([blobPath(digest)]);
        // A later committed write of the same bytes adopts the orphan as its content.
        const { port } = await nextAttempt(again, w);
        const written = writtenArtifact(await port.call(writeArtifact({ title: "w-historical", content })));
        expect(written).toMatchObject({ digest, replayed: false });
        expect(readResult(await port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact").content).toBe(content);
      } finally {
        again.close();
      }
    } finally {
      removeWorld(w);
    }
  }, CASE_TIMEOUT_MS);

  it("failed cleanup followed by successful repeated recovery: an orphan the first recovery cannot remove is reported, the process admits no work, and the next recovery resolves it", async () => {
    const w = newWorld();
    try {
      const content = "orphan behind a failing unlink";
      const digest = sha256Hex(new TextEncoder().encode(content));
      await crash(w, { window: "after_blob_put", invocationId: w.invocationId, title: "w-stuck", content });
      expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: true, temporaries: 0 });
      // The startup boundary refuses to proceed when the reconciliation is incomplete.
      vi.spyOn(FileBlobStore.prototype, "remove").mockImplementationOnce(() => {
        throw Object.assign(new Error("EPERM: operation not permitted, unlink 'C:\\\\blobs\\\\x'"), { code: "EPERM", errno: -1, syscall: "unlink" });
      });
      let refused: unknown;
      try {
        openProcess(w);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(RecoveredIncompleteError);
      const stuck = (refused as RecoveredIncompleteError).report.blobs;
      expect(stuck).toEqual({ ...emptyPendingBlobReconciliation(), failures: [{ kind: "blob_removal_failed", digest, entry: null, failureKind: "filesystem:EPERM" }], failureCount: 1, complete: false });
      expect(JSON.stringify(stuck)).not.toContain("C:\\\\");
      // The marker and the blob both stayed: the obligation is durable.
      expect(storeState(w.blobs, digest)).toEqual({ blob: true, marker: true, temporaries: 0 });
      // The same report is available to a process that opts in to inspect it, with the diagnostic beside it and no path in it.
      vi.spyOn(FileBlobStore.prototype, "remove").mockImplementationOnce(() => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM", errno: -1, syscall: "unlink" });
      });
      const inspecting = openProcess(w, { allowIncomplete: true });
      try {
        expect(inspecting.recovered!.blobs.complete).toBe(false);
        expect(inspecting.diagnostics).toEqual([{ kind: "blob_reconciliation_failed", failure: "blob_removal_failed", digest, message: "blob_removal_failed: filesystem:EPERM" }]);
      } finally {
        inspecting.close();
      }
      vi.restoreAllMocks();
      // The next recovery resolves it: the blob goes, then the marker.
      const h = openProcess(w);
      try {
        expect(h.recovered!.blobs).toEqual(report({ resolvedMarkers: 1, removedBlobs: 1 }));
        expect(blobFiles(w.blobs)).toEqual([]);
        expect(h.recovery.recover().blobs).toEqual(emptyPendingBlobReconciliation());
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [], calls: [] });
      } finally {
        h.close();
      }
    } finally {
      vi.restoreAllMocks();
      removeWorld(w);
    }
  }, CASE_TIMEOUT_MS);

  it("content corrupted on disk stays the typed artifact_content_corrupt failure in a fresh process (never 'not found', never a path), and missing content stays artifact_content_missing", async () => {
    const w = newWorld();
    try {
      const content = "bytes that will be tampered with";
      const digest = sha256Hex(new TextEncoder().encode(content));
      let artifactId: ArtifactId;
      const first = openProcess(w);
      try {
        const { port } = await nextAttempt(first, w);
        artifactId = writtenArtifact(await port.call(writeArtifact({ title: "w5", content }))).artifactId;
      } finally {
        first.close();
      }
      const file = path.join(w.blobs, blobPath(digest));
      fs.writeFileSync(file, "tampered bytes of the same length!!!!!!!!!!!!");
      // One fresh process reads three times; between the reads the parent (over the IPC barrier) removes the file, then restores it.
      const original = new TextEncoder().encode(content);
      let step = 0;
      const exit = await runChild(w, { window: "read", invocationId: w.invocationId, title: "w5", content, artifactId }, (_message, send) => {
        step += 1;
        if (step === 1) fs.rmSync(file);
        if (step === 2) fs.writeFileSync(file, original);
        send(step < 3 ? { kind: "read", artifactId } : { kind: "exit" });
      });
      expect(exit.stderr, exit.stderr).toBe("");
      expect(exit.code).toBe(0);
      const outcomes = exit.messages.map((m) => (m as { outcome: unknown }).outcome);
      expect(outcomes).toHaveLength(3);
      expect(rejectionCodes(outcomes[0] as never)).toEqual(["artifact_content_corrupt"]);
      expect(rejectionCodes(outcomes[1] as never)).toEqual(["artifact_content_missing"]);
      expect(readResult(outcomes[2] as never, "read_artifact").content).toBe(content);
      // The refusals carry ids and digests only: no tampered bytes, no blob path.
      expect(JSON.stringify(outcomes.slice(0, 2))).not.toMatch(/tampered|blobs[\\/]|[A-Za-z]:\\\\/);
      // The metadata is untouched by either failure: nothing was recorded as state, and no marker was ever involved in a read.
      const h = openProcess(w);
      try {
        expect(h.stores.artifacts.get(artifactId)).toMatchObject({ digest, byteSize: content.length });
        expect(rows(h, w.runId).events).toEqual(["artifact.created", "runtime_tool_call.committed"]);
        expect(blobFiles(w.blobs).filter((f) => f.startsWith(".pending/"))).toEqual([]);
      } finally {
        h.close();
      }
    } finally {
      removeWorld(w);
    }
  }, CASE_TIMEOUT_MS);
});
