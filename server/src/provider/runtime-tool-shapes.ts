/**
 * The model-facing input shapes of the runtime tools, for the adapter's
 * in-process MCP server. These are plain zod raw shapes the MCP layer can
 * render as JSON Schema (no custom id types, no refinements, no top-level
 * unions): they describe every field of every runtime tool so the model
 * forms well-formed calls, and nothing more. They authorize and validate
 * nothing: the runtime-tool port re-parses every call through the strict
 * core schemas and refuses what does not fit with a closed rejection the
 * model can act on. Keeping the shapes total over `ExecutableRuntimeTool`
 * means a new runtime tool without a shape does not compile.
 */
import { ARTIFACT_CONTENT_ENCODINGS, DECISION_STATUSES, READ_ARTIFACT_BOUNDS, RECORD_DECISION_MAX_RATIONALE_BYTES, REQUEST_DECISION_BOUNDS, REQUIREMENT_COMPOSITIONS, REQUIREMENT_PROPOSAL_BOUNDS, RESULT_MAX_OPEN_ITEMS, RESULT_MAX_SUMMARY_LENGTH, RESULT_STATUSES, RUNTIME_READ_BOUNDS, TASK_PROPOSAL_MAX_TASKS, TASK_RESULT_STATUSES, TASK_UPDATE_MAX_EVIDENCE, TASK_UPDATE_MAX_OUTPUTS, VERDICTS, WRITE_ARTIFACT_BOUNDS, type ExecutableRuntimeTool } from "@agentique-console/core";
import { z } from "zod";

export type RuntimeToolShape = Record<string, z.ZodType>;

const ID = /^[a-z]+_[0-9a-f]{24}$/;
const id = (what: string) => z.string().regex(ID).describe(`the canonical ${what} id`);
const ids = (what: string) => z.array(id(what)).describe(`canonical ${what} ids, unique`);
const limit = z.number().int().min(1).max(RUNTIME_READ_BOUNDS.maxLimit).describe(`page size, at most ${RUNTIME_READ_BOUNDS.maxLimit}`);

/** One Evidence reference: exactly the fields of its kind. */
export const EVIDENCE_SHAPE = z.union([
  z.object({ kind: z.literal("artifact"), artifactId: id("Artifact") }),
  z.object({ kind: z.literal("command"), command: z.string(), exitCode: z.number().int(), outputArtifactId: id("Artifact"), outputTruncated: z.boolean().optional() }),
  z.object({ kind: z.literal("evaluation"), evaluationId: id("Evaluation") }),
  z.object({ kind: z.literal("file"), path: z.string(), snapshotId: id("Snapshot") }),
  z.object({ kind: z.literal("snapshot"), snapshotId: id("Snapshot") }),
  z.object({ kind: z.literal("url"), url: z.string() }),
]).describe("one Evidence reference (an Artifact, a command output Artifact, an Evaluation, a file at a Snapshot, a Snapshot, or a URL)");

const evidenceList = z.array(EVIDENCE_SHAPE);

/** The typed result of an Attempt (`return_result`), field for field the runtime's InvocationResult contract. */
export const RETURN_RESULT_SHAPE: RuntimeToolShape = {
  status: z.enum(RESULT_STATUSES).describe("completed when the work is done; blocked when a Decision or approval must resolve first; failed when the work cannot be done"),
  artifactIds: ids("Artifact").describe("the Artifacts this Invocation produced and reports as its outputs (created through write_artifact or named in the manifest)"),
  tasks: z.array(z.object({ taskId: id("Task"), status: z.enum(TASK_RESULT_STATUSES), evidence: evidenceList, blocker: z.string().nullable() })).describe("a report per owned Task; a completed Task carries Evidence"),
  evidence: evidenceList.describe("Evidence for the result as a whole"),
  summary: z.string().min(1).max(RESULT_MAX_SUMMARY_LENGTH).describe("one bounded sentence or paragraph summarizing the outcome"),
  openItems: z.array(z.string().min(1)).max(RESULT_MAX_OPEN_ITEMS).describe("bounded list of open items; empty when none"),
  blocker: z.string().nullable().describe("for a blocked result, the Decision id that blocks (or a bounded description); null otherwise"),
  runOutcome: z.object({ kind: z.literal("infeasible"), evidence: evidenceList }).nullable().describe("only the root Orchestrator may declare the Run infeasible, with Evidence; null otherwise"),
  routeSelection: z.object({ selectedLabel: z.string().min(1) }).nullable().describe("only a route selector reports the selected branch label; null otherwise"),
  evaluation: z
    .object({ verdict: z.enum(VERDICTS), criteria: z.array(z.object({ acceptanceCriterionId: id("Acceptance Criterion"), verdict: z.enum(VERDICTS), evidence: evidenceList })), evidence: evidenceList })
    .nullable()
    .describe("only an Evaluator reports verdicts, exactly over the evaluated criteria it was given; null otherwise"),
  finalReport: z
    .object({ summary: z.string().min(1), completed: z.array(z.string().min(1)), verification: z.array(z.string().min(1)), risks: z.array(z.string().min(1)), followUps: z.array(z.string().min(1)) })
    .nullable()
    .describe("only the final_synthesis turn reports the typed final report; null otherwise"),
};

