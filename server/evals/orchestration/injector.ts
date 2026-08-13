/**
 * Milestone-triggered failure injection: subscribe to the harness bus and run
 * each injection's `act` exactly once, after the first event matching `when`.
 * Formalizes the collectUntil-plus-gate idiom the e2e suite hand-rolls.
 */
import type { Harness } from "../../src/test-helpers.ts";
import type { Ev } from "./trace.ts";
import type { Injection } from "./scenario.ts";

export interface ArmedInjector {
  /** Stops listening; resolves once in-flight acts settle. */
  disarm(): Promise<void>;
  /** Rejects the scenario run if any act threw. */
  failures: Error[];
}

export function armInjections(harness: Harness, injections: Injection[]): ArmedInjector {
  const pending = new Set<Promise<void>>();
  const failures: Error[] = [];
  const remaining = [...injections];
  const source = harness.bus.readWithSeq({ fromSeq: 1, follow: true });
  const iterator = source[Symbol.asyncIterator]();
  let stopped = false;

  void (async () => {
    for (;;) {
      const next = await iterator.next().catch(() => ({ done: true as const, value: undefined }));
      if (stopped || next.done === true || remaining.length === 0) return;
      const event = next.value as unknown as Ev;
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const injection = remaining[i]!;
        if (!injection.when(event)) continue;
        remaining.splice(i, 1);
        const act = Promise.resolve()
          .then(() => injection.act(harness))
          .catch((error: unknown) => {
            failures.push(error instanceof Error ? error : new Error(String(error)));
          })
          .then(() => undefined);
        pending.add(act);
        void act.finally(() => pending.delete(act));
      }
    }
  })();

  return {
    async disarm() {
      stopped = true;
      // Fire-and-forget: return() cannot interrupt a parked next().
      void iterator.return?.().catch(() => undefined);
      await Promise.all([...pending]);
    },
    failures,
  };
}
