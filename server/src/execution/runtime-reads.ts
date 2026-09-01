/**
 * The runtime read service (execution-model §6.4 "Runtime read tools"): the
 * scoped, bounded execution of `read_requirements`, `read_decisions`,
 * `read_tasks`, `read_execution_plan`, `read_agent_definitions`, and
 * `read_artifact`. Reads are not durable runtime-tool mutations:
 *
 * - a read runs outside every persistence transaction and opens none;
 * - a read writes no `runtime_tool_calls` row, no Event, no Usage row, and
 *   no receipt, access log, or cursor state of any kind;
 * - repeated reads return the same canonical result for the same database
 *   state, from the canonical projection and store APIs alone;
 * - every list is in a deterministic canonical order and paged by a
 *   stateless keyset cursor over a bounded store query: ownership and
 *   visibility are database predicates, at most `limit + 1` rows of the
 *   collection are retrieved per page, and page-local references are
 *   resolved in batched lookups — never by materializing a Conversation's
 *   Decision history, a Run's whole Task ledger, or every Agent Definition
 *   revision; the one whole-value read is a Requirement revision's tree,
 *   one immutable JSON value bounded by `REQUIREMENT_TREE_MAX_ENTRIES`;
 * - the total serialized response is bounded (`RUNTIME_READ_BOUNDS`),
 *   measured as the UTF-8 bytes of the provider-facing read outcome;
 * - authorization is canonical ownership plus the caller's immutable
 *   manifest and role scope; a supplied id authorizes nothing.
 *
 * `read_artifact` is the one tool that returns Artifact content: the
 * execution runtime authorizes from metadata and rows, then loads and
 * verifies the bytes through the canonical Artifact Store and binds exactly
 * the largest complete, boundary-safe range that fits the serialized
 * ceiling into the tool response. The bytes decide nothing, reach no
 * Event, diagnostic, manifest, or error, and the provider boundary never
 * sees the store.
 */
import {
  canonicalJson,
  InvariantViolationError,
  NotFoundError,
  ORCHESTRATOR_DEFINITION_NAME,
  RUNTIME_READ_BOUNDS,
  READ_ARTIFACT_BOUNDS,
  utf8ByteLength,
  type AcceptanceCriterionId,
  type AgentDefinitionRecord,
  type AgentDefinitionRevision,
  type AgentDefinitionRevisionId,
  type Artifact,
  type ArtifactContentEncoding,
  type ArtifactId,
  type ContextManifest,
  type Decision,
  type DecisionId,
  type DecisionRecord,
  type Invocation,
  type InvocationId,
  type InvocationRole,
  type OversizedRecordRef,
  type PatternPlanNode,
  type PatternShape,
  type PlanEdge,
  type PlanEdgeId,
  type PlanEdgeRecord,
  type PlanNode,
  type PlanNodeId,
  type PlanNodeRecord,
  type PlanNodeShapeSummary,
  type ReadAgentDefinitionsInput,
  type ReadAgentDefinitionsResult,
  type ReadArtifactInput,
  type ReadArtifactResult,
  type ReadDecisionsInput,
  type ReadDecisionsResult,
  type ReadExecutionPlanInput,
  type ReadExecutionPlanResult,
  type ReadRequirementsInput,
  type ReadRequirementsResult,
  type ReadTasksInput,
  type ReadTasksResult,
  type RequirementId,
  type RequirementRecord,
  type RequirementRevision,
  type Run,
  type RuntimeToolReadRequest,
  type RuntimeToolReadResult,
  type RuntimeToolRejection,
  type Task,
  type TaskId,
  type TaskRecord,
} from "@agentique-console/core";
import { BlobCorruptedError, BlobMissingError } from "../persistence/blob-store.ts";
import type { DecisionVisibility } from "../persistence/stores/decisions.ts";
import type { Stores } from "../persistence/stores/index.ts";
import type { TaskVisibility } from "../persistence/stores/tasks.ts";
import { resolveExecutableAgentDefinitionRevision } from "./agent-definitions.ts";

/** A read refused with closed reasons; the executor reports it as the `rejected` outcome. Nothing was written either way. */
export class ReadRefused extends Error {
  constructor(readonly reasons: RuntimeToolRejection[]) {
    super(reasons.map((r) => r.message).join("; "));
    this.name = "ReadRefused";
  }
}

function refuse(code: RuntimeToolRejection["code"], message: string, path: string | null = null): never {
  throw new ReadRefused([{ code, message, path }]);
}

