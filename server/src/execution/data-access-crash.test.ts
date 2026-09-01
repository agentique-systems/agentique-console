/**
 * Abrupt-crash windows of `write_artifact` over a real SQLite file and a
 * `FileBlobStore`, with the crashing side a real child OS process that
 * terminates itself with SIGKILL mid-call (no COMMIT, no rollback hook, no
 * close) — as opposed to the in-process suites, which inject exceptions
 * (ordinary rollback), reopen a file (restart), or run concurrent calls in
 * one owner process. The parent waits on the child's exit notification and
 * a sidecar the child wrote synchronously before dying, then inspects rows
 * and the blob directory: exactly what survives immediately after death,
 * and exactly what recovery changes. These tests state the Artifact
 * Store's guarantee as it is (execution-model §2.1): metadata never
 * commits before its blob exists, and an abrupt death between the blob
 * write and the commit leaves a safe, unreferenced blob that neither
 * recovery nor the retried call removes — the retry reuses it.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactId, InvocationId, RunId } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { FileBlobStore, sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness } from "../persistence/test-support.ts";
import { portFor, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import type { CrashChildArgs, CrashSidecar } from "./data-access-crash-child-test-support.ts";
import { passRetryBackoff, readArtifact, readResult, rejectionCodes, writeArtifact, writtenArtifact } from "./data-access-test-support.ts";
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

/** A process of this test over the world's files: recovery first, like a restarted server. */
function openProcess(w: CrashWorld, options: { recover?: boolean } = {}): RuntimeHarness {
  const store = new FileBlobStore(w.blobs);
  const h = openRuntimeHarness({ base: openHarness(w.db, { blobs: store as unknown as MemoryBlobStore }), governor: WIDE_GOVERNOR });
  if (options.recover !== false) h.recovery.recover();
  return h;
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

/** Every blob file under the store, as `<2 hex>/<digest>` (temporary files included, so a leftover `.tmp` would show). */
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

const blobPath = (root: string, digest: string) => `${digest.slice(0, 2)}/${digest}`;

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
function runChild(w: CrashWorld, args: Omit<CrashChildArgs, "db" | "blobs" | "sidecar">, onMessage?: (message: unknown, send: (request: ChildRequest) => void) => void): Promise<ChildExit> {
  const sidecar = path.join(w.dir, `${args.window}-${Date.now()}.json`);
  const full: CrashChildArgs = { db: w.db, blobs: w.blobs, sidecar, ...args };
  // The child's stderr goes to a file (complete whenever the process is gone, however it died), never a pipe that may still be draining.
  const stderrFile = path.join(w.dir, `${args.window}-${Date.now()}.stderr`);
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
  });
}

/** The canonical rows a crash could leave behind, from a fresh process. */
function rows(h: RuntimeHarness, runId: RunId) {
  const invocations = h.stores.invocations.listByRun(runId);
  return {
    artifacts: h.stores.artifacts.listByRun(runId).filter((a) => a.producer.kind === "invocation").map((a) => ({ id: a.id, digest: a.digest, byteSize: a.byteSize })),
    calls: invocations.flatMap((i) => h.stores.runtimeToolCalls.listByInvocation(i.id).filter((c) => c.tool === "write_artifact").map((c) => ({ invocationId: i.id, attemptId: c.attemptId, artifactId: c.result.tool === "write_artifact" ? c.result.artifactId : null }))),
    events: h.ctx.journal.read({ runId }).map((e) => e.type).filter((t) => t === "artifact.created" || t === "runtime_tool_call.committed"),
    attempts: h.stores.invocations.listAttempts(invocations[0]!.id).map((a) => ({ number: a.number, status: a.status })),
  };
}

const removeWorld = (w: CrashWorld) => fs.rmSync(w.dir, { recursive: true, force: true });

/** The next Attempt of the root turn in a fresh process, with its port. */
async function nextAttempt(h: RuntimeHarness, w: CrashWorld) {
  passRetryBackoff(h, w.invocationId);
  const prepared = await h.executor.prepareNextAttempt(w.invocationId);
  if (prepared.kind !== "prepared") throw new Error(`not prepared: ${prepared.kind}`);
  return { attempt: prepared.attempt, port: portFor(h, prepared.invocation, prepared.attempt) };
}

