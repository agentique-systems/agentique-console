/**
 * Pagination through the HTTP contract (core `Page`, `pageQuerySchema`,
 * `PAGE_MAX_BYTES`, `API_RESPONSE_MAX_BYTES`): every list route pages by
 * keyset over an opaque cursor that names its collection and order — a
 * multi-page walk in either direction is contiguous, complete, and free of
 * duplicates; a malformed, foreign, stale-order, or wrong-shape cursor is a
 * `bad_request`; a page ends before the record that would carry it past the
 * byte bound and says so with its cursor (a record count never bounds
 * bytes); a `desc` page's `reverseCursor` continues into what was posted
 * after it; the aggregate routes window their nested histories beside the
 * totals; and a JSON response that cannot fit the response bound is refused
 * as `payload_too_large`, never truncated.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_RESPONSE_MAX_BYTES, decodeCursor, encodeCursor, PAGE_LIMIT_MAX, PAGE_MAX_BYTES, type ApiErrorBody, type ConversationMessage, type Page, type PlanNodeResponse, type RunOverview, type TaskView, type UsageResponse } from "@agentique-console/core";
import { gitSync } from "../workspace-state/git.ts";
import { CHECK } from "./e2e-fixture.ts";
import { openTestApp, removeAppDirectory, type TestApp } from "./test-support.ts";

type Body<T> = { status: number; body: T };
const ids = (page: Page<ConversationMessage>) => page.items.map((m) => m.id);

/** Walks a collection from its first page to its last, asserting every page continues exactly after the previous one. */
async function walk<T>(fetch: (cursor: string | null) => Promise<Body<Page<T>>>, idOf: (item: T) => string): Promise<{ pages: number; items: T[] }> {
  const items: T[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = await fetch(cursor);
    expect(page.status).toBe(200);
    pages += 1;
    items.push(...page.body.items);
    if (page.body.nextCursor === null) break;
    cursor = page.body.nextCursor;
    expect(pages).toBeLessThan(100);
  }
  expect(new Set(items.map(idOf)).size).toBe(items.length);
  return { pages, items };
}