/** The canonical caller of one read, resolved by the executor from rows: never from the request. */
export interface ReadCaller {
  run: Run;
  node: PatternPlanNode;
  invocation: Invocation;
  manifest: ContextManifest;
  /**
   * The caller's logical turn (the Invocation plus its approval predecessors,
   * newest first): the replay scope of mutating calls and the scope of "its
   * own turn's requests" for Decisions. It is never Artifact-content
   * authorization — that requires the exact current Invocation.
   */
  turnInvocationIds: readonly InvocationId[];
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** The bytes a page may spend on records; the rest of the ceiling is reserved for the result envelope (tool, revision, cursor, oversized reference). */
const RECORD_BUDGET = RUNTIME_READ_BOUNDS.maxResponseBytes - RUNTIME_READ_BOUNDS.responseEnvelopeReserveBytes;

interface Keyed<T, Id extends string> {
  id: Id;
  record: T;
}

interface Page<T, Id extends string> {
  items: T[];
  oversizedRecord: OversizedRecordRef | null;
  next: Id | null;
}

/** The serialized size of a record inside a page: its canonical JSON bytes plus the separator. */
const recordBytes = (record: unknown) => utf8ByteLength(canonicalJson(record));

/**
 * The bounded page over one retrieved window of the caller-visible order:
 * `window` holds at most the requested limit of records in canonical order
 * and `more` says whether the store had a further record beyond it (the
 * keyset fetch asked for one extra row and it was there). Records are
 * included while the page fits the record budget; a first record that alone
 * exceeds it is returned as a typed oversized reference and `next` skips
 * exactly it. Nothing is dropped silently and no JSON object is truncated.
 */
function assemble<T, Id extends string>(window: readonly Keyed<T, Id>[], more: boolean): Page<T, Id> {
  const items: T[] = [];
  let used = 0;
  let consumed = 0;
  let oversizedRecord: OversizedRecordRef | null = null;
  for (const entry of window) {
    const bytes = recordBytes(entry.record) + 1;
    if (items.length === 0 && bytes > RECORD_BUDGET) {
      oversizedRecord = { id: entry.id, byteSize: bytes - 1 };
      consumed = 1;
      break;
    }
    if (used + bytes > RECORD_BUDGET) break;
    items.push(entry.record);
    used += bytes;
    consumed += 1;
  }
  const remaining = consumed < window.length || more;
  const next = consumed > 0 && remaining ? window[consumed - 1]!.id : null;
  return { items, oversizedRecord, next };
}

/** The one named record as a one-record page (its typed oversized reference when it alone exceeds the budget). */
function single<T, Id extends string>(entry: Keyed<T, Id>): Page<T, Id> {
  const bytes = recordBytes(entry.record);
  if (bytes > RECORD_BUDGET) return { items: [], oversizedRecord: { id: entry.id, byteSize: bytes }, next: null };
  return { items: [entry.record], oversizedRecord: null, next: null };
}

/**
 * One keyset page over a store query: the cursor is validated against the
 * visible set by one indexed lookup (a cursor outside it is refused, never
 * treated as an empty page), then `limit + 1` rows are retrieved after it
 * in canonical order, projected as a batch, and assembled within the byte
 * budget. Nothing beyond that window is loaded.
 */
function keyset<Row, T, Id extends string>(
  input: { after?: Id; limit?: number },
  contains: (id: Id) => boolean,
  fetch: (after: Id | undefined, count: number) => Row[],
  project: (rows: Row[]) => Keyed<T, Id>[],
): Page<T, Id> {
  if (input.after !== undefined && !contains(input.after)) refuse("cursor_invalid", `cursor ${input.after} does not name a record of your visible set`, "after");
  const limit = input.limit ?? RUNTIME_READ_BOUNDS.defaultLimit;
  const rows = fetch(input.after, limit + 1);
  return assemble(project(rows.slice(0, limit)), rows.length > limit);
}

/** The exactly named record: refused without confirming existence when it is outside the visible set. */
function exact<Row, T, Id extends string>(id: Id, what: string, contains: (id: Id) => boolean, load: (id: Id) => Row, project: (rows: Row[]) => Keyed<T, Id>[]): Page<T, Id> {
  if (!contains(id)) refuse("record_out_of_scope", `${what} ${id} does not exist or is not readable in your scope`, null);
  return single(project([load(id)])[0]!);
}

/** One page over an in-memory canonical order (the bounded Requirement tree): the window is projected, never the whole list. */
function listPage<Row, T, Id extends string>(ordered: readonly Row[], key: (row: Row) => Id, input: { after?: Id; limit?: number }, project: (rows: Row[]) => Keyed<T, Id>[]): Page<T, Id> {
  const start = input.after === undefined ? 0 : ordered.findIndex((row) => key(row) === input.after) + 1;
  if (input.after !== undefined && start === 0) refuse("cursor_invalid", `cursor ${input.after} does not name a record of your visible set`, "after");
  const limit = input.limit ?? RUNTIME_READ_BOUNDS.defaultLimit;
  return assemble(project(ordered.slice(start, start + limit)), start + limit < ordered.length);
}

/** The provider-facing read outcome the ceiling is measured over: what the executor returns for a successful read. */
export function readOutcomeBytes(result: RuntimeToolReadResult): number {
  return utf8ByteLength(canonicalJson({ kind: "read", tool: result.tool, result }));
}

/** Every result leaves the service within the ceiling; a violation is a defect in the assembly above, never something the caller can cause. */
function bounded<T extends RuntimeToolReadResult>(result: T): T {
  const bytes = readOutcomeBytes(result);
  if (bytes > RUNTIME_READ_BOUNDS.maxResponseBytes) throw new InvariantViolationError(`a ${result.tool} response serialized to ${bytes} bytes, beyond the ${RUNTIME_READ_BOUNDS.maxResponseBytes}-byte ceiling`);
  return result;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class RuntimeReadService {
  constructor(private readonly stores: Stores) {}

  read(caller: ReadCaller, request: RuntimeToolReadRequest): RuntimeToolReadResult {
    switch (request.tool) {
      case "read_requirements":
        return bounded(this.readRequirements(caller, request.input));
      case "read_decisions":
        return bounded(this.readDecisions(caller, request.input));
      case "read_tasks":
        return bounded(this.readTasks(caller, request.input));
      case "read_execution_plan":
        return bounded(this.readExecutionPlan(caller, request.input));
      case "read_agent_definitions":
        return bounded(this.readAgentDefinitions(caller, request.input));
      case "read_artifact":
        return bounded(this.readArtifact(caller, request.input));
    }
  }

  // -------------------------------------------------------------------------
  // read_requirements
  // -------------------------------------------------------------------------

  /**
   * The root Orchestrator's ordinary turns read the Conversation's current
   * Requirement revision; every other caller — a Coordinator, Worker,
   * Evaluator, or Gate-owned turn — reads exactly the pinned revision and
   * the Requirement set its immutable manifest carries. A newer revision is
   * never silently substituted for a scoped caller. The revision's tree is
   * one immutable JSON value (at most `REQUIREMENT_TREE_MAX_ENTRIES`
   * entries) read whole; the page's statuses, criteria, and waiver
   * references are batched lookups over the page alone. Statuses are the
   * Requirements' current semantic statuses; historical revisions, status
   * journals, and Evidence content are not returned.
   */
  readRequirements(caller: ReadCaller, input: ReadRequirementsInput): ReadRequirementsResult {
    const { revision, visibleIds } = this.requirementScope(caller);
    if (revision === null) {
      if (input.requirementId !== undefined) refuse("record_out_of_scope", `Requirement ${input.requirementId} does not exist or is not readable in your scope`);
      if (input.after !== undefined) refuse("cursor_invalid", `cursor ${input.after} does not name a record of your visible set`, "after");
      return { tool: "read_requirements", requirementRevisionId: null, items: [], oversizedRecord: null, next: null };
    }
    const visible = new Set(visibleIds);
    const tree = [...revision.tree].sort((a, b) => a.position - b.position);
    const ordered = tree.filter((entry) => visible.has(entry.id));
    const include = input.includeAcceptanceCriteria === true;
    const project = (entries: RequirementRevision["tree"]): Keyed<RequirementRecord, RequirementId>[] => {
      const statuses = new Map(this.stores.requirements.getMany(entries.map((e) => e.id)).map((r) => [r.id, r.status] as const));
      const criterionIds = include ? entries.flatMap((e) => e.acceptanceCriterionIds) : [];
      const kinds = new Map(this.stores.requirements.getAcceptanceCriteria(criterionIds).map((c) => [c.id, c.check.kind] as const));
      return entries.map((entry) => {
        const status = statuses.get(entry.id);
        if (status === undefined) throw new NotFoundError("Requirement", entry.id);
        const record: RequirementRecord = {
          requirementId: entry.id,
          parentId: entry.parentId,
          composition: entry.composition,
          statement: entry.statement,
          status,
          leaf: entry.composition === null,
          childIds: tree.filter((e) => e.parentId === entry.id && visible.has(e.id)).map((e) => e.id),
          acceptanceCriteria: include ? [...entry.acceptanceCriterionIds].sort().map((id) => ({ acceptanceCriterionId: id as AcceptanceCriterionId, kind: kinds.get(id) ?? this.stores.requirements.getAcceptanceCriterion(id).check.kind })) : null,
          waiverDecisionId: status === "waived" ? this.stores.requirements.latestWaiverDecisionOf(entry.id) : null,
        };
        return { id: entry.id, record };
      });
    };
    if (input.requirementId !== undefined) {
      const entry = ordered.find((e) => e.id === input.requirementId);
      if (!entry) refuse("record_out_of_scope", `Requirement ${input.requirementId} does not exist or is not readable in your scope`, null);
      return { tool: "read_requirements", requirementRevisionId: revision.id, ...single(project([entry])[0]!) };
    }
    return { tool: "read_requirements", requirementRevisionId: revision.id, ...listPage(ordered, (e) => e.id, input, project) };
  }

  private requirementScope(caller: ReadCaller): { revision: RequirementRevision | null; visibleIds: RequirementId[] } {
    // The root Orchestrator's ordinary (non-Gate-owned) turns read the whole current tree.
    if (caller.invocation.role === "orchestrator" && caller.invocation.gateId === null) {
      const revision = this.stores.requirements.currentRevision(caller.run.conversationId);
      return { revision, visibleIds: revision === null ? [] : revision.tree.map((e) => e.id) };
    }
    const pinned = caller.manifest.content.requirementRevisionId;
    if (pinned === null) return { revision: null, visibleIds: [] };
    return { revision: this.stores.requirements.getRevision(pinned), visibleIds: caller.manifest.content.requirements.map((r) => r.requirementId) };
  }

  // -------------------------------------------------------------------------
  // read_decisions
  // -------------------------------------------------------------------------

  /**
   * Visible Decisions by role: the Orchestrator sees the Decisions of the
   * Run and the Conversation-level ones; a Coordinator those affecting its
   * node, the node's Tasks, or its pinned scope, and those requested from
   * its node; a Worker those affecting its own Tasks, node, or manifest
   * Requirements, and its own turn's requests; an Evaluator only the
   * Decisions its immutable manifest names. A Decision of another Run is
   * visible only when the caller's immutable manifest names it (the
   * assembler delivers the earlier Runs' Decisions that reference the
   * caller's Requirements, validated to the same Conversation); every other
   * route admits only the caller's own Run and the Conversation-level
   * Decisions, so a Requirement id shared by two Runs never makes the
   * other Run's Decision visible by itself. The store evaluates every route
   * as a predicate and returns one keyset window; each record's `affects`
   * is projected through the caller's canonical scope with batched
   * lookups. A `side_effect_approval` subject carries the tool, digest, and
   * call Artifact id — the proposed call's bytes live only in that
   * Artifact, which no reference here makes readable.
   */
  readDecisions(caller: ReadCaller, input: ReadDecisionsInput): ReadDecisionsResult {
    const visibility = this.decisionVisibility(caller, input.status);
    const contains = (id: DecisionId) => this.stores.decisions.contains(visibility, id);
    const project = (rows: Decision[]) => this.projectDecisions(caller, rows);
    const paged =
      input.decisionId !== undefined
        ? exact(input.decisionId, "Decision", contains, (id) => this.stores.decisions.get(id), project)
        : keyset(input, contains, (after, count) => this.stores.decisions.page(visibility, after, count), project);
    return { tool: "read_decisions", ...paged };
  }

  private decisionVisibility(caller: ReadCaller, status: ReadDecisionsInput["status"]): DecisionVisibility {
    const { run, node, invocation, manifest } = caller;
    const namedDecisionIds = manifest.content.decisions.map((d) => d.decisionId);
    const base = { conversationId: run.conversationId, runId: run.id, namedDecisionIds, ...(status === undefined ? {} : { status }) };
    switch (invocation.role) {
      case "orchestrator":
        return { ...base, routes: { kind: "run" } };
      case "coordinator":
        return { ...base, routes: { kind: "scoped", planNodeId: node.id, tasks: { kind: "node", planNodeId: node.id }, requirementIds: this.requirementScope(caller).visibleIds, requesters: { kind: "node", planNodeId: node.id } } };
      case "worker":
        return { ...base, routes: { kind: "scoped", planNodeId: node.id, tasks: { kind: "ids", taskIds: this.workerTaskIds(caller) }, requirementIds: this.requirementScope(caller).visibleIds, requesters: { kind: "ids", invocationIds: caller.turnInvocationIds } } };
      case "evaluator":
        // Only what the manifest names: no route beyond it admits anything.
        return { ...base, routes: { kind: "named" } };
    }
  }

  /**
   * The bounded canonical projection of a page of Decisions for one
   * caller. The canonical rows are untouched; each projected `affects`
   * keeps exactly the references inside the caller's canonical scope — the
   * same Requirement, Task, and Plan Node sets `read_requirements`,
   * `read_tasks`, and `read_execution_plan` expose, checked by batched
   * lookups over the page's references — so a visible Decision never names
   * an entity the caller could not read by id. The typed subject is safe by
   * construction (ids, digests, closed values; never the call's bytes) and
   * a reference in it authorizes no read.
   */
  private projectDecisions(caller: ReadCaller, rows: Decision[]): Keyed<DecisionRecord, DecisionId>[] {
    const { run, node, invocation } = caller;
    const requirementIds = new Set(this.requirementScope(caller).visibleIds);
    const taskIds = new Set(this.stores.tasks.visibleAmong(this.taskVisibility(caller), [...new Set(rows.flatMap((d) => d.affects.taskIds))]));
    const nodeIds = new Set(invocation.role === "orchestrator" ? this.stores.plans.membersAmong(run.id, this.stores.plans.latestRevisionNumber(run.id), [...new Set(rows.flatMap((d) => d.affects.planNodeIds))]) : [node.id]);
    return rows.map((d) => ({
      id: d.id,
      record: {
        decisionId: d.id,
        kind: d.kind,
        status: d.status,
        resolutionPolicy: d.resolutionPolicy,
        question: d.question,
        options: d.options.map((o) => ({ id: o.id, label: o.label, description: o.description })),
        recommendedOptionId: d.recommendedOptionId,
        rationale: d.rationale,
        deadlineAt: d.deadlineAt,
        activationCondition: d.activationCondition,
        chosenOptionId: d.resolution?.chosenOptionId ?? null,
        resolvedBy: d.resolution?.resolvedBy ?? null,
        resolvedAt: d.resolution?.resolvedAt ?? null,
        affects: {
          requirementIds: d.affects.requirementIds.filter((id) => requirementIds.has(id)),
          taskIds: d.affects.taskIds.filter((id) => taskIds.has(id)),
          planNodeIds: d.affects.planNodeIds.filter((id) => nodeIds.has(id)),
        },
        subject: d.subject,
        supersessionReason: d.supersessionReason,
        supersededByDecisionId: d.supersededByDecisionId,
      },
    }));
  }

  // -------------------------------------------------------------------------
  // read_tasks
  // -------------------------------------------------------------------------

  /**
   * Visible Tasks by role: the root Orchestrator sees the Run's current
   * (non-superseded) Tasks; a Coordinator its node's complete ledger,
   * superseded rows included, so replacement history stays interpretable;
   * a Worker exactly its assigned Tasks and their direct dependencies; an
   * Evaluator exactly the Tasks its manifest's Gate candidate represents.
   * The store evaluates the visibility as a predicate and returns one
   * keyset window; a page's dependency and replacement references are two
   * batched lookups. A caller cannot reach further by pagination: the
   * cursor moves over the visible set alone.
   */
  readTasks(caller: ReadCaller, input: ReadTasksInput): ReadTasksResult {
    const visibility = this.taskVisibility(caller);
    const contains = (id: TaskId) => this.stores.tasks.contains(visibility, id);
    const project = (rows: Task[]): Keyed<TaskRecord, TaskId>[] => {
      const ids = rows.map((t) => t.id);
      const dependencies = this.stores.tasks.dependencyIdsOf(ids);
      const replacements = this.stores.tasks.replacementsOf(ids);
      return rows.map((task) => ({
        id: task.id,
        record: {
          taskId: task.id,
          subject: task.subject,
          status: task.status,
          planNodeId: task.planNodeId,
          gateId: task.gateId,
          requirementIds: task.requirementIds,
          dependsOnTaskIds: dependencies.get(task.id) ?? [],
          replacesTaskId: task.replacesTaskId,
          supersededByTaskId: replacements.get(task.id) ?? null,
          blockReason: task.blockReason,
          failureReason: task.failureReason,
          inputArtifactIds: task.inputArtifactIds,
          requiredOutputs: task.requiredOutputs,
          outputArtifactIds: task.outputArtifactIds,
          evidence: task.evidence,
        },
      }));
    };
    const paged =
      input.taskId !== undefined
        ? exact(input.taskId, "Task", contains, (id) => this.stores.tasks.get(id), project)
        : keyset(input, contains, (after, count) => this.stores.tasks.page(visibility, after, count), project);
    return { tool: "read_tasks", ...paged };
  }

  private taskVisibility(caller: ReadCaller): TaskVisibility {
    const { run, node, invocation, manifest } = caller;
    switch (invocation.role) {
      case "orchestrator":
        return { runId: run.id, kind: "current" };
      case "coordinator":
        return { runId: run.id, kind: "node", planNodeId: node.id };
      case "worker":
        return { runId: run.id, kind: "ids", taskIds: this.workerTaskIds(caller) };
      case "evaluator":
        return { runId: run.id, kind: "ids", taskIds: manifest.content.inputs.flatMap((i) => (i.kind === "gate_candidate" ? i.tasks.map((t) => t.taskId) : [])) };
    }
  }

  /** A Worker's Task scope: its own Tasks and their direct dependencies (one batched lookup over the owned ids). */
  private workerTaskIds(caller: ReadCaller): TaskId[] {
    const own = caller.invocation.taskIds;
    const dependencies = this.stores.tasks.dependencyIdsOf(own);
    return [...new Set([...own, ...own.flatMap((id) => dependencies.get(id) ?? [])])].sort();
  }

  // -------------------------------------------------------------------------
  // read_execution_plan
  // -------------------------------------------------------------------------

  /**
   * Every role may inspect the current accepted graph of its own Run: node
   * membership and edges as separately paged, bounded projections in the
   * plan's canonical orders — nodes in membership order, edges by target
   * membership position then fan-in position (the same order the scheduler
   * reads), never by generated id. A cursor is an id of the current
   * revision and view; a node of a superseded revision, an edge of another
   * revision, or an id of the other view is refused. No historical
   * revision, source proposal, compiler intermediate state, rejected
   * proposal, or full nested plan JSON is returned.
   */
  readExecutionPlan(caller: ReadCaller, input: ReadExecutionPlanInput): ReadExecutionPlanResult {
    const runId = caller.run.id;
    const revisionNumber = this.stores.plans.latestRevisionNumber(runId);
    if (input.view === "nodes") {
      // The cursor's membership position is looked up once: it is both the visibility check and the keyset.
      const positions = new Map<PlanNodeId, number | null>();
      const position = (id: PlanNodeId) => {
        if (!positions.has(id)) positions.set(id, this.stores.plans.memberPosition(runId, revisionNumber, id));
        return positions.get(id)!;
      };
      const paged = keyset(
        input,
        (id) => position(id) !== null,
        (after, count) => this.stores.plans.pageMembers(runId, revisionNumber, after === undefined ? -1 : (position(after) ?? -1), count),
        (nodes: PlanNode[]) => nodes.map((node) => ({ id: node.id, record: planNodeRecordOf(node) })),
      );
      return { tool: "read_execution_plan", revisionNumber, view: "nodes", ...paged };
    }
    const keys = new Map<PlanEdgeId, { targetPosition: number; position: number } | null>();
    const key = (id: PlanEdgeId) => {
      if (!keys.has(id)) keys.set(id, this.stores.plans.edgeKey(runId, revisionNumber, id));
      return keys.get(id)!;
    };
    const paged = keyset(
      input,
      (id) => key(id) !== null,
      (after, count) => this.stores.plans.pageEdges(runId, revisionNumber, after === undefined ? null : key(after), count),
      (edges: PlanEdge[]) => edges.map((edge) => ({ id: edge.id, record: planEdgeRecordOf(edge) })),
    );
    return { tool: "read_execution_plan", revisionNumber, view: "edges", ...paged };
  }

  // -------------------------------------------------------------------------
  // read_agent_definitions
  // -------------------------------------------------------------------------

  /**
   * The executable Agent Definition revisions relevant to the caller's
   * Workspace and Run: the latest executable revision of every definition
   * this Run may execute (builtin, this Workspace's files, this
   * Conversation's approved authoring), plus any older executable revision
   * the current graph, the Run's verification policy, or the caller itself
   * still references. The store evaluates executability and "latest" as
   * predicates and returns one keyset window in revision id order; every
   * returned revision is re-resolved through the execution boundary's
   * resolver, whose disagreement would be an invariant violation. A foreign
   * Workspace's or Conversation's definition never appears; instruction
   * text never travels.
   */
  readAgentDefinitions(caller: ReadCaller, input: ReadAgentDefinitionsInput): ReadAgentDefinitionsResult {
    const owner = { workspaceId: caller.run.workspaceId, conversationId: caller.run.conversationId };
    const runId = caller.run.id;
    const referencedRevisionIds = [
      ...new Set([
        caller.invocation.agentDefinitionRevisionId,
        ...(caller.run.verificationPolicy.evaluatorAgentDefinitionRevisionId === null ? [] : [caller.run.verificationPolicy.evaluatorAgentDefinitionRevisionId]),
        ...this.stores.plans.listMembers(runId, this.stores.plans.latestRevisionNumber(runId)).flatMap((node) => (node.kind === "pattern" ? shapeRevisionIds(node.shape) : [])),
      ]),
    ];
    const query = { ...owner, referencedRevisionIds, ...(input.agentDefinitionId === undefined ? {} : { definitionId: input.agentDefinitionId }) };
    const project = (rows: AgentDefinitionRevision[]): Keyed<AgentDefinitionRecord, AgentDefinitionRevisionId>[] => {
      const definitions = new Map(this.stores.agents.getDefinitions([...new Set(rows.map((r) => r.definitionId))]).map((d) => [d.id, d] as const));
      return rows.map((revision) => {
        const resolved = resolveExecutableAgentDefinitionRevision(this.stores, owner, revision.id);
        if (!resolved.ok) throw new InvariantViolationError(`the store admitted Agent Definition revision ${revision.id} that the resolver refuses: ${resolved.message}`);
        const definition = definitions.get(revision.definitionId);
        if (definition === undefined) throw new NotFoundError("AgentDefinition", revision.definitionId);
        const roles: InvocationRole[] = definition.name === ORCHESTRATOR_DEFINITION_NAME ? ["orchestrator"] : ["worker", "coordinator", "evaluator"];
        const record: AgentDefinitionRecord = {
          agentDefinitionId: definition.id,
          revisionId: revision.id,
          name: definition.name,
          contentHash: revision.contentHash,
          provenance: revision.provenance,
          roles,
          capabilities: revision.capabilities,
          toolPolicy: revision.toolPolicy,
          modelPolicy: revision.modelPolicy,
          defaultLimits: revision.defaultLimits,
        };
        return { id: revision.id, record };
      });
    };
    const paged = keyset(
      input,
      (id) => this.stores.agents.containsExecutable(query, id),
      (after, count) => this.stores.agents.pageExecutable(query, after, count),
      project,
    );
    if (input.agentDefinitionId !== undefined && input.after === undefined && paged.items.length === 0 && paged.oversizedRecord === null) {
      refuse("record_out_of_scope", `Agent Definition ${input.agentDefinitionId} does not exist or has no executable revision for this Run`);
    }
    return { tool: "read_agent_definitions", ...paged };
  }

  // -------------------------------------------------------------------------
  // read_artifact
  // -------------------------------------------------------------------------

  /**
   * An Artifact is readable exactly when its id is in the caller's
   * immutable manifest (a Handoff, Task input, Gate candidate, Decision
   * resolution, optimizer, completion, or explicitly listed Artifact), or
   * when the exact current Invocation created it through an accepted
   * `write_artifact` call (`authorizeArtifact`). Supplying an id is not
   * authorization, and a refusal never confirms a foreign Artifact's
   * existence. Authorization completes before any byte is loaded; the bytes
   * are then loaded and verified through the canonical Artifact Store, and
   * a missing or corrupt blob is a closed typed failure that is never "not
   * found" and never carries bytes or paths.
   *
   * Paging is over the Artifact's bytes. `offset` and `maxBytes` select a
   * range and `maxBytes` is an upper bound: the page holds the largest
   * complete prefix of that range whose serialized response — the
   * encoded content with its JSON escaping plus the result envelope — fits
   * the 64 KiB ceiling, so a maximal page is never truncated content or
   * malformed JSON. `utf8` never splits a UTF-8 sequence; `base64`
   * represents exactly the returned decoded range. `byteCount`,
   * `nextOffset`, and `eof` describe the returned range exactly; the digest
   * and total size always describe the whole Artifact.
   */
  readArtifact(caller: ReadCaller, input: ReadArtifactInput): ReadArtifactResult {
    // Metadata and Run ownership are validated before any byte is loaded, on every path; a refusal confirms nothing.
    const artifact = this.authorizeArtifact(caller, input.artifactId);
    const offset = input.offset ?? 0;
    const maxBytes = input.maxBytes ?? READ_ARTIFACT_BOUNDS.defaultMaxBytes;
    const encoding = input.encoding ?? "utf8";
    if (offset > artifact.byteSize) refuse("invalid_input", `offset ${offset} is beyond the Artifact's ${artifact.byteSize} bytes`, "offset");
    let bytes: Uint8Array;
    try {
      bytes = this.stores.artifacts.content(artifact);
    } catch (error) {
      if (error instanceof BlobMissingError) refuse("artifact_content_missing", `the content of Artifact ${input.artifactId} (${error.digest}) is missing from the Artifact Store`);
      if (error instanceof BlobCorruptedError) refuse("artifact_content_corrupt", `the content of Artifact ${input.artifactId} (${error.digest}) does not verify against its digest and size`);
      throw error;
    }
    const ceiling = RUNTIME_READ_BOUNDS.maxResponseBytes;
    const available = ceiling - artifactEnvelopeBytes(artifact, offset, encoding);
    const page = (end: number, content: string): ReadArtifactResult => {
      const eof = end >= artifact.byteSize;
      return { tool: "read_artifact", artifactId: artifact.id, mediaType: artifact.mediaType, digest: artifact.digest, byteSize: artifact.byteSize, offset, byteCount: end - offset, encoding, content, nextOffset: eof ? null : end, eof };
    };
    let end = Math.min(offset + maxBytes, artifact.byteSize);
    if (encoding === "utf8") {
      if (offset < artifact.byteSize && (bytes[offset]! & 0xc0) === 0x80) {
        refuse("artifact_content_not_utf8", `offset ${offset} splits a UTF-8 sequence; page from a boundary or request base64`, "offset");
      }
      // Never split a UTF-8 sequence: pull the page end back until it sits before the straddling sequence's lead byte.
      while (end > offset && end < artifact.byteSize && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      if (end === offset && offset < artifact.byteSize) {
        refuse("invalid_input", `maxBytes ${maxBytes} is too small for the next UTF-8 sequence; request at least 4 bytes or base64`, "maxBytes");
      }
      let decoded: string;
      try {
        // Byte-range retrieval, never text normalization: a leading U+FEFF (a BOM at the Artifact's start or at a page boundary) is
        // content and stays in the page, so the returned text re-encodes to exactly the selected bytes and every page advances.
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset, end));
      } catch {
        refuse("artifact_content_not_utf8", `Artifact ${input.artifactId} is not valid UTF-8 in the requested range; request the content as base64`, "encoding");
      }
      // The serialized ceiling: the largest prefix of whole code points whose JSON-escaped UTF-8 bytes fit — estimated conservatively
      // from the widest envelope, then extended code point by code point while the actual serialization still fits.
      let kept = utf8PrefixWithin(decoded, available);
      if (kept.codeUnits === 0 && decoded.length > 0) throw new InvariantViolationError(`a read_artifact page has no room for one UTF-8 sequence (${available} bytes available)`);
      let result = page(offset + kept.utf8Bytes, decoded.slice(0, kept.codeUnits));
      while (kept.codeUnits < decoded.length) {
        const next = decoded.codePointAt(kept.codeUnits)!;
        const step = { codeUnits: kept.codeUnits + (next > 0xffff ? 2 : 1), utf8Bytes: kept.utf8Bytes + utf8Length(next) };
        const candidate = page(offset + step.utf8Bytes, decoded.slice(0, step.codeUnits));
        if (readOutcomeBytes(candidate) > ceiling) break;
        kept = step;
        result = candidate;
      }
      return result;
    }
    // base64 spends 4 characters per 3 bytes and needs no escaping: whole groups only (the final group may be partial at the end of
    // the range), so the text represents exactly the returned range; the conservative estimate is extended group by group likewise.
    const requested = end;
    end = Math.min(requested, offset + Math.floor(available / 4) * 3);
    if (end === offset && requested > offset) throw new InvariantViolationError(`a read_artifact page has no room for one base64 group (${available} bytes available)`);
    let result = page(end, Buffer.from(bytes.subarray(offset, end)).toString("base64"));
    while (end < requested) {
      const step = Math.min(end + 3, requested);
      const candidate = page(step, Buffer.from(bytes.subarray(offset, step)).toString("base64"));
      if (readOutcomeBytes(candidate) > ceiling) break;
      end = step;
      result = candidate;
    }
    return result;
  }

  /**
   * Exactly two routes make an Artifact readable, both over canonical rows
   * and the immutable manifest, never over process memory or the logical
   * turn's replay scope:
   *
   * 1. the caller's manifest lists it (a Handoff, Task input, Gate
   *    candidate, Decision resolution, optimizer, completion, or explicitly
   *    listed Artifact), and its metadata names the caller's Run;
   * 2. the exact current Invocation created it through `write_artifact`:
   *    the metadata names this Run and this Invocation as producer, and an
   *    accepted `runtime_tool_calls` row of this Invocation names the
   *    Artifact. Any Attempt of the Invocation qualifies. An approval
   *    predecessor's or successor's production, a runtime-created Artifact
   *    (an Attempt record, a captured call, a Changeset diff, an index)
   *    that merely names an Invocation, and an id learned from a replayed
   *    result or a Decision subject qualify through nothing but route 1.
   */
  private authorizeArtifact(caller: ReadCaller, artifactId: ArtifactId): Artifact {
    const notReadable = () => refuse("artifact_not_readable", `Artifact ${artifactId} does not exist or is not readable by this Invocation`, "artifactId");
    const artifact = this.artifactOrNull(artifactId);
    if (artifact === null || artifact.runId !== caller.run.id) return notReadable();
    if (caller.manifest.content.artifacts.some((a) => a.artifactId === artifactId)) return artifact;
    const producedHere = artifact.producer.kind === "invocation" && artifact.producer.invocationId === caller.invocation.id;
    if (!producedHere) return notReadable();
    if (this.stores.runtimeToolCalls.writtenArtifactCall(caller.invocation.id, artifactId) === null) return notReadable();
    return artifact;
  }

  private artifactOrNull(id: ArtifactId) {
    try {
      return this.stores.artifacts.get(id);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Serialized-byte accounting for Artifact pages
// ---------------------------------------------------------------------------

/**
 * The serialized bytes of a `read_artifact` outcome around its content: the
 * envelope measured with empty content and every number at its widest
 * possible value for this Artifact (`byteCount` and `nextOffset` never
 * exceed the total size), so the bytes left for the content never
 * undercount. Deterministic for the same Artifact and request.
 */
function artifactEnvelopeBytes(artifact: Artifact, offset: number, encoding: ArtifactContentEncoding): number {
  const widest = (nextOffset: number | null): ReadArtifactResult => ({
    tool: "read_artifact",
    artifactId: artifact.id,
    mediaType: artifact.mediaType,
    digest: artifact.digest,
    byteSize: artifact.byteSize,
    offset,
    byteCount: artifact.byteSize,
    encoding,
    content: "",
    nextOffset,
    eof: false,
  });
  return Math.max(readOutcomeBytes(widest(artifact.byteSize)), readOutcomeBytes(widest(null)));
}

const utf8Length = (codePoint: number) => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4);

/** The UTF-8 bytes one code point costs inside a JSON string: escapes for the quote, the backslash, and control characters; its own encoding otherwise. */
export function escapedBytes(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint < 0x20) return codePoint === 0x08 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0c || codePoint === 0x0d ? 2 : 6;
  return utf8Length(codePoint);
}

/** The longest prefix of `text` (whole code points) whose JSON-escaped UTF-8 encoding fits `budget` bytes: its UTF-16 length and UTF-8 byte length. */
function utf8PrefixWithin(text: string, budget: number): { codeUnits: number; utf8Bytes: number } {
  let escaped = 0;
  let utf8Bytes = 0;
  let codeUnits = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    const cost = escapedBytes(codePoint);
    if (escaped + cost > budget) break;
    escaped += cost;
    utf8Bytes += utf8Length(codePoint);
    codeUnits += character.length;
  }
  return { codeUnits, utf8Bytes };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function planNodeRecordOf(node: PlanNode): PlanNodeRecord {
  const base = {
    planNodeId: node.id,
    status: node.status,
    waitReason: node.waitReason,
    sourcePath: node.sourcePath,
    title: node.title,
    allocation: node.allocation,
    maxConcurrency: node.maxConcurrency,
    maxWallClockMs: node.maxWallClockMs,
  };
  if (node.kind === "join") {
    return { ...base, kind: "join", pattern: null, shape: null, fanInPolicy: node.fanInPolicy, requirementRevisionId: null, requirementIds: [], onAllocationExhausted: null };
  }
  return {
    ...base,
    kind: "pattern",
    pattern: node.pattern,
    shape: shapeSummaryOf(node.shape),
    fanInPolicy: null,
    requirementRevisionId: node.scope?.requirementRevisionId ?? null,
    requirementIds: node.scope?.requirementIds ?? [],
    onAllocationExhausted: node.onAllocationExhausted,
  };
}

function planEdgeRecordOf(edge: PlanEdge): PlanEdgeRecord {
  const base = { planEdgeId: edge.id, sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, position: edge.position };
  switch (edge.type) {
    case "branch":
      return { ...base, type: "branch", label: edge.label };
    case "retry":
      return { ...base, type: "retry", round: edge.round };
    case "sequence":
    case "fan_in":
      return { ...base, type: edge.type };
  }
}

/** The bounded orchestration summary of a shape: counts, labels, and bounds — never operation inputs or instructions. */
function shapeSummaryOf(shape: PatternShape): PlanNodeShapeSummary {
  switch (shape.pattern) {
    case "single":
      return { pattern: "single", operationTitle: shape.operation.title };
    case "chain":
      return { pattern: "chain", stepCount: shape.steps.length };
    case "route":
      return { pattern: "route", selector: shape.selector.kind, branchLabels: shape.branches.map((b) => b.label) };
    case "parallel":
      return { pattern: "parallel", itemCount: shape.items.length, hasAggregation: shape.aggregate !== null, requireAll: shape.requireAll };
    case "coordinator_worker":
      return { pattern: "coordinator_worker", bounds: shape.bounds };
    case "evaluator_optimizer":
      return { pattern: "evaluator_optimizer", maxRounds: shape.maxRounds, round: shape.round };
  }
}

function shapeRevisionIds(shape: PatternShape): AgentDefinitionRevisionId[] {
  switch (shape.pattern) {
    case "single":
      return [shape.operation.agentDefinitionRevisionId];
    case "chain":
      return shape.steps.map((s) => s.agentDefinitionRevisionId);
    case "route":
      return [...(shape.selector.kind === "evaluator" ? [shape.selector.agentDefinitionRevisionId] : []), ...shape.branches.flatMap((b) => (b.inline === null ? [] : [b.inline.agentDefinitionRevisionId]))];
    case "parallel":
      return [...shape.items.map((i) => i.agentDefinitionRevisionId), ...(shape.aggregate === null ? [] : [shape.aggregate.agentDefinitionRevisionId])];
    case "coordinator_worker":
      return [shape.coordinator.agentDefinitionRevisionId, shape.worker.agentDefinitionRevisionId];
    case "evaluator_optimizer":
      return [...(shape.producer === null ? [] : [shape.producer.agentDefinitionRevisionId]), shape.evaluator.agentDefinitionRevisionId];
  }
}
