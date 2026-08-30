/**
 * Shared fixtures for the Run completion suites (execution-model §10
 * `run_completion` and `operator_signoff`): the scripted root turn that
 * requests completion, the scripted read-only `final_synthesis` turn that
 * answers from its typed `final_synthesis` input, a later operator turn
 * (what a posted operator message prepares once the API exists), and
 * canonical readers over Completion Request, Gate, Evaluation, Invocation,
 * Decision, and Artifact rows. Nothing here reads a transcript or process
 * memory of the runtime.
 */
import { FINAL_REPORT_MEDIA_TYPE, type FinalSynthesisResult, type Gate, type Invocation, type ManifestInput, type RunId, type RuntimeToolCallRequest, type Verdict } from "@agentique-console/core";
import type { FakeStep } from "../provider/fake.ts";
import { COMPLETED_RESULT, type RuntimeHarness } from "./test-support.ts";

export const REQUEST_COMPLETION: RuntimeToolCallRequest = { tool: "request_completion", input: {} };

/** A root turn that requests completion once and then ends with `then` (a completed result by default). */
export function requestingStep(then: FakeStep = { kind: "succeed", result: COMPLETED_RESULT }): FakeStep {
  return { kind: "runtime_tool_calls", calls: [REQUEST_COMPLETION], then };
}

export const FINAL_REPORT: FinalSynthesisResult = { summary: "The CLI reports its version.", completed: ["Added --version"], verification: ["npm test passed"], risks: [], followUps: [] };

export type SynthesisInput = Extract<ManifestInput, { kind: "final_synthesis" }>;

/** A final-synthesis step: a completed result carrying the typed report, computed from the turn's `final_synthesis` input when a function is given. */
export function synthesisStep(h: RuntimeHarness, report: FinalSynthesisResult | ((input: SynthesisInput) => FinalSynthesisResult) = FINAL_REPORT, status: "completed" | "failed" | "invalid" = "completed"): FakeStep {
  return {
    kind: "derived",
    step: (request) => {
      const manifest = h.stores.invocations.getManifest(request.invocationId).content;
      const input = manifest.inputs.find((i): i is SynthesisInput => i.kind === "final_synthesis");
      if (!input) throw new Error("the final-synthesis manifest carries no final_synthesis input");
      if (status === "failed") return { kind: "succeed", result: { ...COMPLETED_RESULT, status: "failed", summary: "could not synthesize" } };
      if (status === "invalid") return { kind: "succeed", result: { ...COMPLETED_RESULT, summary: "no report" } };
      return { kind: "succeed", result: { ...COMPLETED_RESULT, summary: "final report", finalReport: typeof report === "function" ? report(input) : report } };
    },
  };
}

/** A completion Gate Evaluator step: a completed evaluation over exactly the `gate_candidate` input's criteria, with the pinned Snapshot as its Evidence (a completion candidate may hold no Artifact). */
export function completionEvaluatorStep(h: RuntimeHarness, verdict: Verdict, criteria: Record<string, Verdict> = {}): FakeStep {
  return {
    kind: "derived",
    step: (request) => {
      const manifest = h.stores.invocations.getManifest(request.invocationId).content;
      const candidate = manifest.inputs.find((i): i is Extract<ManifestInput, { kind: "gate_candidate" }> => i.kind === "gate_candidate");
      if (!candidate) throw new Error("the Evaluator manifest carries no gate_candidate input");
      return {
        kind: "succeed",
        result: { ...COMPLETED_RESULT, summary: `gate ${candidate.gateId} ${verdict}`, evaluation: { verdict, criteria: candidate.acceptanceCriterionIds.map((id) => ({ acceptanceCriterionId: id, verdict: criteria[id] ?? verdict, evidence: [] })), evidence: [{ kind: "snapshot", snapshotId: candidate.snapshotId }] } },
      };
    },
  };
}

/** A later operator turn on the root (a posted operator message prepares one once the API exists): ordinary funding, continuing from the latest turn. */
export function prepareOperatorTurn(h: RuntimeHarness, runId: RunId, content = "continue"): Invocation {
  const run = h.stores.runs.get(runId);
  const root = h.stores.plans.rootNode(runId);
  const latest = h.stores.invocations.latestAtPosition(root.id, "orchestrator");
  const message = h.stores.conversations.postMessage({ conversationId: run.conversationId, author: "operator", content, runId, invocationId: null });
  return h.preparation.prepare({
    runId,
    planNodeId: root.id,
    role: "orchestrator",
    purpose: "operator_input",
    patternPosition: { kind: "orchestrator" },
    continuedFromInvocationId: latest?.id ?? null,
    funding: { source: "plan_node" },
    inputs: [{ kind: "operator_message", conversationMessageId: message.id, content: message.content }],
    correlationId: null,
    causationSeq: null,
  }).invocation;
}

export const requestsOf = (h: RuntimeHarness, runId: RunId) => h.stores.completionRequests.listByRun(runId);
export const completionGatesOf = (h: RuntimeHarness, runId: RunId): Gate[] => h.stores.gates.listByKind(runId, "run_completion");
export const signoffGatesOf = (h: RuntimeHarness, runId: RunId): Gate[] => h.stores.gates.listByKind(runId, "operator_signoff");
export const synthesesOf = (h: RuntimeHarness, runId: RunId) => h.stores.invocations.listByRun(runId).filter((i) => i.purpose === "final_synthesis");
export const completionEvaluatorsOf = (h: RuntimeHarness, runId: RunId) => h.stores.invocations.listByRun(runId).filter((i) => i.role === "evaluator" && i.gateId !== null && h.stores.gates.get(i.gateId).kind === "run_completion");
export const reportsOf = (h: RuntimeHarness, runId: RunId) => h.stores.artifacts.listByRun(runId).filter((a) => a.mediaType === FINAL_REPORT_MEDIA_TYPE);
export const remediationsOf = (h: RuntimeHarness, runId: RunId) => h.stores.tasks.listRemediationTasks(runId).filter((t) => h.stores.gates.get(t.gateId!).kind === "run_completion");

/** Drives the scheduler pass by pass (one action per pass with `maxActions: 1`) until `done` holds or nothing more can be performed; returns the performed action kinds. */
export async function advanceUntil(h: RuntimeHarness, runId: RunId, done: () => boolean, options: { maxPasses?: number; maxActions?: number } = {}): Promise<string[]> {
  const kinds: string[] = [];
  for (let i = 0; i < (options.maxPasses ?? 100) && !done(); i += 1) {
    const pass = await h.scheduler.advanceRun(runId, options.maxActions === undefined ? undefined : { maxActions: options.maxActions });
    if (pass.failure) throw new Error(pass.failure.message);
    kinds.push(...pass.actions.map((p) => p.action.kind));
    if (pass.actions.length === 0) {
      if (pass.stop === "waiting" && pass.wakeAt !== null) {
        h.clock.advance(Math.max(1, Date.parse(pass.wakeAt) - Date.parse(h.ctx.clock())));
        continue;
      }
      break;
    }
  }
  if (!done()) throw new Error(`the Run did not reach the expected state after ${kinds.join(", ")}`);
  return kinds;
}
