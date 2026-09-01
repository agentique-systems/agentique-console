/**
 * Shared fixtures for the operator Run-control suites (execution-model
 * §14): a planned Run with its first root turn finished, a pass held at a
 * provider barrier so control arrives while an Attempt executes, the
 * durable facts a control operation could duplicate or lose, and readers
 * over Attempt, Invocation, Task, node, reservation, lease, and Event rows.
 * Nothing here reads a transcript or process memory of the runtime.
 */
import type { AttemptId, InvocationId, PlanExpression, PlanNode, RunId } from "@agentique-console/core";
import type { FakeStep } from "../provider/fake.ts";
import { finishRoot, until } from "./coordinator-test-support.ts";
import type { SchedulerOutcome } from "./scheduler.ts";
import { COMPLETED_RESULT, planNodes, seedPlanningRuntime, type RuntimeHarness, type RuntimeSeedOverrides } from "./test-support.ts";

export type PlanningSeed = ReturnType<typeof seedPlanningRuntime>;

export const NODE_ALLOCATION = { costUsd: 6, tokens: 60_000, attempts: 6 };

/** A `single` worker expression with a generous node allocation. */
export const single = (s: PlanningSeed, title: string, extra: Partial<PlanExpression> = {}): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title }, allocation: NODE_ALLOCATION, ...extra }) as PlanExpression;

/** A `chain` of single steps. */
export const chain = (s: PlanningSeed, titles: string[]): PlanExpression => ({ pattern: "chain", steps: titles.map((title): PlanExpression => ({ pattern: "single", operation: { agentDefinitionRevisionId: s.worker.id, title } })), allocation: NODE_ALLOCATION }) as PlanExpression;

/** A provider step that completes only when the test releases `key` (or the runtime interrupts it), then answers `then`. */
export const delayed = (key: string, then: FakeStep = { kind: "succeed", result: COMPLETED_RESULT }): FakeStep => ({ kind: "delay", key, then });

/** A Run planned with the expressions `build` derives from its seed, whose first root turn has finished, so a pass starts on the plan. */
export async function planned(h: RuntimeHarness, build: (s: PlanningSeed) => PlanExpression[], overrides: RuntimeSeedOverrides = {}) {
  const s = seedPlanningRuntime(h, overrides);
  const { nodes, revisionNumber } = planNodes(h, s, build(s));
  await finishRoot(h, s);
  return { s, runId: s.created.run.id, nodes, revisionNumber };
}

/** Starts a pass and yields until the provider holds every one of `keys` at its barrier: an Attempt is executing for each. The pass is returned unawaited (wrapped, so `await` does not flatten it). */
export async function executing(h: RuntimeHarness, runId: RunId, keys: string[], options: { maxActions?: number } = {}): Promise<{ pass: Promise<SchedulerOutcome> }> {
  const pass = h.scheduler.advanceRun(runId, options);
  await until(() => keys.every((key) => h.provider.delayedKeys.includes(key)));
  return { pass };
}

/** Everything a control operation could duplicate or lose, from rows alone. */
export function work(h: RuntimeHarness, runId: RunId) {
  const invocations = h.stores.invocations.listByRun(runId);
  return {
    invocations: invocations.length,
    attempts: invocations.reduce((n, i) => n + h.stores.invocations.listAttempts(i.id).length, 0),
    usage: invocations.reduce((n, i) => n + h.stores.invocations.listAttempts(i.id).reduce((m, a) => m + h.stores.usage.listByAttempt(a.id).length, 0), 0),
    handoffs: h.stores.handoffs.listByRun(runId).length,
    changesets: h.stores.changesets.listByRun(runId).length,
    integrated: h.stores.changesets.listByRun(runId).filter((c) => c.integrationStatus === "integrated").length,
    events: h.ctx.journal.lastSeq(),
  };
}

/** The Attempts of an Invocation as `[number, status, retry permitted]`. */
export const attemptsOf = (h: RuntimeHarness, invocationId: InvocationId) => h.stores.invocations.listAttempts(invocationId).map((a) => [a.number, a.status, a.retryDecision?.permitted ?? null] as const);

/** The one Invocation of a single node. */
export function invocationOf(h: RuntimeHarness, node: PlanNode) {
  const [invocation, ...more] = h.stores.invocations.listByPlanNode(node.id);
  if (invocation === undefined || more.length > 0) throw new Error(`PlanNode ${node.id} holds ${more.length + (invocation ? 1 : 0)} Invocations, not one`);
  return invocation;
}

/** The statuses of the Run's nodes (membership order of `nodes`) and of its root. */
export const statuses = (h: RuntimeHarness, nodes: PlanNode[]) => nodes.map((n) => h.stores.plans.getNode(n.id).status);

/** Every active reservation and lease of the Run, by id: what a cancellation must have settled. */
export function activeCapacity(h: RuntimeHarness, runId: RunId) {
  const reservations = h.stores.reservations.listByParent({ type: "run", id: runId }).filter((r) => r.status === "active").map((r) => r.id);
  for (const node of h.stores.plans.listNodes(runId)) for (const r of h.stores.reservations.listByParent({ type: "plan_node", id: node.id })) if (r.status === "active") reservations.push(r.id);
  return { reservations: reservations.sort(), leases: h.stores.leases.listByRun(runId).filter((l) => l.status === "active").map((l) => l.id) };
}

/** The Event types journaled for the Run after `seq`, filtered to `prefixes`. */
export const eventsAfter = (h: RuntimeHarness, runId: RunId, seq: number, prefixes: string[] = ["run."]) => h.ctx.journal.read({ runId, afterSeq: seq }).map((e) => e.type).filter((t) => prefixes.some((p) => t.startsWith(p)));

/** The Attempt ids the executor reports in flight for the Run. */
export const inFlightOf = (h: RuntimeHarness, runId: RunId): AttemptId[] => h.executor.inFlightOf(runId);

export { finishRoot, until };
