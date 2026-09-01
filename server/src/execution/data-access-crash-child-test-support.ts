/**
 * The child process of the abrupt-crash recovery suite
 * (`data-access-crash.test.ts`): a real runtime process over a real SQLite
 * file and a `FileBlobStore`, driven by the parent through one JSON
 * argument. It recovers (as a restarted server does), prepares the next
 * Attempt of the given root Invocation, binds the runtime-tool port to it,
 * and performs one `write_artifact` — terminating itself abruptly
 * (`SIGKILL`, no COMMIT, no rollback hook, no close) at the requested
 * window after recording the facts of that moment in a sidecar file the
 * parent reads once the process-exit notification arrives. Nothing here
 * sleeps or polls: the window is a synchronous hook inside the call.
 *
 * Death windows of a `write_artifact`, in protocol order:
 * - `after_marker`: the pending marker exists; no temporary file, no blob,
 *   no row.
 * - `partial_temporary`: the marker exists and the temporary file holds a
 *   prefix of the bytes; no blob, no row.
 * - `after_blob_put`: the blob store has written (or reused) the blob; the
 *   Artifact row, its Event, and the call row are not yet in the open
 *   transaction.
 * - `after_artifact_insert`: the Artifact row and its Event are in the
 *   open transaction; the `runtime_tool_calls` row is not; nothing has
 *   committed.
 * - `after_commit_before_marker_removal`: the call committed; the process
 *   dies inside the commit hook before the marker is removed.
 * - `after_commit`: the call committed and its hooks ran; the response is
 *   lost with the process before the Attempt is finalized.
 *
 * Other windows:
 * - `two_creates_uncommitted`: two same-digest `ArtifactStore.create` calls
 *   in one open transaction (runtime producer, no tool call), then death.
 * - `recovery_after_blob_removal`: no write; the startup recovery of this
 *   process dies right after it removed an unreferenced blob and before it
 *   removed the blob's marker.
 * - `read`: no crash — the process reads the named Artifact and reports the
 *   outcome to the parent over IPC.
 */