describe("pagination through the API", () => {
  let t: TestApp;
  let workspaceId: string;
  let conversationId: string;
  const posted: string[] = [];

  beforeAll(async () => {
    t = await openTestApp();
    const repo = path.join(t.dir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    gitSync(["init", "--quiet", "--initial-branch=main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
    gitSync(["add", "-A"], { cwd: repo });
    gitSync(["commit", "--quiet", "--no-verify", "-m", "init"], { cwd: repo, identity: true });
    const workspace = await t.call<{ workspace: { id: string } }>("createWorkspace", { body: { rootPath: repo } });
    workspaceId = workspace.body.workspace.id;
    const conversation = await t.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId, title: "paged" } });
    conversationId = conversation.body.conversation.id;
    for (let i = 0; i < 130; i += 1) {
      const message = await t.call<{ message: { id: string } }>("postConversationMessage", { params: { conversationId }, body: { content: `message ${String(i).padStart(3, "0")}` } });
      expect(message.status).toBe(201);
      posted.push(message.body.message.id);
    }
  }, 120_000);

  afterAll(async () => {
    await t.close();
    removeAppDirectory(t.dir);
  });

  const messages = (query: Record<string, string | number | undefined>) => t.call<Page<ConversationMessage>>("listConversationMessages", { params: { conversationId }, query });
  /** The canonical order of the collection — `(createdAt, id)` — as one page states it; two messages posted within one millisecond order by id. */
  const canonical = async (): Promise<string[]> => {
    const whole = await messages({ limit: PAGE_LIMIT_MAX });
    expect(whole.body.nextCursor).toBeNull();
    return whole.body.items.map((m) => m.id);
  };

  it("walks a multi-page collection in both orders: contiguous, complete, no duplicate, and the last page says so", async () => {
    const order = await canonical();
    expect([...order].sort()).toEqual([...posted].sort());
    const ascending = await walk((cursor) => messages({ limit: 50, ...(cursor === null ? {} : { cursor }) }), (m) => m.id);
    expect(ascending.pages).toBe(3);
    expect(ascending.items.map((m) => m.id)).toEqual(order);
    const descending = await walk((cursor) => messages({ limit: 50, order: "desc", ...(cursor === null ? {} : { cursor }) }), (m) => m.id);
    expect(descending.pages).toBe(3);
    expect(descending.items.map((m) => m.id)).toEqual([...order].reverse());
    // An exact multiple of the limit ends with a full last page and no further cursor claimed falsely.
    const exact = await walk((cursor) => messages({ limit: 65, ...(cursor === null ? {} : { cursor }) }), (m) => m.id);
    expect(exact.pages).toBe(2);
    // The maximum limit still pages a collection larger than it.
    const max = await messages({ limit: PAGE_LIMIT_MAX });
    expect(max.body.items).toHaveLength(130);
    expect(max.body.nextCursor).toBeNull();
    const first = await messages({ limit: 1 });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).not.toBeNull();
  });

  it("refuses a malformed, foreign, stale-order, or wrong-shape cursor, and a cursor never reads another scope", async () => {
    const page = await messages({ limit: 10 });
    const cursor = page.body.nextCursor!;
    const key = decodeCursor(cursor, { scope: `messages:${conversationId}`, order: "asc", shape: ["string", "string"] });
    expect(key).toEqual([page.body.items[9]!.createdAt, page.body.items[9]!.id]);
    const refused = async (query: Record<string, string | number | undefined>, reason: string) => {
      const response = await t.call<ApiErrorBody>("listConversationMessages", { params: { conversationId }, query });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("bad_request");
      expect(response.body.error.details).toMatchObject({ field: "cursor", reason });
    };
    await refused({ cursor: "not a cursor" }, "malformed");
    await refused({ cursor: encodeCursor({ scope: `messages:${conversationId}`, order: "asc", key: ["only-one"] }) }, "shape");
    await refused({ cursor: encodeCursor({ scope: `messages:${conversationId}`, order: "asc", key: [1, 2] }) }, "shape");
    await refused({ cursor, order: "desc" }, "order");
    // The same cursor against another Conversation (another scope) is refused, not silently reset.
    const other = await t.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId, title: "other" } });
    const foreign = await t.call<ApiErrorBody>("listConversationMessages", { params: { conversationId: other.body.conversation.id }, query: { cursor } });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details).toMatchObject({ field: "cursor", reason: "scope" });
    // A cursor from the Run list cannot page the message list.
    const runs = await t.call<Page<unknown>>("listConversationRuns", { params: { conversationId }, query: { limit: 1 } });
    expect(runs.status).toBe(200);
    expect((await t.call<ApiErrorBody>("listConversationMessages", { params: { conversationId }, query: { cursor: encodeCursor({ scope: `runs:${conversationId}`, order: "asc", key: ["a", "b"] }) } })).body.error.details).toMatchObject({ reason: "scope" });
  });

  it("continues a newest-first page into what is posted afterwards through reverseCursor, without a gap or a duplicate", async () => {
    const order = await canonical();
    const newest = await messages({ limit: 20, order: "desc" });
    expect(ids(newest.body)).toEqual([...order].reverse().slice(0, 20));
    const older = await messages({ limit: 20, order: "desc", cursor: newest.body.nextCursor! });
    expect(ids(older.body)).toEqual([...order].reverse().slice(20, 40));
    // Nothing newer yet.
    const nothing = await messages({ limit: 20, order: "asc", cursor: newest.body.reverseCursor! });
    expect(nothing.body.items).toEqual([]);
    expect(nothing.body.nextCursor).toBeNull();
    const later = await t.call<{ message: { id: string } }>("postConversationMessage", { params: { conversationId }, body: { content: "posted later" } });
    posted.push(later.body.message.id);
    const newer = await messages({ limit: 20, order: "asc", cursor: newest.body.reverseCursor! });
    expect(ids(newer.body)).toEqual([later.body.message.id]);
    // The reverse of an older page continues into the newest page exactly (the 20 that followed it, oldest first).
    const back = await messages({ limit: 20, order: "asc", cursor: older.body.reverseCursor! });
    expect(ids(back.body)).toEqual([...order].reverse().slice(0, 20).reverse());
  });

  it("bounds a page by serialized bytes, not only by record count: the page ends before the record that would cross the bound and reports its cursor", async () => {
    const big = await t.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId, title: "big" } });
    const content = "y".repeat(30_000);
    const bigIds: string[] = [];
    for (let i = 0; i < 45; i += 1) {
      const message = await t.call<{ message: { id: string } }>("postConversationMessage", { params: { conversationId: big.body.conversation.id }, body: { content: `${String(i).padStart(2, "0")} ${content}` } });
      bigIds.push(message.body.message.id);
    }
    const page = await t.call<Page<ConversationMessage>>("listConversationMessages", { params: { conversationId: big.body.conversation.id }, query: { limit: 200 } });
    expect(page.status).toBe(200);
    const bytes = Buffer.byteLength(JSON.stringify(page.body.items));
    expect(bytes).toBeLessThanOrEqual(PAGE_MAX_BYTES);
    expect(page.body.items.length).toBeLessThan(45);
    expect(page.body.items.length).toBeGreaterThan(30);
    expect(page.body.nextCursor).not.toBeNull();
    const rest = await walk((cursor) => t.call<Page<ConversationMessage>>("listConversationMessages", { params: { conversationId: big.body.conversation.id }, query: { limit: 200, cursor: cursor ?? page.body.nextCursor! } }), (m) => m.id);
    expect([...page.body.items, ...rest.items].map((m) => m.id)).toEqual(bigIds);
    expect(page.body.items.every((m) => m.content.length === 30_003)).toBe(true);
  });

  it("refuses a JSON response that cannot fit the response bound as payload_too_large instead of truncating it", async () => {
    const bounded = await openTestApp({ responseMaxBytes: 16_384 });
    try {
      const workspace = await bounded.call<{ workspace: { id: string } }>("createWorkspace", { body: { rootPath: path.join(bounded.dir, "w"), create: true } });
      const conversation = await bounded.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId: workspace.body.workspace.id, title: "bounded" } });
      const refused = await bounded.call<ApiErrorBody>("postConversationMessage", { params: { conversationId: conversation.body.conversation.id }, body: { content: "z".repeat(20_000) } });
      // The mutation committed; its echo cannot be served within the bound.
      expect(refused.status).toBe(413);
      expect(refused.body.error).toMatchObject({ code: "payload_too_large", details: { field: "response" } });
      const listed = await bounded.call<Page<ConversationMessage>>("listConversationMessages", { params: { conversationId: conversation.body.conversation.id }, query: { limit: 1 } });
      expect(listed.status).toBe(413);
      const small = await bounded.call<Page<ConversationMessage>>("listConversationMessages", { params: { conversationId: conversation.body.conversation.id }, query: { limit: 1, order: "desc" } });
      expect(small.status).toBe(413);
      expect(API_RESPONSE_MAX_BYTES).toBeGreaterThan(PAGE_MAX_BYTES);
    } finally {
      await bounded.close();
      removeAppDirectory(bounded.dir);
    }
  });

  it("pages Runs, Conversations, Workspaces, Decisions by status, Tasks, Invocations by Plan Node, and Usage by Invocation, and windows a Plan Node's histories beside their totals", async () => {
    // Several Conversations and Runs beyond one page.
    const conversationIds: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const c = await t.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId, title: `c${i}` } });
      conversationIds.push(c.body.conversation.id);
    }
    const conversations = await walk((cursor) => t.call<Page<{ conversation: { id: string } }>>("listWorkspaceConversations", { params: { workspaceId }, query: { limit: 4, ...(cursor === null ? {} : { cursor }) } }), (c) => c.conversation.id);
    expect(conversations.pages).toBeGreaterThanOrEqual(3);
    expect(conversations.items.map((c) => c.conversation.id)).toEqual(expect.arrayContaining(conversationIds));
    const all = await walk((cursor) => t.call<Page<{ conversation: { id: string } }>>("listConversations", { query: { limit: 4, ...(cursor === null ? {} : { cursor }) } }), (c) => c.conversation.id);
    expect(all.items.length).toBe(conversations.items.length);
    const runIds: string[] = [];
    for (const id of conversationIds.slice(0, 5)) {
      const run = await t.call<RunOverview>("createRun", { params: { conversationId: id }, body: { goal: `goal ${id}`, completionCheck: CHECK, start: false } });
      expect(run.status).toBe(201);
      runIds.push(run.body.run.id);
    }
    const runs = await walk((cursor) => t.call<Page<{ id: string }>>("listWorkspaceRuns", { params: { workspaceId }, query: { limit: 2, ...(cursor === null ? {} : { cursor }) } }), (r) => r.id);
    expect(runs.pages).toBe(3);
    expect(runs.items.map((r) => r.id)).toEqual(runIds);
    const workspaces = await t.call<Page<{ workspace: { id: string } }>>("listWorkspaces", { query: { limit: 1 } });
    expect(workspaces.body.items).toHaveLength(1);
    // The Run's collections: the root Invocation, the empty ledger, the plan node window, the usage page.
    const runId = runIds[0]!;
    const invocations = await t.call<Page<{ id: string; planNodeId: string }>>("listRunInvocations", { params: { runId } });
    expect(invocations.status).toBe(200);
    const plan = await t.call<{ graph: { nodes: { id: string }[] } }>("getRunPlan", { params: { runId } });
    const rootId = plan.body.graph.nodes[0]!.id;
    const byNode = await t.call<Page<{ id: string }>>("listRunInvocations", { params: { runId }, query: { planNodeId: rootId, limit: 10 } });
    expect(byNode.status).toBe(200);
    expect(byNode.body.items.length).toBe(invocations.body.items.filter((i) => i.planNodeId === rootId).length);
    const foreignNode = await t.call<ApiErrorBody>("listRunInvocations", { params: { runId }, query: { planNodeId: "not-a-node" } });
    expect(foreignNode.status).toBe(400);
    const node = await t.call<PlanNodeResponse>("getPlanNode", { params: { planNodeId: rootId } });
    expect(node.status).toBe(200);
    expect(node.body).toMatchObject({ invocationCount: node.body.invocations.length, taskCount: 0, gateCount: 0, evaluationCount: 0, extensionCount: 0 });
    const ledger = await t.call<Page<TaskView>>("listRunTasks", { params: { runId }, query: { limit: 5 } });
    expect(ledger.status).toBe(200);
    expect(ledger.body).toEqual({ items: [], nextCursor: null, reverseCursor: null });
    const decisions = await t.call<Page<unknown>>("listRunDecisions", { params: { runId }, query: { status: "open", limit: 5 } });
    expect(decisions.status).toBe(200);
    expect((await t.call<ApiErrorBody>("listRunDecisions", { params: { runId }, query: { status: "pending" } })).status).toBe(400);
    const usage = await t.call<UsageResponse>("getRunUsage", { params: { runId }, query: { limit: 1 } });
    expect(usage.status).toBe(200);
    expect(usage.body.byInvocation).toMatchObject({ items: expect.any(Array), nextCursor: null });
    const revisions = await t.call<Page<{ number: number }>>("listRunPlanRevisions", { params: { runId }, query: { limit: 1 } });
    expect(revisions.body.items.map((r) => r.number)).toEqual([1]);
    expect(revisions.body.nextCursor).toBeNull();
  }, 120_000);
});
