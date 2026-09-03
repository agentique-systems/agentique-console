/**
 * Capacity release over the real composition (execution-model §7.8, §14
 * "Provider capacity refused by the governor"): the production scheduler,
 * governor, persistence, and host, with the SDK fixture as the provider and
 * a barrier that holds one Attempt — and its one lease — for as long as the
 * test wants. Run A holds the shared capacity; Run B's pass ends waiting on
 * `provider_capacity` with no resumption time (no mark, no timer, nothing
 * queued); when A's lease is released by its own finalization, the committed
 * release re-projects B, which proceeds without an operator action, a
 * reconnect, a restart, or a polling timer. A Run waiting on a Decision is
 * not touched, repeated notifications create no duplicate, a shutdown that
 * releases A's lease admits nothing for B, and the next process
 * reconstructs both from rows.
 *
 * §15 invariants exercised here: 2, 8, 9, 13.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Attempt, CapacityResponse, Page, RunOverview } from "@agentique-console/core";
import { FakeClaudeSdk, type FakeSdkTurn } from "../provider/claude-sdk-test-support.ts";
import { CHECK, initFixtureRepo, returned, tool } from "./e2e-fixture.ts";
import { newAppDirectory, openTestApp, removeAppDirectory, type TestApp } from "./test-support.ts";

/** One provider slot for the whole process: the second Attempt of any Run is refused until the first ends. */
const ONE_SLOT = { CONSOLE_PROVIDER_MAX_CONCURRENCY: "1", CONSOLE_PROCESS_MAX_ATTEMPTS: "1" };

interface Barrier {
  promise: Promise<void>;
  release: () => void;
}

