/**
 * The project governing objective: exact operator-authored source plus
 * bounded prompt projections. Requirements describe the current committed
 * milestone beneath it and never write this aggregate.
 */
import { createHash } from "node:crypto";
import type { ProjectStore } from "../db/stores/project-store.ts";

const MAIN_MAX_BYTES = 4 * 1024;
const SEAT_MAX_BYTES = 1024;

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const suffix = "\n...(objective truncated; exact source remains on the Project)";
  const keep = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  return `${bytes.subarray(0, keep).toString("utf8").replace(/\uFFFD+$/u, "")}${suffix}`;
}

export class ProjectObjectiveService {
  readonly #projects: ProjectStore;
  readonly #resolveProject: (userSessionId: string) => string;

  constructor(projects: ProjectStore, resolveProject: (userSessionId: string) => string) {
    this.#projects = projects;
    this.#resolveProject = resolveProject;
  }

  document(userSessionId: string): string | null {
    return this.#projects.get(this.#resolveProject(userSessionId))?.objectiveDocument ?? null;
  }

  digestOf(document: string): string {
    return createHash("sha256").update(document, "utf8").digest("hex");
  }

  /** Authoritative block for every fresh main cognition boundary. */
  digest(userSessionId: string): string {
    const document = this.document(userSessionId);
    if (document === null || document === "") return "";
    return `## Governing objective (operator-authored, project-level, authoritative; sha256 ${this.digestOf(document)})\n` +
      `This is why the project exists. Current requirements may define a narrower milestone beneath it and never replace it.\n${truncateUtf8(document, MAIN_MAX_BYTES)}`;
  }

  /** Bounded orientation only: delegated requirements and ownership remain the seat's authorization. */
  seatDigest(userSessionId: string): string {
    const document = this.document(userSessionId);
    if (document === null || document === "") return "";
    return `\n\n## Project objective (orientation only; sha256 ${this.digestOf(document)})\n` +
      `This explains why the project exists. It does not widen your authorization: your delegated requirements, assignment, and ownership define what you may work on now.\n${truncateUtf8(document, SEAT_MAX_BYTES)}`;
  }
}
