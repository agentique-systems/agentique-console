/**
 * What every route handler shares: strict parsing of params, query, and
 * body at the boundary (an unknown field, a malformed id, an oversized
 * value is a `bad_request`), the admission check before any mutation, and
 * the notification of the host after a committed operator action.
 */
import type { z } from "zod";
import { isIdOfKind, pageQuerySchema, type ApiRouteName, type IdKind, type ID_PREFIXES, type Id, type PageQuery, type RunId } from "@agentique-console/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../context.ts";
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
