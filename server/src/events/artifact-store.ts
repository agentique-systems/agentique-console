/**
 * Durable blob storage for content too large or too binary for an event row:
 * spilled payloads, screenshots, worktree diffs, seat notes. Content lives in
 * SQLite so it survives restarts and stays outside every seat's file scope.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { eventArtifacts } from "../db/schema.ts";
import { newId, nowIso } from "../ids.ts";

export interface ArtifactScope {
  workspaceId?: string;
  userSessionId?: string;
  agentSessionId?: string;
}

export interface ArtifactRow {
  id: string;
  mediaType: string;
  bytes: number;
  content: string;
  createdAt: string;
}

export class ArtifactStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** A `;base64` mediaType suffix marks binary content; bytes count the decoded size. */
  store(content: string, mediaType: string, scope: ArtifactScope = {}): { artifactId: string; bytes: number } {
    const artifactId = newId("artifact");
    const bytes = mediaType.endsWith(";base64") ? Buffer.from(content, "base64").byteLength : Buffer.byteLength(content);
    this.#db.insert(eventArtifacts).values({ id: artifactId, workspaceId: scope.workspaceId ?? null,
      userSessionId: scope.userSessionId ?? null, agentSessionId: scope.agentSessionId ?? null,
      mediaType, bytes, content, createdAt: nowIso() }).run();
    return { artifactId, bytes };
  }

  get(id: string): ArtifactRow | undefined {
    return this.#db.select({ id: eventArtifacts.id, mediaType: eventArtifacts.mediaType, bytes: eventArtifacts.bytes, content: eventArtifacts.content, createdAt: eventArtifacts.createdAt })
      .from(eventArtifacts).where(eq(eventArtifacts.id, id)).get();
  }
}
