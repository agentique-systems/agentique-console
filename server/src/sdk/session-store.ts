/**
 * SQLite-backed SDK SessionStore: the durable mirror of Claude Agent SDK
 * transcripts. With this wired (plus sessionStoreFlush: "eager"), resume ids
 * survive server restarts. Port of the factory's PgClaudeSessionStore.
 */
import { and, asc, eq, max, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { sdkSessionEntries } from "../db/schema.ts";
import { nowIso } from "../ids.ts";
import type { SessionKey, SessionStoreEntry } from "./types.ts";

export class SqliteSessionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const now = nowIso();
    const rows = entries.map((entry) => ({
      projectKey: key.projectKey,
      sessionId: key.sessionId,
      subpath: key.subpath ?? "",
      uuid: typeof entry.uuid === "string" ? entry.uuid : null,
      type: entry.type,
      entry: entry as Record<string, unknown>,
      createdAt: now,
    }));
    // uuid-bearing entries dedup on re-append via the partial unique index
    // (crash-retry safe); uuid-less rows carry NULL uuid, fall outside the
    // index, and always insert. The blanket ON CONFLICT DO NOTHING is safe:
    // that index is the only constraint an insert can violate.
    this.#db.insert(sdkSessionEntries).values(rows).onConflictDoNothing().run();
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = this.#db
      .select({ entry: sdkSessionEntries.entry })
      .from(sdkSessionEntries)
      .where(this.#keyFilter(key))
      .orderBy(asc(sdkSessionEntries.ord))
      .all();
    if (rows.length === 0) return null;
    return rows.map((row) => row.entry as SessionStoreEntry);
  }

  async listSessions(
    projectKey: string,
  ): Promise<{ sessionId: string; mtime: number }[]> {
    const rows = this.#db
      .select({
        sessionId: sdkSessionEntries.sessionId,
        latest: max(sdkSessionEntries.createdAt),
      })
      .from(sdkSessionEntries)
      .where(eq(sdkSessionEntries.projectKey, projectKey))
      .groupBy(sdkSessionEntries.sessionId)
      .all();
    return rows
      .map((row) => ({
        sessionId: row.sessionId,
        mtime: row.latest === null ? 0 : Date.parse(row.latest),
      }))
      .toSorted((a, b) => b.mtime - a.mtime);
  }

  async delete(key: SessionKey): Promise<void> {
    this.#db.delete(sdkSessionEntries).where(this.#keyFilter(key)).run();
  }

  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const rows = this.#db
      .selectDistinct({ subpath: sdkSessionEntries.subpath })
      .from(sdkSessionEntries)
      .where(
        and(
          eq(sdkSessionEntries.projectKey, key.projectKey),
          eq(sdkSessionEntries.sessionId, key.sessionId),
          ne(sdkSessionEntries.subpath, ""),
        ),
      )
      .all();
    return rows.map((row) => row.subpath).toSorted();
  }

  #keyFilter(key: SessionKey) {
    return and(
      eq(sdkSessionEntries.projectKey, key.projectKey),
      eq(sdkSessionEntries.sessionId, key.sessionId),
      eq(sdkSessionEntries.subpath, key.subpath ?? ""),
    );
  }
}
