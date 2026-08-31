/**
 * File-backed restart fixtures shared by the recovery suites: a `World` is
 * one SQLite file plus the process-independent fakes (clock, blobs,
 * workspace ports) that successive "processes" open over it, exactly as a
 * restarted server would — recovery first, then the work, then the handle
 * closed — and a `competitor` is a second connection held at the same time.
 */
import type { PlanNodeId, RunId } from "@agentique-console/core";
import { sha256Hex, type MemoryBlobStore } from "../persistence/blob-store.ts";
import { openHarness, type TestClock } from "../persistence/test-support.ts";
import { WIDE_GOVERNOR } from "./coordinator-test-support.ts";
import { FakeAcceptanceCriterionExecution, FakeIntegrationWorkspace, FakeRunFinalizationWorkspace, openRuntimeHarness, type RuntimeHarness } from "./test-support.ts";

export interface World {
  dir: string;
  file: string;
  clock: TestClock;
  blobs: MemoryBlobStore;
  integration: FakeIntegrationWorkspace;
  checks: FakeAcceptanceCriterionExecution;
  finalization: FakeRunFinalizationWorkspace;
  runId: RunId;
  nodeId: PlanNodeId;
  revisionNumber: number;
}

/** A World over the database file `file` inside the suite's temporary directory `dir` (the suite creates and removes the directory). */
export function newWorld(dir: string, file: string): World {
  const integration = new FakeIntegrationWorkspace(sha256Hex);
  return { dir, file, clock: undefined as never, blobs: undefined as never, integration, checks: new FakeAcceptanceCriterionExecution(), finalization: new FakeRunFinalizationWorkspace(integration), runId: undefined as never, nodeId: undefined as never, revisionNumber: 0 };
}

/** A process over the World's database; the first process records the clock and blob store the later ones share. */
export function openProcess(w: World): RuntimeHarness {
  const h = openRuntimeHarness({ base: openHarness(w.file, w.clock === undefined ? {} : { clock: w.clock, blobs: w.blobs }), governor: WIDE_GOVERNOR, integrationWorkspace: w.integration, criterionExecution: w.checks, finalizationWorkspace: w.finalization });
  if (w.clock === undefined) {
    w.clock = h.clock;
    w.blobs = h.blobs;
  }
  return h;
}

/** Runs `body` in a fresh process over the same database: recovery runs first, exactly as at startup, `after` (a suite's mock restore) runs, and the file is always closed. */
export async function withProcess<T>(w: World, body: (h: RuntimeHarness) => Promise<T> | T, options: { recover?: boolean; after?: () => void } = {}): Promise<T> {
  const h = openProcess(w);
  try {
    if (options.recover !== false) h.recovery.recover();
    return await body(h);
  } finally {
    options.after?.();
    try {
      h.close();
    } catch {
      // A process that "died" closed its own handle already.
    }
  }
}

/** A second connection to the same database, as another process would hold; it never waits for the write lock. */
export function competitor(w: World): RuntimeHarness {
  const b = openProcess(w);
  b.database.sqlite.pragma("busy_timeout = 0");
  return b;
}
