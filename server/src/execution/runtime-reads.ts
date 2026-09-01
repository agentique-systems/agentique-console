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
 * - every list is in a deterministic canonical order, paged by a stateless
 *   keyset cursor reconstructible from persisted rows, and the total
 *   serialized result is bounded (`RUNTIME_READ_BOUNDS`);
 * - authorization is canonical ownership plus the caller's immutable
 *   manifest and role scope; a supplied id authorizes nothing.
 *
 * `read_artifact` is the one tool that returns Artifact content: the
 * execution runtime loads and verifies the bytes through the canonical
 * Artifact Store and binds exactly the requested, boundary-safe range into
 * the tool response. The bytes decide nothing, reach no Event, diagnostic,
 * manifest, or error, and the provider boundary never sees the store.
 */
import {
  canonicalJson,
  NotFoundError,
  ORCHESTRATOR_DEFINITION_NAME,
  RUNTIME_READ_BOUNDS,
  READ_ARTIFACT_BOUNDS,
  utf8ByteLength,
  type AgentDefinitionRecord,
  type AgentDefinitionRevisionId,
  type Artifact,
  type ArtifactId,
  type ContextManifest,
  type Decision,
  type DecisionRecord,
  type Invocation,
  type InvocationId,
  type InvocationRole,
  type OversizedRecordRef,
  type PatternPlanNode,
  type PatternShape,
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
import type { Stores } from "../persistence/stores/index.ts";
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

/**
 * The caller's canonical scope over the three kinds of reference a Decision
 * carries: exactly the Requirement, Task, and Plan Node ids the caller's
 * `read_requirements`, `read_tasks`, and `read_execution_plan` would expose.
 * A visible Decision is projected through it, so its `affects` never names
 * an entity the caller could not read by id.
 */
interface CanonicalScope {
  requirementIds: ReadonlySet<RequirementId>;
  taskIds: ReadonlySet<TaskId>;
  planNodeIds: ReadonlySet<PlanNodeId>;
}

interface Keyed<T, Id extends string> {
  id: Id;
  record: T;
}

interface Page<T, Id extends string> {
  items: T[];
  oversizedRecord: OversizedRecordRef | null;
  next: Id | null;
}

const byId = <Id extends string>(a: { id: Id }, b: { id: Id }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * One bounded page over a caller-visible ordered list. The cursor is the id
 * of the last record of the previous page in this exact order; a cursor
 * outside the visible set is refused. Records are included while the page
 * fits the response bound; a first record that alone exceeds it is returned
 * as a typed oversized reference and `next` skips exactly it. Nothing is
 * dropped silently and no JSON object is truncated.
 */
function page<T, Id extends string>(ordered: readonly Keyed<T, Id>[], after: Id | undefined, limit: number | undefined): Page<T, Id> {
  const start = after === undefined ? 0 : ordered.findIndex((k) => k.id === after) + 1;
  if (after !== undefined && start === 0) refuse("cursor_invalid", `cursor ${after} does not name a record of your visible set`, "after");
  const window = ordered.slice(start, start + (limit ?? RUNTIME_READ_BOUNDS.defaultLimit));
  const budget = RUNTIME_READ_BOUNDS.maxResponseBytes - RUNTIME_READ_BOUNDS.responseEnvelopeReserveBytes;
  const items: T[] = [];
  let used = 0;
  let lastIndex = start - 1;
  let oversizedRecord: OversizedRecordRef | null = null;
  for (const entry of window) {
    const bytes = utf8ByteLength(canonicalJson(entry.record)) + 1;
    if (items.length === 0 && bytes > budget) {
      oversizedRecord = { id: entry.id, byteSize: bytes - 1 };
      lastIndex += 1;
      break;
    }
    if (used + bytes > budget) break;
    items.push(entry.record);
    used += bytes;
    lastIndex += 1;
  }
  const next = lastIndex >= start && lastIndex < ordered.length - 1 ? ordered[lastIndex]!.id : null;
  return { items, oversizedRecord, next };
}

/** The named record of the visible set as a one-record page, or a typed refusal that never confirms a foreign record's existence. */
function exactly<T, Id extends string>(ordered: readonly Keyed<T, Id>[], id: Id, what: string): Page<T, Id> {
  const entry = ordered.find((k) => k.id === id);
  if (!entry) refuse("record_out_of_scope", `${what} ${id} does not exist or is not readable in your scope`, null);
  const budget = RUNTIME_READ_BOUNDS.maxResponseBytes - RUNTIME_READ_BOUNDS.responseEnvelopeReserveBytes;
  const bytes = utf8ByteLength(canonicalJson(entry.record));
  if (bytes > budget) return { items: [], oversizedRecord: { id: entry.id, byteSize: bytes }, next: null };
  return { items: [entry.record], oversizedRecord: null, next: null };
}

export class RuntimeReadService {
  constructor(private readonly stores: Stores) {}

  read(caller: ReadCaller, request: RuntimeToolReadRequest): RuntimeToolReadResult {
    switch (request.tool) {
      case "read_requirements":
        return this.readRequirements(caller, request.input);
      case "read_decisions":
        return this.readDecisions(caller, request.input);
      case "read_tasks":
        return this.readTasks(caller, request.input);
      case "read_execution_plan":
        return this.readExecutionPlan(caller, request.input);
      case "read_agent_definitions":
        return this.readAgentDefinitions(caller, request.input);
      case "read_artifact":
        return this.readArtifact(caller, request.input);
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
   * never silently substituted for a scoped caller. Statuses are the
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
    const include = input.includeAcceptanceCriteria === true;
    const ordered: Keyed<RequirementRecord, RequirementId>[] = tree
      .filter((entry) => visible.has(entry.id))
      .map((entry) => {
        const requirement = this.stores.requirements.get(entry.id);
        const childIds = tree.filter((e) => e.parentId === entry.id && visible.has(e.id)).map((e) => e.id);
        const record: RequirementRecord = {
          requirementId: entry.id,
          parentId: entry.parentId,
          composition: entry.composition,
          statement: entry.statement,
          status: requirement.status,
          leaf: entry.composition === null,
          childIds,
          acceptanceCriteria: include
            ? [...entry.acceptanceCriterionIds].sort().map((id) => ({ acceptanceCriterionId: id, kind: this.stores.requirements.getAcceptanceCriterion(id).check.kind }))
            : null,
          waiverDecisionId: requirement.status === "waived" ? this.waiverDecisionOf(caller.run, entry.id) : null,
        };
        return { id: entry.id, record };
      });
    const paged = input.requirementId !== undefined ? exactly(ordered, input.requirementId, "Requirement") : page(ordered, input.after, input.limit);
    return { tool: "read_requirements", requirementRevisionId: revision.id, ...paged };
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

  private waiverDecisionOf(run: Run, requirementId: RequirementId) {
    const waiver = this.stores.decisions
      .listByConversation(run.conversationId)
      .filter((d) => d.kind === "requirement_waiver" && d.status === "resolved" && d.resolution?.chosenOptionId === "waive" && d.subject?.kind === "requirement_waiver" && d.subject.requirementId === requirementId)
      .at(-1);
    return waiver?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // read_decisions
  // -------------------------------------------------------------------------

  /**
   * Visible Decisions by role: the Orchestrator sees the Decisions of the
   * Run (and the Conversation-level ones); a Coordinator those affecting
   * its node, the node's Tasks, or its pinned scope, and those requested
   * from its node; a Worker those affecting its own Tasks, node, or
   * manifest Requirements, and its own turn's requests; an Evaluator only
   * the Decisions its immutable manifest names. A `side_effect_approval`
   * subject carries the tool, digest, and call Artifact id — the proposed
   * call's bytes live only in that Artifact, which this scope cannot read.
   */
  readDecisions(caller: ReadCaller, input: ReadDecisionsInput): ReadDecisionsResult {
    const manifestIds = new Set(caller.manifest.content.decisions.map((d) => d.decisionId));
    const scope = this.canonicalScope(caller);
    const visible = this.decisionVisibility(caller, manifestIds, scope);
    const ordered: Keyed<DecisionRecord, Decision["id"]>[] = this.stores.decisions
      .listByConversation(caller.run.conversationId)
      .filter(visible)
      .filter((d) => input.status === undefined || d.status === input.status)
      .sort(byId)
      .map((d) => ({ id: d.id, record: decisionRecordOf(d, scope) }));
    const paged = input.decisionId !== undefined ? exactly(ordered, input.decisionId, "Decision") : page(ordered, input.after, input.limit);
    return { tool: "read_decisions", ...paged };
  }

  /**
   * Which Decisions a caller sees. A Decision of another Run is visible only
   * when the caller's immutable manifest names it (the assembler delivers
   * the earlier Runs' Decisions that reference the caller's Requirements,
   * validated to the same Conversation); every other route — the affected
   * ids, the requester — admits only the caller's own Run and the
   * Conversation-level Decisions (`runId` null). A Requirement id shared by
   * two Runs never makes the other Run's Decision visible by itself.
   */
  private decisionVisibility(caller: ReadCaller, manifestIds: ReadonlySet<string>, scope: CanonicalScope): (d: Decision) => boolean {
    const { run, node, invocation } = caller;
    const ownRun = (d: Decision): boolean => d.runId === run.id || d.runId === null;
    const requestedByNode = (d: Decision): boolean => {
      if (d.requestedBy.kind !== "invocation") return false;
      try {
        return this.stores.invocations.get(d.requestedBy.invocationId).planNodeId === node.id;
      } catch (error) {
        if (error instanceof NotFoundError) return false;
        throw error;
      }
    };
    const affectsScope = (d: Decision): boolean => d.affects.planNodeIds.some((id) => scope.planNodeIds.has(id)) || d.affects.taskIds.some((id) => scope.taskIds.has(id)) || d.affects.requirementIds.some((id) => scope.requirementIds.has(id));
    switch (invocation.role) {
      case "orchestrator":
        return (d) => manifestIds.has(d.id) || ownRun(d);
      case "coordinator":
        return (d) => manifestIds.has(d.id) || (ownRun(d) && (affectsScope(d) || requestedByNode(d)));
      case "worker": {
        const turn = new Set(caller.turnInvocationIds);
        return (d) => manifestIds.has(d.id) || (ownRun(d) && (affectsScope(d) || (d.requestedBy.kind === "invocation" && turn.has(d.requestedBy.invocationId))));
      }
      case "evaluator":
        return (d) => manifestIds.has(d.id);
    }
  }

  /**
   * The caller's canonical scope, derived from the same rules the other read
   * tools apply — never a separately maintained map: Requirements as
   * `read_requirements` exposes them, Tasks as `read_tasks` exposes them,
   * Plan Nodes as the current graph (the Orchestrator) or the caller's own
   * node (everyone else).
   */
  private canonicalScope(caller: ReadCaller): CanonicalScope {
    const { run, node, invocation } = caller;
    const requirementIds = new Set(this.requirementScope(caller).visibleIds);
    const all = this.stores.tasks.listByRun(run.id);
    const supersededBy = new Map<TaskId, TaskId>();
    for (const task of all) {
      if (task.replacesTaskId !== null) supersededBy.set(task.replacesTaskId, task.id);
    }
    const taskIds = new Set(this.visibleTasks(caller, all, supersededBy).map((t) => t.id));
    const planNodeIds = invocation.role === "orchestrator" ? new Set(this.stores.plans.currentGraph(run.id).nodes.map((n) => n.id)) : new Set([node.id]);
    return { requirementIds, taskIds, planNodeIds };
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
   * A caller cannot reach further by pagination: the cursor moves over the
   * visible set alone.
   */
  readTasks(caller: ReadCaller, input: ReadTasksInput): ReadTasksResult {
    const all = this.stores.tasks.listByRun(caller.run.id);
    const supersededBy = new Map<TaskId, TaskId>();
    for (const task of all) {
      if (task.replacesTaskId !== null) supersededBy.set(task.replacesTaskId, task.id);
    }
    const visible = this.visibleTasks(caller, all, supersededBy);
    const ordered: Keyed<TaskRecord, TaskId>[] = visible.sort(byId).map((task) => ({
      id: task.id,
      record: {
        taskId: task.id,
        subject: task.subject,
        status: task.status,
        planNodeId: task.planNodeId,
        gateId: task.gateId,
        requirementIds: task.requirementIds,
        dependsOnTaskIds: this.stores.tasks.dependenciesOf(task.id).map((d) => d.dependsOnTaskId).sort(),
        replacesTaskId: task.replacesTaskId,
        supersededByTaskId: supersededBy.get(task.id) ?? null,
        blockReason: task.blockReason,
        failureReason: task.failureReason,
        inputArtifactIds: task.inputArtifactIds,
        requiredOutputs: task.requiredOutputs,
        outputArtifactIds: task.outputArtifactIds,
        evidence: task.evidence,
      },
    }));
    const paged = input.taskId !== undefined ? exactly(ordered, input.taskId, "Task") : page(ordered, input.after, input.limit);
    return { tool: "read_tasks", ...paged };
  }

  private visibleTasks(caller: ReadCaller, all: Task[], supersededBy: ReadonlyMap<TaskId, TaskId>): Task[] {
    const { node, invocation, manifest } = caller;
    switch (invocation.role) {
      case "orchestrator":
        return all.filter((t) => !supersededBy.has(t.id));
      case "coordinator":
        return all.filter((t) => t.planNodeId === node.id);
      case "worker": {
        const own = new Set<TaskId>(invocation.taskIds);
        const dependencies = new Set<TaskId>();
        for (const id of invocation.taskIds) {
          for (const edge of this.stores.tasks.dependenciesOf(id)) dependencies.add(edge.dependsOnTaskId);
        }
        return all.filter((t) => own.has(t.id) || dependencies.has(t.id));
      }
      case "evaluator": {
        const named = new Set<TaskId>(manifest.content.inputs.flatMap((i) => (i.kind === "gate_candidate" ? i.tasks.map((t) => t.taskId) : [])));
        return all.filter((t) => named.has(t.id));
      }
    }
  }

  // -------------------------------------------------------------------------
  // read_execution_plan
  // -------------------------------------------------------------------------

  /**
   * Every role may inspect the current accepted graph of its own Run: node
   * membership and edges as separately paged, bounded projections. No
   * historical revision, source proposal, compiler intermediate state,
   * rejected proposal, or full nested plan JSON is returned.
   */
  readExecutionPlan(caller: ReadCaller, input: ReadExecutionPlanInput): ReadExecutionPlanResult {
    const graph = this.stores.plans.currentGraph(caller.run.id);
    if (input.view === "nodes") {
      const ordered = graph.nodes.map((node) => ({ id: node.id, record: planNodeRecordOf(node) }));
      return { tool: "read_execution_plan", revisionNumber: graph.revisionNumber, view: "nodes", ...page(ordered, input.after, input.limit) };
    }
    const ordered = [...graph.edges]
      .sort(byId)
      .map((edge) => ({
        id: edge.id,
        record: {
          planEdgeId: edge.id,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          position: edge.position,
          ...(edge.type === "branch" ? { type: "branch" as const, label: edge.label } : edge.type === "retry" ? { type: "retry" as const, round: edge.round } : { type: edge.type }),
        } as PlanEdgeRecord,
      }));
    return { tool: "read_execution_plan", revisionNumber: graph.revisionNumber, view: "edges", ...page(ordered, input.after, input.limit) };
  }

  // -------------------------------------------------------------------------
  // read_agent_definitions
  // -------------------------------------------------------------------------

  /**
   * The executable Agent Definition revisions relevant to the caller's
   * Workspace and Run: the latest executable revision of every definition
   * this Run may execute (builtin, this Workspace's files, this
   * Conversation's approved authoring), plus any older revision the current
   * graph, the Run's verification policy, or the caller itself still
   * references. A foreign Workspace's or Conversation's definition never
   * appears; instruction text never travels.
   */
  readAgentDefinitions(caller: ReadCaller, input: ReadAgentDefinitionsInput): ReadAgentDefinitionsResult {
    const owner = { workspaceId: caller.run.workspaceId, conversationId: caller.run.conversationId };
    const relevant = new Set<AgentDefinitionRevisionId>();
    for (const definition of this.stores.agents.listDefinitions()) {
      const latest = this.stores.agents.listRevisions(definition.id).at(-1);
      if (latest !== undefined && resolveExecutableAgentDefinitionRevision(this.stores, owner, latest.id).ok) relevant.add(latest.id);
    }
    const referenced = [
      caller.invocation.agentDefinitionRevisionId,
      ...(caller.run.verificationPolicy.evaluatorAgentDefinitionRevisionId === null ? [] : [caller.run.verificationPolicy.evaluatorAgentDefinitionRevisionId]),
      ...this.stores.plans.currentGraph(caller.run.id).nodes.flatMap((node) => (node.kind === "pattern" ? shapeRevisionIds(node.shape) : [])),
    ];
    for (const id of referenced) {
      if (resolveExecutableAgentDefinitionRevision(this.stores, owner, id).ok) relevant.add(id);
    }
    const ordered: Keyed<AgentDefinitionRecord, AgentDefinitionRevisionId>[] = [...relevant]
      .sort()
      .map((revisionId) => {
        const revision = this.stores.agents.getRevision(revisionId);
        const definition = this.stores.agents.getDefinition(revision.definitionId);
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
      })
      .filter((entry) => input.agentDefinitionId === undefined || entry.record.agentDefinitionId === input.agentDefinitionId);
    if (input.agentDefinitionId !== undefined && ordered.length === 0) {
      refuse("record_out_of_scope", `Agent Definition ${input.agentDefinitionId} does not exist or has no executable revision for this Run`);
    }
    return { tool: "read_agent_definitions", ...page(ordered, input.after, input.limit) };
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
   */
  readArtifact(caller: ReadCaller, input: ReadArtifactInput): ReadArtifactResult {
    // Metadata and Run ownership are validated before any byte is loaded, on every path; a refusal confirms nothing.
    const artifact = this.authorizeArtifact(caller, input.artifactId);
    let bytes: Uint8Array;
    try {
      bytes = this.stores.artifacts.content(artifact);
    } catch (error) {
      if (error instanceof BlobMissingError) refuse("artifact_content_missing", `the content of Artifact ${input.artifactId} (${error.digest}) is missing from the Artifact Store`);
      if (error instanceof BlobCorruptedError) refuse("artifact_content_corrupt", `the content of Artifact ${input.artifactId} (${error.digest}) does not verify against its digest and size`);
      throw error;
    }
    const offset = input.offset ?? 0;
    const maxBytes = input.maxBytes ?? READ_ARTIFACT_BOUNDS.defaultMaxBytes;
    const encoding = input.encoding ?? "utf8";
    if (offset > artifact.byteSize) refuse("invalid_input", `offset ${offset} is beyond the Artifact's ${artifact.byteSize} bytes`, "offset");
    let end = Math.min(offset + maxBytes, artifact.byteSize);
    let content: string;
    if (encoding === "utf8") {
      if (offset < artifact.byteSize && (bytes[offset]! & 0xc0) === 0x80) {
        refuse("artifact_content_not_utf8", `offset ${offset} splits a UTF-8 sequence; page from a boundary or request base64`, "offset");
      }
      // Never split a UTF-8 sequence: pull the page end back until it sits before the straddling sequence's lead byte.
      while (end > offset && end < artifact.byteSize && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      if (end === offset && offset < artifact.byteSize) {
        refuse("invalid_input", `maxBytes ${maxBytes} is too small for the next UTF-8 sequence; request at least 4 bytes or base64`, "maxBytes");
      }
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
      } catch {
        refuse("artifact_content_not_utf8", `Artifact ${input.artifactId} is not valid UTF-8 in the requested range; request the content as base64`, "encoding");
      }
    } else {
      content = Buffer.from(bytes.subarray(offset, end)).toString("base64");
    }
    const eof = end >= artifact.byteSize;
    return {
      tool: "read_artifact",
      artifactId: artifact.id,
      mediaType: artifact.mediaType,
      digest: artifact.digest,
      byteSize: artifact.byteSize,
      offset,
      byteCount: end - offset,
      encoding,
      content,
      nextOffset: eof ? null : end,
      eof,
    };
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
   *    (a transcript, a captured call, a Changeset diff, an index) that
   *    merely names an Invocation, and an id learned from a replayed result
   *    or a Decision subject qualify through nothing but route 1.
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

/**
 * The bounded canonical projection of one Decision for one caller. The
 * canonical row is untouched; the projected `affects` keeps exactly the
 * references inside the caller's canonical scope, so a visible Decision
 * never names a Task, Requirement, or Plan Node the caller could not read.
 * The typed subject is safe by construction — ids, digests, closed values,
 * never the proposed call's bytes — and a reference in it authorizes no
 * read: `read_artifact` decides from the manifest and producer rows alone.
 */
function decisionRecordOf(d: Decision, scope: CanonicalScope): DecisionRecord {
  return {
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
      requirementIds: d.affects.requirementIds.filter((id) => scope.requirementIds.has(id)),
      taskIds: d.affects.taskIds.filter((id) => scope.taskIds.has(id)),
      planNodeIds: d.affects.planNodeIds.filter((id) => scope.planNodeIds.has(id)),
    },
    subject: d.subject,
    supersessionReason: d.supersessionReason,
    supersededByDecisionId: d.supersededByDecisionId,
  };
}

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
