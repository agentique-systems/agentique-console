/**
 * Starting a Run the way an operator does (execution-model §3, §8.1, §10):
 * the goal becomes the operator's first message and a Requirement of the
 * Conversation (with the declared deterministic completion check as its
 * Acceptance Criterion), the Run is created through the Run creation
 * service with validated defaults, and started through the Run start
 * service. Nothing here assembles ids or plan sources by hand; the
 * Orchestrator refines the Requirements and the plan from its turns.
 *
 * Defaults come from the configuration and the canonical allocation rules:
 * the final reserve of a coding Run must fund the completion work — one
 * Orchestrator allocation for the final synthesis plus, when an Evaluator is
 * named, one Evaluator allocation — so the default is derived from the
 * built-in definitions with `addAllocation` and checked with
 * `allocationFits`, and a configured or requested value that cannot fund it
 * is refused with a message naming what to change.
 */
import { addAllocation, allocationFits, allocationOfLimits, ValidationError, ZERO_ALLOCATION, type AcceptanceCriterionId, type Allocation, type ConversationId, type ProposedRequirement, type RequirementRevision, type Run, type RunCreateBody, type RunKind, type RunTarget } from "@agentique-console/core";
import type { ConsoleRuntime } from "../composition/console-runtime.ts";
import type { Config } from "../config.ts";
import { defaultTargetOf } from "./workspaces.ts";

export interface LaunchDefaults {
  budget: Config["defaults"]["budget"];
  orchestratorAllocation: Allocation;
  completionCheck: Config["defaults"]["completionCheck"];
  evaluator: "reviewer" | "none";
  runKind: RunKind;
}

/** The least final reserve a Run with these choices needs: the canonical rule of the completion engine, from the built-in definitions. */
export function requiredFinalReserve(runtime: ConsoleRuntime, evaluator: "reviewer" | "none"): Allocation {
  const synthesis = runtime.agents.builtins.orchestrator.defaultLimits.allocation;
  const judge = evaluator === "reviewer" ? runtime.agents.builtins.reviewer.defaultLimits.allocation : ZERO_ALLOCATION;
  return addAllocation(synthesis, judge);
}

/** The final reserve of each Run kind under the defaults: exactly the required allocation for a coding Run, nothing for `other`. */
export function defaultFinalReserve(runtime: ConsoleRuntime, evaluator: "reviewer" | "none"): Record<RunKind, Allocation> {
  return { code: requiredFinalReserve(runtime, evaluator), other: ZERO_ALLOCATION };
}

export interface LaunchedRun {
  run: Run;
  requirementRevision: RequirementRevision | null;
  criterionIds: AcceptanceCriterionId[];
}

export class RunLaunchService {
  constructor(
    private readonly runtime: ConsoleRuntime,
    private readonly defaults: LaunchDefaults,
  ) {}