function barrier(): Barrier {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** A turn held at the barrier: the Attempt executes, holding its lease, until the test releases it or the runtime interrupts it. */
const holding = (b: Barrier, summary: string): FakeSdkTurn => ({ steps: [{ kind: "wait", until: b.promise }, returned(summary)] });

/** A turn that asks the operator a Decision: the Run waits on `decision`, its lease released. */
const asking = (): FakeSdkTurn => ({ steps: [{ kind: "tool_use", name: tool("request_decision"), input: { kind: "operator_choice", question: "Proceed?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }], recommendedOptionKey: "yes", resolutionPolicy: { kind: "operator_required" }, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } } }] });

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) {
      if (process.env.CAPACITY_TEST_TRACE) console.log(`[capacity] ${what}: ${Date.now() - started}ms`);
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last).slice(0, 1_500)}`);
}

interface World {
  t: TestApp;
  dir: string;
  workspaceId: string;
}

async function openWorld(dir: string, sdk: FakeClaudeSdk): Promise<World> {
  const t = await openTestApp({ dir, sdk, env: ONE_SLOT });
  const repo = initFixtureRepoOnce(dir);
  const workspaces = await t.call<Page<{ workspace: { id: string; rootPath: string } }>>("listWorkspaces");
  let workspaceId = workspaces.body.items.find((w) => w.workspace.rootPath === repo)?.workspace.id ?? null;
  if (workspaceId === null) {
    const created = await t.call<{ workspace: { id: string } }>("createWorkspace", { body: { rootPath: repo } });
    expect(created.status).toBe(201);
    workspaceId = created.body.workspace.id;
  }
  return { t, dir, workspaceId };
}

const repos = new Map<string, string>();
function initFixtureRepoOnce(dir: string): string {
  const existing = repos.get(dir);
  if (existing !== undefined) return existing;
  const repo = initFixtureRepo(dir);
  repos.set(dir, repo);
  return repo;
}

/** Creates a Conversation and starts a Run in it from the operator's goal; the fixture's next turn answers its first Orchestrator turn. */
async function startRun(w: World, title: string): Promise<string> {
  const conversation = await w.t.call<{ conversation: { id: string } }>("createConversation", { body: { workspaceId: w.workspaceId, title } });
  expect(conversation.status).toBe(201);
  const created = await w.t.call<RunOverview>("createRun", { params: { conversationId: conversation.body.conversation.id }, body: { goal: `${title}: add --version`, completionCheck: CHECK } });
  expect(created.status).toBe(201);
  return created.body.run.id;
}

const overview = (w: World, runId: string) => w.t.call<RunOverview>("getRun", { params: { runId } }).then((r) => r.body);

/** The Attempts of the Run's one root Invocation, by status. */
async function rootAttempts(w: World, runId: string): Promise<Attempt[]> {
  const invocations = await w.t.call<Page<{ id: string; role: string }>>("listRunInvocations", { params: { runId } });
  const roots = invocations.body.items.filter((i) => i.role === "orchestrator");
  expect(roots).toHaveLength(1);
  const attempts = await w.t.call<Page<Attempt>>("listInvocationAttempts", { params: { invocationId: roots[0]!.id } });
  return attempts.body.items;
}

const capacity = (w: World) => w.t.call<CapacityResponse>("capacity").then((r) => r.body);
const hostReleases = (w: World) => w.t.app.diagnostics.list().filter((d) => d.source === "host" && d.diagnostic.kind === "capacity_released").map((d) => (d.diagnostic as { runIds: string[] }).runIds);

describe("capacity release re-projection over the real composition", () => {
  const worlds: World[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) {
      await w.t.close().catch(() => undefined);
      removeAppDirectory(w.dir);
    }
  });

  it("resumes a Run that waits on provider capacity when the holder's lease release commits — no operator action, reconnect, restart, or timer — without touching a Decision waiter or duplicating anything", async () => {
    const sdk = new FakeClaudeSdk();
    const w = await openWorld(newAppDirectory("agentique-capacity-"), sdk);
    worlds.push(w);
    // C asks the operator a Decision first: it waits on `decision` with its lease released, and must stay there.
    sdk.script(asking());
    const runC = await startRun(w, "C");
    await until(() => overview(w, runC), (o) => o.phase === "waiting_decision", "C waiting on its Decision");
    expect((await rootAttempts(w, runC)).map((a) => a.status)).toEqual(["failed"]);
    // A holds the one slot at the barrier.
    const hold = barrier();
    sdk.script(holding(hold, "A done"));
    const runA = await startRun(w, "A");
    await until(() => capacity(w), (c) => c.activeLeases.length === 1 && c.activeLeases[0]!.runId === runA, "A's lease");
    // B's pass is refused capacity: the Run row records `waiting`/`provider_capacity`, and the host holds no mark, timer, or queue entry for it.
    sdk.script({ steps: [returned("B done")] });
    const runB = await startRun(w, "B");
    const waiting = await until(() => overview(w, runB), (o) => o.phase === "waiting_capacity", "B waiting on capacity");
    expect(waiting.run).toMatchObject({ status: "waiting", waitReason: "provider_capacity" });
    // A's pass stays active for as long as its Attempt executes; B's pass ended: not active, not queued, no timer, only remembered as a capacity waiter.
    await until(() => Promise.resolve(w.t.app.host.snapshot()), (s) => !s.active.includes(runB as never) && s.queued.length === 0, "B's pass to end");
    expect(w.t.app.host.snapshot()).toMatchObject({ active: [runA], queued: [], armed: [], capacityWaiters: [runB] });
    expect(await rootAttempts(w, runB)).toEqual([]);
    expect(hostReleases(w)).toEqual([]);
    // Time passes and repeated notifications arrive: nothing polls and nothing duplicates — the governor still refuses, so B keeps waiting.
    await new Promise((resolve) => setTimeout(resolve, 300));
    w.t.app.host.notifyRun(runB as never);
    w.t.app.host.notifyRun(runB as never);
    await until(() => Promise.resolve(w.t.app.host.snapshot()), (s) => !s.active.includes(runB as never) && s.queued.length === 0, "B's re-projection to end");
    expect(await rootAttempts(w, runB)).toEqual([]);
    expect((await overview(w, runB)).phase).toBe("waiting_capacity");
    expect((await capacity(w)).activeLeases.map((l) => l.runId)).toEqual([runA]);
    // A finishes: its finalization releases the lease and commits; the committed release re-projects B, which executes its turn.
    hold.release();
    await until(() => rootAttempts(w, runB), (a) => a.length === 1 && a[0]!.status === "succeeded", "B's turn", 60_000);
    expect(hostReleases(w).some((ids) => ids.includes(runB))).toBe(true);
    expect((await rootAttempts(w, runA)).map((a) => a.status)).toEqual(["succeeded"]);
    expect(sdk.remainingTurns).toBe(0);
    await until(() => overview(w, runB), (o) => o.phase === "running" && (o.projection?.inFlight.length ?? 1) === 0, "B idle");
    // Exactly one lease, one Invocation, one Attempt for B; C untouched: still waiting on its Decision with its one Attempt.
    const leasesB = w.t.app.runtime.stores.leases.listByRun(runB as never);
    expect(leasesB.map((l) => l.status)).toEqual(["released"]);
    expect((await w.t.call<Page<unknown>>("listRunInvocations", { params: { runId: runB } })).body.items).toHaveLength(1);
    expect((await overview(w, runC)).phase).toBe("waiting_decision");
    expect((await rootAttempts(w, runC)).map((a) => a.status)).toEqual(["failed"]);
    expect((await w.t.call<Page<unknown>>("listRunInvocations", { params: { runId: runC } })).body.items).toHaveLength(1);
    // Later notifications of an idle B change nothing.
    w.t.app.host.notifyRun(runB as never);
    await w.t.app.host.idle();
    expect(await rootAttempts(w, runB)).toHaveLength(1);
    expect(w.t.app.runtime.stores.leases.listByRun(runB as never)).toHaveLength(1);
  }, 120_000);

  it("admits nothing for the waiter through the release a shutdown commits, and the next process reconstructs both Runs from rows", async () => {
    const dir = newAppDirectory("agentique-capacity-");
    const sdk = new FakeClaudeSdk();
    let w = await openWorld(dir, sdk);
    worlds.push(w);
    const hold = barrier();
    sdk.script(holding(hold, "A done"));
    const runA = await startRun(w, "A");
    await until(() => capacity(w), (c) => c.activeLeases.length === 1, "A's lease");
    sdk.script({ steps: [returned("B done")] });
    const runB = await startRun(w, "B");
    await until(() => overview(w, runB), (o) => o.phase === "waiting_capacity", "B waiting on capacity");
    await until(() => Promise.resolve(w.t.app.host.snapshot()), (s) => !s.active.includes(runB as never) && s.queued.length === 0, "B's pass to end");
    // Shutdown interrupts A; A's finalization releases the lease and commits — after the host stopped, so B receives nothing.
    await w.t.close();
    worlds.splice(0);
    // The rows as the dead process left them, read through the stores of a composition that has not booted (no recovery, no host).
    const rows = await openTestApp({ dir, sdk: new FakeClaudeSdk(), env: ONE_SLOT, boot: false });
    try {
      const attemptsOf = (runId: string) => rows.app.runtime.stores.invocations.listByRun(runId as never).flatMap((i) => rows.app.runtime.stores.invocations.listAttempts(i.id).map((a) => a.status));
      expect(attemptsOf(runA)).toEqual(["interrupted"]);
      expect(attemptsOf(runB)).toEqual([]);
      expect(rows.app.runtime.stores.runs.get(runB as never)).toMatchObject({ status: "waiting", waitReason: "provider_capacity" });
      expect(rows.app.runtime.stores.leases.listActive()).toEqual([]);
    } finally {
      await rows.app.close();
    }
    // The next process: recovery, then reconstruction from rows — A retries, B proceeds; one slot serialises them and nothing repeats.
    const again = new FakeClaudeSdk();
    again.script({ steps: [returned("A done")] }, { steps: [returned("B done")] });
    w = await openWorld(dir, again);
    worlds.push(w);
    await until(() => rootAttempts(w, runB), (a) => a.length === 1 && a[0]!.status === "succeeded", "B's turn in the new process", 60_000);
    await until(() => rootAttempts(w, runA), (a) => a.length === 2 && a[1]!.status === "succeeded", "A's retry in the new process", 60_000);
    expect((await rootAttempts(w, runA)).map((a) => a.status)).toEqual(["interrupted", "succeeded"]);
    expect(again.remainingTurns).toBe(0);
    expect(w.t.app.runtime.stores.leases.listByRun(runB as never)).toHaveLength(1);
    expect((await w.t.call<Page<unknown>>("listRunInvocations", { params: { runId: runB } })).body.items).toHaveLength(1);
  }, 120_000);
});
