import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  EXPECTED_SCHEMA_INFO,
  SCHEMA_APPLICATION,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  schemaInfoSchema,
  type SchemaInfo,
} from "@agentique-console/core";
import { connect, prepareConnection, runMigrations, type Connection } from "./client.ts";

/**
 * The database file was created by a previous, unsupported schema. The
 * server refuses it without reading, converting, backing up, renaming, or
 * deleting anything; the operator resets it. The entrypoint prints
 * `message` and exits non-zero.
 */
export class ResetRequiredError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(
      `reset-required: ${file} was created by a previous, unsupported schema.\n` +
        `Delete the file or point CONSOLE_DATA_DIR at an empty directory.`,
    );
    this.name = "ResetRequiredError";
    this.file = file;
  }
}

export type DatabaseDisposition =
  | { kind: "initialize" }
  | { kind: "open"; schemaInfo: SchemaInfo }
  | { kind: "refuse"; reason: string };

/**
 * Classifies an opened connection before any migration runs:
 * - no user tables → initialize;
 * - a `schema_info` row matching application, schema, and a version at or
 *   below the one this build knows → open and migrate forward;
 * - anything else → refuse. Legacy rows are never inspected.
 */
export function inspectDatabase(sqlite: Database.Database): DatabaseDisposition {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  if (tables.length === 0) return { kind: "initialize" };
  if (!tables.some((t) => t.name === "schema_info")) {
    return { kind: "refuse", reason: "no schema_info table" };
  }
  let rows: unknown[];
  try {
    rows = sqlite.prepare("SELECT application, schema, version FROM schema_info").all();
  } catch (error) {
    return { kind: "refuse", reason: `unreadable schema_info: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (rows.length !== 1) return { kind: "refuse", reason: `schema_info has ${rows.length} rows` };
  const parsed = schemaInfoSchema.safeParse(rows[0]);
  if (!parsed.success) return { kind: "refuse", reason: "schema_info does not identify this application" };
  const info = parsed.data;
  if (info.application !== SCHEMA_APPLICATION || info.schema !== SCHEMA_NAME) {
    return { kind: "refuse", reason: `schema_info names ${info.application}/${info.schema}` };
  }
  if (info.version > SCHEMA_VERSION) {
    return { kind: "refuse", reason: `schema version ${info.version} is newer than ${SCHEMA_VERSION}` };
  }
  return { kind: "open", schemaInfo: info };
}

export interface OpenedDatabase extends Connection {
  file: string;
  disposition: "initialized" | "opened";
  schemaInfo: SchemaInfo;
  close(): void;
}

/**
 * Opens `file` under the migration contract: a missing or empty database is
 * initialized with the baseline; a matching database is migrated forward;
 * any other file raises `ResetRequiredError` with the handle closed.
 * `:memory:` always initializes.
 */
export function openDatabase(file: string): OpenedDatabase {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const connection = connect(file);
  try {
    const disposition = inspectDatabase(connection.sqlite);
    if (disposition.kind === "refuse") {
      throw new ResetRequiredError(file);
    }
    prepareConnection(connection);
    runMigrations(connection);
    const schemaInfo = readSchemaInfo(connection.sqlite);
    if (schemaInfo.version !== EXPECTED_SCHEMA_INFO.version) {
      throw new Error(`migrations left schema version ${schemaInfo.version}, expected ${EXPECTED_SCHEMA_INFO.version}`);
    }
    return {
      ...connection,
      file,
      disposition: disposition.kind === "initialize" ? "initialized" : "opened",
      schemaInfo,
      close: () => connection.sqlite.close(),
    };
  } catch (error) {
    // A refused or failed open must not leave a native handle locking the file.
    connection.sqlite.close();
    throw error;
  }
}

export function readSchemaInfo(sqlite: Database.Database): SchemaInfo {
  const row = sqlite.prepare("SELECT application, schema, version FROM schema_info WHERE id = 1").get();
  const parsed = schemaInfoSchema.safeParse(row);
  if (!parsed.success) throw new Error("schema_info row is missing or malformed after migration");
  return parsed.data;
}