  /** Creates the Run (and, unless `start` is false, starts it) from the operator's goal and defaults; every refusal names its cause. */
  launch(conversationId: ConversationId, body: RunCreateBody): LaunchedRun {
    const { stores } = this.runtime;
    const conversation = stores.conversations.get(conversationId);
    const workspace = stores.workspaces.get(conversation.workspaceId);
    const kind = body.kind ?? this.defaults.runKind;
    const target: RunTarget | null = body.target ?? defaultTargetOf(workspace);
    if (target === null) throw new ValidationError("the Workspace has no branch to target; create a commit first or state the Target", { workspaceId: workspace.id });
    if ((workspace.kind === "git") !== (target.kind === "branch")) throw new ValidationError(`a ${workspace.kind} Workspace targets ${workspace.kind === "git" ? "a branch" : "the directory"}`, { kind: workspace.kind });
    const evaluator = body.evaluator ?? this.defaults.evaluator;
    const budget = body.budget ?? this.defaults.budget;
    const orchestratorAllocation = body.orchestratorAllocation ?? this.defaults.orchestratorAllocation;
    const required = kind === "code" ? requiredFinalReserve(this.runtime, evaluator) : ZERO_ALLOCATION;
    const finalReserve = body.finalReserve ?? required;
    if (kind === "code" && !allocationFits(required, finalReserve)) {
      throw new ValidationError(`the final reserve (${describe(finalReserve)}) cannot fund the completion work (${describe(required)}: the final synthesis${evaluator === "reviewer" ? " and the Gate Evaluator" : ""}); raise the final reserve or lower CONSOLE_ORCHESTRATOR_*`, { finalReserve: describe(finalReserve), required: describe(required) });
    }
    const pool = allocationOfLimits(budget);
    if (!allocationFits(addAllocation(orchestratorAllocation, finalReserve), pool)) {
      throw new ValidationError(`the Run Budget (${describe(pool)}) cannot hold the Orchestrator allocation (${describe(orchestratorAllocation)}) plus the final reserve (${describe(finalReserve)}); raise CONSOLE_DEFAULT_MAX_* or the Budget`, { budget: describe(pool) });
    }
    // The completion check: a deterministic Acceptance Criterion the coding Run declares, on the operator's Requirement.
    const check = body.completionCheck === undefined ? this.defaults.completionCheck : body.completionCheck;
    if (kind === "code" && check === null) throw new ValidationError("a coding Run declares a deterministic completion check (a command whose exit code decides completion)", { kind });
    const authored = check === null ? null : this.authorRequirement(conversationId, body.goal, check);
    const created = this.runtime.runCreation.create({
      conversationId,
      kind,
      target,
      budget,
      orchestratorAgentDefinitionRevisionId: this.runtime.agents.builtins.orchestrator.id,
      finalReserve,
      orchestratorAllocation,
      verificationPolicy: {
        evaluatorAgentDefinitionRevisionId: evaluator === "reviewer" ? this.runtime.agents.builtins.reviewer.id : null,
        runCompletionAcceptanceCriterionIds: authored === null ? [] : authored.criterionIds,
      },
    });
    let run = created.run;
    if (body.start !== false) {
      const message = stores.conversations.postMessage({ conversationId, author: "operator", content: body.goal, runId: run.id, invocationId: null });
      run = this.runtime.runStart.start({ runId: run.id, conversationMessageId: message.id }).run;
    }
    return { run, requirementRevision: authored?.revision ?? null, criterionIds: authored?.criterionIds ?? [] };
  }

  /** Starts a created Run from the operator's message (the goal by default). */
  start(run: Run, message: string | undefined): Run {
    const { stores } = this.runtime;
    const content = message ?? stores.conversations.listMessages(run.conversationId).find((m) => m.runId === run.id && m.author === "operator")?.content ?? "Proceed.";
    const posted = stores.conversations.postMessage({ conversationId: run.conversationId, author: "operator", content, runId: run.id, invocationId: null });
    return this.runtime.runStart.start({ runId: run.id, conversationMessageId: posted.id }).run;
  }

  /**
   * The operator's goal as a Requirement of the Conversation: appended to the current tree as one more leaf (kept Requirements keep
   * their ids), carrying the completion check as its Acceptance Criterion; the first Run of a Conversation creates revision 1.
   */
  private authorRequirement(conversationId: ConversationId, goal: string, check: { command: string; expectedExitCode?: number }): { revision: RequirementRevision; criterionIds: AcceptanceCriterionId[] } {
    const { stores } = this.runtime;
    const current = stores.requirements.currentRevision(conversationId);
    const live = new Set(stores.requirements.listByConversation(conversationId).filter((r) => r.status !== "retired").map((r) => r.id));
    const kept: ProposedRequirement[] = (current?.tree ?? [])
      .filter((entry) => live.has(entry.id))
      .map((entry) => ({ key: entry.id, parentKey: entry.parentId === null || !live.has(entry.parentId) ? null : entry.parentId, composition: entry.composition, statement: entry.statement, requirementId: entry.id, acceptanceCriteria: [] }));
    const statement = goal.trim().split(/\r?\n/)[0]!.slice(0, 500);
    const entries: ProposedRequirement[] = [...kept, { key: "goal", parentKey: null, composition: null, statement, requirementId: null, acceptanceCriteria: [{ kind: "deterministic", command: check.command, expectedExitCode: check.expectedExitCode ?? 0 }] }];
    const authored = this.runtime.requirementProposals.author({ conversationId, entries, rationale: "the operator's goal and completion check" });
    const goalId = authored.revision.tree.find((entry) => entry.statement === statement && !live.has(entry.id))!.id;
    return { revision: authored.revision, criterionIds: authored.criteria.filter((c) => c.requirementId === goalId).map((c) => c.id) };
  }
}

function describe(a: Allocation): string {
  return `${a.costUsd} USD / ${a.tokens} tokens / ${a.attempts} attempts`;
}
