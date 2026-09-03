/**
 * What every route handler shares: strict parsing of params, query, and
 * body at the boundary (an unknown field, a malformed id, an oversized
 * value is a `bad_request`), the admission check before any mutation, the
 * notification of the host after a committed operator action, and the one
 * page builder every list route uses — a keyset page of at most `limit`
 * records and at most `PAGE_MAX_BYTES` of serialized items, continued by an
 * opaque cursor that names its collection and order.
 */
import type { z } from "zod";
import { decodeCursor, encodeCursor, isIdOfKind, PAGE_LIMIT_DEFAULT, PAGE_MAX_BYTES, pageQuerySchema, type ApiRouteName, type IdKind, type ID_PREFIXES, type Id, type Page, type PageKeyElement, type PageKeyShape, type PageOrder, type PageQuery, type RunId } from "@agentique-console/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../context.ts";
import type { KeysetQuery } from "../../persistence/stores/paging.ts";
import { ApiError } from "../errors.ts";

export interface RouteRequest {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  raw: FastifyRequest;
  reply: FastifyReply;
}

export type RouteHandler = (request: RouteRequest, ctx: AppContext) => Promise<unknown> | unknown;
export type RouteHandlers = Record<ApiRouteName, RouteHandler>;

export function id<K extends IdKind>(kind: K, value: string | undefined, what?: string): Id<(typeof ID_PREFIXES)[K]> {
  const field = what ?? kind;
  if (!isIdOfKind(kind, value)) throw new ApiError("bad_request", `${field} is not a well-formed ${kind} id`, { field });
  return value as Id<(typeof ID_PREFIXES)[K]>;
}

export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError("bad_request", `${what}: ${issue?.message ?? "invalid"}${issue && issue.path.length > 0 ? ` at ${issue.path.map(String).join(".")}` : ""}`, { field: issue?.path.map(String).join(".") ?? what });
  }
  return parsed.data;
}

export const page = (query: Record<string, unknown>): PageQuery => parse(pageQuerySchema, query, "query");

/** The canonical key of a `(createdAt, id)` collection. */
export const CREATED_ID: PageKeyShape = ["string", "string"];
export const ORDINAL: PageKeyShape = ["number"];

/** What a list route pages: the collection's scope (route and owning id), the key of each item, and the key's shape. */
export interface PageSpec<T> {
  scope: string;
  keyOf: (item: T) => PageKeyElement[];
  shape: PageKeyShape;
}

/**
 * Builds one page: decodes the cursor against the route's scope, order, and key shape (a foreign, stale, or malformed cursor
 * is a `bad_request`), asks the store for one record more than the limit to learn whether a further page exists, and cuts the
 * page before the item whose serialized JSON would carry it past `PAGE_MAX_BYTES` — reporting the cursor of the last item
 * kept, so nothing is truncated or hidden. A single record beyond the bound is refused as `payload_too_large`, never cut.
 */
export function pageResponse<T>(query: PageQuery, fetch: (keyset: KeysetQuery) => T[], spec: PageSpec<NoInfer<T>>): Page<T> {
  const order: PageOrder = query.order ?? "asc";
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor, { scope: spec.scope, order, shape: spec.shape });
  const limit = query.limit ?? PAGE_LIMIT_DEFAULT;
  const rows = fetch({ after, order, limit: limit + 1 });
  const items: T[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > PAGE_MAX_BYTES) {
      if (items.length === 0) throw new ApiError("payload_too_large", `one record of ${spec.scope} exceeds the page bound of ${PAGE_MAX_BYTES} bytes`, { field: "items", key: spec.keyOf(row).map(String) });
      break;
    }
    bytes += size;
    items.push(row);
  }
  const last = items.at(-1);
  const first = items[0];
  const more = rows.length > items.length;
  return {
    items,
    nextCursor: more && last !== undefined ? encodeCursor({ scope: spec.scope, order, key: spec.keyOf(last) }) : null,
    reverseCursor: first === undefined ? null : encodeCursor({ scope: spec.scope, order: order === "asc" ? "desc" : "asc", key: spec.keyOf(first) }),
  };
}

/** Every mutation that admits or steers work passes the admission gate first. */
export function admit(ctx: AppContext): void {
  ctx.app.admission.require();
}

/** After a committed operator action the host re-projects the Run; the notification is coalesced and never the source of truth. */
export function notify(ctx: AppContext, runId: RunId): void {
  ctx.app.host.notifyRun(runId);
}

export function created<T>(reply: FastifyReply, value: T): T {
  void reply.status(201);
  return value;
}
