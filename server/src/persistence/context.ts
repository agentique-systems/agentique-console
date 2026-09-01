import { newId, timestampNow, type IdKind, type Timestamp } from "@agentique-console/core";
import type Database from "better-sqlite3";
import type { BlobStore } from "./blob-store.ts";
import type { PersistenceDb } from "./client.ts";
import type { OpenedDatabase } from "./database.ts";
import { EventJournal } from "./journal.ts";
import { Transactor } from "./transactions.ts";

/**
 * A non-sensitive operational diagnostic from the persistence layer: a
 * condition that did not fail the caller's operation but that an operator
 * should see. Never carries payload bytes, provider state, or secrets.
 */
export type PersistenceDiagnostic =
  | { kind: "blob_cleanup_failed"; digest: string; message: string }
  /** A committed Artifact's pending marker could not be removed; the next recovery resolves it (digest and closed kind only). */
  | { kind: "blob_marker_cleanup_failed"; digest: string; message: string }
  /** One obligation of the pending-blob reconciliation stayed unresolved (closed reconciliation kind, digest where one exists, closed failure kind). */
  | { kind: "blob_reconciliation_failed"; failure: string; digest: string | null; message: string }
  | { kind: "rollback_hook_failed"; index: number; message: string }
  | { kind: "commit_hook_failed"; index: number; message: string };

export type DiagnosticSink = (diagnostic: PersistenceDiagnostic) => void;

/**
 * Everything a store needs: the query builder, the raw connection, the
 * re-entrant Transactor, the Event journal bound to it, the blob store, the
 * diagnostics sink, and injectable clock and id minting for deterministic
 * tests. One context owns one database file and one blob store; the pair
 * is used by exactly one runtime process at a time.
 */
export interface PersistenceContext {
  db: PersistenceDb;
  sqlite: Database.Database;
  tx: Transactor;
  journal: EventJournal;
  blobs: BlobStore;
  diagnostics: DiagnosticSink;
  clock: () => Timestamp;
  ids: <K extends IdKind>(kind: K) => ReturnType<typeof newId<K>>;
}

export interface PersistenceContextOptions {
  clock?: () => Timestamp;
  ids?: PersistenceContext["ids"];
  diagnostics?: DiagnosticSink;
}

const defaultDiagnostics: DiagnosticSink = (diagnostic) => {
  switch (diagnostic.kind) {
    case "blob_cleanup_failed":
    case "blob_marker_cleanup_failed":
      console.warn(`[persistence] ${diagnostic.kind}: ${diagnostic.message} (digest ${diagnostic.digest})`);
      return;
    case "blob_reconciliation_failed":
      console.warn(`[persistence] ${diagnostic.kind}: ${diagnostic.failure}: ${diagnostic.message}${diagnostic.digest === null ? "" : ` (digest ${diagnostic.digest})`}`);
      return;
    case "rollback_hook_failed":
    case "commit_hook_failed":
      console.warn(`[persistence] ${diagnostic.kind}: ${diagnostic.message} (hook ${diagnostic.index})`);
      return;
  }
};

export function createPersistenceContext(
  database: Pick<OpenedDatabase, "db" | "sqlite">,
  blobs: BlobStore,
  options: PersistenceContextOptions = {},
): PersistenceContext {
  const clock = options.clock ?? (() => timestampNow());
  const diagnostics = options.diagnostics ?? defaultDiagnostics;
  const tx = new Transactor(database.sqlite, {
    onRollbackHookFailure: (failure) => diagnostics({ kind: "rollback_hook_failed", ...failure }),
    onCommitHookFailure: (failure) => diagnostics({ kind: "commit_hook_failed", ...failure }),
  });
  return {
    db: database.db,
    sqlite: database.sqlite,
    tx,
    journal: new EventJournal(database.db, tx, clock),
    blobs,
    diagnostics,
    clock,
    ids: options.ids ?? ((kind) => newId(kind)),
  };
}
