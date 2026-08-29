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
export type PersistenceDiagnostic = { kind: "blob_cleanup_failed"; digest: string; message: string };

export type DiagnosticSink = (diagnostic: PersistenceDiagnostic) => void;

/**
 * Everything a store needs: the query builder, the raw connection, the
 * re-entrant Transactor, the Event journal bound to it, the blob store, the
 * diagnostics sink, and injectable clock and id minting for deterministic
 * tests.
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
  console.warn(`[persistence] ${diagnostic.kind}: ${diagnostic.message} (digest ${diagnostic.digest})`);
};

export function createPersistenceContext(
  database: Pick<OpenedDatabase, "db" | "sqlite">,
  blobs: BlobStore,
  options: PersistenceContextOptions = {},
): PersistenceContext {
  const clock = options.clock ?? (() => timestampNow());
  const tx = new Transactor(database.sqlite);
  return {
    db: database.db,
    sqlite: database.sqlite,
    tx,
    journal: new EventJournal(database.db, tx, clock),
    blobs,
    diagnostics: options.diagnostics ?? defaultDiagnostics,
    clock,
    ids: options.ids ?? ((kind) => newId(kind)),
  };
}
