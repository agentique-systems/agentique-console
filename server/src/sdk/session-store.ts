import { and, asc, eq, max, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { providerEntries } from "../db/schema.ts";
import { nowIso } from "../ids.ts";

export interface SessionKey {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}

export interface SessionStoreEntry {
  type: string;
  uuid?: string;
  [key: string]: unknown;
}

/** Console-owned eager journal: provider history survives process or UI failure. */
export class SqliteSessionStore {
  constructor(readonly db: Db) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.db
      .insert(providerEntries)
      .values(entries.map((entry) => ({
        projectKey: key.projectKey,
        sessionId: key.sessionId,
        subpath: key.subpath ?? "",
        uuid: typeof entry.uuid === "string" ? entry.uuid : null,
        type: entry.type,
        entry,
        createdAt: nowIso(),
      })))
      .onConflictDoNothing()
      .run();
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = this.db.select({ entry: providerEntries.entry }).from(providerEntries)
      .where(this.#filter(key)).orderBy(asc(providerEntries.ord)).all();
    return rows.length === 0 ? null : rows.map((row) => row.entry as SessionStoreEntry);
  }

  async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    return this.db.select({ sessionId: providerEntries.sessionId, latest: max(providerEntries.createdAt) })
      .from(providerEntries).where(eq(providerEntries.projectKey, projectKey))
      .groupBy(providerEntries.sessionId).all()
      .map((row) => ({ sessionId: row.sessionId, mtime: row.latest ? Date.parse(row.latest) : 0 }))
      .toSorted((a, b) => b.mtime - a.mtime);
  }

  async delete(key: SessionKey): Promise<void> {
    this.db.delete(providerEntries).where(this.#filter(key)).run();
  }

  /** A durable-reference probe: `ref` names a journal entry uuid or a session. */
  hasEntryRef(ref: string): boolean {
    return this.db.select({ id: providerEntries.ord }).from(providerEntries)
      .where(or(eq(providerEntries.uuid, ref), eq(providerEntries.sessionId, ref))).get() !== undefined;
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return this.db.selectDistinct({ subpath: providerEntries.subpath }).from(providerEntries)
      .where(and(eq(providerEntries.projectKey, key.projectKey), eq(providerEntries.sessionId, key.sessionId), ne(providerEntries.subpath, "")))
      .all().map((row) => row.subpath).toSorted();
  }

  #filter(key: SessionKey) {
    return and(eq(providerEntries.projectKey, key.projectKey), eq(providerEntries.sessionId, key.sessionId), eq(providerEntries.subpath, key.subpath ?? ""));
  }
}
