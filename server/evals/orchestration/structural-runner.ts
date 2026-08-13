/**
 * Tier A engine: run one scenario variant through the REAL composition root
 * (makeHarness) with its scripted programs, service the operator script
 * against interaction cards, wait for the scenario's done event, and evaluate
 * every check against the resulting journal.
 */
import type { ConsoleEvent } from "@agentique-console/shared";
import { collectUntil, makeHarness, type Harness } from "../../src/test-helpers.ts";
import { armInjections } from "./injector.ts";
import { makeGate } from "./programs.ts";
import type { CheckResult, OperatorStep, OrchestrationScenario } from "./scenario.ts";
import { Trace, type Ev } from "./trace.ts";

export interface VariantRun {
  harness: Harness;
  userSessionId: string;
  trace: Trace;
  results: { id: string; dimension: string; description: string; result: CheckResult }[];
  /** Errors thrown by injections; a non-empty list fails the variant run. */
  injectionFailures: Error[];
}

function questionTextsOf(harness: Harness, userSessionId: string, interactionId: unknown): string {
  const pending = harness.interactions.listPending(userSessionId);
  const row = pending.find((entry) => entry.id === interactionId) ?? pending[0];
  const payload = (row as { payload?: { questions?: { question?: string }[] } } | undefined)?.payload;
  return (payload?.questions ?? []).map((question) => question.question ?? "").join("\n");
}

/** Services operatorScript steps against the live bus; steps fire once, in order. */
function armOperator(harness: Harness, userSessionId: string, steps: OperatorStep[]): { disarm: () => Promise<void> } {
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
        if ("onProposal" in step) return event.type === "run.completion.proposed";
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
        }
        // onProposal resolution is a Tier B concern; Tier A scenarios end at
        // the proposal event itself.
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
  const harness = makeHarness(variant.program(ctx), fake.harness);
  live = harness;
  const userSessionId = harness.addUserSession();

  const injector = armInjections(harness, fake.injections ?? []);
  const operator = armOperator(harness, userSessionId, scenario.operatorScript);
  const doneWhen = fake.doneWhen?.() ?? ((event: Ev) => event.type === "agent_session.result.returned");
  const done = collectUntil(harness.bus, (event) => doneWhen(event as unknown as Ev), fake.timeoutMs ?? 10_000);

  harness.runner.postOperatorMessage(userSessionId, scenario.taskCard);
  await done;
  // Give trailing async work (deliveries, completion sweep) a breath before reading.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await operator.disarm();
  await injector.disarm();

  const trace = Trace.fromSqlite(harness.sqlite, userSessionId);
  const results = scenario.checks.map((check) => ({
    id: check.id,
    dimension: check.dimension,
    description: check.description,
    result: check.run(trace),
  }));
  return { harness, userSessionId, trace, results, injectionFailures: injector.failures };
}
