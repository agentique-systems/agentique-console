/**
 * Keyset paging over store predicates (execution-model §13; the API's
 * `Page` contract): one bounded, indexed query per page, ordered by the
 * collection's canonical key — a `(createdAt, id)` pair, an `openedAt`, an
 * ordinal — in either direction, continuing strictly after the key of the
 * item a cursor names. Nothing here loads a collection to slice it, and the
 * SQL is the same whatever the history's length.
 */
import { and, asc, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

export type KeysetOrder = "asc" | "desc";

export interface KeysetQuery {
  /** The key of the item the page continues after (exclusive), or `null` for the first page. */
  after: readonly (string | number)[] | null;
  order: KeysetOrder;
  /** Rows to return at most; a caller detecting a further page asks for one more than it shows. */
  limit: number;
}

/** The predicate `key > after` (ascending) or `key < after` (descending) over the lexicographic key columns; `undefined` for the first page. */
export function keysetWhere(columns: readonly SQLiteColumn[], query: KeysetQuery): SQL | undefined {
  const after = query.after;
  if (after === null) return undefined;
  if (after.length !== columns.length) throw new Error(`a keyset cursor of ${after.length} elements cannot address ${columns.length} key columns`);
  const beyond = query.order === "asc" ? gt : lt;
  const clauses = columns.map((column, i) => and(...columns.slice(0, i).map((prefix, j) => eq(prefix, after[j]!)), beyond(column, after[i]!))!);
  return clauses.length === 1 ? clauses[0] : or(...clauses)!;
}

/** The ORDER BY of the key columns in the query's direction. */
export function keysetOrder(columns: readonly SQLiteColumn[], query: KeysetQuery): SQL[] {
  return columns.map((column) => (query.order === "asc" ? asc(column) : desc(column)));
}