const proposalShape = z.object({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).describe("a batch-local key other proposals may depend on"),
  subject: z.string().min(1).max(500),
  requirementIds: ids("Requirement").describe("a non-empty subset of the node's pinned leaf Requirements"),
  inputArtifactIds: ids("Artifact"),
  requiredOutputs: z.array(z.string().min(1).max(200)).min(1).describe("what the Worker must produce; unique"),
  dependsOnKeys: z.array(z.string()).describe("dependencies on proposals of this batch, by key"),
  dependsOnTaskIds: ids("Task").describe("dependencies on existing Tasks of the node"),
  replacesTaskId: id("Task").nullable().describe("a blocked or failed Task of the node this proposal replaces; null otherwise"),
});

/** The input shape of every executable runtime tool. */
export const RUNTIME_TOOL_INPUT_SHAPES: Readonly<Record<ExecutableRuntimeTool, RuntimeToolShape>> = Object.freeze({
  read_requirements: {
    requirementId: id("Requirement").optional().describe("read exactly one visible Requirement instead of a page"),
    includeAcceptanceCriteria: z.boolean().optional(),
    after: id("Requirement").optional().describe("keyset cursor: the last Requirement of the previous page"),
    limit: limit.optional(),
  },
  read_decisions: {
    decisionId: id("Decision").optional(),
    status: z.enum(DECISION_STATUSES).optional(),
    after: id("Decision").optional(),
    limit: limit.optional(),
  },
  read_tasks: {
    taskId: id("Task").optional(),
    after: id("Task").optional(),
    limit: limit.optional(),
  },
  read_artifact: {
    artifactId: id("Artifact"),
    offset: z.number().int().min(0).optional().describe("byte offset into the content"),
    maxBytes: z.number().int().min(1).max(READ_ARTIFACT_BOUNDS.maxMaxBytes).optional(),
    encoding: z.enum(ARTIFACT_CONTENT_ENCODINGS).optional().describe("utf8 for text, base64 for binary"),
  },
  read_execution_plan: {
    view: z.enum(["nodes", "edges"]).describe("which part of the current plan to page"),
    after: z.string().regex(ID).optional().describe("keyset cursor: the last node or edge id of the previous page"),
    limit: limit.optional(),
  },
  read_agent_definitions: {
    agentDefinitionId: id("Agent Definition").optional(),
    after: id("Agent Definition revision").optional(),
    limit: limit.optional(),
  },
  write_artifact: {
    title: z.string().min(1).max(WRITE_ARTIFACT_BOUNDS.titleMaxBytes),
    mediaType: z.string().min(1).max(WRITE_ARTIFACT_BOUNDS.mediaTypeMaxBytes).describe("lower-case media type such as text/plain or text/markdown"),
    encoding: z.enum(ARTIFACT_CONTENT_ENCODINGS).describe("utf8 for text, base64 for binary"),
    content: z.string().describe(`the content; at most ${WRITE_ARTIFACT_BOUNDS.maxContentBytes} decoded bytes`),
  },
  propose_tasks: {
    tasks: z.array(proposalShape).min(1).max(TASK_PROPOSAL_MAX_TASKS),
  },
  update_task: {
    taskId: id("Task"),
    update: z
      .union([
        z.object({ kind: z.literal("cancel"), reason: z.string().min(1).max(500) }),
        z.object({ kind: z.literal("add_evidence"), evidence: evidenceList.min(1).max(TASK_UPDATE_MAX_EVIDENCE) }),
        z.object({ kind: z.literal("add_outputs"), artifactIds: ids("Artifact").min(1).max(TASK_UPDATE_MAX_OUTPUTS) }),
      ])
      .describe("cancel an unstarted or blocked Task with a reason; add Evidence to a non-terminal Task; add output Artifacts to a non-terminal Task"),
  },
  create_tasks: {
    tasks: z.array(proposalShape).min(1).max(TASK_PROPOSAL_MAX_TASKS).describe("Run-level Tasks; requirementIds are leaves of the current Requirement revision; dependencies and replacements name current Tasks of the Run"),
  },
  record_decision: {
    question: z.string().min(1).max(REQUEST_DECISION_BOUNDS.questionMaxBytes),
    options: z.array(z.object({ key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/), label: z.string().min(1).max(REQUEST_DECISION_BOUNDS.optionLabelMaxBytes), description: z.string().min(1).max(REQUEST_DECISION_BOUNDS.optionDescriptionMaxBytes).optional() })).min(1).max(REQUEST_DECISION_BOUNDS.maxOptions).describe("the options you considered, with unique keys"),
    chosenOptionKey: z.string().describe("the key of the option you chose"),
    rationale: z.string().min(1).max(RECORD_DECISION_MAX_RATIONALE_BYTES),
    affects: z.object({ requirementIds: ids("Requirement"), taskIds: ids("Task"), planNodeIds: ids("Plan Node") }).describe("what the choice affects, within your scope"),
  },
  propose_requirements: {
    requirements: z
      .array(
        z.object({
          key: z.string().regex(REQUIREMENT_PROPOSAL_BOUNDS.keyPattern).describe("a proposal-local key"),
          parentKey: z.string().nullable().describe("the key of the parent entry, or null for a root"),
          composition: z.enum(REQUIREMENT_COMPOSITIONS).nullable().describe("all or any for an entry with children; null for a leaf"),
          statement: z.string().min(1).max(REQUIREMENT_PROPOSAL_BOUNDS.statementMaxBytes),
          requirementId: id("Requirement").nullable().describe("an existing Requirement this entry keeps; null proposes a new one"),
          acceptanceCriteria: z
            .array(z.union([z.object({ kind: z.literal("deterministic"), command: z.string().min(1), expectedExitCode: z.number().int() }), z.object({ kind: z.literal("evaluated"), question: z.string().min(1), rubric: z.string().min(1).nullable() })]))
            .max(REQUIREMENT_PROPOSAL_BOUNDS.maxCriteriaPerEntry),
        }),
      )
      .min(1)
      .max(REQUIREMENT_PROPOSAL_BOUNDS.maxEntries),
    rationale: z.string().min(1).max(REQUIREMENT_PROPOSAL_BOUNDS.rationaleMaxBytes),
  },
  revise_execution_plan: {
    source: z.record(z.string(), z.unknown()).describe("the complete source Execution Plan object ({ version: 1, expressions: { ... } }); the runtime compiles and validates it"),
  },
  request_completion: {},
  request_decision: {
    kind: z.enum(["operator_choice", "requirement_waiver"]).describe("operator_choice asks the operator to choose; requirement_waiver asks to waive one Requirement"),
    question: z.string().min(1).max(REQUEST_DECISION_BOUNDS.questionMaxBytes).optional().describe("operator_choice: the question"),
    options: z.array(z.object({ key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/), label: z.string().min(1).max(REQUEST_DECISION_BOUNDS.optionLabelMaxBytes), description: z.string().min(1).max(REQUEST_DECISION_BOUNDS.optionDescriptionMaxBytes).optional() })).min(REQUEST_DECISION_BOUNDS.minOptions).max(REQUEST_DECISION_BOUNDS.maxOptions).optional().describe("operator_choice: the ordered options with unique keys"),
    recommendedOptionKey: z.string().optional().describe("operator_choice: the key of the recommended option"),
    rationale: z.string().min(1).max(REQUEST_DECISION_BOUNDS.rationaleMaxBytes).optional().describe("why the Decision is needed (required for a waiver and for a default policy)"),
    resolutionPolicy: z.object({ kind: z.enum(["operator_required", "use_default_after_deadline"]), deadlineAt: z.string().optional().describe("ISO 8601 UTC timestamp"), activationCondition: z.object({ kind: z.literal("plan_node_ready"), planNodeId: id("Plan Node") }).optional() }).optional().describe("operator_choice: operator_required, or use_default_after_deadline with a deadline or activation condition"),
    affects: z.object({ requirementIds: ids("Requirement"), taskIds: ids("Task"), planNodeIds: ids("Plan Node") }).optional().describe("operator_choice: what the Decision affects, within your own work"),
    requirementId: id("Requirement").optional().describe("requirement_waiver: the Requirement to waive"),
    evidenceArtifactIds: ids("Artifact").optional().describe("requirement_waiver: Evidence Artifacts"),
  },
});
