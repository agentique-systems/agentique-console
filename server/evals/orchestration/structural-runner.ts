/**
 * Tier A engine: run one scenario variant through the REAL composition root
 * (makeHarness) with its scripted programs, service the operator script
 * against interaction cards and sign-offs, optionally restart the harness
 * mid-run (real bootApp recovery over the same sqlite), wait for the
 * scenario's done event, and evaluate every check against the resulting
 * journal.
 */
import type { ConsoleEvent } from "@agentique-console/shared";
import { collectUntil, makeHarness, restartHarness, type Harness } from "../../src/test-helpers.ts";
import { makeGate } from "./programs.ts";
import type { CheckResult, OperatorStep, OrchestrationScenario } from "./scenario.ts";
import { Trace, type Ev } from "./trace.ts";

export interface VariantRun {
  harness: Harness;
  userSessionId: string;
  trace: Trace;
  results: { id: string; dimension: string; description: string; result: CheckResult }[];
}

function questionTextsOf(harness: Harness, userSessionId: string, interactionId: unknown): string {
  const pending = harness.interactions.listPending(userSessionId);
  const row = pending.find((entry) => entry.id === interactionId) ?? pending[0];
  const payload = (row as { payload?: { questions?: { question?: string }[] } } | undefined)?.payload;
  return (payload?.questions ?? []).map((question) => question.question ?? "").join("\n");
}

/**
 * Services operatorScript steps against the live bus; steps fire once, in
 * order of first match. disarm() returns the UNFIRED steps so a restarted
 * harness can re-arm them (the operator outlives the process).
 */
function armOperator(harness: Harness, userSessionId: string, steps: OperatorStep[]): { disarm: () => Promise<OperatorStep[]> } {
  const remaining = [...steps];
  const source = harness.bus.readWithSeq({ fromSeq: 1, follow: true });
  const iterator = source[Symbol.asyncIterator]();
  let stopped = false;

  void (async () => {
    for (;;) {
      const next = await iterator.next().catch(() => ({ done: true as const, value: undefined }));
      if (stopped || next.done === true || remaining.length === 0) return;
      const event = next.value as ConsoleEvent;
      const index = remaining.findIndex((step) => {
        if ("onQuestionMatching" in step) {
          if (event.type !== "user_session.question.asked") return false;
          const texts = questionTextsOf(harness, userSessionId, (event.payload as { interactionId?: unknown }).interactionId);
          return step.onQuestionMatching.test(texts);
        }
        if ("afterEvent" in step) return step.afterEvent(event as unknown as Ev);
        if ("onProposal" in step) {
          if (event.type === "user_session.plan.proposed") {
            // "spec" matches whichever governing-document card the run uses —
            // the requirement graph or the legacy markdown spec.
            const isSpec = (event.payload as { spec?: unknown; requirements?: unknown }).spec !== undefined
              || (event.payload as { requirements?: unknown }).requirements !== undefined;
            return step.kind === undefined || (step.kind === "spec" && isSpec);
          }
          if (event.type === "run.completion.proposed") {
            return step.kind === undefined || step.kind === "completion";
          }
          return false;
        }
        return false;
      });
      if (index === -1) continue;
      const step = remaining.splice(index, 1)[0]!;
      try {
        if ("onQuestionMatching" in step) {
          const interactionId = (event.payload as { interactionId?: string }).interactionId;
          const pending = harness.interactions.listPending(userSessionId);
          const row = pending.find((entry) => entry.id === interactionId) ?? pending[0];
          if (row) {
            harness.interactions.resolveFromApi(userSessionId, row.id, {
              answers: step.answer,
              ...(step.freeText === undefined ? {} : { freeText: step.freeText }),
            } as Parameters<typeof harness.interactions.resolveFromApi>[2]);
          }
        } else if ("afterEvent" in step) {
          harness.runner.postOperatorMessage(userSessionId, step.say);
        } else if ("onProposal" in step) {
          if (event.type === "user_session.plan.proposed") {
            // The spec/plan card: resolve the parked interaction (the same
            // path the API takes; propose_spec unblocks on it).
            const interactionId = (event.payload as { interactionId?: string }).interactionId;
            const pending = harness.interactions.listPending(userSessionId);
            const row = pending.find((entry) => entry.id === interactionId)
              ?? pending.find((entry) => (entry as { kind?: string }).kind === "plan_approval");
            if (row) {
              harness.interactions.resolveFromApi(userSessionId, row.id, {
                decision: step.onProposal,
                ...(step.note === undefined ? {} : { note: step.note }),
              } as Parameters<typeof harness.interactions.resolveFromApi>[2]);
            }
          } else {
            // The sign-off is run state, not an interaction — resolve through
            // the completion service, exactly as the API route does.
            harness.completion.resolve(userSessionId, step.onProposal === "approve" ? "accept" : "changes", step.note);
          }
        }
      } catch {
        // A step that raced a settled turn is not a scenario failure.
      }
    }
  })();

  return {
    async disarm() {
      stopped = true;
      // Fire-and-forget: return() cannot interrupt a parked next().
      void iterator.return?.().catch(() => undefined);
      return remaining;
    },
  };
}

