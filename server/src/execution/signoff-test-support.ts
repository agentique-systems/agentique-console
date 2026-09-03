/**
 * Shared fixtures for the operator signoff suites (execution-model §9.3,
 * §10 `operator_signoff`): a Run driven to `awaiting_signoff` through the
 * real completion path (a writing root turn whose Changeset is the Run's
 * only content, the deterministic completion check, the read-only final
 * synthesis), the operator's Conversation message a change request answers,
 * and canonical readers over Signoff Resolution, Changeset, Gate, Decision,
 * and Invocation rows. Nothing here reads a transcript or process memory of
 * the runtime.
 */
import type { ConversationMessage, DecisionId, Gate, Invocation, RunId } from "@agentique-console/core";
import type { FakeStep } from "../provider/fake.ts";
import { advanceUntil, requestingStep, signoffGatesOf, synthesisStep } from "./completion-test-support.ts";
import { orchestratorStep, scriptByRole } from "./gate-test-support.ts";
import { seedPlanningRuntime, type RuntimeHarness, type RuntimeSeedOverrides } from "./test-support.ts";

/** The open signoff boundary of a Run that reached `awaiting_signoff`. */
export interface AwaitingSignoff {
  runId: RunId;
  gate: Gate;
  decisionId: DecisionId;
  /** The root turn that requested completion (and wrote the Run's content). */
  requestingTurn: Invocation;
}

/**
 * Seeds a coding Run and drives it to `awaiting_signoff`: the first root turn writes `diff` (a content Changeset, the
 * Run's only change) and requests completion; the completion check passes; the synthesis produces the report; the
 * signoff boundary opens. With `diff: null` the root turn writes nothing, so the final diff is empty.
 */
export async function awaitSignoff(h: RuntimeHarness, options: { diff?: string | null; seed?: RuntimeSeedOverrides } = {}): Promise<AwaitingSignoff> {
  const s = seedPlanningRuntime(h, options.seed ?? {});
  const runId = s.created.run.id;
  const diff = options.diff === undefined ? "+feature" : options.diff;
  const then: FakeStep = diff === null ? { kind: "succeed", result: { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "done", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null } } : orchestratorStep(h, { diff });
  scriptByRole(h, { orchestrator: [requestingStep(then), synthesisStep(h)] });
  await advanceUntil(h, runId, () => h.stores.runs.get(runId).status === "awaiting_signoff");
  const gate = signoffGatesOf(h, runId).at(-1)!;
  const decision = h.stores.decisions.signoffOf(gate.id)!;
  return { runId, gate, decisionId: decision.id, requestingTurn: s.invocation };
}

/** An operator message of the Run's Conversation, posted during the Run: what a change request answers. */
export function operatorMessage(h: RuntimeHarness, runId: RunId, content = "Please rename the flag to --show-version."): ConversationMessage {
  const run = h.stores.runs.get(runId);
  return h.stores.conversations.postMessage({ conversationId: run.conversationId, author: "operator", content, runId, invocationId: null });
}

export const resolutionsOf = (h: RuntimeHarness, runId: RunId) => h.stores.signoffResolutions.listByRun(runId);
export const finalChangesetOf = (h: RuntimeHarness, runId: RunId) => h.stores.changesets.finalOf(runId);
export const rootTurnsOf = (h: RuntimeHarness, runId: RunId) => h.stores.invocations.listAtPosition(h.stores.plans.rootNode(runId).id, "orchestrator");
export const followUpsOf = (h: RuntimeHarness, runId: RunId) => rootTurnsOf(h, runId).filter((t) => t.purpose === "decision_resolution");

/** Everything a repeated signoff operation could duplicate, from rows alone. */
export function signoffWork(h: RuntimeHarness, runId: RunId) {
  const run = h.stores.runs.get(runId);
  return {
    run: run.status,
    finalSnapshotId: run.finalSnapshotId,
    finalChangesetId: run.finalChangesetId,
    activeRunId: h.stores.conversations.get(run.conversationId).activeRunId,
    resolutions: resolutionsOf(h, runId).map((r) => [r.outcome, r.followUpInvocationId !== null]),
    signoffGates: signoffGatesOf(h, runId).map((g) => [g.status, g.failure?.kind ?? null]),
    decisions: h.stores.decisions.listByConversation(run.conversationId).filter((d) => d.kind === "signoff").map((d) => [d.status, d.resolution?.chosenOptionId ?? null]),
    changesets: h.stores.changesets.listByRun(runId).map((c) => [c.kind, c.integrationStatus]),
    diffs: h.stores.artifacts.listByRun(runId).filter((a) => a.mediaType === "text/x-diff").length,
    invocations: h.stores.invocations.listByRun(runId).length,
    attempts: h.stores.invocations.listByRun(runId).reduce((n, i) => n + h.stores.invocations.listAttempts(i.id).length, 0),
    rootTurns: rootTurnsOf(h, runId).map((t) => [t.purpose, t.status]),
    requests: h.stores.completionRequests.listByRun(runId).map((r) => r.status),
    inspections: h.finalizationWorkspace.requests.filter((r) => r.runId === runId).length,
    events: h.ctx.journal.read({ runId }).map((e) => e.type).filter((t) => t.startsWith("run.") || t.startsWith("signoff_resolution.") || t === "gate.passed" || t === "gate.failed" || t === "decision.resolved" || t === "changeset.recorded" || t === "invocation.created"),
  };
}
