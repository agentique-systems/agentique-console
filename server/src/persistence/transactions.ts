import type Database from "better-sqlite3";

/**
 * Explicit, re-entrant write transactions over one SQLite connection.
 *
 * The outermost `write` opens `BEGIN IMMEDIATE`; nested calls join it, so a
 * store operation that composes other store operations commits or rolls
 * back as one unit. Any thrown error rolls the whole transaction back and
 * is rethrown unchanged, so an illegal transition detected after an Event
 * append leaves neither the Event nor the projection behind.
 */
export class Transactor {
  #depth = 0;

  constructor(private readonly sqlite: Database.Database) {}

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  write<T>(work: () => T): T {
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return work();
      } finally {
        this.#depth -= 1;
      }
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    try {
      const result = work();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // The connection may already have rolled back (for example on a
        // constraint failure inside a statement); the original error wins.
      }
      throw error;
    } finally {
      this.#depth = 0;
    }
  }
}