export async function runScenarioVariant(
  scenario: OrchestrationScenario,
  variantName: string,
): Promise<VariantRun> {
  const fake = scenario.fake;
  if (!fake) throw new Error(`scenario ${scenario.id} has no Tier A material`);
  const variant = fake.variants[variantName];
  if (!variant) throw new Error(`scenario ${scenario.id} has no variant ${variantName}`);

  let live: Harness | null = null;
  const ctx = {
    makeGate,
    harness(): Harness {
      if (live === null) throw new Error("ctx.harness() is only available once the run has started");
      return live;
    },
  };
  let harness = makeHarness(variant.program(ctx), fake.harness);
  live = harness;
  const userSessionId = harness.addUserSession();

  let operator = armOperator(harness, userSessionId, scenario.operatorScript);
  const timeoutMs = fake.timeoutMs ?? 10_000;
  const doneWhen = variant.doneWhen?.() ?? fake.doneWhen?.() ?? ((event: Ev) => event.type === "agent_session.result.returned");

  // The governance sweep (pattern stall + liveness alarms) runs in scenarios
  // exactly as in production — the supervision scenarios depend on it.
  harness.host.startGovernanceSweep(10);
  try {
    if (fake.restart) {
      // Phase 1: run until the restart trigger, then die and recover — same
      // sqlite, real bootApp recovery (the path recovery.test.ts proves).
      const restartAt = collectUntil(harness.bus, (event) => fake.restart!.when()(event as unknown as Ev), timeoutMs);
      harness.runner.postOperatorMessage(userSessionId, scenario.taskCard);
      await restartAt;
      harness.host.stopGovernanceSweep();
      const unfired = await operator.disarm();
      const restarted = await restartHarness(harness);
      harness = restarted;
      live = restarted;
      operator = armOperator(harness, userSessionId, unfired);
      harness.host.startGovernanceSweep(10);
      await collectUntil(harness.bus, (event) => doneWhen(event as unknown as Ev), timeoutMs);
    } else {
      const done = collectUntil(harness.bus, (event) => doneWhen(event as unknown as Ev), timeoutMs);
      harness.runner.postOperatorMessage(userSessionId, scenario.taskCard);
      await done;
    }
    // Give trailing async work (deliveries, completion sweep) a breath before reading.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    harness.host.stopGovernanceSweep();
    await operator.disarm();
  }

  const trace = Trace.fromSqlite(harness.sqlite, userSessionId);
  const results = scenario.checks.map((check) => ({
    id: check.id,
    dimension: check.dimension,
    description: check.description,
    result: check.run(trace),
  }));
  return { harness, userSessionId, trace, results };
}
