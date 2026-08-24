import { randomUUID } from "node:crypto";

/** One prefix per entity kind — a prefix is never reused for a second kind. */
export type IdPrefix = "ws" | "us" | "as" | "msg" | "int" | "turn" | "task" | "delivery" | "artifact" | "usage" | "handoff" | "cron" | "run" | "proc" | "draft" | "rnd" | "sched" | "spec" | "ost" | "req" | "rqs" | "rqd" | "proj" | "rql" | "chg";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
