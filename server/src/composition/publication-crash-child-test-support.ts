/**
 * The child process of the real-git publication death suite
 * (`publication-git.test.ts`): a real runtime process over the world's
 * directory — the real SQLite file, blob store, and Workspace ports — that
 * recovers as a restarted server does, advances the named Publication
 * through its next durable boundary, and terminates itself abruptly
 * (`SIGKILL`, no COMMIT, no close) at the requested window after recording
 * the facts of that moment in a sidecar file the parent reads once the
 * process-exit notification arrives. The window is a synchronous hook on
 * the production publication port; nothing sleeps or polls.
 *
 * Windows:
 * - `after_target_update`: the atomic reference transaction moved the
 *   Target and created the receipt; the process dies before the checkout
 *   handling and before SQLite records success.
 * - `before_marker`: the candidate is constructed and its ref recorded; the
 *   process dies before the prepared marker is written.
 */
import fs from "node:fs";
import { RunPublicationService } from "../execution/publication.ts";
import { WorkspacePublication } from "../workspace-state/publish.ts";
import { openWorld } from "./publication-git-test-support.ts";

export type PublicationCrashWindow = "after_target_update" | "before_marker";

export interface PublicationCrashArgs {
  dir: string;
  publicationId: string;
  sidecar: string;
  window: PublicationCrashWindow;
}

export interface PublicationCrashSidecar {
  window: PublicationCrashWindow;
  pid: number;
  publicationId: string;
  /** The Publication's status in SQLite at the moment of death (read outside any transaction). */
  status: string;
  inTransaction: boolean;
}

const args = JSON.parse(process.argv[2]!) as PublicationCrashArgs;
const runtime = openWorld(args.dir);
const writeFile = fs.writeFileSync;

function die(publicationId: string): never {
  const sidecar: PublicationCrashSidecar = { window: args.window, pid: process.pid, publicationId, status: runtime.stores.publications.get(publicationId as never).status, inTransaction: runtime.ctx.tx.inTransaction };
  writeFile(args.sidecar, JSON.stringify(sidecar));
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable: the process terminated itself");
}

async function main(): Promise<void> {
  const report = runtime.recovery.recover();
  if (!report.blobs.complete) throw new Error("recovery left the blob store incomplete");
  const port = new WorkspacePublication(runtime.layout, {
    afterTargetUpdate: (id) => {
      if (args.window === "after_target_update") die(id);
    },
    beforeMarker: (id) => {
      if (args.window === "before_marker") die(id);
    },
  });
  const publication = new RunPublicationService({ ctx: runtime.ctx, stores: runtime.stores, port, checks: runtime.checks });
  const outcome = await publication.advance(args.publicationId as never);
  throw new Error(`the window did not fire; the advance returned ${outcome.kind}`);
}

main().catch((error: unknown) => {
  fs.writeSync(2, `publication crash child failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(2);
});