describe("abrupt process death around write_artifact (real SQLite file, FileBlobStore, child process)", () => {
  it("1: killed after the blob write and before the metadata commit — immediately after death an unreferenced blob file exists and no row; after recovery the blob still exists, nothing references it, and the retried call reuses it", async () => {
    const w = newWorld();
    try {
      const content = "window one: blob written, nothing committed";
      const digest = sha256Hex(new TextEncoder().encode(content));
      const before = blobFiles(w.blobs);
      const exit = await runChild(w, { window: "after_blob_put", invocationId: w.invocationId, title: "w1", content });
      expect(exit.stderr, exit.stderr).toBe("");
      expect(exit.sidecar).toMatchObject({ window: "after_blob_put", digest, blobWritten: true, inTransaction: true, artifactId: null });
      expect(exit.code === 0).toBe(false);
      // Immediately after death: the blob file survives, unreferenced; no Artifact row, no call row, no Event.
      const afterDeath = blobFiles(w.blobs);
      expect(afterDeath).toEqual([...before, blobPath(w.blobs, digest)].sort());
      const g = openProcess(w, { recover: false });
      try {
        expect(rows(g, w.runId)).toMatchObject({ artifacts: [], calls: [], events: [] });
        expect(g.stores.artifacts.findByDigest(w.runId, digest)).toEqual([]);
      } finally {
        g.close();
      }
      // After recovery: the Attempt is interrupted with a durable retry, and the blob is exactly as it was — recovery removes nothing.
      const h = openProcess(w);
      try {
        expect(rows(h, w.runId).attempts.at(-1)).toMatchObject({ status: "interrupted" });
        expect(blobFiles(w.blobs)).toEqual(afterDeath);
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [], calls: [] });
        // The retried identical call commits from scratch (no row existed to replay) and reuses the content-addressed orphan.
        const { port } = await nextAttempt(h, w);
        const written = writtenArtifact(await port.call(writeArtifact({ title: "w1", content })));
        expect(written).toMatchObject({ digest, replayed: false });
        expect(blobFiles(w.blobs)).toEqual(afterDeath);
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [{ digest }], calls: [{ artifactId: written.artifactId }], events: ["artifact.created", "runtime_tool_call.committed"] });
        expect(readResult(await port.call(readArtifact({ artifactId: written.artifactId })), "read_artifact").content).toBe(content);
      } finally {
        h.close();
      }
      // Recovery is repeatable: a further process finds the same state and repeats nothing.
      const again = openProcess(w);
      try {
        expect(rows(again, w.runId)).toMatchObject({ artifacts: [{ digest }], events: ["artifact.created", "runtime_tool_call.committed"] });
        expect(blobFiles(w.blobs)).toEqual(afterDeath);
      } finally {
        again.close();
      }
    } finally {
      removeWorld(w);
    }
  });

  it("2: killed after the Artifact row and its Event entered the transaction, before the call row — after death no row of any kind survives, the blob does; recovery leaves the blob; the retry commits once and reuses it", async () => {
    const w = newWorld();
    try {
      const content = "window two: artifact inserted, call row never reached";
      const digest = sha256Hex(new TextEncoder().encode(content));
      const before = blobFiles(w.blobs);
      const exit = await runChild(w, { window: "after_artifact_insert", invocationId: w.invocationId, title: "w2", content });
      expect(exit.stderr, exit.stderr).toBe("");
      expect(exit.sidecar).toMatchObject({ window: "after_artifact_insert", digest, inTransaction: true, artifactId: expect.stringMatching(/^art_/) });
      const afterDeath = blobFiles(w.blobs);
      expect(afterDeath).toEqual([...before, blobPath(w.blobs, digest)].sort());
      const g = openProcess(w, { recover: false });
      try {
        // The uncommitted transaction left nothing: not the Artifact row, not its Event, not the call row.
        expect(rows(g, w.runId)).toMatchObject({ artifacts: [], calls: [], events: [] });
        expect(() => g.stores.artifacts.get(exit.sidecar!.artifactId as ArtifactId)).toThrow();
      } finally {
        g.close();
      }
      const h = openProcess(w);
      try {
        expect(blobFiles(w.blobs)).toEqual(afterDeath);
        const { port } = await nextAttempt(h, w);
        const written = writtenArtifact(await port.call(writeArtifact({ title: "w2", content })));
        expect(written).toMatchObject({ digest, replayed: false });
        expect(written.artifactId).not.toBe(exit.sidecar!.artifactId);
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [{ digest }], calls: [{ artifactId: written.artifactId }], events: ["artifact.created", "runtime_tool_call.committed"] });
        expect(blobFiles(w.blobs)).toEqual(afterDeath);
      } finally {
        h.close();
      }
    } finally {
      removeWorld(w);
    }
  });

  it("3: killed after the commit with the response lost — after death the Artifact, its Event, the call row, and the blob all exist; a fresh process's retry replays the same Artifact id and creates nothing twice", async () => {
    const w = newWorld();
    try {
      const content = "window three: committed, response lost";
      const digest = sha256Hex(new TextEncoder().encode(content));
      const exit = await runChild(w, { window: "after_commit", invocationId: w.invocationId, title: "w3", content });
      expect(exit.stderr, exit.stderr).toBe("");
      expect(exit.sidecar).toMatchObject({ window: "after_commit", digest, inTransaction: false, artifactId: expect.stringMatching(/^art_/) });
      const artifactId = exit.sidecar!.artifactId as ArtifactId;
      const afterDeath = blobFiles(w.blobs);
      expect(afterDeath).toContain(blobPath(w.blobs, digest));
      const g = openProcess(w, { recover: false });
      try {
        expect(rows(g, w.runId)).toMatchObject({ artifacts: [{ id: artifactId, digest }], calls: [{ attemptId: exit.sidecar!.attemptId, artifactId }], events: ["artifact.created", "runtime_tool_call.committed"] });
      } finally {
        g.close();
      }
      const h = openProcess(w);
      try {
        const { attempt, port } = await nextAttempt(h, w);
        expect(attempt.id).not.toBe(exit.sidecar!.attemptId);
        const replay = writtenArtifact(await port.call(writeArtifact({ title: "w3", content })));
        expect(replay).toMatchObject({ artifactId, digest, replayed: true });
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [{ id: artifactId }], calls: [{ attemptId: exit.sidecar!.attemptId, artifactId }], events: ["artifact.created", "runtime_tool_call.committed"] });
        expect(blobFiles(w.blobs)).toEqual(afterDeath);
        expect(readResult(await port.call(readArtifact({ artifactId })), "read_artifact").content).toBe(content);
      } finally {
        h.close();
      }
    } finally {
      removeWorld(w);
    }
  });

  it("4: a pre-existing deduplicated blob referenced by committed metadata survives a crash of a second write of the same bytes, and the committed Artifact still reads", async () => {
    const w = newWorld();
    try {
      const content = "window four: shared bytes";
      const bytes = new TextEncoder().encode(content);
      const digest = sha256Hex(bytes);
      // A committed runtime Artifact already references the digest.
      const seed = openProcess(w, { recover: false });
      let committed: ArtifactId;
      try {
        committed = seed.stores.artifacts.create({ runId: w.runId, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: "committed earlier" }, bytes).id;
      } finally {
        seed.close();
      }
      const before = blobFiles(w.blobs);
      expect(before).toContain(blobPath(w.blobs, digest));
      const exit = await runChild(w, { window: "after_blob_put", invocationId: w.invocationId, title: "w4", content });
      expect(exit.stderr, exit.stderr).toBe("");
      // The blob store reused the verified blob (nothing new was written) and the process died inside the transaction.
      expect(exit.sidecar).toMatchObject({ window: "after_blob_put", digest, blobWritten: false, inTransaction: true });
      expect(blobFiles(w.blobs)).toEqual(before);
      const h = openProcess(w);
      try {
        expect(blobFiles(w.blobs)).toEqual(before);
        expect(Uint8Array.from(h.stores.artifacts.read(committed).bytes)).toEqual(bytes);
        expect(rows(h, w.runId)).toMatchObject({ artifacts: [], calls: [] });
        const { port } = await nextAttempt(h, w);
        const written = writtenArtifact(await port.call(writeArtifact({ title: "w4", content })));
        expect(written).toMatchObject({ digest, replayed: false });
        expect(written.artifactId).not.toBe(committed);
        expect(blobFiles(w.blobs)).toEqual(before);
        expect(Uint8Array.from(h.stores.artifacts.read(committed).bytes)).toEqual(bytes);
      } finally {
        h.close();
      }
    } finally {
      removeWorld(w);
    }
  });

  it("5: content corrupted on disk stays the typed artifact_content_corrupt failure in a fresh process (never 'not found', never a path), and missing content stays artifact_content_missing", async () => {
    const w = newWorld();
    try {
      const content = "window five: bytes that will be tampered with";
      const digest = sha256Hex(new TextEncoder().encode(content));
      let artifactId: ArtifactId;
      const first = openProcess(w);
      try {
        const { port } = await nextAttempt(first, w);
        artifactId = writtenArtifact(await port.call(writeArtifact({ title: "w5", content }))).artifactId;
      } finally {
        first.close();
      }
      const file = path.join(w.blobs, blobPath(w.blobs, digest));
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
      // The metadata is untouched by either failure: nothing was recorded as state.
      const h = openProcess(w);
      try {
        expect(h.stores.artifacts.get(artifactId)).toMatchObject({ digest, byteSize: content.length });
        expect(rows(h, w.runId).events).toEqual(["artifact.created", "runtime_tool_call.committed"]);
      } finally {
        h.close();
      }
    } finally {
      removeWorld(w);
    }
  });
});
