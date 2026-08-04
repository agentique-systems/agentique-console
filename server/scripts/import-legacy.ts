import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/client.ts";
import { SqliteSessionStore, type SessionStoreEntry } from "../src/sdk/session-store.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: npm run import-legacy -- <transcript.jsonl> [session-id] [subpath]");
const sessionId = process.argv[3] ?? path.basename(file, ".jsonl");
const subpath = process.argv[4];
const entries = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line) as SessionStoreEntry; }
  catch (error) { throw new Error(`invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
});
const config = loadConfig();
const { db, sqlite } = openDb(config.dbFile);
try {
  await new SqliteSessionStore(db).append({ projectKey: path.dirname(path.resolve(file)), sessionId, ...(subpath ? { subpath } : {}) }, entries);
  console.log(`imported ${entries.length} provider entries into ${sessionId}${subpath ? `/${subpath}` : ""}`);
} finally { sqlite.close(); }