import fs from "node:fs";
import type { ArtifactId, InvocationId, RunId } from "@agentique-console/core";
import { FileBlobStore, sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness } from "../persistence/test-support.ts";
import { portFor, WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { passRetryBackoff, readArtifact, writeArtifact, writtenArtifact } from "./data-access-test-support.ts";
import { recoverOrRefuse } from "./recovery-test-support.ts";
import { openRuntimeHarness } from "./test-support.ts";

export type CrashWindow =
  | "after_marker"
  | "partial_temporary"
  | "after_blob_put"
  | "after_artifact_insert"
  | "after_commit_before_marker_removal"
  | "after_commit"
  | "two_creates_uncommitted"
  | "recovery_after_blob_removal"
  | "read";

export interface CrashChildArgs {
  db: string;
  blobs: string;
  sidecar: string;
  window: CrashWindow;
  runId: RunId;
  invocationId: InvocationId;
  title: string;
  content: string;
  /** The Artifact a `read` window reads. */
  artifactId?: ArtifactId;
}

/** What the child records synchronously before terminating itself. */
export interface CrashSidecar {
  window: CrashWindow;
  pid: number;
  attemptId: string | null;
  digest: string | null;
  artifactId: string | null;
  /** `written` of the blob store's put at `after_blob_put`: false when a verified blob of the digest already existed. */
  blobWritten: boolean | null;
  /** `pending` of the blob store's put at `after_blob_put`: whether this call published a marker. */
  blobPending: boolean | null;
  inTransaction: boolean;
}

const args = JSON.parse(process.argv[2]!) as CrashChildArgs;
const blobs = new FileBlobStore(args.blobs);
const base = openHarness(args.db, { blobs: blobs as unknown as MemoryBlobStore });
const h = openRuntimeHarness({ base, governor: WIDE_GOVERNOR });
const contentBytes = new TextEncoder().encode(args.content);
const contentDigest = sha256Hex(contentBytes);
// The sidecar is written with the unpatched primitive, whatever the window patched.
const writeFile = fs.writeFileSync;

function die(record: Omit<CrashSidecar, "window" | "pid">): never {
  const sidecar: CrashSidecar = { window: args.window, pid: process.pid, ...record };
  writeFile(args.sidecar, JSON.stringify(sidecar));
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable: the process terminated itself");
}

const isTemporaryOf = (file: fs.PathOrFileDescriptor, digest: string): boolean => typeof file === "string" && file.endsWith(".tmp") && file.includes(digest);

if (args.window === "recovery_after_blob_removal") {
  // Startup recovery over the previous process's leftovers dies between the blob removal and the marker removal.
  const remove = blobs.remove.bind(blobs);
  blobs.remove = (digest) => {
    const removed = remove(digest);
    die({ attemptId: null, digest, artifactId: null, blobWritten: removed, blobPending: null, inTransaction: h.ctx.tx.inTransaction });
  };
}
recoverOrRefuse(h);

async function main(): Promise<void> {
  if (args.window === "two_creates_uncommitted") {
    h.ctx.tx.write(() => {
      const input = { runId: args.runId, mediaType: "text/plain", producer: { kind: "runtime", component: "command" }, taskId: null, title: args.title } as const;
      const first = h.stores.artifacts.create(input, contentBytes);
      const second = h.stores.artifacts.create(input, contentBytes);
      die({ attemptId: null, digest: first.digest, artifactId: `${first.id},${second.id}`, blobWritten: null, blobPending: null, inTransaction: h.ctx.tx.inTransaction });
    });
  }
  passRetryBackoff(h, args.invocationId);
  const prepared = await h.executor.prepareNextAttempt(args.invocationId);
  if (prepared.kind !== "prepared") throw new Error(`Attempt not prepared: ${prepared.kind}`);
  const attemptId = prepared.attempt.id;
  const port = portFor(h, prepared.invocation, prepared.attempt);
  if (args.window === "read") {
    // One process, one Attempt, several reads: each read is requested by the parent over IPC (a deterministic barrier — the parent
    // changes the blob directory between requests), and the parent ends the process with `exit`.
    let request: { kind: "read"; artifactId: ArtifactId } | { kind: "exit" } = { kind: "read", artifactId: args.artifactId! };
    while (request.kind === "read") {
      const outcome = await port.call(readArtifact({ artifactId: request.artifactId }));
      request = await new Promise((resolve, reject) => {
        process.once("message", (message) => resolve(message as typeof request));
        process.send!({ kind: "read", outcome }, (error: Error | null) => (error ? reject(error) : undefined));
      });
    }
    h.close();
    process.disconnect?.();
    return;
  }
  if (args.window === "after_marker") {
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (isTemporaryOf(file, contentDigest)) die({ attemptId, digest: contentDigest, artifactId: null, blobWritten: null, blobPending: null, inTransaction: h.ctx.tx.inTransaction });
      writeFile(file, data, options);
    }) as typeof fs.writeFileSync;
  }
  if (args.window === "partial_temporary") {
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (isTemporaryOf(file, contentDigest)) {
        writeFile(file, contentBytes.subarray(0, Math.floor(contentBytes.byteLength / 2)));
        die({ attemptId, digest: contentDigest, artifactId: null, blobWritten: null, blobPending: null, inTransaction: h.ctx.tx.inTransaction });
      }
      writeFile(file, data, options);
    }) as typeof fs.writeFileSync;
  }
  if (args.window === "after_blob_put") {
    const put = blobs.put.bind(blobs);
    blobs.put = (bytes) => {
      const written = put(bytes);
      die({ attemptId, digest: written.digest, artifactId: null, blobWritten: written.written, blobPending: written.pending, inTransaction: h.ctx.tx.inTransaction });
    };
  }
  if (args.window === "after_artifact_insert") {
    h.stores.runtimeToolCalls.record = (input) => {
      const result = input.result;
      die({ attemptId, digest: result.tool === "write_artifact" ? result.digest : null, artifactId: result.tool === "write_artifact" ? result.artifactId : null, blobWritten: null, blobPending: null, inTransaction: h.ctx.tx.inTransaction });
    };
  }
  if (args.window === "after_commit_before_marker_removal") {
    // The only marker removal of this call is the commit hook's: the call has committed, and the marker outlives the process.
    blobs.clearPending = (digest) => die({ attemptId, digest, artifactId: null, blobWritten: null, blobPending: null, inTransaction: h.ctx.tx.inTransaction });
  }
  const outcome = await port.call(writeArtifact({ title: args.title, content: args.content }));
  const written = writtenArtifact(outcome);
  die({ attemptId, digest: written.digest, artifactId: written.artifactId, blobWritten: null, blobPending: null, inTransaction: h.ctx.tx.inTransaction });
}

main().catch((error: unknown) => {
  // Synchronous, so the text reaches the parent's pipe before the process exits.
  fs.writeSync(2, `crash child failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(2);
});
