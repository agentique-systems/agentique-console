/**
 * The scripted operator for live runs: polls pending interaction cards and
 * answers them from the scenario's operatorScript. Each step fires once, in
 * order of first match — the same semantics Tier A's armOperator applies, so
 * a scenario means the same thing in both tiers.
 *
 * An optional LLM-operator mode (persona-driven free-text answers) is a
 * deliberate later addition; the scripted table is the reproducible baseline.
 */
import type { App } from "../../../src/app.ts";
import type { OperatorStep } from "../scenario.ts";

export interface OperatorPolicy {
  stop(): void;
}

export function runOperatorPolicy(
  app: App,
  userSessionId: string,
  steps: OperatorStep[],
  options: { pollMs?: number; log?: (line: string) => void } = {},
): OperatorPolicy {
  const remaining = [...steps];
  const log = options.log ?? (() => undefined);
  const timer = setInterval(() => {
    if (remaining.length === 0) return;
    let pending: { id: string; kind: string; payload?: { questions?: { question?: string }[]; spec?: unknown } }[];
    try {
      pending = app.interactions.listPending(userSessionId) as typeof pending;
    } catch {
      return;
    }
    for (const row of pending) {
      const texts = (row.payload?.questions ?? []).map((question) => question.question ?? "").join("\n");
      const index = remaining.findIndex((step) => {
        if ("onQuestionMatching" in step) return row.kind === "question" && step.onQuestionMatching.test(texts);
        if ("onProposal" in step) {
          if (row.kind !== "plan_approval") return false;
          const isSpec = row.payload?.spec !== undefined;
          return step.kind === undefined || (step.kind === "spec" && isSpec);
        }
        return false;
      });
      if (index === -1) continue;
      const step = remaining.splice(index, 1)[0]!;
      try {
        if ("onQuestionMatching" in step) {
          app.interactions.resolveFromApi(userSessionId, row.id, {
            answers: step.answer,
            ...(step.freeText === undefined ? {} : { freeText: step.freeText }),
          } as Parameters<typeof app.interactions.resolveFromApi>[2]);
          log(`operator: answered "${texts.slice(0, 60)}"`);
        } else if ("onProposal" in step) {
          app.interactions.resolveFromApi(userSessionId, row.id, {
            decision: step.onProposal === "approve" ? "approve" : "reject",
            ...(step.note === undefined ? {} : { note: step.note }),
          } as Parameters<typeof app.interactions.resolveFromApi>[2]);
          log(`operator: ${step.onProposal}d proposal`);
        }
      } catch (error) {
        log(`operator: resolve failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    // The sign-off is run state, not an interaction — resolve it through the
    // completion service, exactly as the API route does. (The old
    // `row.kind === "signoff"` match here could never fire.)
    try {
      if (app.repo.getUserSession(userSessionId)?.runState === "awaiting_signoff") {
        const index = remaining.findIndex((step) =>
          "onProposal" in step && (step.kind === undefined || step.kind === "completion"));
        if (index !== -1) {
          const step = remaining.splice(index, 1)[0]! as Extract<OperatorStep, { onProposal: "approve" | "reject" }>;
          app.completion.resolve(userSessionId, step.onProposal === "approve" ? "accept" : "changes", step.note);
          log(`operator: ${step.onProposal}d sign-off`);
        }
      }
    } catch (error) {
      log(`operator: sign-off resolve failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }, options.pollMs ?? 2_000);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
