/**
 * Deterministic quality gate for rotation checkpoints. A checkpoint is the
 * successor context's only inheritance, so beyond schema validity we require
 * the structural minimum a successor needs: a summary, a next action, and at
 * least one evidence pointer that actually resolves. Checks are structural
 * only — no length scoring, and an honest empty-work checkpoint (status
 * completed) passes with neither next action nor evidence.
 */
import type { HandoffDraft } from "@agentique-console/shared";

export interface CheckpointGateInput {
  draft: HandoffDraft;
  /** From HandoffService.referenceWarnings — one entry per non-resolving ref. */
  referenceWarnings: string[];
  /** Whether the claimed taskId resolves; null when no taskId is claimed. */
  taskResolves: boolean | null;
}

/** Returns [] on pass; each entry is a failure fed back into the retry prompt. */
export function evaluateCheckpointDraft(input: CheckpointGateInput): string[] {
  const { core } = input.draft;
  const failures: string[] = [];
  const completed = core.status === "completed";
  if (!core.state.summary || core.state.summary.trim() === "") failures.push("state.summary is empty");
  if (!completed && (!core.nextAction || core.nextAction.trim() === "")) failures.push("nextAction is empty for a non-completed checkpoint");
  if (!completed) {
    const refs = [...core.state.evidence, ...core.result.artifacts];
    if (refs.length === 0) failures.push("no evidence refs on a non-completed checkpoint");
    else if (input.referenceWarnings.length >= refs.length) failures.push(`no evidence ref resolves: ${input.referenceWarnings[0] ?? "all refs failed validation"}`);
  }
  if (core.taskId != null && input.taskResolves === false) failures.push(`taskId does not resolve: ${core.taskId}`);
  return failures;
}
