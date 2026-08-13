/**
 * The living specification: the shared definition of "done well" for a run.
 * Main drafts it (propose_spec), the operator edits/approves it through a
 * plan-approval card, and the approved text is injected into main's prompt,
 * every agent's prompt, and rotation checkpoints. Amendments supersede;
 * nothing silently diverges from an approved spec.
 */
import type { EventBus } from "../events/bus.ts";
import type { SpecRevisionRow, SpecStore } from "../db/stores/spec-store.ts";

/** Bound on the injected digest; the full text stays reachable via read_spec. */
const DIGEST_MAX_BYTES = 8 * 1024;
const AMENDMENT_TRAIL_MAX = 5;

export class SpecService {
  readonly #store: SpecStore;
  readonly #bus: EventBus;

  constructor(store: SpecStore, bus: EventBus) {
    this.#store = store;
    this.#bus = bus;
  }

  latestApproved(userSessionId: string): SpecRevisionRow | undefined {
    return this.#store.latestApproved(userSessionId);
  }

  listForUserSession(userSessionId: string): SpecRevisionRow[] {
    return this.#store.listForUserSession(userSessionId);
  }

  get(id: string): SpecRevisionRow | undefined {
    return this.#store.get(id);
  }

  propose(userSessionId: string, document: string, changeNote?: string): SpecRevisionRow {
    return this.#store.insertDraft({ userSessionId, document, changeNote: changeNote ?? null });
  }

  approve(revisionId: string, input: { document: string; edited: boolean; interactionId?: string | null }): SpecRevisionRow {
    const approved = this.#store.approve(revisionId, input);
    this.#bus.append({
      type: "user_session.spec.updated",
      userSessionId: approved.userSessionId,
      payload: { userSessionId: approved.userSessionId, revision: approved.revision,
        ...(approved.changeNote === null ? {} : { changeNote: approved.changeNote }), edited: input.edited },
    });
    return approved;
  }

  reject(revisionId: string): void {
    this.#store.reject(revisionId);
  }

  /**
   * The prompt injection. Renders EMPTY when no spec is approved — an empty
   * header would break prompt-caching byte stability for spec-less sessions.
   */
  digest(userSessionId: string): string {
    const approved = this.#store.latestApproved(userSessionId);
    if (!approved) return "";
    let document = approved.document;
    if (Buffer.byteLength(document, "utf8") > DIGEST_MAX_BYTES) {
      document = `${document.slice(0, DIGEST_MAX_BYTES)}\n…(truncated — read_spec returns the full text)`;
    }
    const trail = this.#store.listForUserSession(userSessionId)
      .filter((row) => row.changeNote !== null && (row.status === "approved" || row.status === "superseded"))
      .slice(-AMENDMENT_TRAIL_MAX)
      .map((row) => `- rev ${row.revision}: ${row.changeNote}`);
    return `## Approved specification (rev ${approved.revision}, authoritative)\n${document}` +
      (trail.length > 0 ? `\n\nAmendment trail:\n${trail.join("\n")}` : "");
  }

  /** One line for checkpoints: which revision governs, and its last note. */
  pointer(userSessionId: string): string | null {
    const approved = this.#store.latestApproved(userSessionId);
    if (!approved) return null;
    const heading = approved.document.split("\n").find((line) => line.trim() !== "")?.slice(0, 120) ?? "";
    return `rev ${approved.revision}${approved.changeNote ? ` — ${approved.changeNote}` : heading ? ` — ${heading}` : ""}`;
  }
}
