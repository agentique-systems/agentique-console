# Execution model

This document defines how a Run executes: which component owns which state,
how the Execution Plan is authored, compiled, and scheduled, what each
Pattern does, how work and results move between Invocations, how
verification, completion, and publishing work, and how budget, usage, and
capacity are accounted. Terms are defined in [glossary.md](glossary.md).
The replacement rules are in [migration-contract.md](migration-contract.md).
Everything here is normative; the invariants in §15 are the acceptance test
for the implementation.

## 1. Actors

There are five actors and each has a fixed responsibility.

| Actor | Responsibility | Never does |
|---|---|---|
| Operator | Starts Conversations and Runs, approves Requirements, resolves Decisions (including every Requirement waiver), accepts or rejects a Run at the `operator_signoff` Gate, publishes a completed Run. | Edit runtime state directly. |
| Orchestrator | The agent that talks to the operator. Proposes Requirements, records its own Decisions, proposes Requirement waivers, creates Tasks, authors and revises the source Execution Plan, reads compiled plan state, works directly when that is cheaper than delegating. | Schedule, retry, wait, or account for anything. Write compiled plan structure. Resolve a Requirement waiver. Talk to Workers. |
| Runtime | Deterministic code. Validates source plan revisions, compiles them, and owns the compiled Execution Plan, scheduling, retries, dependencies, waiting, progress, Budget reservations, fan-in, Gates, Snapshots, Changesets, publishing, the journal. | Decide what the work should be. |
| Resource governor | Deterministic code inside the runtime process. Owns provider quota, provider concurrency, and machine concurrency; grants capacity leases to Runs. | Invoke a model, generate text, or hold semantic Run state. |
| Provider | Executes one Attempt: a model plus its native tools against a Context Manifest. | Hold any state the runtime depends on for correctness. |

The Orchestrator is an agent and is subject to every rule below. It is
distinguished only by running in the root Plan Node and by being the role
whose Context Manifests include the operator's messages.

## 2. State ownership

Every fact in the system has exactly one canonical store and one writer.
The types, state sets, and transition validators for every object below
are defined once in `@agentique-console/core` (`core/src/`); every
canonical store below is implemented behind `server/src/persistence/`
(schema, client, database-open guard, baseline migration, stores, blob
store, transaction helpers); the deterministic runtime that composes
stores into canonical operations — the plan compiler, the plan-revision
service, Run creation, the Context Manifest assembler and renderer,
Invocation preparation, the Attempt executor with its retry policy and
result validator, the resource governor, restart recovery, Run start, the
readiness evaluator with its condition-fact projection, the Handoff
router, the Changeset integration service, the `single`, `chain`, `route`,
`parallel`, `coordinator_worker`, and `evaluator_optimizer` Pattern
runners, the deterministic join settler, the pure Task projection, the
runtime-tool call boundary with its Task proposal handlers, the
deterministic Acceptance Criterion check service, the scheduler, the
Gates, the completion engine, the signoff service, and the publication
service — lives behind `server/src/execution/`, which
depends only on the core package, the persistence boundary, the
provider-neutral adapter contract under `server/src/provider/` (§6.5),
and narrow ports for capabilities implemented in later phases (the
Workspace preparation port, §3, the execution-workspace port, §9.1, the
integration-workspace port, §9.2, the Acceptance Criterion execution
port, §10.1, the Run finalization Workspace port, §9.3, and the
publication Workspace port, §9.4). The provider boundary
(`server/src/provider/`) holds the adapter contract, the scripted fake,
the continuation payload stores, and, in a later subphase, the
provider-specific adapters; it depends on the core package and on the
continuation index alone, and it never makes a Run, Plan, Pattern,
Invocation, Task, Requirement, Decision, Budget, or retry decision. Every
state-changing store operation validates the transition, appends the
Event, and updates the projection in one transaction; an illegal
transition writes nothing.

### 2.1 Write transactions

Store operations run inside the persistence transactor
(`server/src/persistence/transactions.ts`), which is synchronous and
re-entrant over one SQLite connection:

- **Root and nested writes.** The outermost `write` is the root: it owns
  `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK`. A `write` entered while a
  root is open is nested: it joins the root, opens no savepoint, and never
  commits or rolls back on its own. A service that composes several store
  operations (Run creation with its root Plan Node and reservation, plan
  compilation with its scope rows and reservations, Invocation creation
  with its manifest and Events) wraps them in one root `write`.
- **Rollback-only.** Any error that escapes a nested `write` marks the root
  rollback-only, whether or not an enclosing callback catches it. A
  rollback-only root never commits: when its callback returns it rolls
  back and throws the first failure that marked it, which remains the
  canonical cause even if the outer callback later throws something else.
- **Transaction-scoped compensation.** A store or service that performs an
  external side effect inside a transaction (writing a new Artifact blob;
  preparing a Run's Workspace through the Workspace preparation port at
  Run creation) registers compensation on the root with
  `afterRollback(hook)`, from any nesting depth. Hooks run exactly once, only when the root rolls back
  (callback failure, rollback-only failure, or commit failure), never after
  a successful commit; they run after the SQLite `ROLLBACK` has been
  attempted and the transactor has left the transaction, so a hook that
  reads the database sees committed rows only; they run in reverse
  registration order (most recently registered first, like unwinding), and
  are cleared when the root ends. A hook that throws never replaces the
  canonical error: the failure is reported as the `rollback_hook_failed`
  diagnostic and attached to the thrown error.
- **What is and is not guaranteed for blobs.** SQLite and the Artifact
  blob store do not form a crash-atomic distributed transaction. The
  guarantee is: no invalid request writes a blob (every validation runs
  first); Artifact metadata never commits before its blob exists; every
  validation failure and ordinary synchronous transaction failure is
  compensated by removing a blob the transaction newly wrote, unless a
  committed Artifact references its digest (a pre-existing or restored
  blob is never removed); a process or machine crash between the blob
  write and the database commit can leave a safe, unreferenced blob behind
  — never committed metadata pointing at content the operation did not
  write — and reads always verify digest and size. There is no garbage
  collector in Phase 1.
- **Ownership.** A database file and its blob store are owned by exactly
  one runtime process at a time. Compensation and reference checks assume
  that single owner; multi-process cleanup safety is neither implemented
  nor claimed.

| Object | Writer | Canonical store | Projections |
|---|---|---|---|
| Schema identity | Migration | `schema_info` | — |
| Workspace | Operator via API | `workspaces` | — |
| Conversation, messages | Operator, Orchestrator via runtime | `conversations`, `conversation_messages` | Conversation view |
| Run (with its persisted final reserve) | Runtime (Run creation service) | `runs` | Run view, Run list |
| Budget Increase | Runtime (Budget Increase service, from the operator's `approve`) | `budget_increases` | Run view |
| Allocation Extension | Runtime (Plan Node capacity operation) | `allocation_extensions` | Run view, Plan view |
| Execution Plan (source; accepted revisions only) | Runtime (plan-revision service; revision 1 by Run creation) | `execution_plan_revisions` | Plan view |
| Plan Node, Plan Edge (compiled) | Plan-revision service through the compiler; the root node by Run creation | `plan_nodes`, `plan_edges` | Plan view |
| Plan Revision Membership | Plan-revision service; revision 1 by Run creation | `plan_revision_nodes` | Plan view |
| Plan Node Requirement scope | Plan-revision service through the compiler | `plan_node_requirements` | Plan view, Task ledger |
| Requirement | Runtime (from Orchestrator proposal, operator approval) | `requirements`, `requirement_revisions`, `requirement_status_changes` | Requirements panel |
| Acceptance Criterion | Runtime (from Orchestrator) | `acceptance_criteria` | Requirements panel, Gate view |
| Decision | Runtime (from operator, Orchestrator, or a resolution policy) | `decisions` | Decision cards |
| Task | Runtime (from Orchestrator or Coordinator proposals) | `tasks`, `task_dependencies` | Task ledger |
| Artifact | Runtime | `artifacts` + blob store | Artifact viewer |
| Handoff | Runtime | `handoffs` | Plan view |
| Agent Definition, revision | Runtime (from files, built-ins, approved Conversation authoring) | `agent_definitions`, `agent_definition_revisions` | Agents view |
| Invocation | Runtime | `invocations` | Plan view |
| Attempt | Runtime | `attempts` | Plan view, transcript viewer |
| Approval use | Runtime (tool-call authorization) | `approved_tool_call_uses` | Decision cards, Plan view |
| Runtime-tool call | Runtime (runtime-tool executor) | `runtime_tool_calls` | Invocation inspector |
| Completion Request | Runtime (`request_completion` handler, completion engine) | `completion_requests` | Run view |
| Signoff Resolution | Runtime (signoff service, from the operator's `accept` or `request_changes`) | `signoff_resolutions` | Run view, Decision cards |
| Provider continuation index | Provider adapter | `provider_continuations` (index) + adapter-owned payload store | Attempt inspector (existence only) |
| Context Manifest | Runtime | `context_manifests` | Invocation inspector |
| Evaluation, Gate | Runtime | `evaluations`, `gates` | Gate view |
| Snapshot, Changeset | Runtime | `snapshots`, `changesets` | Run view |
| Publication | Runtime (publication service) | `publications` | Run view |
| Budget reservation | Runtime | `budget_reservations` | Run view, Plan view |
| Capacity lease | Resource governor | `capacity_leases` | System view |
| Usage | Runtime | `usage` | Every view's cost line |
| Event | Runtime | `events` | Everything |

Agent transcripts (the provider's message stream for one Attempt) are
stored as Artifacts of media type `application/x-agent-transcript`. They
are diagnostic records. No runtime decision reads a transcript; no
projection is built from one; no state is recoverable only from one.
Provider continuation payloads (§6.6) are not Artifacts, are not in any
canonical row, and are optimization-only: deleting every payload and every
`provider_continuations` index row changes no Run's outcome.

## 3. Run lifecycle

A Run has these states. Transitions are made by the runtime only.

```
created ──► running ──► verifying ──► awaiting_signoff ──► completed
               │            │               │
               │            │               └──► running   (operator requests changes)
               │            └──► running                   (run_completion Gate produced Tasks)
               ├──► waiting  ──► running                   (wait reason cleared)
               ├──► failed                                 (terminal failure transition, §7.6)
               └──► cancelled
```

- `created`: the Run's complete initial state exists, established
  atomically by the Run creation service in one root transaction: the Run
  row with its Run Budget and persisted final reserve (§7.6); the base
  Snapshot of the Target and the Run's Integration Workspace created from
  it (§9), obtained through the Workspace preparation port
  (`RunWorkspacePreparationPort`: `prepare` takes the Snapshot and creates
  the Integration Workspace, `discard` is its compensation when creation
  rolls back after preparation succeeded); accepted Execution Plan revision
  1 with the empty source `{ "version": 1, "expressions": [] }`; the root
  Plan Node (the Orchestrator's `single` node, §4.6) with its explicit
  initial allocation reserved from ordinary Run capacity; revision-1
  membership containing the root; the Conversation's active-Run reference;
  and every corresponding Event. Creation validates Conversation and
  Workspace ownership, that the Conversation has no active Run, that the
  Orchestrator Agent Definition revision exists, is the `orchestrator`
  definition, and declares the read, write, and shell capabilities, and
  that the initial allocation and the final reserve fit the Run Budget
  together, the allocation never being the whole Budget. Creation also
  persists the Run's immutable **verification policy** (§10): the Gate
  Evaluator Agent Definition revision — resolved through the same
  executable-revision resolver as the Orchestrator's, never the
  `orchestrator` definition, `null` for a Run whose Gates are
  deterministic only — `maxNodeGateCycles`, the bound on `node_exit`
  Gate cycles per Plan Node, `maxRunCompletionCycles`, the bound on
  `run_completion` Gate cycles per Run, and
  `runCompletionAcceptanceCriterionIds`, the Run's declared completion
  criteria: each must exist in the Run's Conversation on a Requirement of
  the current revision or on a Task; the list is deduplicated and kept in
  id order; a `kind: code` Run declares at least one deterministic one, an
  `other` Run may declare none, and an evaluated one requires the Gate
  Evaluator. The policy is never read from mutable configuration after
  creation. A preparation
  failure creates nothing; a database failure after preparation rolls back
  and runs the port's compensation. No Invocation exists yet: the initial
  Orchestrator Invocation is created when the Run starts.
- `running`: at least one Plan Node is `ready` or `running`. A Run
  enters `running` through the Run start service
  (`server/src/execution/run-start-service.ts`): given a Run in
  `created` and the operator's initial message (which must belong to the
  Run's Conversation), one transaction moves the root node `pending →
  ready → running`, the Run `created → running`, and prepares the first
  Orchestrator Invocation (§4.6, §6.1) — role `orchestrator`, purpose
  `operator_input`, ordinary Plan Node funding, no predecessor — with its
  reservation and Context Manifest. Nothing executes until the Attempt
  executor is asked; a second start is a conflict that creates no second
  first Invocation. Completing an Orchestrator turn leaves the root node
  and the Run `running`.
- `waiting`: no Plan Node can make progress. The Run records a structured
  reason: `decision` (an `operator_required` Decision is unanswered),
  `budget` (work that must proceed cannot be funded from the Run's
  effective ordinary capacity, even through an Allocation Extension, and
  only an approved ordinary Budget Increase can make it fundable, §7.6),
  `provider_capacity` (the resource governor has no lease to
  grant), `integration_conflict` (a Changeset conflict Task is open, §9.2),
  `operator` (the operator paused the Run). The scheduler records the
  Run `waiting` only when no action remains, no Attempt is executing, and
  no ready node is merely held back by the concurrency limit; the reason
  is the earliest waiting node's reason, and the Run resumes through an
  explicit `resume_run` action when that exact reason has cleared.
- `verifying`: the root Orchestrator's accepted Completion Request (§6.4)
  has begun: its requesting turn settled and integrated, and one
  transaction pinned the integration Snapshot, the current Requirement
  revision, and the criterion set, opened the `run_completion` Gate
  (§10), and moved the Run here. Only the completion engine's actions
  execute (§7.1): the deterministic checks, the one Gate Evaluator, the
  Requirement-status derivation, and the one read-only final synthesis,
  the last two funded from the final reserve. A failed Gate returns the
  Run to `running` with exactly one remediation Task for the root's
  batched `gate_result` turn; no ordinary work starts meanwhile and no
  ordinary Invocation can be prepared.
- `awaiting_signoff`: the `run_completion` Gate passed, the final-report
  Artifact exists, and the `operator_signoff` Gate is open with its one
  `operator_required` `signoff` Decision. The runtime performs nothing:
  no action is projected, no Invocation can be prepared, no Completion
  Request can be created, and nothing resolves the Decision by itself.
  Only the operator resolves it, through the signoff service
  (`server/src/execution/signoff.ts`, §10 `operator_signoff`), by exactly
  one of two closed operations: `accept` moves the Run to `completed`
  with its final Snapshot and final Changeset (§9.3); `request_changes`
  returns it to `running` with one follow-up root Orchestrator turn.
  Each is recorded as one canonical Signoff Resolution; neither is
  inferred from Conversation text, an Orchestrator result, a model
  summary, or an unresolved Decision.
- `completed`: the operator accepted the verified final Snapshot. Terminal.
  A completed Run carries exactly its two final references,
  `finalSnapshotId` (the signoff Gate's verified Snapshot, by reference)
  and `finalChangesetId` (the Run's one `final` Changeset, §9.3), and no
  other Run carries either. Its Integration Workspace remains in place. A
  completed Run may then be published (§9.4) through its own resolved
  `publish` Decision; Publication is a separate, explicit operation that
  never changes the Run's state, and signoff acceptance grants no publish
  authority.
- `failed`: reached only by a terminal failure transition: the root Plan
  Node failed (its current Orchestrator Invocation failed after its
  permitted Attempts with a permanent failure), or the Orchestrator
  returned a result declaring the Run infeasible with Evidence. Budget
  exhaustion never produces `failed` by itself. Terminal.
- `cancelled`: the operator cancelled. Terminal.

Terminal states are final. There is no resume. A new Run in the same
Conversation starts from the Conversation's current Requirements, Decisions,
and Artifacts, and from a fresh Snapshot of the Target.

## 4. The Execution Plan

### 4.1 Two forms, one owner

The Execution Plan exists in two forms, both owned by the runtime:

- **Source form** — a tree of Pattern expressions authored by the
  Orchestrator. Each expression names a Pattern and its operands; an operand
  is either a leaf operation (an Agent Definition revision plus an input
  specification) or another Pattern expression. Expressions may name the
  Requirement roots they serve, at one pinned Requirement revision, and the
  Budget allocation they request. The source form is what the Orchestrator
  reads and revises. It is persisted append-only as
  `execution_plan_revisions`.
- **Compiled form** — a flat directed acyclic graph of Plan Nodes and typed
  Plan Edges materialized by the deterministic plan compiler from a source
  revision. The compiled form is what the scheduler executes. It is
  persisted in `plan_nodes`, `plan_revision_nodes` (each accepted
  revision's immutable ordered membership), `plan_edges` (each edge owned
  by exactly one revision), and `plan_node_requirements`.

The Orchestrator authors and revises the source form through the
`revise_execution_plan` tool. The plan-revision service validates the
proposed revision, compiles it, reconciles it with the current accepted
revision, and either applies it atomically or rejects it (§4.5). Only
that service, through the compiler, writes `plan_nodes`,
`plan_revision_nodes`, `plan_edges`, and `plan_node_requirements`; Run
creation writes the root node and revision 1. The Orchestrator may read
compiled plan state through `read_execution_plan`. Coordinators, Workers,
and Evaluators cannot revise either form.

The scheduler reads one thing: the **current executable graph**, the
membership and edges of the Run's latest accepted revision
(`currentGraph`). Historical graphs are read by revision number
(`graph(run, n)`). No query infers membership from timestamps, a node's
creating revision, incident edges, source-path prefixes, or status.

### 4.2 Plan Node

A compiled Plan Node has:

- `id`, `runId`, `kind`, `title`, `sourcePath` (the canonical source path
  of the expression it was compiled from, §4.4), `createdInRevisionNumber`
  (the accepted revision that created it; later memberships are recorded
  in `plan_revision_nodes`)
- `kind`: `pattern` or `join`
- `pattern`: for `kind: pattern`, exactly one of `single`, `chain`,
  `route`, `parallel`, `coordinator_worker`, `evaluator_optimizer`; absent
  for `kind: join`
- `shape`: for `kind: pattern`, the immutable pattern-specific execution
  shape — every operation the Pattern executes (Agent Definition revision,
  title, input, the `role` its Invocations hold, and `readOnly`, true for
  the evaluator role) in its position, and the Pattern's bounds: `single` (role
  `worker`, or `orchestrator` for the root only, and one operation);
  `chain` (two or more steps); `route` (the selector and the branch
  bindings in canonical label order, each inline with an operation or
  composite); `parallel` (one or more items, optional aggregation,
  `requireAll`); `coordinator_worker` (coordinator, worker, bounds);
  `evaluator_optimizer` (inline producer with `round: null`, or an
  evaluate-only node naming its unrolled `round`, plus evaluator and
  `maxRounds`); absent for `kind: join`
- `input`: for `kind: pattern`, a Context Manifest template — the union of
  the Task ids, Decision ids, and Artifact ids of the shape's operations
- Requirement scope: the exact set of leaf Requirement ids the node serves,
  at the pinned Requirement revision, persisted in `plan_node_requirements`
  (§4.7); empty for the root node and for `join` nodes
- `allocation`: the Budget allocation reserved for this node from the Run
  Budget (§7.6), plus the node's local limits (`maxConcurrency`,
  `maxWallClockMs`) and its `onAllocationExhausted` policy
  (`fail | wait | extend`)
- `fanInPolicy`: for `kind: join`, exactly `require_all` (default) or
  `require_any`; this is a closed two-value set (no threshold, count,
  weighted, or custom policy)
- `gate`: for `kind: pattern`, the `node_exit` Gate's Acceptance Criteria
  (may be empty)
- `status`: `pending | ready | running | waiting | succeeded | failed | cancelled | skipped`
- `output`: the Artifact ids produced, set when the node reaches `succeeded`

Everything above except `id`, `runId`, `createdInRevisionNumber`,
`status`, `output`, and timestamps is the node's **definition**; it is
immutable from insertion (a database trigger enforces it) and is what
reconciliation compares (§4.5).

A Plan Node of `kind: pattern` executes an orchestration Pattern by creating
Invocations. A Plan Node of `kind: join` has no Pattern value, no Agent
Definition, and creates no Invocation: it executes deterministically, waits
for its declared fan-in predecessors, produces an index Artifact containing
the ordered predecessor references, their outcomes, and their output
Artifact ids, and succeeds or fails according to its `fanInPolicy`. `join`
is a deterministic node kind, not a seventh orchestration Pattern.

**Join settlement** (`server/src/execution/join.ts`). A join requests no
capacity lease, consumes no provider tokens, creates no Invocation and no
Attempt, holds zero allocation, and never enters `running` or `waiting`.
Once the readiness evaluator has made it `ready` (§4.3), one transaction
settles it: over its non-skipped `fan_in` predecessors, `require_all`
succeeds only when every one succeeded and `require_any` when at least
one did; a skipped predecessor counts as neither success nor failure. The
transaction writes the **join index Artifact** (media type
`application/vnd.agentique.join-index.v1+json`, schema `joinIndexSchema`
in `core/src/index-artifacts.ts`: `{ version: 1, planNodeId, sources:
[{ position, edgeId, sourceNodeId, status, outputArtifactIds }] }`,
ordered by `fan_in` edge position, then edge id, as canonical JSON; never
Artifact bytes or narrative) and moves the node to `succeeded` with that
Artifact as its output, creating the current-revision edge Handoffs from
it, or to `failed` with `join_fan_in_failed`, the index recorded in the
`plan_node.failed` Event's `artifactIds` for diagnosis. Because the index
and the terminal transition share one transaction, a repeated pass or a
restart creates neither a second index nor a second Handoff.

A persisted Plan Node does not contain other Plan Nodes. Everything inside
a `pattern` node is an Invocation (§5). Composition between nodes is
expressed only by Plan Edges.

### 4.3 Plan Edge

A Plan Edge is a typed, directed relation between two Plan Nodes:

| Edge type | Meaning |
|---|---|
| `sequence` | The target becomes eligible when the source is terminal; the source's output Artifacts are delivered to the target as a Handoff. |
| `branch(label)` | A `sequence` edge that is active only when the source (a `route` node) selected `label`. Inactive branches' targets become `skipped`. |
| `fan_in` | Enters a `join` node. The join becomes eligible when every `fan_in` source is terminal; the sources' outcomes and outputs are recorded in the join's index Artifact in edge order. |
| `retry(round)` | A `sequence` edge from the evaluate-only node of round `round − 1` of an unrolled `evaluator_optimizer` expression into the producer subgraph of round `round`; active only when the source's recorded round verdict is `fail` or `inconclusive`. When the verdict is `pass`, the edge is inactive and every later round is `skipped`. |

Every Plan Edge belongs to exactly one accepted revision and is
append-only; a later revision that keeps a node writes its own edge rows.
Readiness is computed from the current accepted revision's edges only; an
edge of a historical revision never makes a node ready:

- A `pattern` node is `ready` when every predecessor is terminal, no
  predecessor is `failed` or `cancelled` (unless the node was compiled with
  `runOnDependencyFailure: true`), at least one predecessor is `succeeded`
  or the node has no predecessors, and its allocation is reserved (§7.6).
  A node all of whose predecessors are `skipped` is `skipped`. A node with
  a `failed` or `cancelled` predecessor is `skipped` unless
  `runOnDependencyFailure` is set, in which case it becomes `ready` with
  the failure in its manifest.
- A `join` node is `ready` when every `fan_in` predecessor is terminal.
  It then executes immediately: it writes the index Artifact and becomes
  `succeeded` when its `fanInPolicy` is met (`require_all`: every
  non-skipped predecessor `succeeded`; `require_any`: at least one
  `succeeded`), otherwise `failed`. A join all of whose predecessors are
  `skipped` is `skipped`. A join never waits on anything but its edges and
  never holds a capacity lease or a Budget allocation beyond zero.

Readiness is computed by a pure evaluator
(`server/src/execution/readiness.ts`) over one **readiness input**: the
current graph plus the explicit canonical condition facts that decide
conditional edges.

```ts
interface ReadinessInput {
  graph: PlanGraph;
  routeSelections: ReadonlyMap<PlanNodeId, RouteSelectionFact>;
  optimizerVerdicts: ReadonlyMap<PlanNodeId, OptimizerVerdictFact>;
}
interface RouteSelectionFact { planNodeId; selectedLabel; evaluationId }
interface OptimizerVerdictFact { planNodeId; round; maxRounds; evaluationId; verdict }
```

Readiness cannot be a function of `PlanGraph` alone: a `branch(label)`
edge and a `retry(round)` edge (and the `sequence` edges out of an
evaluate-only `evaluator_optimizer` node) are activated by a canonical
Evaluation fact the graph does not contain. The evaluator therefore
receives those facts as input and stays pure: it queries no store, writes
nothing, mints nothing, and reads no clock, transcript, Artifact content,
Handoff summary, Invocation creation order, source-path text, or Event
replay. The caller projects the facts from canonical rows
(`server/src/execution/readiness-facts.ts`: `projectReadinessInput` reads
exactly the `route_selection` Evaluations of the Run, keyed by route node
id, and the `optimizer_verdict` Evaluations of the Run, keyed by
`evaluator_optimizer` node id — of a node that judged several rounds the
latest round's verdict, with its `round` explicit so several rounds inside
one inline node stay unambiguous) and hands them in. A fact that is
missing where an edge needs it (a succeeded route node without a
selection; a succeeded evaluate-only node without a verdict) or that
contradicts the graph (a label the node's shape does not bind, a fact on a
member of another kind, a fact keyed by another node, a verdict whose
`round` or `maxRounds` the node's immutable shape does not hold, an
evaluate-only node's fact naming another round than its fixed one, a
succeeded inline optimizer node whose latest verdict is not `pass`) is a
typed `ReadinessFactError` — an invariant failure, never guessed
readiness. Facts are per node id, so a node a later revision replaced (a
new id) carries no historical fact, and a fact of a node outside the
current membership is inert: historical Evaluation facts cannot activate
current-revision edges.

Given the input, the evaluator returns, per member in membership order,
`remain_pending`, `become_ready`, `become_skipped` (with the cause and the
failed predecessors), or the observation that the node is already ready,
active, or terminal. Each current-revision edge into a pending node has an
**activation**: `pending` while its source has not ended; `inactive` when
the source was skipped, when it is a `branch(label)` edge whose route
selected another label, when it is a `sequence` edge out of a route that
selected a composite branch (that selection delivers through the branch's
exits, never through the route's own edges), when it is a `sequence` edge
out of an evaluate-only optimizer node whose round verdict is `fail` or
`inconclusive`, or when it is a `retry(round)` edge out of an evaluate-only
node whose verdict is `pass`; `failed` when the source failed or was
cancelled; `delivers` when the source succeeded and the edge is active. A
`retry(round)` edge is validated against the graph before any status is
read: its source is the evaluate-only node of round `round − 1` and
`round` is within the node's `maxRounds`; anything else is a
`ReadinessFactError`. A pending pattern node with no edges becomes ready;
with every edge inactive it is skipped; with a failed edge it is skipped
unless compiled with `runOnDependencyFailure`; otherwise it becomes ready
once every edge has settled and at least one delivers — so an inline
selection lets successors proceed once every composite alternative has
been skipped, a composite selection makes successors wait until the
selected branch's exits are terminal, a failed optimizer round readies
exactly the next producer round through its retry edge while the
expression's successors wait for a later round, and a passing round skips
every later round through the ordinary all-inactive rule. An inactive
conditional edge is never a failed predecessor: it removes that path from
eligibility, and the inactive target and everything behind it are
`skipped`, never `failed`. A `join` becomes ready when every `fan_in`
predecessor is terminal and is skipped when every one was skipped; its
policy is applied at settlement (§4.2), never here. The same activation
decides which edges the Handoff router delivers along (§7.7). Every
Pattern has a runner and every edge type has activation semantics; the
readiness evaluator defers nothing.

### 4.4 Composition and compilation

Pattern composition is expressed structurally in the source form and
materialized flat by the compiler. The compiler is deterministic: the same
normalized source revision, with the same resolved inputs, always yields
the byte-for-byte same compiled draft.

The compiler (`server/src/execution/compiler/`) is a pure function from
one immutable **compile input** — the validated source, the resolved Agent
Definition revisions, the pinned Requirement revision trees and current
Requirement statuses, the Task, Decision, Artifact, and Acceptance
Criterion ids that exist, the allocation defaults, and the limits — to a
**compiled draft**: nodes keyed by canonical source path with their full
definitions, and edges between keys with fan-in positions. It never
queries the database, mints database ids, writes Events, reserves Budget,
or mutates persisted state; the plan-revision service maps keys to
retained or newly minted Plan Node ids during reconciliation (§4.5).

**Agent Definition resolution and role policy.** Every Agent Definition
revision a source names is resolved by the executable-revision resolver
(`server/src/execution/agent-definitions.ts`) before compilation: the
revision must exist and its provenance must belong to the Run (§11); a
revision that does not resolve rejects the proposal with
`invalid_agent_definition_revision`. The compiler receives the resolved
revisions' immutable facts (name, provenance kind, capabilities, Tool
Policy, default limits) and binds each operation to the role its position
holds, recording `role` and `readOnly` so the Context Manifest can later
intersect the revision's Tool Policy with the role policy (§6.4) without
re-deriving anything; the compiler evaluates no provider tool semantics and
never rejects a definition for the tools it declares. The one contradictory
binding — the `orchestrator` definition in any role but the root's — is
rejected with `invalid_role_binding`, as is a route selector option mapped
to a branch that does not exist.

**Leaf operations.** A leaf is a `single` expression that declares no
node-level option other than a title (no scope, allocation, limits,
policy, or Gate criteria). Leaves are absorbed into their enclosing
Pattern node as chain steps, parallel items, inline route branches, or an
inline producer. A `single` expression that declares node-level options
has node semantics of its own and compiles to its own node.

**Node options.** An expression's `allocation`, `limits`,
`onAllocationExhausted`, `runOnDependencyFailure`, and
`gateAcceptanceCriterionIds` apply to every `pattern` node compiled
directly from it (the node of an all-leaf expression; the leaf-run nodes of
a composite chain; the leaves node and the aggregation node of a composite
parallel; every evaluate-only round). Nodes compiled from a nested
expression take that expression's options. Omitted allocations resolve to
the configured default; omitted limits are unbounded; policies default to
`fail` and `false`.

**Canonical source paths.** Every compiled node is keyed by a source path
under this grammar, which is the logical key reconciliation matches on:

```
path       := "root" | expression
expression := "e" index { "/" segment }
segment    := "steps/" index                 a composite chain step
            | "steps/" index ".." index       a maximal run of leaf chain steps (one chain node)
            | "items/" index                  a composite parallel item
            | "leaves"                        the leaf items of a composite parallel (one parallel node)
            | "join"                          the compiler-emitted join of a composite parallel
            | "aggregate"                     the aggregation node of a composite parallel
            | "branches/" label               a composite route branch
            | "rounds/" round "/producer"     one unrolled evaluator-optimizer producer round
            | "rounds/" round "/evaluate"     the evaluate-only node of that round
index      := decimal integer >= 0 (position in a semantically ordered array)
round      := decimal integer >= 1
label      := the branch label percent-encoded: [A-Za-z0-9_-] verbatim, every other
              UTF-8 byte as %XX (upper-case hex)
```

An all-leaf expression's node takes the expression's own path (`e0`,
`e0/steps/2`, `e0/branches/x`). The grammar is deterministic, unique
within a revision, independent of object insertion order (route branches
are keyed by label, never position), safe for any label, and stable when
unrelated later siblings are appended. Inline roles (chain steps, parallel
items, inline branches, the selector, the inline producer and evaluator)
live inside their node's shape and have no path of their own.

Compilation rules, applied recursively to each expression:

1. A leaf operation compiles to one `single` node.
2. `chain(e₁ … eₙ)`: each operand compiles to a subgraph; the exits of the
   subgraph for `eᵢ` are connected to the entries of the subgraph for
   `eᵢ₊₁` by `sequence` edges. A maximal run of consecutive leaf operands
   compiles to one `chain` node whose steps are those leaves (path
   `steps/i..j`); a run of one leaf compiles to a `single` node (path
   `steps/i`). A chain whose operands are all leaves compiles to one
   `chain` node at the expression's path; a chain of one leaf compiles to
   a `single` node. Step order is preserved.
3. `route(selector, {label ⇒ e})`: compiles to one `route` node holding
   the selector and the branch bindings in canonical (code-unit) label
   order. A leaf branch stays inside the node as its branch Invocation. A
   composite branch compiles to its own subgraph, connected from the
   `route` node by a `branch(label)` edge. Successors of the expression
   receive `sequence` edges from the `route` node and from every composite
   branch's exits; the readiness rule in §4.3 makes exactly the selected
   path deliver and never executes an inactive branch. A
   `decision_answer` selector must name an existing Decision and map every
   option to an existing branch label; an `evaluator` selector must name an
   existing Agent Definition revision.
4. `parallel(items, aggregate?)`:
   - When every item is a leaf, the expression compiles to one `parallel`
     node holding the items and, if given, the aggregation as an inline
     Invocation (§5.4).
   - When any item is composite, every composite item compiles to its own
     subgraph (path `items/i`), and the leaf items (if any) compile to one
     `parallel` node without aggregation (path `leaves`, positioned at the
     first leaf item). All of these fan into one `join` node (path `join`,
     policy `require_all` unless `requireAll: false`, then `require_any`)
     by `fan_in` edges, in item order (a composite item with several exits
     contributes one edge per exit). If an aggregation is given, it
     compiles to a `single` node (path `aggregate`) reached from the join
     by a `sequence` edge, whose input is the join's index Artifact.
     Successors of the expression receive `sequence` edges from the
     aggregation node, or from the join when there is none; a terminal
     composite parallel without aggregation ends at its join.
   - A `parallel` node is never created with zero items and never exists
     only to perform fan-in; fan-in is always a `join` node.
5. `evaluator_optimizer(producer, evaluator, maxRounds)`: a leaf producer
   compiles to one `evaluator_optimizer` node (§5.6) whose shape holds the
   producer inline (`round: null`). A composite producer is unrolled: for
   each round `r` in `1 … maxRounds` the compiler emits a copy of the
   producer subgraph `Pᵣ` (path `rounds/r/producer`) and an
   `evaluator_optimizer` node `Eᵣ` in evaluate-only form (path
   `rounds/r/evaluate`; `producer: null`, `round: r`; it evaluates the
   Handoff from `Pᵣ`'s exits); `Pᵣ → Eᵣ` by `sequence`; `Eᵣ → Pᵣ₊₁` by
   `retry(r+1)`; successors of the expression receive `sequence` edges from
   every `Eᵣ`. A passing `Eᵣ` skips every later round. `maxRounds` above
   `maxUnrolledRounds` is rejected.
6. `coordinator_worker(coordinator, worker)`: compiles to one
   `coordinator_worker` node with the resolved bounds (the expression's or
   the configured default; `maxConcurrentWorkers` may not exceed
   `maxTasks`, and `maxCoordinatorInvocations` is at least 2, because a
   useful lifecycle needs one `decompose` and one `synthesize` turn — both
   rejected with `invalid_pattern_bounds`). Its operands must be leaves. It may not be an operand of
   another `coordinator_worker` expression at any depth; a raw proposal
   that nests one, or gives one a composite operand, is rejected before
   schema parsing with `nested_coordinator_worker`. Tasks and Invocations
   are runtime execution records and are never compiled.
7. Requirement scope: an expression that names Requirement roots at a
   pinned revision is expanded to the exact leaf set (§4.7), in tree order,
   and the set is persisted for every `pattern` node compiled from that
   expression or its descendants that do not name their own roots; a
   descendant that names its own roots replaces the inherited scope for
   itself and its descendants. Roots resolve against exactly one pinned
   revision of the Run's Conversation; an internal root is expanded and is
   never itself in the scope. The root Orchestrator node and `join` nodes
   carry no scope.
8. Allocation: every `pattern` node is compiled with the allocation its
   expression requests (or the configured default); the whole revision's
   allocations are validated before persistence and reserved atomically for
   the newly created nodes when the revision is applied (§7.6), from
   ordinary Run capacity outside the persisted final reserve. Reused nodes
   keep their reservation and are never reserved twice. A `join` node's
   allocation is zero.

Rejected at validation or compile time, with the rejection returned to the
Orchestrator as the tool result carrying one or more stable,
machine-readable reasons (`PLAN_REJECTION_CODES`), each with a concise
message and, where one applies, the source path:

- `cyclic_source_object`: a source object that references itself or an
  ancestor (detected structurally by an iterative walk before any schema
  parse, never by a stack overflow);
- `excessive_source_depth`: raw nesting beyond the hard object bound, or
  expression depth greater than `maxPlanDepth` (default 4);
- `excessive_unrolled_rounds`: `maxRounds` greater than
  `maxUnrolledRounds` (default 6);
- `excessive_compiled_nodes`: more than `maxPlanNodes` (default 200)
  compiled nodes;
- `compiled_graph_cycle`: any cycle in the compiled graph;
- `unsupported_pattern`: any Pattern name other than the six;
- `explicit_join`: a `join` requested explicitly (joins are
  compiler-emitted only);
- `invalid_structure`: a malformed expression (empty chain, items, or
  branches; unknown fields; wrong operand types);
- `invalid_agent_definition_revision`, `invalid_task_reference`,
  `invalid_artifact_reference`, `invalid_decision_reference`,
  `invalid_acceptance_criterion_reference`: a reference to something that
  does not exist in this Run or Conversation;
- `invalid_role_binding`: the `orchestrator` definition bound to a Worker,
  Coordinator, Evaluator, or selector position, or a selector option mapped
  to a branch that does not exist;
- `invalid_requirement_scope`: a Requirement revision that does not exist
  or belongs to another Conversation, or a root that does not exist at the
  pinned revision, belongs to another Conversation, or is `retired`;
- `nested_coordinator_worker`: a `coordinator_worker` operand that is not
  a leaf, or a `coordinator_worker` nested inside another one;
- `invalid_pattern_bounds`: a Pattern-specific bound that cannot hold;
- `insufficient_capacity`: an allocation set that cannot be reserved from
  unreserved ordinary Run capacity after the persisted final reserve
  (§7.6);
- `started_node_changed`: a revision that would change the definition of
  a node that has started or ended (§4.5).

Examples that compile:

- a chain whose middle stage is a route: `chain(A, route(s, {x ⇒ B, y ⇒ chain(C, D)}), E)` → `single A → route(s; inline B) → single E` plus `route –branch(y)→ chain(C, D) → single E`;
- an evaluator-optimizer wrapping a chain: unrolled rounds `chain(P₁a, P₁b) → E₁ –retry→ chain(P₂a, P₂b) → E₂ …`;
- a route branch that is a chain (as above);
- a parallel whose items are static subgraphs with an aggregation: each subgraph's exits `fan_in` to one `join`, then `join → single(aggregate)`;
- a terminal parallel with composite branches and no aggregation: the subgraphs `fan_in` to one `join`, which is the expression's exit.

### 4.5 Who may change the plan

- Only the Orchestrator authors and revises the source form, and only an
  Orchestrator Invocation belonging to the Run may propose a non-initial
  revision (any other proposer is an error, not a rejection). The
  plan-revision service (`server/src/execution/plan-revision-service.ts`)
  performs, in order: authorization; source validation (cyclic objects,
  explicit joins, unknown Patterns, nested coordinator-worker, schema,
  depth and round limits); compile-input resolution; deterministic
  compilation; reconciliation; atomic persistence; and a structured
  accepted or rejected result.
- **Reconciliation** compares the compiled draft with the current accepted
  revision by canonical source path and full immutable definition (kind
  and Pattern, title, source path, shape — role bindings and Agent
  Definition revisions, Pattern bounds, selector, join policy — manifest
  template, Requirement scope and pinned revision, allocation, concurrency
  and wall-clock limits, allocation-exhaustion policy, dependency-failure
  policy, Gate criteria):
  - a draft node whose path matches a member with an equal definition
    **reuses** that node: it keeps its id, status, timestamps, output,
    scope rows, and reservation and actual Usage history, and receives no
    second reservation;
  - a draft node whose path matches a member with a different definition
    **replaces** it when the member has not started (`pending` or
    `ready`): the old node is cancelled with its reservation released and
    a new node with a new id is created; the old node's definition is
    never mutated and its id is never reused for changed semantics. If the
    member has started or ended (`running`, `waiting`, or terminal) the
    whole proposal is rejected with `started_node_changed`; the
    Orchestrator cancels the node and adds a new expression instead;
  - a draft node with no matching member is **created** `pending` with its
    allocation reserved;
  - a member with no matching draft node is **removed**: if it has not
    started it is cancelled and its reservation released; if it is
    `running`, `waiting`, or terminal its row, state, and definition are
    never rewritten — it simply leaves the new revision's membership, so
    historical edges cannot activate successors through it, its existing
    execution may still finish and produce a `node_result`, and only the
    current revision's graph controls future scheduling.
- **Accepted revision.** In one root transaction the service appends the
  immutable source revision (numbered after the latest accepted one),
  cancels removed and replaced unstarted nodes and releases their
  reservations, creates the new nodes with their exact scope rows, reserves
  every new node's allocation atomically from ordinary Run capacity, writes
  the revision's immutable membership (root first, then the compiled draft
  order) and revision-specific edges (a reused node never reuses an older
  revision's edge row), and appends `execution_plan.revised`,
  `plan_node.cancelled` and `budget_reservation.released`,
  `execution_plan.compiled`, `plan_node.created`, and
  `budget_reservation.created`, all correlated with the proposal and caused
  by the revised Event. No intermediate accepted state is observable.
- **Rejected revision.** A rejected proposal persists no source revision,
  consumes no revision number, creates no membership, node, edge, scope
  row, or reservation, modifies no existing node, and appends exactly one
  `execution_plan.rejected` Event in a separate successful transaction,
  carrying the stable reasons and the proposing Invocation's correlation
  and causation. An ordinary invalid proposal never throws at the service
  boundary; an unexpected infrastructure failure throws after rollback and
  is never mislabeled as a rejection.
- **Gate Evaluator availability.** A draft `pattern` node other than
  `evaluator_optimizer` whose `node_exit` Gate names an evaluated
  Acceptance Criterion is rejected with `gate_evaluator_unavailable` when
  the Run's verification policy names no Gate Evaluator; deterministic-only
  Gates and `evaluator_optimizer` nodes (whose rounds consume their own
  criteria through their own Evaluator, §5.6) are unaffected.
- Coordinators, Workers, and Evaluators cannot revise either form. Tasks a
  Coordinator proposes are internal execution records of its node (§5.5)
  and never create, remove, or alter Plan Nodes, Plan Edges, or scope rows.
- A node in `pending` or `ready` may be cancelled by the Orchestrator or the
  operator. A `running` node may be cancelled; its Invocations are
  interrupted and the node ends `cancelled`.
- Every accepted revision writes one `execution_plan.revised` Event
  carrying the source revision and one `execution_plan.compiled` Event
  carrying the revision's membership, its member nodes, its edges, their
  scope rows, and the created, reused, and cancelled node ids; every
  rejected proposal writes one `execution_plan.rejected` Event carrying the
  reasons and the revision number that remains current.

### 4.6 The root node and Orchestrator Invocations

The root Plan Node is created with the Run by the Run creation service,
not by the compiler: `kind: pattern`, pattern `single`, shape role
`orchestrator` (the only node that may hold it), title `Orchestrator`,
source path `root`, no predecessors, no Requirement scope, and an explicit
initial allocation (`initialOrchestratorAllocation`, configurable and
overridable per Run) reserved from ordinary Run capacity (§7.6) — never
the whole Run Budget. Its `onAllocationExhausted` policy is `extend`. It
is the first member of every accepted revision's membership. The root node
stays `running` for the life of the Run and reaches `succeeded` only when
the Run does.

The root node owns a sequence of Orchestrator Invocations. Each is one
logical execution with one immutable Context Manifest and one `purpose`.
The runtime creates a new Orchestrator Invocation when new logical input
exists for the Orchestrator and no Orchestrator Invocation is active:

| Purpose | Created when |
|---|---|
| `operator_input` | The operator posted a message (the Run's first Invocation always has this purpose). |
| `node_result` | A Plan Node reached a terminal state. |
| `decision_resolution` | A Decision the Orchestrator requested or that affects the Run was resolved or superseded; or the operator resolved the Run's `signoff` Decision with `request_changes` (§10): the signoff service prepares exactly one such turn in the resolving transaction — continued from the previous root turn, funded from the root's ordinary allocation, carrying the typed `signoff_resolution` input and the operator's message — and links it to the Signoff Resolution. |
| `gate_result` | A `node_exit` Gate of a node without a Coordinator failed and its remediation Task awaits the Orchestrator (§10): every pending remediation Task of the Run is batched into one turn, created only when no other action, in-flight Attempt, or concurrency-limited node remains, funded from the root's ordinary allocation (when it does not fit, the root's `extend` policy creates the exact Allocation Extension the Run's effective ordinary capacity admits, in the transaction that creates the turn, and when no such extension fits the Run waits with reason `budget` until an ordinary Budget Increase is approved, §7.6); or a `run_completion` Gate failed and its one remediation Task awaits the Orchestrator (§10) — coalesced into the same batched turn as any failed node Gates, with a typed `gate_result` input per Gate. |
| `plan_revision` | The Orchestrator's previous Invocation ended by returning `blocked` on a rejected plan revision or by requesting continuation after a revision, and the compiled outcome is now available. |
| `final_synthesis` | The Run's `run_completion` Gate passed every criterion and every structural condition (§10): the completion engine prepares the one read-only final-synthesis turn of that Gate — positioned at the root's `orchestrator` position, owning the Gate through `gateId`, funded from the final reserve, with no Task, no Execution Workspace, and no Changeset — and its typed `FinalSynthesisResult` becomes the final-report Artifact. Never created by the input queue, never for a terminal Run. |

There is never more than one active Orchestrator Invocation for a Run.
Inputs that arrive while one is active are queued; when it ends, the
runtime creates exactly one new Invocation whose Context Manifest carries
every queued input and whose `purpose` is the first in the table order
above that applies. Routine progress — an Invocation starting, a Task
changing state, Usage accruing, a lease being granted — never creates an
Orchestrator Invocation. Each Orchestrator Invocation records
`continuedFromInvocationId` pointing at the previous one; its initial
Attempt may be `resumed` across that boundary under §6.6.

A `gate_result` turn ends its remediation Tasks, never the Run: a
completed turn (its Changeset integrated first) marks every Task it was
given addressed — a Task the Orchestrator reported completed keeps its
own Evidence and output Artifacts, the rest complete with the integration
Snapshot as Evidence — and the gated nodes open their next Gate cycle
(§10); a turn blocked on an approval continues in a successor that carries
the same `gate_result` inputs and takes the Tasks over; a turn that fails,
ends without completing, or reports a Task blocked ends those Tasks, and
each affected node fails with `gate_remediation_failed` while the root and
the Run stay `running`. This is the one Orchestrator failure that does not
fail the Run.

### 4.7 Plan Node Requirement scope

A source Pattern expression may name the Requirement roots it serves,
together with exactly one pinned Requirement revision of the Conversation.
During compilation the compiler expands those roots to the exact set of
leaf Requirement ids that exist under them at that revision and persists
one `plan_node_requirements` row per (Plan Node, Requirement id, pinned
Requirement revision) for every `pattern` node compiled from the
expression. An expression that names no roots inherits its nearest
ancestor expression's scope; the root Orchestrator node and `join` nodes
have no scope rows.

- A running Plan Node's scope never changes. A later Requirement revision
  does not add, remove, or re-pin any row of an existing node.
- To work against revised Requirements, the Orchestrator revises the
  source Execution Plan; reconciliation (§4.5) produces replacement nodes
  with their own scope rows and cancels unstarted nodes whose expressions
  were removed.
- Coordinator-proposed Tasks must reference a non-empty subset of their
  node's persisted scope at the pinned revision (§5.5.1). Orchestrator-
  created Tasks reference leaf Requirements of the Conversation's current
  revision.
- The scope rows are the only source of truth for "which Requirements does
  this node serve"; no ancestor path, tree walk, or revision lookup is
  needed at validation time. Inherited scope is materialized: a `pattern`
  node compiled from an expression that inherits its ancestor's roots gets
  its own complete set of rows, so identical rows under sibling nodes are
  intentional, and validation is one indexed lookup on
  `(plan_node_id, requirement_id, requirement_revision_id)`. Rows carry a
  position so a node's scope reads back in the deterministic tree order
  the compiler produced.

## 5. Patterns

Each Pattern is a fixed shape the runtime executes inside one `pattern`
Plan Node. The runtime, not an agent, creates the Invocations, orders them,
delivers Handoffs, and combines results. A Pattern never communicates with
agents outside its own Plan Node.

Common rules for every Pattern:

- Every Invocation receives exactly its Context Manifest and returns a typed
  result (§6.3).
- Every Invocation whose Tool Policy grants write capability runs in an
  isolated worktree from the node's starting Snapshot and produces a
  Changeset (§9).
- Every Invocation receives an explicit allocation from its node (§7.6)
  before it starts.
- A node with `node_exit` Gate criteria reaches `succeeded` only through
  its Gate (§10): once the Pattern's candidate output is complete and
  integrated the runtime opens the Gate, runs the deterministic criteria
  first, invokes one read-only Evaluator for the evaluated ones, and
  settles the node on a pass; `evaluator_optimizer` consumes its criteria
  inside its rounds instead (§5.6).
- A Pattern's failure is the node's failure. The runtime retries at
  Invocation level (§7.2), never by re-running the whole node.

### 5.1 `single`

One Invocation of one Agent Definition revision. This is the default Pattern
and the only one the Orchestrator should choose unless the work has a shape
that one of the others describes exactly.

- Invocations: 1 (`worker`, purpose `step`; or `orchestrator` for the root node, §4.6)
- Pattern position: `single` (`orchestrator` for the root node)
- Input: the node's manifest, plus the Handoffs delivered along its incoming `sequence` edges
- Output: the Invocation's result Artifacts
- Fan-in: none
- Lifecycle: `ready → running` creates and prepares the Invocation;
  when its Attempt ends the runtime settles the node in one transaction —
  a `succeeded` Invocation integrates the node's Changeset (§9.2) and
  the node becomes `succeeded` with the result's output Artifacts — a node
  with Gate criteria stays `running` and its `node_exit` Gate judges those
  Artifacts on the integration Snapshot (§10) — (or
  `failed` with `result_failed`, or waits when the result is `blocked` on
  an open Decision); a `failed` Invocation fails the node with
  `invocation_failed`; a `blocked` Invocation leaves the node `running`
  until its `side_effect_approval` Decision resolves, when a successor
  Invocation at the same position continues it (§7.4).

### 5.2 `chain`

An ordered list of leaf steps, each one Invocation. Step `n+1` starts when
step `n` has returned; it receives the node's manifest plus a Handoff
pointing at step `n`'s output Artifacts.

- Invocations: one per step, sequential, all `worker` with purpose `step`
- Pattern position: `chain_step` with the step's `index` and the step `count`
- Input: node manifest; step `n>1` additionally receives a Handoff from step `n-1`
  (key `chain_step:<node>:<n-1>`) carrying that step's output Artifacts,
  and step 1 the Handoffs of the node's incoming `sequence` edges
- Output: the last step's result Artifacts (earlier steps' Artifacts remain readable by id)
- Fan-in: none
- Failure: a step that fails after its Attempts fails the node with the
  failure reason of that step; no later step starts
- Lifecycle: each step's Changeset is integrated (§9.2) before the next
  step is prepared, so step `n+1` starts from the Snapshot that includes
  step `n`; the current step is the position of the node's latest
  Invocation, read from rows, never from a counter

Composite stages are compiled out of the node (§4.4); a `chain` node only
ever holds leaf steps.

### 5.3 `route`

One selector chooses exactly one branch. The selector is either a
deterministic rule the runtime evaluates (a predicate over the manifest,
such as which files a Task touches or a Decision's answer) or a read-only
`evaluator` Invocation (purpose `select`) that returns a branch label. The
selection is recorded as an Evaluation on the node. A leaf branch runs as
one Invocation inside the node; a composite branch is a subgraph reached by
a `branch(label)` edge.

- Invocations: 0 or 1 selector (`evaluator`, `select`, position `route_selection`), then 1 inline branch (`worker`, `step`, position `route_branch { label }`) when the selected branch is a leaf
- Input: the node manifest with the node's incoming edge Handoffs; the branch additionally receives the selection Evaluation as its typed `route_selection` manifest input (`evaluationId`, `selectedLabel`)
- Output: the inline branch's result Artifacts, or nothing (`[]`) when the selected branch is composite (its subgraph's exits deliver)
- Fan-in: none
- Failure: a selector that yields no valid label fails the node with `route_selection_failed`; a failed inline branch fails the node like a `single`

**Selection ownership.** The selection is one canonical `route_selection`
Evaluation on the node (`subject: { kind: "route_selection",
selectedLabel }`, verdict `pass`, `planNodeId` the route node, no Gate, no
judged Artifact) — exactly one per route node, enforced by the Evaluation
store (a second selection is a conflict) and by a database unique index
over `evaluations(plan_node_id)` for `route_selection` subjects, so
repeated or concurrent settlement never records two. The Evaluation is
recorded in the same transaction that acts on it, and every later pass or
restart reads it back from rows: it is never inferred from a transcript,
Artifact, Handoff summary, Invocation order, or Event.

- `decision_answer` selector: the runner reads the exact referenced
  Decision (its Conversation and Run ownership checked). While it is open
  the node waits with reason `decision` and the Run waits when nothing else
  can proceed; no model is invoked and no Attempt is consumed. Once
  resolved, the chosen option is mapped through `labelsByOptionId` and the
  label validated against the shape's branch bindings; an unmapped option
  or a superseded Decision fails the node with `route_selection_failed`.
  The Evaluation's producer is `runtime`.
- `evaluator` selector: one read-only Evaluator Invocation (role
  `evaluator`, purpose `select`) whose Context Manifest carries the node's
  incoming Handoffs and the empty selector input the compiled shape
  authorizes. It returns the typed `routeSelection.selectedLabel` of the
  result contract (§6.3); the result validator admits a selection only
  from a `select` Invocation, only with a label the shape binds, and from
  no other Invocation, so an invalid label is an invalid result — retried
  within the Invocation's Attempts with the violation in the retry
  appendix — and no valid label after the permitted Attempts fails the
  node with `route_selection_failed`. The Evaluation's producer names the
  Evaluator Invocation and its Agent Definition revision. Evaluators are
  read-only by role policy and record no Changeset.
- Inline branch: the Worker Invocation is prepared with the Evaluation
  (its `route_selection` input), the node's incoming Handoffs, and only its
  own operation input; an approval successor continues at the same
  position with the selection re-delivered; its Changeset is integrated
  before the node settles; its result Artifacts are the node's output.
- Composite branch: the node succeeds with no fabricated output, the
  `branch(label)` Handoff to the selected branch's entry is created, and
  the readiness evaluator activates exactly that edge from the recorded
  fact (§4.3), skipping every inactive branch's subgraph. No inline
  Invocation is created, and no child is ever inferred to have been
  selected from having started.

### 5.4 `parallel`

A static, non-empty list of independent leaf items, each one Invocation,
run concurrently up to the node's `maxConcurrency`. The runtime collects
every item result into one index Artifact (the ordered list of item
results with their Artifact ids and outcomes) and optionally runs one
aggregation Invocation over that index inside the node. Composite items
never live in a `parallel` node; the compiler lifts them into subgraphs
that fan into a `join` node (§4.4).

- Invocations: one `worker` (`step`) per item at position `parallel_item { index, count }`, then 0 or 1 aggregation `worker` (`step`) at position `parallel_aggregation`
- Input: each item receives only its own operation input (`operationAt(shape, position)`) plus the node's incoming edge Handoffs; the aggregation receives the manifest plus the one `parallel_index` Handoff to the index Artifact
- Output: the aggregation's result Artifacts, or the index Artifact when there is no aggregation
- Fan-in: the runtime waits for every item to reach its required terminal state and for every successful writing Changeset to be integrated, then writes the index
- Failure: an item that fails after its Attempts (or returns a `failed` or `blocked` result) is recorded as failed in the index; `requireAll: true` (default) needs every item to succeed, `requireAll: false` at least one; otherwise the node fails with `parallel_items_failed`, the index recorded on the failure Event; a failed aggregation fails the node like a `single`

Items never see each other's results. A `parallel` node whose items are
not independent is a plan error; the Orchestrator should use `chain`.

**Scheduling.** Items may run concurrently subject to the Run's
`maxConcurrency`, the node's `maxConcurrency`, the governor's leases, and
the node's remaining allocation (an item that cannot be funded follows
`onAllocationExhausted`). The scheduler starts one further position per
iteration (`start_position`), so no single transaction creates every item
and the database's one-active-Invocation-per-position rule bounds
duplicates. An approval-blocked item continues through a successor
Invocation at the same position once its Decision resolves; the node
waits with reason `decision` only while a blocked item's Decision is open
and nothing else can proceed.

**Deterministic integration order.** Attempts finish in any order, but
writing Changesets are integrated in item-index order, never completion
order: an item's Changeset is integrated only once every lower-index item
is determined (terminal and integrated, or terminal without a Changeset),
so a later item whose Attempt finished first stays pending. A conflict
follows the ordinary lifecycle (§9.2) — the node waits with
`integration_conflict`; a second conflict or a failed or cancelled conflict
Task fails the node — and never lets another item's Changeset pass it.

**Index Artifact.** After every item is terminal and every successful
Changeset is integrated, exactly one **parallel index Artifact** is
created (media type `application/vnd.agentique.parallel-index.v1+json`,
schema `parallelIndexSchema` in `core/src/index-artifacts.ts`:
`{ version: 1, planNodeId, items: [{ index, invocationId, outcome,
outputArtifactIds, failure }] }` in item-index order, `outcome` one of
`succeeded | failed | cancelled`, `failure` the bounded classification
`{ kind: invocation_failed | result_failed | result_blocked,
invocationFailureReason }` for a failed item; canonical JSON; never a
transcript, provider message, prompt, worktree path, continuation, copied
Artifact content, or summary). The index is created in the same
transaction that consumes it — the node's success, the `parallel_index`
Handoff plus the aggregation Invocation, or the node's failure — so a
repeated pass or a restart never creates a second one. With an
aggregation, the Handoff carries the index by reference (never inlined
into narrative), the aggregation's Changeset is integrated before the node
settles, and its result Artifacts are the node's output.

### 5.5 `coordinator_worker`

One Coordinator role proposes Tasks; the runtime creates Worker Invocations
for them; a Coordinator synthesizes the results. The node is bounded and
the coordination depth is one by construction. The runner is
`server/src/execution/patterns/coordinator-worker.ts`; the Coordinator
proposes intent through the runtime-tool boundary (§6.4), and the runtime
owns every Task creation, dependency, readiness decision, allocation,
retry, integration, fan-in, wait, and progress fact.

Roles and what each may do:

- A **Coordinator Invocation** proposes Tasks through `propose_tasks`,
  cancels its node's unstarted Tasks through `update_task`, and returns
  through `return_result`. It does not revise the Execution Plan, does not
  create Invocations, and does not call, message, or address Workers. It
  never sees a Worker except as a `worker_result` Handoff the runtime
  delivers.
- The **runtime** validates every proposed Task (§5.5.1) atomically as a
  batch, reserves a Worker Invocation allocation for each from the node's
  allocation, persists them, projects readiness, and starts one Worker
  Invocation per runnable Task. It integrates Worker Changesets in
  canonical Task order, records each integrated result as a Handoff on the
  node, and decides when a new Coordinator turn is created.
- A **Worker Invocation** (purpose `task`) executes exactly one Task and
  returns a result. Its Context Manifest holds exactly its Task, that
  Task's Requirements (a subset of the node's pinned scope), and the
  Artifacts the Task lists as inputs. A Worker cannot propose or create
  Tasks, Workers, Coordinators, or Plan Nodes, cannot address any other
  Invocation, and has no runtime handler for `propose_tasks` however its
  Tool Policy reads.

**Coordinator turns.** The node has one Coordinator position,
`coordinator_turn`, and one Worker position per Task, `worker_task
{ taskId }`. A **logical Coordinator turn** is one Coordinator Invocation
plus every approval successor continued from it at the same position
(§6.1): a `side_effect_approval` successor continues the same turn,
consumes no unit of `maxCoordinatorInvocations`, and never duplicates its
predecessor's accepted proposal, because the runtime-tool call records of
the whole turn are the replay set (§6.4). Each turn has its own immutable
Context Manifest carrying a typed `coordinator_turn` input (purpose,
bounds, turns used, the node's Task ledger ordered by Task id, and the
sorted keys of the blockers the turn is asked to resolve). Turns are
created only on these occasions, and never more than one is active:

1. `decompose` — once, at node start, with the node's incoming edge
   Handoffs and the empty ledger. It must have exactly one accepted,
   non-empty proposal before its completed result advances the node; a
   completed turn with no accepted proposal fails the node with
   `coordinator_no_progress`. A `decompose` that returns `blocked` or
   `failed` waits or fails the node like any other Invocation.
2. `replan` — only when deterministic work cannot advance any Task: no
   Worker is active or runnable, no Changeset can be integrated, and the
   **blocker frontier** is non-empty. The frontier is projected from rows
   and holds every unresolved blocker: a `failed` Task that has not been
   replaced, a `blocked` Task (blocked by a Worker's `blocked` report, or
   by a `failed` or `cancelled` dependency), and an unresolved
   integration conflict of a Worker's Changeset (§9.2). The whole frontier
   is coalesced into one turn. The turn's manifest carries the
   `worker_result` Handoffs recorded since the previous turn and one
   `coordinator_blocker` input per blocker fact **not delivered to an
   earlier turn**; blockers delivered before are named only by key in
   `blockerKeys`. The Coordinator may propose replacement Tasks, cancel
   `pending`, `ready`, or `blocked` Tasks, or return `failed`. A replan
   must make canonical progress — an accepted proposal, an accepted
   cancellation, or a frontier that differs from the one it was given —
   otherwise the node fails with `coordinator_no_progress`. A blocker
   that resolves without a turn (a conflict Task completing) spends
   nothing.
3. `synthesize` — once, when every current Task is `completed` or
   `cancelled`, every completed Task's Changeset is integrated and its
   Handoff recorded, no conflict is open, and no Worker is active. Its
   manifest carries every `worker_result` Handoff not delivered to an
   earlier turn. Its result Artifacts, after its own Changeset is
   integrated, are the node's output.

Logical turns are bounded by `maxCoordinatorInvocations` (at least 2,
§4.4). When blockers remain, or synthesis is due, and no turn is left, the
node fails with `coordinator_invocations_exhausted`. Routine progress — a
Task completing, a Worker starting, a Changeset integrating, Usage
accruing — never creates a turn. Each turn records
`continuedFromInvocationId` pointing at the node's previous turn; its
initial Attempt may be `resumed` across that boundary under §6.6.

**Task set.** The node's Tasks are its **current** Tasks minus those a
replacement superseded. A replacement is a proposal naming
`replacesTaskId`: the replaced Task must be `failed` or `blocked` and
owned by the node; a `blocked` Task is cancelled by the replacement (its
reservation released) and a `failed` Task stays `failed` (never
reclassified); a Task is replaced at most once (database-enforced) and a
`completed` Task never; every dependent of the replaced Task gains the
replacement as a dependency, so the projection sees the replacement in
the replaced Task's place; and every proposed Task, superseded ones
included, counts toward the cumulative `maxTasks`.

**Readiness and Workers.** Task readiness is a pure projection
(`server/src/execution/task-projection.ts`) over the current Tasks and
dependency edges: Kahn's order over effective dependencies (creation order
breaks ties) is the **canonical Task order**; a `pending` Task whose
dependencies are all `completed` becomes `ready`, and one with a `failed`
or `cancelled` dependency becomes `blocked`. The runner starts one Worker
per runnable Task, in canonical order, one per scheduler iteration, at
most `maxConcurrentWorkers` active at once (independently of the Run's
`maxConcurrency` and the governor), and never while a Coordinator turn is
active. A Worker is funded by transferring its Task's reservation
(§7.6); the node's allocation is not reserved twice. A Task whose Worker
ends `waiting` on a Decision stays `running` with its Invocation
`blocked`; the resolved Decision produces an approval successor at the
same `worker_task` position, funded like any successor. A `running` Task
whose Worker has ended without a result (an Attempt-exhausted or
recovered Invocation) is failed or blocked from rows on the next
projection.

**Integration and fan-in.** A Worker's completed result is integrated in
canonical Task order — dependency order, then stable Task order, never
completion order — so a Task's Changeset waits until every earlier Task
in the order is determined (terminal or integrated). A result without a
Changeset needs no integration. Only an integrated result gets its
`worker_result:<node>:<task>` Handoff (§7.7), whose Artifacts are the
Task's output Artifacts; the Handoff is recorded once, by key, however
many passes reach it. A conflicting Changeset follows the ordinary
conflict lifecycle (§9.2): the conflict Task is created for the node,
the conflict joins the blocker frontier, and the Changeset is applied
once more when that Task completes; a cancelled or failed conflict Task
fails the node with `integration_conflict`. The Coordinator's own
Changesets (its Agent Definition may grant `write`) are integrated the
same way, before the node proceeds past the turn.

**Settlement.** The synthesis result's Artifacts become the node's
`outputArtifactIds` and the node succeeds; a node with Gate criteria stays
`running` while its `node_exit` Gate judges the integrated synthesis
(§10). The Coordinator remediates its own failed Gate: the Gate joins the
blocker frontier as `gate_failed` (its remediation Task and Gate ids), the
next consolidated `replan` turn receives that blocker together with the
Gate's typed `gate_result` facts, canonical progress on that turn marks
the remediation Task addressed, and the next `synthesize` turn's
integrated output is the next Gate's candidate (one logical synthesis per
Gate cycle); a replan without progress fails the node with
`coordinator_no_progress` as for any other blocker. A
failing node cancels its unstarted current Tasks and releases their
reservations; Tasks that ran keep their state. A node removed from the
membership settles its own turn and Workers and hands off to nobody.

- Invocations: `coordinator` Invocations with purposes `decompose`, `replan` (0..n), `synthesize` (one logical turn each, plus approval successors); N `worker` Invocations with purpose `task` (one per Task that ran)
- Input: a Coordinator turn receives the node manifest, its `coordinator_turn` input, the `worker_result` Handoffs since the previous turn, and (for `replan`) the new `coordinator_blocker` facts — a `gate_failed` blocker with the Gate's `gate_result` input; each Worker receives the manifest restricted to its Task
- Output: the `synthesize` turn's result Artifacts
- Fan-in: performed by the runtime as described above
- Bounds: `maxTasks` (cumulative, superseded Tasks included), `maxConcurrentWorkers`, and `maxCoordinatorInvocations` (logical turns); the node allocation caps total cost, tokens, and Attempts
- Failure: `coordinator_no_progress`, `coordinator_invocations_exhausted`, a turn returning `failed`, `integration_conflict`, or a node allocation exhausted under policy `fail`

Tasks proposed inside a `coordinator_worker` node are Tasks of the Run (they
appear in the ledger, reference Requirements, and carry Evidence) and are
tagged with the node id. They are internal execution records of the node:
they do not appear in the source Execution Plan and their existence never
changes a Plan Node, Plan Edge, or scope row.

#### 5.5.1 Task proposal validation

`propose_tasks` carries a batch of 1–64 proposals. Each proposal is
well-formed by schema: a batch-unique `key`, a bounded subject, Requirement
ids, input Artifact ids, dependencies on batch keys (`dependsOnKeys`) or
existing Task ids (`dependsOnTaskIds`), 1–20 unique required outputs, and
optionally `replacesTaskId`. The whole batch is validated **atomically**
by the Task proposal service (`server/src/execution/task-proposals.ts`)
against rows, inside the runtime-tool call's transaction; a rejected batch
persists nothing and is reported in the tool result with every failing
rule (closed rejection codes), and an accepted batch creates every Task,
its dependencies, and its reservation in that one transaction. The rules:

1. the caller is a `running` Coordinator Invocation of the node whose
   purpose permits proposals (`decompose`, `replan`; never `synthesize`
   — `purpose_not_permitted`) and the logical turn has no accepted
   proposal yet (`proposal_already_accepted`);
2. keys are unique within the batch (`duplicate_key`) and every
   `dependsOnKeys` entry names a batch key (`unknown_dependency_key`);
3. every `dependsOnTaskIds` and `replacesTaskId` entry names a Task of
   this node that is not superseded (`foreign_dependency`,
   `invalid_replacement`);
4. every Requirement id lies in the node's exact pinned scope
   (`plan_node_requirements`; `requirement_out_of_scope`) and is not
   `retired` at the current revision (`requirement_retired`);
5. every input Artifact exists (`unknown_artifact`) and belongs to the
   Run (`foreign_artifact`);
6. the replaced Task is `failed` or `blocked`, has not been replaced
   before, and is not `completed` (`invalid_replacement`);
7. the dependency graph over existing edges, the batch, and the edges
   implied by replacement stays acyclic (`dependency_cycle`);
8. the cumulative Task count of the node — every Task ever proposed,
   superseded ones included — stays within `maxTasks`
   (`max_tasks_exceeded`);
9. one Worker Invocation allocation per proposal can be reserved from the
   node's unconsumed, unreserved allocation (§7.6;
   `allocation_insufficient`).

Cancellation through `update_task` (`{ kind: "cancel" }`) is accepted
only for a `pending`, `ready`, or `blocked`, non-superseded Task of the
caller's node (`task_not_cancellable`); it releases the Task's reservation.

### 5.6 `evaluator_optimizer`

One producer and one Evaluator alternate in rounds until a round passes
or `maxRounds` is reached. In every round the runtime first runs the
node's deterministic Acceptance Criteria against the exact integration
Snapshot that holds the candidate; only when every deterministic criterion
passed is one read-only Evaluator invoked. The runner is
`server/src/execution/patterns/evaluator-optimizer.ts`; the deterministic
checks go through the Acceptance Criterion check service (§10.1).

- Invocations: per round, 1 producer `worker` (`step`, position `producer_round { round, maxRounds }`; inline form only), then the deterministic checks (no Invocation, no Usage, no lease), then 1 `evaluator` (`evaluate`, position `evaluator_round { round, maxRounds }`) unless a deterministic criterion failed
- Input: the round-1 producer receives the node's incoming edge Handoffs and its compiled input; producer round `r > 1` additionally receives the `optimizer_feedback:<node>:<r−1>` Handoff carrying the previous candidate's Artifact ids and the typed `optimizer_feedback` manifest input (the previous round's overall Evaluation id, round, verdict, and Evidence references); the Evaluator receives the candidate (the `optimizer_candidate:<node>:<r>` Handoff of an inline node, or the producer subgraph's edge Handoffs of an evaluate-only node), the typed `optimizer_candidate` input (round, `maxRounds`, judged Snapshot, exact candidate Artifact ids, and the evaluated Acceptance Criteria it must cover), the criteria themselves, and — for an inline round `r > 1` — the previous round's `optimizer_feedback`
- Output: the passing round's candidate Artifact ids; an evaluate-only node whose non-final round failed outputs the judged candidate for the retry edge (see below)
- Fan-in: none
- Bounds: `maxRounds` on the node (validated against `maxUnrolledRounds` at compile time)
- Failure: `optimizer_rounds_exhausted` when the final round's verdict is `fail` or `inconclusive` (the last verdict's Artifacts are the failure Event's diagnostic references); `invocation_failed` when a producer or Evaluator fails after its permitted Attempts (no verdict is manufactured); `result_failed`, `result_blocked`, `integration_conflict`, and `allocation_exhausted` as for every Pattern

**Round identity.** A round verdict is correctness-critical state and is
persisted as an Evaluation with an explicit, machine-readable
**context** (`core/src/verification.ts`):

```ts
type EvaluationContext =
  | { kind: "optimizer_criterion"; round; maxRounds }   // subject: acceptance_criterion
  | { kind: "optimizer_verdict";   round; maxRounds };  // subject: optimizer_round
```

Every optimizer Evaluation names its Run, its `evaluator_optimizer` Plan
Node, the round and `maxRounds` (validated against the node's immutable
shape; an evaluate-only node accepts only its fixed round), the judged
Snapshot (`snapshotId`), the judged candidate Artifact ids, its verdict
(`pass | fail | inconclusive`), its producer (`runtime` for a
deterministic check or a deterministically derived verdict; the Evaluator
Invocation and its Agent Definition revision otherwise), and its Evidence.
Nothing infers a round verdict from a node status, an Invocation summary,
a blocker, a transcript, a Handoff summary, an Artifact title, an Event, a
source path, or Invocation creation order. **Uniqueness:** at most one
`optimizer_criterion` Evaluation per node, round, and Acceptance Criterion,
and at most one `optimizer_verdict` per node and round — enforced by the
Evaluation store and by partial unique indexes over generated columns of
`evaluations` (`context_kind`, `context_round`, `subject_criterion_id`),
so repeated passes, restarts, and racing callers converge on one canonical
row. Evaluation rows stay append-only.

**Deterministic checks (fail-fast).** For one round, in order: the
producer's successful Changeset is integrated; the exact resulting
integration Snapshot is the round's judged Snapshot (recorded on every
Evaluation of the round and in the Evaluator's manifest); the node's
deterministic criteria are selected in stable Acceptance Criterion id
order; each command runs outside every database transaction against a
disposable, isolated view of that Snapshot (§10.1); its bounded output is
stored as a `text/plain` Artifact (runtime producer `command`) and its
Evaluation — verdict `pass` on the expected exit code, `fail` on any other,
Evidence `command` (with `outputTruncated` recorded canonically whenever
the stored output is a prefix) plus `snapshot` — is recorded in one
transaction; the first failure ends the round: no later command runs, the
Evaluator is not invoked, and the runtime records the round's
`optimizer_verdict` of `fail` (Evidence: the failing criterion Evaluation
and its command Evidence) in the same transaction. A criterion whose
Evaluation for this node and round already exists is never executed
again. A port failure (timeout, abort, a view that could not be created,
lost output) is an infrastructure failure: it records nothing, fabricates
no Evaluation, is returned typed (`verification_failed`), and a later pass
retries the check.

**Evaluator round.** When every deterministic criterion passed, the
Evaluator's completed result must carry the typed `evaluation` payload
(§6.3); the runner records one `optimizer_criterion` Evaluation per
reported evaluated criterion (producer: the Evaluator) and one
`optimizer_verdict` Evaluation with the overall verdict, in the transaction
that acts on it. An invalid Evaluator result is retried within the
Evaluator Invocation's Attempt allocation and creates no Evaluation; a
permanently failed Evaluator Invocation fails the node.

**Inline lifecycle** (`producer` set, `round: null`). `ready → running`
ensures the node's incoming edge Handoffs and prepares producer round 1.
When the producer completes, the runner integrates its Changeset (outside
any transaction), then asks for verification (the scheduler's
`verify_node` action), then prepares the Evaluator, then acts on the
recorded verdict: `pass` settles the node `succeeded` with the candidate
as its output and creates its edge Handoffs; `fail` or `inconclusive`
below `maxRounds` ensures the `optimizer_feedback` Handoff and prepares
producer round `r + 1` with `continuedFromInvocationId` pointing at the
round-`r` producer (a new Invocation, never a retry Attempt); at
`maxRounds` the node fails with `optimizer_rounds_exhausted`. Exactly one
producer or Evaluator position is active at a time; the current round is
the highest producer position that exists, read from rows. An
approval-blocked producer or Evaluator continues through a successor at
the same round position with the same typed optimizer inputs, consuming
no round. A producer that fails after its permitted Attempts fails the
node at once. Every round Invocation is funded from the node's allocation
under its `onAllocationExhausted` policy (`extend` remains a typed
deferral); the deterministic checks reserve nothing, record no Usage, and
hold no lease.

**Evaluate-only lifecycle** (`producer: null`, fixed `round`). The node
becomes ready when the unrolled producer subgraph's exits are terminal and
every producer Changeset is integrated (§4.3, §9.2). `ready → running`
ensures its incoming edge Handoffs; the candidate is the Artifact set
carried by the delivering `sequence` Handoffs in canonical incoming-edge
order (an inactive edge — a route's own sequence edge under a composite
selection, a skipped alternative — carries nothing); the judged Snapshot
is the Run's current integration Snapshot when verification begins. The
deterministic-then-Evaluator round then runs exactly as inline. The
recorded verdict is the readiness fact that activates the node's edges
(§4.3): on `pass` the node succeeds with the candidate as its output (its
`sequence` edges deliver, its `retry` edge is inactive, every later round
is skipped); on a non-final `fail` or `inconclusive` the node also ends
`succeeded` — **as a control node**, so that the typed `retry(r+1)` edge
can be consumed — with the judged candidate as its output, which the
`retry:<source>:<target>` Handoff carries to the next producer round's
entry together with the `optimizer_feedback` input the runtime derives
from the verdict; the candidate did not pass verification, the recorded
Evaluation says so, and nothing reads the node's success as candidate
acceptance. A final `fail` or `inconclusive` fails the node with
`optimizer_rounds_exhausted` and readies nothing. Evaluate-only Evaluators
judge each round independently: prior-round feedback reaches the next
producer subgraph, not the Evaluator.

**Gate boundary.** An `evaluator_optimizer` node's `gateAcceptanceCriterionIds`
are exactly the round criteria this contract verifies: the deterministic
ones by the runtime, the evaluated ones by the Evaluator, each once per
round on the exact judged Snapshot and candidate. A passing round
therefore settles the node `succeeded` without opening a separate
`node_exit` Gate row, and no criterion is evaluated twice. The Gate phase
reuses these Snapshot- and Artifact-bound Evaluations for a node whose
Gate would otherwise re-check the same criteria on the same Snapshot; it
never spends another Evaluator Invocation for an identical judgment. An
`evaluator_optimizer` node never has a `gates` row; every other Pattern's
`node_exit` Gate is opened and settled by the Gate engine (§10).

**Recovery.** Every step is derived from rows and safe to repeat: a
prepared position, an integrated Changeset, a recorded check, an existing
Handoff, a recorded verdict, or a settled node is found, never duplicated.
A crash after a command ran but before its record leaves only that command
to rerun (its stale isolated view is discarded by the port); a crash after
the Evaluator's result committed leaves only the Evaluations to record; a
crash after a verdict leaves only its consequence to apply, which the next
pass re-derives from the verdict row.

## 6. Invocations

### 6.1 Definition and creation

An Invocation is one logical execution of an Agent Definition revision
inside a `pattern` Plan Node: one role, one `purpose`, one immutable
Context Manifest, one allocation, and one typed result. New logical input
always creates a new Invocation; an Invocation's manifest never changes
after creation.

The runtime creates an Invocation when a Pattern calls for it (§5) or when
new logical input exists for a turn-driven role (§4.6, §5.5). Creation
records the Agent Definition revision, the role, the `purpose`, the Plan
Node, the Task ids, the allocation and its **allocation source** — the
Plan Node (`plan_node`, the default, reserved from the node per §7.6) or
the Run's final reserve (`run_final_reserve`, reserved directly from the
Run; permitted only for the `final_synthesis` Orchestrator Invocation and
the `run_completion` Gate's Evaluator Invocation, each recorded as the
Invocation's `finalReserveUse`, both on the root Plan Node, never with a
Task) — and
`continuedFromInvocationId` when the Invocation logically follows an
earlier one (the previous Orchestrator Invocation of the Run, the previous
Coordinator Invocation of the node, the previous producer round, or the
Invocation whose Decision was resolved). The runtime then assembles and
persists the Context Manifest and starts the initial Attempt.

Purposes by role:

| Role | Purposes |
|---|---|
| `orchestrator` | `operator_input`, `node_result`, `decision_resolution`, `gate_result`, `plan_revision`, `final_synthesis` |
| `coordinator` | `decompose`, `replan`, `synthesize` |
| `worker` | `step` (single, chain, parallel item, aggregation, producer), `task` (coordinator-worker Task) |
| `evaluator` | `select` (route selector), `evaluate` (evaluator-optimizer round, Gate evaluated criterion) |

Invocation status: `pending | running | waiting | blocked | succeeded |
failed | cancelled`. `waiting` is a pause after which the same Invocation
can still start or continue (capacity, Budget, operator; §7.4); `blocked`
is terminal: an `approval_required` capability call was intercepted, the
provider execution is over, the Invocation records the open
`side_effect_approval` Decision it is blocked on (`blockedByDecisionId`),
and the logical continuation is a successor Invocation with
`continuedFromInvocationId` set (§6.4). `blocked`, `succeeded`, `failed`,
and `cancelled` are terminal.
The `purpose` value set is closed: exactly the thirteen values in the table
above, enforced by the `InvocationPurpose` union in `core/src/invocations.ts`
and a database check constraint on `invocations.purpose`; each purpose is
valid for exactly one role.

A **Gate Evaluator Invocation** (role `evaluator`, purpose `evaluate`)
has no Pattern position and names its Gate in the immutable `gateId`; a
positioned Invocation names no Gate (database-enforced, as is the role).
It belongs to the Gate's Plan Node, executes exactly the Run's
verification-policy Evaluator revision, holds no Task, is read-only, is
funded from the node's allocation under the node's allocation policy —
or, for the `run_completion` Gate, from the Run's final reserve
(`finalReserveUse: run_completion`) on the root node — and is the one
active Evaluator of its Gate; it can be created only while the Gate is
open. An `evaluator_optimizer` round's Evaluator is positioned
(`evaluator_round`) and names no Gate. The one other Invocation that
names a Gate is the **final-synthesis Invocation** (role `orchestrator`,
purpose `final_synthesis`, §10): positioned at the root's `orchestrator`
position, it names the passed-in-verification `run_completion` Gate it
reports on in `gateId`, is funded from the final reserve
(`finalReserveUse: final_synthesis`), holds no Task, and is the one
active synthesis of its Gate (database-enforced).

### 6.2 Context Manifest

The manifest lists every input by id. The runtime renders it into the
Attempt's prompt in a fixed, documented layout; the rendering is a
projection, and the manifest is the record. It contains:

- Agent Definition revision id and content hash, and the instructions it
  carries
- Role, `purpose`, Pattern position (for example `chain step 2 of 3`), and
  `continuedFromInvocationId`
- Run id, Plan Node id, Task ids and their subjects
- Requirement ids and statements at the node's pinned revision for the
  Requirements in the node's scope (or, for the root node, the current
  revision), with their Acceptance Criteria
- Decision ids and answers for every Decision that references those
  Requirements or Tasks, and every Decision resolved since the
  `continuedFromInvocationId` Invocation's manifest
- Handoffs delivered to this Invocation, including the results of the
  `continuedFromInvocationId` Invocation and every queued input this
  Invocation was created for
- Artifact ids the Invocation may read (delivered Handoffs' Artifacts plus
  any the Orchestrator listed on the node)
- Starting Snapshot and the worktree path
- The allocation and limits for this Invocation
- The Tool Policy in force and the runtime tools available (§6.4)

An Invocation is told nothing else. There is no shared working state, no
narrative of what other agents are doing, no transcript of anyone else's
Attempt, and no provider continuation payload. The manifest is always
sufficient to start a `fresh` Attempt (§6.6).

**Assembly.** The Context Manifest assembler
(`server/src/execution/manifest/assembler.ts`) resolves every entry by
id from the canonical stores inside the preparation transaction (§6.1)
and validates ownership: a foreign, missing, retired, or unauthorized
object fails preparation and nothing is written. The manifest content
records, beyond the list above, the effective model policy, the
allocation source and final-reserve use, the effective capability set and
Tool Policy (§6.4), the role's runtime tools, the queued logical inputs
as typed entries (an operator message with its content; a Plan Node
outcome; a Decision resolution; a `gate_result`, validated against the
closed Gate's canonical facts (kind, node, cycle ordinal, verdict, pinned
Snapshot and candidate, failed criteria, Evaluations, remediation Task)
and delivered only to the root Orchestrator or to the gated node's
Coordinator; a `signoff_resolution`, validated against the canonical
Signoff Resolution of this Run (outcome `request_changes`, its closed
`operator_signoff` Gate failed `changes_requested` on the named
Decision, the operator-resolved Decision, the passed completion Gate,
the verified Snapshot, the final report, and the operator's message,
which must also be delivered as the ordinary `operator_message` input)
and delivered only to the root Orchestrator's `decision_resolution`
turn; a `gate_candidate`, validated to name the Invocation's own
open Gate, the Gate's pinned Snapshot and candidate, and exactly the
Gate's evaluated criteria; a plan-revision outcome; a
Publication result; a route selection, validated against the node's
canonical `route_selection` Evaluation; an `optimizer_candidate`,
validated to name the Invocation's `evaluator_round`, the node's exact
`maxRounds` and fixed round, a Snapshot of the Run's Workspace, Artifacts
of the Run carried by the delivered Handoffs, and exactly the node's
evaluated Gate criteria; an `optimizer_feedback`, validated to name a
`fail` or `inconclusive` `optimizer_verdict` Evaluation of this Run for
the round before the Invocation's — on the same inline node, or on the
evaluate-only node whose current-revision `retry(r+1)` edge enters this
node — whose Evidence the input restates exactly and whose judged
Artifacts the delivered feedback or retry Handoff carries exactly; a
historical or foreign Evaluation is refused), each delivered Handoff's routing metadata, and
bounded metadata (media type, size, title) of every readable Artifact;
Artifact content is never embedded and is read through `read_artifact`.
Every collection is in canonical order — Requirements in scope order,
everything else by id — so equal inputs assemble byte-identical content.
The root node's manifest carries the current Requirement revision; a
scoped node's carries exactly its pinned leaf Requirements, and a scoped
node whose pinned Requirement has since been retired cannot prepare a
further Invocation (the Orchestrator revises the plan).

**Rendering.** The renderer (`server/src/execution/manifest/renderer.ts`)
is a pure projection from the persisted manifest to the bytes the
provider receives: a documented field order (header, instructions,
inputs, Tasks, Requirements, Acceptance Criteria, Decisions, Handoffs,
Artifacts, capabilities, Tool Policy, runtime tools), compact technical
wording, no clock, no query, no path ordering, and byte-for-byte the same
text for the same manifest before and after a restart. The manifest row
records the renderer format version it was assembled for
(`rendererVersion`), so a retry after a restart renders under the
contract it was prepared with; this is a renderer version, not a
compatibility version. A retry Attempt receives the same text plus a
bounded appendix (§7.2).

### 6.3 Result

Every Attempt must end by returning a typed result through the runtime's
`return_result` tool. The result has:

- `status`: `completed | failed | blocked`
- `artifacts`: Artifact ids produced (the runtime has already stored them
  when the Invocation wrote them)
- `tasks`: Task id → `completed | blocked | failed`, with Evidence for each
  `completed` and a blocker for each `blocked`
- `evidence`: Evidence for the claims made
- `summary`: at most 500 characters
- `openItems`: at most 10 short strings
- `blocker`: for `blocked` only — the Decision id requested or a short
  statement of what must change
- `runOutcome`: Orchestrator only, optional — `infeasible` with Evidence,
  which is the Orchestrator's only path to a terminal Run failure (§3)
- `routeSelection`: route selector only (`select`) — the typed
  `{ selectedLabel }` of exactly one branch the node's shape binds; the
  only channel for a selection (never the summary, blocker, an open item,
  an Artifact, or transcript text), `null` for every other Invocation
- `evaluation`: Evaluator only (`evaluate`) — the typed
  `EvaluatorResult { verdict, criteria: [{ acceptanceCriterionId, verdict,
  evidence }], evidence }`: the overall verdict on the judged candidate,
  one verdict per evaluated Acceptance Criterion the runtime asked it to
  judge, and the Evidence of the overall verdict (per-criterion Evidence
  lives on the criterion entry, so nothing is duplicated); the only channel
  for a verdict, `null` for every other Invocation, and mutually exclusive
  with `routeSelection`

The runtime validates the result: every referenced id must exist and belong
to this Run; every `completed` Task must carry Evidence and its required
output Artifacts; a writing Invocation must have produced a Changeset
(possibly empty, stated as such); a completed `select` result names a
bound branch label and no other result names one; a completed `evaluate`
result carries an `evaluation` and no other result does. The Evaluator
payload is bound through the same validator: the reported criteria must be
exactly the evaluated criteria the immutable Context Manifest delivered
(the `optimizer_candidate` input's list for an optimizer round, otherwise
the manifest's evaluated criteria) — none missing, none duplicated, none
extra or foreign, and never a deterministic criterion, which the runtime
checks; every Evidence reference exists in the Run; the overall verdict
carries Evidence; an overall `pass` is invalid when any reported criterion
is `fail` or `inconclusive`; and an Evaluator never claims `command`
Evidence (the runtime records those), never reports Task state, never
returns `runOutcome` or `blocked`, and never records a Changeset. The
runtime supplies the subject, Plan Node, round, Snapshot, and judged
Artifact set through the manifest; the model cannot substitute them, and
an Evaluator cannot judge an Artifact it produced (refused by the
Evaluation store). An invalid Evaluator result follows ordinary Attempt
retry and creates no Evaluation. An Attempt that ends without a valid
result is a failed Attempt.

A Task reported `completed` in a valid result is transitioned to
`completed` by the runtime (§7.9). It does not change any Requirement's
status (§8.1).

Results are the only way an Invocation communicates. There is no message
tool, no peer addressing, and no channel to the operator except a Decision
request routed through the runtime (§8.2).

### 6.4 Tools and Tool Policy

An Invocation has two tool sets.

**Capability tools** (file read/write, shell, worktree, MCP servers) are
provider-native. Which of them an Attempt may use is the intersection of
the Agent Definition revision's declared capabilities, the role's policy
(Evaluators and selectors are read-only), and the Run's Workspace policy.
The console builds no capability tools. The intersection is computed once
per Invocation by `effectiveCapabilityPolicy` in the core package and
persisted in the Context Manifest: per declared tool, the revision's
disposition (default `allowed`) is narrowed — never widened — to `denied`
by a role that does not hold the tool or a Workspace that denies it, and
to `approval_required` by a Workspace that requires approval; the
effective capability set is every declared tool whose disposition is not
`denied`. The role policy is: the Orchestrator and a Worker may hold
every declared tool and MCP server; a Coordinator holds only the
coordination set (`read`, `search`, `write`) and no MCP server; an
Evaluator or route selector holds only the read-only tools (`read`,
`search`) and no MCP server. Every tool name outside the read-only set,
including any provider-specific name, is treated as write-capable, so a
read-only role never receives an unknown tool by accident and any
Invocation holding a write-capable tool runs in an isolated worktree and
produces a Changeset (§5, §9.1).

Each capability tool carries a **Tool Policy** disposition from the Agent
Definition revision: `allowed`, `denied`, or `approval_required`. An
`approval_required` tool call is intercepted at the provider boundary and
ends the provider execution with the exact proposed call in the
provider-neutral form (`ProposedToolCall`: the console's tool name and the
call's input as plain JSON). The runtime then finalizes the Attempt and
the interception in one transaction (§6.5): the Attempt ends `failed`
(`tool_failure`, retry refused `approval_required`, detail naming the tool
only); the call's **canonical bytes** — the canonical JSON of exactly
`{ "input": …, "tool": … }` with keys sorted at every depth and no
whitespace, bounded at 64 KiB — are stored as a content-addressed
Artifact of media type `application/x-tool-call+json`, whose SHA-256 is
the **call digest**; one open `side_effect_approval` Decision (§8.2) is
requested with policy `operator_required`, the two stable options
`approve_once` and `deny`, `affects` naming the Plan Node and the
Invocation's Tasks, and a typed **subject** (tool, call digest, call
Artifact id, originating Run, Plan Node, Invocation, and Attempt); the
Invocation ends `blocked` on that Decision with its reservation released;
its Tasks are `blocked` on the Decision; and its worktree cleanup
obligation is due (§9.1). Two calls are the same call if and only if their
canonical bytes are equal; a provider-specific display string is never
used for equality or enforcement, and a call beyond the bound is a tool
failure, never a truncated subject. The call bytes live only in the
Artifact: Events, failure details, diagnostics, manifests, and views carry
the digest, the Artifact id, and safe metadata.

When the Decision is resolved the runtime creates the successor Invocation
(purpose `decision_resolution` for the Orchestrator; the same purpose as
the blocked Invocation otherwise) with `continuedFromInvocationId` set to
the blocked Invocation and the resolution as typed logical input
(`side_effect_approval_resolution`: Decision, blocked Invocation, Attempt,
tool, digest, Artifact, outcome), validated against the canonical
Decision. An `approve_once` resolution becomes one **approval grant** in
the successor's manifest `approvedCalls` (Decision, tool, digest); a
`deny` resolution is input and nothing more. **Approval authorizes only
the exact tool and canonical call digest, at most once across the entire
Run.** It changes neither the Agent Definition nor the effective Tool
Policy (the tool stays `approval_required`), it authorizes no later or
different call, and its enforcement belongs to the runtime — never to the
adapter's memory and never to the model.

Three things are distinct here. The **approval grant** is immutable
input delivered to an Invocation: it says the call *may* be claimed, and
because the manifest is immutable every Attempt of that Invocation
receives the same grant list; it is eligibility, never evidence that the
call remains unused. The **approval claim** (or **use**) is the canonical
append-only record (`approved_tool_call_uses`: Decision, tool, digest,
Run, Plan Node, successor Invocation, claiming Attempt, claim time) that
consumes the grant; the database allows one use per Decision and
re-checks every ownership fact at insertion, so competing claimants have
exactly one committed winner without any process lock. **External
execution** is what the provider-native tool does after the claim; it
cannot be made atomic with the claim. The runtime-owned authorization
boundary (`server/src/execution/tool-call-authorization.ts`, the
`ToolCallAuthorizationPort` of the adapter contract) is bound to the
Attempt being executed and answers one closed outcome per proposed call:
`allowed` (Tool Policy `allowed`; no claim involved), `denied` (Tool
Policy `denied`, or an undeclared tool), `approved_once` (an exact
matching grant was claimed and committed), `approval_required` (the tool
requires approval and no matching unconsumed grant exists — a refused
claim, a used grant, or no grant at all), `invalid` (malformed or beyond
the canonical bound; nothing recorded), and `failed` (the claim
transaction failed; nothing persisted, nothing authorized, one bounded
diagnostic). The algorithm is: the adapter proposes the exact
`ProposedToolCall`; the runtime validates and canonicalizes it and
evaluates the effective Tool Policy; for an `approval_required` tool it
looks the digest up among the manifest's grants and, when one matches,
claims that Decision in its own short root transaction while the
provider is running — the use row and its `approved_tool_call.used`
Event commit, then and only then the adapter learns `approved_once` and
may execute the call. The adapter must consult the port before executing
every provider-native capability call, executes only on `allowed` or
`approved_once`, ends the execution with the typed `approval_required`
completion otherwise, never queries a canonical store, and keeps no
approval-consumption state; a fresh or restarted adapter therefore
cannot repeat a consumed call.

The claim is never rolled back because the provider later fails, the
Attempt is retried, finalization fails, or the process crashes, and the
same Decision can never be claimed again: a retry receives the unchanged
manifest but its claim is refused, and if the call must be attempted
again it is intercepted again and a new `side_effect_approval` Decision
is opened. This is **at-most-once authorization**, not exactly-once
execution: a crash after the claim and before the external call
conservatively consumes the approval and requires a new operator
approval, and a crash after the external call but before the Attempt is
finalized leaves the call executed once with its use recorded. Exactly-once
execution of the external effect is possible only when the underlying
tool supports its own idempotency mechanism. A consumed grant is never
delivered again: the manifest assembler refuses a
`side_effect_approval_resolution` input whose Decision already has a
use. Built-in definitions mark destructive shell operations, network
access outside declared MCP servers, and any operation on a path outside
the worktree as `approval_required` or `denied`. Tool Policy, capability
policy, worktree isolation, side-effect approval, and Gates are the safety
mechanisms; there is no trust flag.

**Runtime tools** are the same for every role, restricted by role:

| Tool | orchestrator | coordinator | worker | evaluator |
|---|---|---|---|---|
| `read_requirements`, `read_decisions`, `read_tasks`, `read_artifact`, `read_execution_plan`, `read_agent_definitions` | yes | yes | yes | yes |
| `write_artifact` | yes | yes | yes | yes |
| `update_task` (Evidence, output Artifacts on own Tasks) | yes | own node | own Task | no |
| `create_tasks` | yes | no | no | no |
| `propose_tasks` | no | own node | no | no |
| `request_decision` (any kind except `orchestrator_choice` and `budget_increase`; `requirement_waiver` is always `operator_required`) | yes | yes | yes | no |
| `record_decision` (kind `orchestrator_choice` only; cannot resolve any other kind) | yes | no | no | no |
| `propose_requirements` | yes | no | no | no |
| `revise_execution_plan` (source form only; validated and compiled by the runtime) | yes | no | no | no |
| `request_completion` | yes | no | no | no |
| `return_result` | yes | yes | yes | yes |

No tool lets an agent see another Invocation's transcript, send a message
to another agent, alter scheduling, write compiled plan structure, or
resolve a Decision of any kind other than `orchestrator_choice`. In
particular `record_decision` cannot create or resolve a
`requirement_waiver`; the Orchestrator proposes a waiver only through
`request_decision`, and only the operator resolves it (§8.2).

**Runtime-tool calls.** Four sets are distinct and never conflated:

1. the runtime tools the **role** permits (the table above, computed by
   `runtimeToolsFor(role, purpose)` in core and recorded in the
   manifest);
2. the tools the **manifest** permits (the role's set, restricted by
   purpose — a `synthesize` turn has neither `propose_tasks` nor
   `update_task`; a `final_synthesis` turn has no mutating runtime tool
   at all);
3. the tools the runtime **can execute** in this phase — the handler
   bindings in `core/src/runtime-tools.ts`: `propose_tasks` and the
   cancelling `update_task`, for a Coordinator with purpose `decompose`
   or `replan`; and `request_completion`, for the root Orchestrator's
   ordinary turns (every Orchestrator purpose but `final_synthesis`) and
   for no other role, node, or purpose; and
4. the **effective callable set** exposed to a provider execution: the
   intersection of the manifest's tools, the runtime handlers, and the
   validity of the caller's role and purpose. A tool that is permitted
   but not executable (`request_decision`, every read tool, a Worker's
   `update_task`) is not exposed as callable.

The Attempt executor binds one `RuntimeToolCallPort` (`tools`, `call`)
per Attempt, fixed to that Attempt, Invocation, manifest, role, purpose,
Run, and Plan Node; the adapter receives the port and nothing else. A
call is a closed discriminated request (`propose_tasks`, `update_task`,
`request_completion`),
parsed strictly, canonicalized (sorted-key JSON of `{ tool, input }`),
bounded at 65,536 bytes, and digested; its outcome is a closed union —
`accepted` (call id, digest, `replayed`, the tool's typed result),
`rejected` (closed rejection codes), `not_callable`, or `failed`. The
runtime-tool executor (`server/src/execution/runtime-tools.ts`) performs
each mutating call in its own short root transaction, outside provider
execution and never nested: it re-checks that the caller's Attempt and
Invocation are `running`, replays an identical call already committed
by the same **logical turn** (the Invocation plus its approval
predecessors) by digest, otherwise runs the handler and appends one
`runtime_tool_calls` row — id (`rtc_`), Run, Plan Node, Invocation, the
first committing Attempt, tool, digest, the safe result, and the commit
time — with one `runtime_tool_call.committed` Event. The row set is
unique per Invocation, tool, and digest, and holds at most one accepted
`propose_tasks` per Invocation; rejected calls write nothing; rows are
append-only (database triggers). Retries and approval successors
therefore never duplicate an accepted proposal, and the raw call input
never appears in an Event, diagnostic, or manifest. Decisions are not
touched by the runtime-tool executor: `request_decision` remains
permitted by role and not executable in this phase.

**`request_completion`.** The root Orchestrator's running ordinary turn
(the root Plan Node, a running Invocation of any Orchestrator purpose but
`final_synthesis`, on a `running` Run) calls it with an empty input to
ask the runtime to verify the Run; no Worker, Coordinator, Evaluator,
final-synthesis turn, or non-root caller can (`caller_not_permitted`,
nothing written). The handler runs the **completion preflight** inside
the call's transaction and rejects with the closed codes, creating
nothing, when: another Completion Request is active
(`completion_request_active`); the Run is not running
(`run_not_running`); a current non-root node is pending, ready, running,
or waiting (`node_active`) or failed without a canonical resolution
(`node_failed`); a Changeset is pending or in conflict
(`changeset_unintegrated`); a `node_exit` Gate is open (`gate_open`) or
its remediation unresolved (`gate_remediation_unresolved`); another
Invocation is active (`invocation_active`); a current Task is not
completed or cancelled and has no valid replacement (`task_unfinished`);
an `operator_required` Decision is unresolved (`decision_unresolved`);
the Run has no integration Snapshot (`no_integration_snapshot`); a
coding Run's criterion set holds no deterministic criterion
(`no_deterministic_completion_criterion`); an evaluated criterion exists
without a Gate Evaluator (`evaluator_unavailable`); the final reserve
cannot fund the Evaluator (when needed) and the synthesis
(`final_reserve_insufficient`); or the Run's `run_completion` cycles are
exhausted (`run_completion_cycles_exhausted`). An accepted call records
the one `runtime_tool_calls` row and creates exactly one **Completion
Request** (`completion_requests`, id `crq_`) in status `requested`,
naming the Run, the requesting Invocation, and the accepted call; the
call's typed result is the request id, so a retry or approval successor
of the same logical turn replays the same request and a concurrent
duplicate commits one row. The request's lifecycle is closed —
`requested → verifying → passed | failed`, `requested → cancelled` —
with one Event per transition; at most one non-terminal request exists
per Run (database-enforced); rows are never deleted and their identity
never changes; a later attempt at completion is a new request; nothing
infers a request from Events. The Run stays `running` while the
requesting turn is active; the scheduler begins the request only after
the turn completed and its Changeset integrated (§7.1, §10), and a
requesting turn that failed, was cancelled, or ended without completing
cancels the request (`requesting_turn_failed`) before anything else
happens to the Run.

### 6.5 Attempts

An Attempt is one provider execution of an Invocation from start to a
terminal result or failure. Every Attempt records:

- `kind`: `initial` (the Invocation's first Attempt) or `retry` (a later
  Attempt after a retryable failure, §7.2)
- `startMode`: `fresh` (started from the Context Manifest) or `resumed`
  (continued provider execution from `resumedFromAttemptId`)
- `resumedFromAttemptId`: nullable; the Attempt whose provider execution
  this one continued — a prior Attempt of the same Invocation, or the last
  Attempt of the Invocation named by `continuedFromInvocationId`
- its transcript Artifact, Usage rows, failure classification, and result

There is no other Attempt kind. New logical input never produces an
Attempt; it produces a new Invocation (§6.1).

Attempt status is `pending | running | succeeded | failed | timed_out |
interrupted | cancelled`. Every status other than `pending` and `running`
is terminal. Once an Attempt is created it has consumed one Attempt from
its Invocation's allocation, whatever its outcome: an `interrupted`
Attempt (§14, server restart or wall-clock limit) keeps its consumed
Attempt, and the retry that follows it is a new Attempt that consumes
another. A `pending` Attempt whose process ended before the provider was
reached is likewise `interrupted` by recovery and never becomes `running`
retroactively. Recovery therefore never yields unlimited free retries;
when no Attempt allocation remains the Invocation is `failed` with reason
`allocation_exhausted`.

A terminal Attempt that did not succeed also records, in the same
transition, a bounded **failure detail** (a sanitized single-line
message, the exact result-validation violations for `result_invalid`,
the capability tool concerned, and whether the interruption was a
cancellation — never a transcript, raw provider message, complete tool
output, stack trace, or secret) and its durable **retry decision**
(§7.2): whether another Attempt is permitted, the closed reason, and the
earliest time. A restart reads these back verbatim instead of
recomputing them from process configuration. Every Attempt is executed
by the Attempt executor (`server/src/execution/attempt-executor.ts`)
through a provider-neutral adapter (`server/src/provider/adapter.ts`)
that receives one execution request — Attempt and Invocation ids, model
and effort, the deterministic rendered input, the effective capability
and Tool Policy, the runtime-owned tool-call authorization port bound to
this Attempt (§6.4), the working directory, the wall-clock deadline, a
cancellation signal, an optional verified continuation payload, and a
transient-output sink — and returns one typed outcome: a closed
completion (completed, transient or permanent provider error, tool
failure, approval required, interrupted with its cause), the candidate
result, Usage chunks, bounded transcript bytes, an optional opaque
continuation payload, timing, and safe diagnostics. The adapter holds no
canonical state, makes no scheduling, retry, or transition decision,
never treats an `approval_required` disposition as `allowed`, and never
decides for itself whether a call may run: every provider-native
capability call goes through the authorization port first.

The executor's transaction boundaries are fixed. *Prepare* (one
transaction) verifies the Invocation and its manifest, the remaining
Attempt, cost, and token allocation, and the previous Attempt's retry
decision, selects a fresh or resumed start, checks the governor before
creating anything, then creates the Attempt with its lease and starts it;
a capacity refusal creates no Attempt and consumes nothing. *Execute*
(no transaction) renders the manifest, calls the provider under
cancellation and the Invocation-wide wall-clock deadline that the
caller's clock enforces, streams transient output, collects a writing
Invocation's Changeset through the execution-workspace port, and stores
any continuation payload; each approval claim the provider requests
during this step commits in its own short transaction (§6.4) that
contains no external execution. *Finalize* (one transaction) stores the
transcript Artifact, records every Usage row, records the Changeset,
validates the candidate result, transitions the Attempt with its failure
detail and retry decision, releases the lease exactly once, records an
intercepted call's Artifact and Decision (§6.4), and settles the
Invocation and its Tasks only when no retry remains — which releases the
Invocation's reservation; the worktree release then follows the commit
under the §9.1 ordering. Usage is therefore always recorded before the
Invocation becomes terminal, and a finalization that fails is retried on
the next call without repeating the provider call. The in-memory record
of an executing Attempt is published only after the prepare transaction
has committed: a callback failure, a rollback-only root, or a failed
COMMIT leaves no such record, so the provider is never called for an
Attempt that does not exist. Every executor operation is safe to repeat:
it never creates a duplicate Attempt, lease, Usage row, or terminal Event.

### 6.6 Provider resumption

Correctness never depends on provider state. The Context Manifest and the
canonical Run state are always sufficient to start a `fresh` Attempt, and
the runtime never waits on, reads, or reconstructs anything from a provider
session to decide what to do next.

An Attempt may start `resumed` only when all of the following hold:

- the provider adapter reports that the provider supports continuation;
- the adapter determines continuation is safe for this Attempt: the prior
  Attempt ended in a state the provider can continue from, the same Agent
  Definition revision and Tool Policy apply, and the new Invocation's
  manifest differs from the prior one only by the inputs it was created to
  receive (continuation across an Invocation boundary is permitted on
  exactly these terms);
- a `provider_continuations` index row exists for `resumedFromAttemptId`,
  is not expired, and the payload it points to is present and matches its
  digest;
- the projected context size and cost stay within the Invocation's
  allocation and the Agent Definition's context policy.

Otherwise the Attempt starts `fresh` from the manifest. Resumption is an
optimization that saves re-reading the manifest; a `fresh` start is always
correct. The adapter reports whether it supports continuation; the
runtime's continuation policy
(`server/src/execution/continuation-policy.ts`) decides the candidate
from canonical facts alone at Attempt start — a prior Attempt of the
same Invocation, or the last Attempt of the `continuedFromInvocationId`
Invocation whose manifest agrees with the new one on everything that is
not new logical input (the definition revision, hash, instructions, and
model policy; the role, Plan Node, and Run; the effective capabilities,
Tool Policy, and runtime tools; the funding), the prior Attempt having
succeeded, returned an invalid result, or been interrupted or hit a
transient provider error without being cancelled, with an unexpired
index row and a last prompt that fits the context policy and the
remaining token allocation — and the executor resolves and verifies the
payload outside any transaction. The decision is recorded only as the
Attempt's `startMode` and `resumedFromAttemptId`; nothing else in the
runtime branches on it. There is no rotation, no generation counter, no
checkpoint reconstruction, and no continuation document.

Continuation storage is pointer-based. `provider_continuations` is an index
row per Attempt: Attempt id, provider, storage key, digest, creation time,
optional expiry time. The provider adapter owns a replaceable continuation
payload store (interface `ContinuationPayloadStore` in
`server/src/provider/continuation-store.ts`; the index rows are written
through `server/src/persistence/`) and the storage key points to the
opaque payload there. Payloads are not Artifacts, are not in
Context Manifests, are never read by projections or scheduler decisions,
may be deleted at any time, and never appear in Events, logs, or API
responses. A missing, expired, or digest-mismatched payload yields a
`fresh` Attempt.

## 7. Runtime responsibilities

The runtime owns all of the following. No agent is asked to do any of it,
and no agent can.

### 7.1 Scheduling

The scheduler (`server/src/execution/scheduler.ts`) is a deterministic
runtime component with two entry points and no timer, loop, or interval:

- `reconcileRun(runId)` is a read-only projection. From canonical rows
  alone — the current accepted revision and membership, node statuses and
  wait reasons, Pattern positions, Invocations and Attempts, retry
  decisions, Handoffs, Changesets and their integration status, Decisions,
  reservations, and leases — it returns the ordered list of typed
  **actions** that are canonical next (`resume_run`, `ready_node`,
  `skip_node`, `start_node`, `start_position`, `execute_invocation`,
  `verify_node`, `settle_node`, `settle_join`, `settle_removed_node`,
  `resume_node`, `wait_node`, `settle_root`, `wait_run`), the nodes that
  are waiting and why, the work deferred to a later phase, the ready nodes held back by
  the Run's `maxConcurrency`, the Invocations executing in this process,
  and the earliest resumption time (retry `notBefore`, provider
  `retryAfter`, or an Invocation deadline). Readiness is evaluated over
  the current graph plus the condition facts projected from rows (§4.3).
  One action is projected per node per iteration, in membership order; the
  root node is settled first. `start_position` is the one further
  position a running `parallel` or `coordinator_worker` node may prepare
  now (a further item or runnable Task's Worker, the successor of a
  blocked position whose Decision resolved, or the next Coordinator turn
  with its purpose), subject to the same Run and node concurrency limits
  as `start_node`; `verify_node` runs an `evaluator_optimizer` round's
  pending deterministic Acceptance Criteria (§5.6, §10.1) — external like a
  Changeset application, outside every transaction, recorded afterwards;
  `settle_join` is the deterministic settlement of a `ready` join (§4.2);
  `open_node_gate`, `run_gate_checks` (external, outside every
  transaction), `prepare_gate_evaluator` (subject to the Run and node
  concurrency limits like any Invocation), and `settle_node_gate` are the
  `node_exit` Gate phase of a node whose candidate is complete and
  integrated (§10); `prepare_gate_remediation` and
  `settle_gate_remediation` are the root Orchestrator's batched
  remediation of failed non-Coordinator Gates, the former projected only
  when no other action, in-flight Attempt, or concurrency-limited node
  remains, so every Gate that fails in a pass joins the same turn. The
  projection lists nodes whose failed Gate awaits the root under
  `remediating`; no Gate work is ever deferred to a later phase.
  Run completion (§10) is the same scheduler's work, under the same
  bound, with typed actions the completion engine
  (`server/src/execution/completion.ts`) performs: on a `running` Run,
  `begin_run_completion` (the accepted request's turn has settled and
  integrated; projected only when the root is idle and nothing is in
  flight) and `complete_run_verification` (a failed cycle's or a
  cancelled request's consequence); on a `verifying` Run — where no
  ordinary Pattern work, settlement, or `wait_run` is projected — exactly
  one of `run_completion_checks` (external, outside every transaction),
  `prepare_run_completion_evaluator`, `execute_invocation` of the
  Evaluator or synthesis (subject to the Run's concurrency limit and the
  governor), `settle_run_completion_evaluator`,
  `derive_requirement_statuses`, `prepare_final_synthesis`,
  `settle_final_synthesis`, or `complete_run_verification`, plus the
  waits of a blocked or retrying completion Invocation; on an
  `awaiting_signoff` Run nothing at all. Every one of them revalidates the
  request, Gate, Invocation, and Run rows inside its transaction, so a
  repeated or stale projection changes nothing. The projection reports
  the engine's advice under `completion`. Operator signoff (§10
  `operator_signoff`) is externally triggered, never a scheduler
  decision: after `accept` the projection reports `run_terminal` and
  performs nothing; after `request_changes` the Run is `running` again
  and the prepared follow-up turn executes and settles through the
  ordinary root path. No polling, timer, or second scheduler exists.
  For an `evaluator_optimizer` node the projection distinguishes, from rows
  alone: producer position ready (`start_node` / `settle_node` preparing
  the next round), producer Attempt active (`execute_invocation` or an
  in-flight or timed wait), deterministic checks pending (`verify_node`),
  Evaluator position ready (`settle_node` preparing it), Evaluator Attempt
  active, round verdict recorded (`settle_node` applying it), retry edge
  active (`ready_node` of the next producer round), final pass and rounds
  exhausted (terminal), and the Gate phase (which this Pattern never
  enters, §5.6).
- `advanceRun(runId, { maxActions })` is a bounded pass. It performs the
  projected actions one at a time, re-projecting the current graph before
  every state-changing action; every mutation runs inside a Pattern
  runner transaction that revalidates the revision, membership, node
  status, and active Invocation, so a stale projection changes nothing
  (`stale`, `no_change`). Provider executions run outside every
  transaction; independent Attempts execute concurrently within one pass
  up to the Run's `maxConcurrency` and the governor's leases (§7.8), and
  the pass waits only when no other action can proceed, until the first
  executing Attempt ends — that completion is what re-triggers projection
  while the others keep running. The pass stops with
  a closed reason: `quiescent` (nothing to do), `waiting` (the Run
  waits, an Attempt is still in flight, or a resumption time is pending),
  `action_limit`, `run_terminal`, `unsupported` (only later-phase work
  remains), or `infrastructure_failure` (a store or port threw; the
  bounded message is returned and the next pass resumes from rows).
  Concurrent calls for one Run share one pass in-process; canonical
  database constraints (one active Invocation per position, one Handoff
  per key, one active Attempt per Invocation) remain the source of
  correctness across processes.
- Node readiness is computed from Plan Edges, the explicit condition
  facts, and allocation as defined in §4.3. Within a node, the Pattern
  runner (`patterns/`) decides Invocation
  order (§5); an Invocation starts only after its allocation is reserved
  (§7.6) and executes only under a lease. A node whose allocation cannot
  be reserved follows its `onAllocationExhausted` policy: `fail` fails it
  with `allocation_exhausted`, `wait` waits it with `budget`, and
  `extend` has the runtime create exactly the minimal Allocation Extension
  from the Run's effective ordinary capacity in the transaction that
  creates the work — or, when no such extension fits, waits it with
  `budget` (§7.6). The root node never transitions: an unfunded root turn
  or remediation turn is what makes the Run `waiting`/`budget`, and the
  next pass after an approved Budget Increase funds and creates it through
  the ordinary transitions; no timer, poll, or second scheduler exists.
- A node removed from the membership while running settles its own work
  (`settle_removed_node`) but hands off to nobody and readies nothing.
- Deadlines are enforced from the caller's clock at the start of each
  iteration; the scheduler holds no clock of its own and never sleeps.
- Routine progress creates no conversational message and no status update
  of any kind; a Run whose root node's turn fails is `failed` with
  `root_node_failed`.

### 7.2 Retries

- An Invocation has a maximum Attempt count from its allocation (default 2:
  the `initial` Attempt plus one `retry`).
- The runtime classifies each Attempt failure: `provider_transient`
  (retry after backoff), `provider_permanent` (no retry), `result_invalid`
  (retry with the validation error in the manifest rendering, the manifest
  itself unchanged), `allocation_exhausted` (no retry), `interrupted`
  (retry only if the interruption was not a cancellation), `tool_failure`
  (retry once).
- A retry is a new Attempt of `kind: retry`, started `fresh` or `resumed`
  under §6.6. The failed Attempt's transcript Artifact remains. When the
  permitted Attempts are exhausted the Invocation is `failed`.
- The decision is deterministic and durable
  (`server/src/execution/retry-policy.ts`): backoff is `base × 2^(n−1)`
  capped, from an injected clock and without randomness; a tool failure
  is retried once (a second consecutive tool failure refuses with
  `tool_failure_retried`); an interruption caused by cancellation refuses
  with `cancelled`; a transient failure, invalid result, or interruption
  whose Usage has already exhausted the cost or token allocation is
  classified `allocation_exhausted` and refused; an `approval_required`
  capability call ends the Attempt `failed` (`tool_failure`) with the
  refusal reason `approval_required` and ends the Invocation `blocked` on
  the `side_effect_approval` Decision created in the same transaction
  (§6.4) — no approval is invented, no provider process waits, and the
  continuation is a successor Invocation. The decision is persisted on the Attempt with
  its exact `retryNotBefore`, and the Invocation's next Attempt is
  permitted only when that time has passed and the Invocation-wide
  deadline (§7.6) has not; a deadline timeout, a passed deadline, or a
  backoff ending at or after the deadline refuses with
  `wall_clock_exhausted`. A refused retry ends the Invocation:
  `provider_permanent`, `allocation_exhausted` (cost, tokens, Attempts,
  or wall clock exhausted, including after an interruption),
  `result_invalid` when the last Attempt's result was invalid,
  `attempts_exhausted` after a repeated tool failure, `cancelled` on
  cancellation; a `task` Invocation's Task fails with the corresponding
  reason. The retry
  Attempt is rendered from the unchanged manifest plus a bounded appendix
  carrying only the prior Attempt id, failure class, sanitized detail,
  exact violations, and the ordinal and remaining Attempts.

### 7.3 Dependencies

- Plan Edges are the only cross-node ordering mechanism.
- Task dependencies order Worker Invocation creation and Changeset
  integration inside a `coordinator_worker` node (§5.5, §7.9) and are
  otherwise informational. A replacement Task inherits every dependent
  of the Task it replaces.
- Cycles are rejected at compile time and at Task proposal time.

### 7.4 Waiting

A node or Invocation waits when it has requested an `operator_required`
Decision that is unanswered, when its allocation is exhausted under policy
`wait` or `extend` with no capacity available, when the resource governor
has no lease to grant, when its Changeset conflicted on integration and
the conflict Task is open (`integration_conflict`, §9.2), or when the
operator has paused the Run. Waiting is
a recorded state with a recorded reason. An Invocation `waiting` before
its provider execution started (capacity, Budget, operator) is the same
Invocation once the wait clears. An Invocation whose provider execution
ended on an intercepted `approval_required` call is not waiting: it is
terminal, `blocked` on its `side_effect_approval` Decision (§6.1, §6.4),
and when the Decision is resolved the runtime creates a new Invocation
with `continuedFromInvocationId` set and the resolution in its manifest
(its initial Attempt `resumed` if §6.6 allows, otherwise `fresh`).
Nothing waits by polling, and nothing waits inside a provider process.

### 7.5 Progress

Progress is derived, never reported by an agent:

- Node progress: the count of Invocations by status and, for
  `coordinator_worker`, the count of Tasks by status.
- Run progress: the count of Plan Nodes by status, the count of Tasks by
  status, the count of Requirements by status, and Budget consumed versus
  reserved versus unreserved.
- Every derivation is a query over canonical stores and is recomputed on
  read.

The UI shows these counts and the plan graph. There is no "status update"
message type.

### 7.6 Budgets, allocations, and reservations

**Run Budget.** The Run Budget is the global cap and allocation pool for
the entire Run: limits for cost, tokens, wall-clock duration, Attempts, and
concurrent Invocations, stored on the Run. All Usage from every Plan Node,
Invocation, and Attempt counts against it. The stored limits are the
**base Budget**, immutable for the Run's life; the Run's **effective**
limits are derived on every read from the base Budget plus the Run's
approved Budget Increases (below), never stored as an aggregate and never
written back to the Run row:

```
effective global limit        = base limit + Σ added of all Budget Increases
effective final-reserve limit = base final reserve + Σ added of `final_reserve` Budget Increases
effective ordinary limit      = effective global limit − effective final-reserve limit
```

Wall-clock duration and concurrency are limits, not reserved quantities,
and no Budget Increase or Allocation Extension changes them.

**Reservations.** Allocation is accounted with canonical
`budget_reservations` rows, never inferred from limits and Usage. A
reservation identifies the parent bounded object (Run, Plan Node, or
Invocation), the child bounded object or proposed work item (Plan Node,
Invocation, or Task), the reserved cost, tokens, and Attempts, the creation
time, the release time, and the status (`active`, `released`). Wall-clock
deadlines and concurrency ceilings are limits enforced by the runtime and
the resource governor; they are not reserved quantities.

- Unreserved capacity of a parent = its effective limit − Σ(charges of
  its `active` reservations) − Σ(final consumed amounts of its `released`
  reservations) − its own direct consumption (an Invocation's Attempts).
  A reservation's own reserved amounts are immutable; an active
  `Run → Plan Node` reservation's **effective reserved allocation** is
  those amounts plus the sum of its Allocation Extensions (below), and a
  Plan Node's effective limit for its own children is that effective
  reserved allocation.
- A reservation is created atomically with the object it allocates and
  before that object becomes runnable. Creation fails, and the requesting
  operation is rejected, when the parent's unreserved capacity is
  insufficient.
- When the child reaches a terminal state, its reservation is `released`
  with its final consumed amounts recorded; the unused remainder returns to
  the parent's unreserved capacity.
- Reaching the reserved amount is the child's local allocation exhaustion
  and the runtime's signal to stop starting work for it. A reservation
  gates whether work may start; it is not permission to discard real
  Usage once a provider has exceeded its estimate. The consumption
  recorded on release is the complete actual consumption from the
  canonical Usage and Attempt rows, never clamped to the reserved
  amounts, so a released reservation may show `consumed` above
  `reserved`. The parent's unreserved capacity then goes negative: the
  overrun is visible, Run Usage totals and reservation accounting agree,
  and every further reservation request is rejected until the operator
  approves a Budget Increase that covers it.
- Usage is attributed while the owning Invocation is non-terminal, which
  includes the interval after its Attempt has ended; once the Invocation
  is terminal its reservation has been released and further Usage for it
  is rejected. The runtime records final Usage, then ends the Attempt,
  then ends the Invocation.

**Plan Node allocation.** Each `pattern` Plan Node receives an explicit
allocation reserved from the Run Budget when the revision that creates it
is applied (§4.4 rule 8); the whole revision's new allocations are
reserved atomically and the revision is rejected if they cannot be, while
reused nodes keep their existing reservation. The root Orchestrator node
receives an explicit initial allocation (`initialOrchestratorAllocation`,
configurable), not the entire Run Budget. When the Orchestrator revises
the plan, new node allocations are reserved only from unconsumed,
unreserved ordinary Run capacity.

**Final reserve.** Every Run carries a **final reserve** (cost, tokens,
Attempts): chosen at Run creation from a configurable default per Run kind
(enabled by default for `kind: code` Runs, zero for `other`) or an explicit
value, validated to be non-negative and to fit within the Run Budget
together with the root node's initial allocation, and persisted on the Run,
immutable for its life as the **base final reserve**; the effective
final-reserve limit is the base plus the Run's `final_reserve` Budget
Increases. "Configured final reserve" always means the persisted base
value; a runtime configuration value is never read back into an existing
Run. The Run Budget is thereby partitioned: the **ordinary pool** (the
effective global limit less the effective final reserve) is the only
capacity plan revisions and Allocation Extensions can reserve; the final
reserve is spent only on
`final_synthesis` Orchestrator Invocations and `run_completion` Gate
Evaluator Invocations, each reserved with the explicit capacity source
`final_reserve`. The completion preflight admits a request only when the
effective reserve can fund the remaining completion work (the Evaluator
when an evaluated criterion exists, and the synthesis) — a refused
request may be retried after a `final_reserve` Budget Increase, and no
Completion Request is ever created automatically by an increase; a
reserve that can no
longer fund an Invocation when it is prepared fails the cycle with
`final_reserve_exhausted` — no verdict or report is fabricated and no
ordinary capacity is used instead (§10). Unused node allocation is
released when the node reaches a terminal state. A `join` node's
allocation is zero.

**Global and partition availability.** The ordinary pool and the final
reserve are partitions of one Run Budget, not independent Budgets.
`runCapacity` reports the base limit, the base final reserve, the Run's
increases by partition, the effective global, final-reserve, and ordinary
limits, and three accounts, each with `limit` (effective), `reserved` (Σ
active effective reserved amounts), `active` (Σ active charges),
`consumed` (Σ released consumption), `committed` (active + consumed), and
signed `available = limit − committed`:

- the **global** account charges every Run-level child of either partition
  against the whole Budget;
- the **ordinary** partition charges its Plan Node children against the
  Budget less the final reserve;
- the **final** partition charges its final-reserve Invocations against
  the final reserve;

and each partition reports `effectiveAvailable = min(available, global
available)` component-wise, which is what a reservation is checked
against. An **active** child is charged component-wise `max(effective
reserved allocation, actual attributable consumption so far)` — a Plan Node's consumption from
its own allocation at Run level, an Invocation's own Usage and Attempts at
Plan Node level and for final-reserve Invocations at Run level; a Task
reservation has no Usage and is charged its reserved amount — so an
overrun is visible at every affected parent the moment it happens, not
only after release. Consequently an ordinary overrun reduces effective
final availability, a final overrun reduces global and therefore ordinary
effective availability, neither partition may reserve beyond global
availability, ordinary work still cannot claim unused reserve, final work
still cannot claim unused ordinary capacity, negative availability stays
visible, and nothing is clamped.

**No double counting.** Usage roll-ups (`totalsForInvocation`,
`totalsForPlanNode`, `totalsForRun`) include every Usage row once, so the
root node's and the Run's operator-facing totals include final-synthesis
and run-completion Usage. Reservation consumption is accounted separately:
a Plan Node's Run-level reservation is released with
`consumedFromPlanNodeAllocation` — the consumption of the Invocations it
funded — while a final-reserve Invocation's consumption is recorded only on
its own `Run → Invocation` reservation. Once every Run-level child is
released, the sum of their recorded consumption equals total Run Usage.

**Invocation allocation.** Each Invocation receives an explicit allocation
before it starts, from the source its row names: an ordinary Invocation
(`allocationSource: plan_node`) reserves from its Plan Node's unconsumed,
unreserved allocation; a final-reserve Invocation (`run_final_reserve`,
with `finalReserveUse` `final_synthesis` or `run_completion`) reserves
directly from the Run's final reserve with a `Run → Invocation`
reservation created atomically with the Invocation, so that neither
consumer needs the root node to hold a second reservation and neither
consumes the root node's ordinary allocation. Both remain attached to the
root Plan Node for scope, progress, Event attribution, and Usage roll-up.
The store's `reserveFinalInvocation` accepts only a persisted Invocation
whose row names a permitted use with the matching role and purpose, on the
root node, with a non-zero Attempt allocation and no Task; the ordinary
entry point has no parameter that selects final capacity. Coordinator-proposed Tasks reserve their Worker Invocation
allocations at proposal time (§5.5.1), before the Task can become `ready`;
when the Worker Invocation is created the runtime, in one transaction,
releases the Task reservation (reason `transferred_to_invocation`,
consumed amounts zero) and creates the Invocation reservation for the same
amounts, recording the Task reservation id on the new row. Two auditable
rows result; a reservation is never re-pointed from a Task to an
Invocation, and the node's capacity is at no point free or doubly
reserved. Cancelling or rejecting the Task releases its reservation
without creating an Invocation reservation. Unused allocation returns to
the node when the Invocation reaches a terminal state.

**Exhaustion.**

- An Invocation that reaches its reserved cost, tokens, or Attempts is
  `failed` with reason `allocation_exhausted`; no retry. The wall-clock
  limit (the Invocation's, bounded by its node's) is Invocation-wide: one
  absolute deadline, `Invocation.startedAt + maxWallClockMs`, begins when
  the Invocation first becomes `running` and is shared by every Attempt
  and every retry backoff. Reaching it interrupts the running Attempt
  (`timed_out`, classified `interrupted`) and that interruption is final:
  no further Attempt is created whatever Attempts remain, a backoff that
  would end at or after the deadline is refused rather than persisted, and
  an Invocation whose deadline has passed is settled `failed` with
  `allocation_exhausted` exactly once. A non-deadline interruption before
  the deadline may retry with only the remaining time. A restart derives
  the same deadline from the persisted start and the immutable manifest
  limit.
- A Plan Node whose effective allocation cannot cover the next child it
  must fund acts on its `onAllocationExhausted` policy through the one
  Plan Node capacity operation (below): `fail` (default) fails the node
  with `allocation_exhausted`; `wait` puts the node in `waiting` with
  reason `budget` until an ordinary Budget Increase is approved or the
  Orchestrator revises the node's expression; `extend` (the root node's
  policy) has the runtime create an Allocation Extension for exactly the
  shortfall from the Run's effective ordinary capacity and, when that
  capacity cannot cover the shortfall, behaves as `wait`. Neither `fail`
  nor `wait` ever extends.
- The Run enters `waiting` with reason `budget` when the work that must
  proceed cannot be funded — its node is waiting on allocation or the
  root's own turn is unfunded — no other node can act, nothing is in
  flight, and no Allocation Extension fits the Run's effective ordinary
  capacity. The operator may approve an ordinary Budget Increase (after
  which the next scheduler pass funds the same work through the ordinary
  resume and readiness transitions) or cancel the Run. Budget exhaustion
  never transitions the Run to `failed`; `failed` is reached only through
  the terminal failure transitions in §3.

**Plan Node capacity operation.** Every child funded from a Plan Node's
allocation — a Pattern Invocation (single, chain, route, parallel,
Coordinator, evaluator/optimizer), a root Orchestrator turn of any purpose,
a `gate_result` remediation turn and its successor, a Coordinator Task
batch, a Worker Invocation created from a Task, a `node_exit` Gate
Evaluator, and the follow-up turn of a signoff change request — is admitted
by the one canonical operation `ensurePlanNodeCapacity(planNodeId,
required, trigger)` inside the root transaction that creates the child. It
computes the component-wise shortfall `max(0, required − available)` of
the node's effective allocation; with no shortfall it funds the child;
otherwise it applies the node's policy: `fail` refuses with
`allocation_exhausted`, `wait` refuses into a `budget` wait, and `extend`
records exactly one Allocation Extension of exactly the shortfall when the
Run's effective ordinary capacity covers it and otherwise refuses into a
`budget` wait, writing nothing. A Coordinator Task batch is validated as a
whole and funded by one aggregate extension for the batch's total, so
either the whole batch and its extension commit or neither does. There is
no speculative, rounded, or configured increment, no partial extension,
and no extension created ahead of the work that needs it.

**Allocation Extension.** The append-only `allocation_extensions` record
of one such transfer: the Run, the Plan Node, the node's existing active
ordinary `Run → Plan Node` reservation, the exact added cost, tokens, and
Attempts (non-negative, at least one positive), the closed trigger
(`invocation`, `task_batch`, `gate_evaluator`, `gate_remediation`,
`root_turn`, `signoff_follow_up`), and the creation time. It raises the
reservation's effective reserved allocation without creating a second
reservation and without rewriting the reservation's own amounts; it
creates no Usage, enlarges no existing Invocation's allocation, and never
draws on the final reserve. Only a nonterminal `pattern` node's active
ordinary reservation of the same Run may be extended; a released
reservation, a terminal node, a join node, and a final-reserve reservation
never are. While the reservation is active the Run charges
`max(original + Σ extensions, actual)`; once released it charges the
recorded actual consumption alone and the extension remains as provenance.
The event is `allocation_extension.created`.

**Budget Increase.** The append-only `budget_increases` record of one
operator-approved enlargement of the Run's effective Budget: the Run, the
authorizing `budget_increase` Decision (exactly one increase per approved
Decision), the partition (`ordinary` or `final_reserve`), the exact added
cost, tokens, and Attempts (non-negative, at least one positive), and the
creation time. It is requested and resolved only through the Budget
Increase service — never by a model, a policy, a runtime tool, a
Coordinator, or the Orchestrator — and recorded in the Decision's
resolving transaction with one correlation chain, creating no Invocation,
no Usage, no Run transition, no reservation, and no `decision_resolution`
turn: the scheduler's next explicit pass derives the new effective
capacity from rows and resumes a Run waiting on `budget` through the
existing transitions. An `ordinary` increase is permitted while the Run is
`created`, `running`, `waiting`, or `awaiting_signoff`; a `final_reserve`
increase while `created`, `running`, or `waiting`; neither on a
`verifying` or terminal Run, and one `budget_increase` Decision is open per
Run at a time. `deny` creates nothing; an identical retry replays the
recorded resolution; a conflicting retry is refused typed and writes
nothing. Increases never reduce, revoke, replace, or expire capacity, and
never change wall-clock deadlines or concurrency. The event is
`budget_increase.recorded`.

### 7.7 Fan-in

Fan-in is performed by the runtime: by `join` nodes for `fan_in` edges
(§4.2), by the `parallel` Pattern for its inline items (§5.4), and by the
`coordinator_worker` Pattern for Worker results. It waits for the required
results, writes the index Artifact or records the Handoffs, and creates the
next Invocation or marks the node terminal. No agent waits for another
agent.

**Handoff routes.** The Handoff router (`server/src/execution/handoff-routing.ts`)
carries every transfer under a stable canonical key of the closed core
`HandoffRoute` union: `sequence:<source>:<target>` for a delivering
`sequence` edge (a join's output is its index Artifact; a route's own
sequence edges deliver only for an inline selection), `branch:<source>:<target>`
for the one active `branch(label)` edge of a route that selected a
composite branch (no Artifacts; the label is validated routing metadata
against the node's shape and the revision's edge), `chain_step:<node>:<step>`
for a chain's internal transfer, `parallel_index:<node>` for a parallel
node's delivery of its index to its own aggregation,
`worker_result:<node>:<task>` for a `coordinator_worker` node's delivery
of one integrated Worker result (the Task's output Artifacts) to its next
Coordinator turn, `retry:<source>:<target>` for the one active
`retry(round)` edge out of an evaluate-only `evaluator_optimizer` node
whose round failed (carrying the judged candidate Artifact ids to the next
producer round's entry; the round is validated routing metadata against
the revision's edge), `optimizer_candidate:<node>:<round>` for an inline
`evaluator_optimizer` node's delivery of a round's candidate from its
producer Invocation to that round's Evaluator, and
`optimizer_feedback:<node>:<round>` for an inline node's delivery of a
failed round's judged candidate to the next producer round (the verdict
itself travels as the typed `optimizer_feedback` manifest input, never as
Handoff text). Which edges deliver is
decided by the readiness evaluator's activation over the graph and the
facts (§4.3); a Handoff still holds only source, target, Task ids,
Artifact ids, a bounded summary, and a status — never a message, an
Evaluation payload, or copied Artifact content — and the database's unique
key per Run makes every transfer exist at most once across passes,
retries, and restarts.

### 7.8 Resource governor

The resource governor is a deterministic component of the runtime process
that manages:

- provider quota and capacity (rate limits, usage windows, provider-reported
  overload);
- global provider concurrency (concurrent Attempts across all Runs);
- machine and process concurrency (concurrent worktrees, subprocesses,
  memory);
- configured resource limits.

Before an Attempt starts, the scheduler requests a capacity lease from the
governor for the Run. The governor grants or refuses deterministically from
its current accounting and returns a structured reason on refusal
(`provider_quota`, `provider_concurrency`, `process_concurrency`,
`configured_limit`) and, where known, a retry-after time. A Run with no
runnable Attempt holding a lease enters `waiting` with reason
`provider_capacity` and the structured sub-reason. Leases are released when
the Attempt ends and are recorded in `capacity_leases` with grant and
release times. `join` nodes never request a lease.

The governor never invokes a model, never generates conversational text,
never holds or interprets semantic Run state, and never decides which Run
or node is more important beyond the configured ordering (creation order
by default). It is backpressure, not orchestration. There is no global
"pause" product state; the operator pauses individual Runs (§14).

The governor (`server/src/execution/governor.ts`) accounts from the
canonical `capacity_leases` rows on every call rather than from in-memory
counters, so a rolled-back grant, a crashed process, or a restart never
leaves it trusting stale state; its only memory is the availability a
provider last reported (a quota or overload refusal with an optional
retry-after time that clears itself once passed). Refusal reasons are
evaluated in a fixed order — `configured_limit` (an unconfigured or
zero-limit provider, or a request above a configured ceiling),
`provider_quota`, `provider_concurrency`, `process_concurrency` — and a
refusal writes nothing. A grant and its persisted lease are one
transaction with the Attempt it starts; the executor checks the governor
before creating the Attempt so that a refusal creates no Attempt and
consumes no allocation; a lease is released exactly once on every
terminal path; restoration after a restart releases every lease still
active and forgets reported availability. `join` nodes never request a
lease. The governor performs no polling and, in Phase 2B, no queueing:
it returns the typed refusal and the scheduler maps it to a `waiting`
Run.

### 7.9 Task states and transitions

A Task has exactly one of these states; every transition is made by the
runtime:

| State | Meaning |
|---|---|
| `pending` | Created; its dependencies are not all `completed`, a required input Artifact is not yet available, or (for a Coordinator-proposed Task) its Worker allocation is reserved but the node is not yet scheduling it. |
| `ready` | Eligible for execution: dependencies `completed`, inputs available, allocation reserved. |
| `running` | Assigned to an active Invocation. |
| `blocked` | Cannot continue without a Decision, a replacement input, or Coordinator replanning. |
| `completed` | Finished with its required output Artifacts and Evidence, validated by the runtime. Terminal. |
| `failed` | Its Invocation exhausted the permitted Attempts or reached a permanent failure. Terminal. |
| `cancelled` | Deliberately stopped by the Orchestrator, a Coordinator `replan`, or the operator. Terminal. |

Transitions:

- `pending → ready` when every dependency is `completed`, every input
  Artifact exists, and the allocation is reserved.
- `ready → running` when the runtime starts the assigned Invocation.
- `running → completed` when the Invocation's valid result reports the
  Task `completed` with Evidence and required Artifacts.
- `running → blocked` when the result reports the Task `blocked`, or the
  Invocation ends `waiting` on a Decision.
- `running → failed` when the Invocation is `failed` (§7.2).
- `blocked → ready` when the blocker is resolved (Decision answered,
  replacement input delivered) and the runtime creates a new Invocation
  for it; `blocked → cancelled` when a `replan` cancels it or replaces it
  (the replacement supersedes it and inherits its dependents).
- `pending → blocked` when a dependency becomes `failed` or `cancelled`
  (never a silent cancellation; the Coordinator or Orchestrator decides).
- `pending | ready | blocked → cancelled` by the Orchestrator, a
  Coordinator `replan`, or operator cancellation of the Run or node.
- `failed` and `completed` are terminal; a failed Task is never
  reclassified as `cancelled`, and a replacement is a new Task that
  records `replacesTaskId` — at most one per replaced Task, never for a
  `completed` one (§5.5).

A Task completing never changes a Requirement's status (§8.1). A `blocked`
or `failed` Task is never described as in progress; only `running` is.

## 8. Specification and decisions

### 8.1 Requirements

- The Orchestrator proposes a Requirement tree with Acceptance Criteria
  through `propose_requirements`. The operator approves, edits, or rejects.
  Approval creates a Requirement revision. Plan Nodes pin the revision
  their expressions named (§4.7); the root node's manifests carry the
  current revision.
- A Requirement revision represents a change to an intended outcome or
  constraint: a statement's meaning, its composition, its Acceptance
  Criteria, or which Requirements exist. Changes to how the work is carried
  out — which Tasks exist, how the Execution Plan is shaped, which agent
  does what — change Tasks or the Execution Plan and never create a
  Requirement revision.
- Requirement statuses are `open`, `satisfied`, `violated`, `infeasible`,
  `waived`, and `retired`. Parent statuses are derived; a `waived` child
  counts as satisfied for derivation.
- `satisfied` is established only from Acceptance Criteria and Evidence: a
  leaf becomes `satisfied` when every deterministic Acceptance Criterion on
  it passed at a Gate on the current integration Snapshot and every
  evaluated criterion has a passing Evaluation. The runtime records the
  status change with the Evaluations as Evidence. A Task completing, a
  Worker's claim, or an Orchestrator's statement never satisfies a
  Requirement. The derivation runs at the `run_completion` Gate
  (`server/src/execution/requirement-derivation.ts`, §10) over the pinned
  revision: for each current leaf, `waived` and `retired` are retained
  (`waived` only with its operator waiver Decision), `infeasible` is
  retained and never derived from a failed check, every criterion `pass`
  → `satisfied`, any `fail` or `inconclusive` → `violated`, no criterion
  or an incomplete set → `open`; each internal Requirement follows its
  `all`/`any` composition bottom-up over the derived children; every
  change is one `requirement_status_changes` row by the runtime
  referencing the Gate and the Evaluation Evidence that established it,
  and a status that already holds produces no row, so repeating the
  derivation writes nothing.
- `violated` and `infeasible` are recorded by the runtime from a failing
  Evaluation or by the Orchestrator or operator with Evidence.
- `waived` is reached only when the operator resolves a Decision of kind
  `requirement_waiver` (§8.2). The resolved Decision records the actor (the
  operator), the rationale, the affected Requirement id, the timestamp, and
  optional supporting Artifact ids. The runtime applies the status change
  only after that resolution and links the two. There is no other path to
  `waived`; no policy, no Orchestrator tool, and no Conversation-level
  setting can produce it. A waiver never satisfies the Requirement's
  Acceptance Criteria; it records that the outcome is accepted without
  them.
- `retired` is reached through a Requirement revision that removes the
  Requirement.
- A later Requirement revision never changes the scope of an existing Plan
  Node (§4.7). To work against revised Requirements the Orchestrator
  revises the source Execution Plan, producing replacement nodes under the
  reconciliation rules in §4.5.

### 8.2 Decisions

A Decision is the canonical record of a choice. Every Decision has a kind:

- `operator_choice` — a question put to the operator;
- `orchestrator_choice` — a choice the Orchestrator made itself;
- `requirement_waiver` — accepts a Requirement without its Acceptance
  Criteria (§8.1); proposed by the Orchestrator, resolved only by the
  operator;
- `side_effect_approval` — approves one intercepted `approval_required`
  tool call (§6.4);
- `signoff` — the operator's acceptance or change request at the
  `operator_signoff` Gate;
- `publish` — the operator's publish instruction (§9.4).

Every Decision request records the question, the options, the requester's
recommended option, the rationale, the affected Run, Requirement, Task,
and Plan Node ids, and a **resolution policy**:

- `operator_required` — the Decision resolves only when the operator
  answers. The requesting Invocation ends `blocked` and waits (§7.4); other
  nodes continue.
- `use_default_after_deadline` — the Decision resolves with the recorded
  recommended option when the operator has not answered by a recorded
  deadline or when a recorded deterministic activation condition becomes
  true (for example "the Plan Node this Decision affects becomes ready").
  A request with this policy must carry the recommended option, the
  deadline or condition, the rationale, and the affected ids; a request
  missing any of them is rejected. The requesting Invocation continues on
  the recommendation; the Decision stays open for the operator until it
  resolves.

Only `operator_choice` Decisions may use `use_default_after_deadline`.
`requirement_waiver`, `side_effect_approval`, `signoff`, `publish`, and
`budget_increase` Decisions always use `operator_required` and are
resolved only by the operator. A `budget_increase` Decision (§7.6) has
exactly the options `approve` and `deny`, no default deadline, and an
immutable typed subject naming the Run, the partition, and the exact added
cost, tokens, and Attempts; it is requested and resolved only through the
Budget Increase service — no runtime tool requests it — and its approval
records exactly one Budget Increase in the resolving transaction. No policy, delegation, or Conversation-level setting can resolve
them or transfer that authority, and no standing or automatic publication
authorization exists: every Publication is authorized by its own resolved
`publish` Decision (§9.4).

Resolution, by whichever path, writes exactly one `decision.resolved`
Event recording the answer, the resolver (`operator`, `orchestrator`, or
`policy:use_default_after_deadline`), and the time. No Decision resolves
without that Event, and a policy resolution is shown in the Conversation
like any other. A Decision resolved by policy may later be superseded by
the operator; the runtime records the superseding Decision and creates a
`decision_resolution` Orchestrator Invocation.

## 9. Workspace, Snapshots, Changesets, integration, publishing

### 9.1 Isolation

- Each Run has a **Target**: the operator's branch in the Workspace that
  the Run's result is meant for. The runtime never modifies the Target
  while the Run is executing.
- Each Run has an **Integration Workspace**: a Run-owned worktree and
  branch created from the Run's base Snapshot of the Target. All
  integration happens there.
- Every Invocation with write capability runs in its own worktree created
  from the node's starting Snapshot of the Integration Workspace. Read-only
  Invocations run against the Integration Workspace directly, or a
  read-only worktree when concurrent writers exist.
- The Workspace's own checkout and the Target are never modified by an
  Invocation.
- **Worktree cleanup is a durable obligation** (`invocations.workspace_cleanup`:
  `none | pending | released`, with `workspaceReleasedAt`). Preparation
  (§6.1) calls the execution-workspace port's `prepare` inside its
  transaction and records the obligation `pending` right after it, so a
  rollback runs the port's `discard` and commits no obligation; a
  read-only Invocation records `none` and never creates cleanup work. The
  release ordering is fixed and its crash window is closed by
  reconciliation: (1) the Invocation's terminal settlement (`blocked`,
  `succeeded`, `failed`, or `cancelled`) commits; (2) the port's `release`
  runs outside any transaction and must be idempotent; (3) the obligation
  is recorded `released` in its own transaction with the
  `invocation.workspace_released` Event. A release failure never changes
  the canonical Attempt or Invocation outcome — it is reported as the
  bounded `workspace_release_failed` diagnostic — and restart recovery
  (§14) retries every obligation still `pending` on a terminal Invocation
  after its canonical reconciliation; a crash between (2) and (3) is
  closed by the same idempotent retry. A retryable Invocation never
  releases its worktree between Attempts; repeated recovery and repeated
  release are harmless. The manifest's worktree path is a rendering input,
  never the record of the obligation.

### 9.2 Integration

- When a writing Invocation returns, the runtime commits its worktree,
  records the Changeset (kind `invocation`, its writing Invocation, before
  Snapshot, after Snapshot, diff Artifact, integration status `pending`),
  and integrates the Changeset into the Integration Workspace in Plan Edge
  order — before the node is settled, the next `chain` step is prepared,
  or a successor is readied. Changesets have a closed **kind**:
  `invocation` Changesets live in the integration lifecycle above; the
  Run's one `final` Changeset (§9.3) is a descriptive record that is never
  applied, retried, or resolved.
- Integration goes through the Changeset integration service
  (`server/src/execution/integration-service.ts`) and the
  integration-workspace port (`ports/integration-workspace.ts`:
  `apply` takes the Run, the Changeset identity, the Integration Workspace
  path, the current integration Snapshot, and the Changeset's diff as an
  `ArtifactContentSource`, and returns `integrated` with the new Snapshot
  or `conflict` with a bounded report). **The execution runtime resolves
  and verifies Changeset content. The Integration Workspace receives a
  capability bound to that exact immutable content and has no persistence
  access.** Before the port is called, and outside any transaction, the
  service resolves the diff Artifact through the canonical Artifact Store,
  checks that it belongs to the Run and has the Changeset diff media type
  (`text/x-diff`), and verifies the stored bytes against the Artifact's
  digest and byte size; the content source it then binds names exactly
  that Artifact, its media type, digest, and size, and offers one
  parameterless `read` that verifies again on every call — never a store,
  a blob, a storage key, a path to the content, or a lookup by id. An
  adapter applies exactly the bytes it reads; a zero-byte diff is a valid
  empty Changeset, not a metadata-only shortcut. Content that is missing,
  corrupted, or inconsistent with its metadata is an infrastructure
  failure (`ChangesetContentError`, carrying ids, the failure kind, and
  the digest, never bytes): the port is not called, nothing is recorded,
  no conflict Task or report Artifact is invented, and the Changeset stays
  `pending` for a later pass once the store is repaired. Diff bytes appear
  in no Event, outcome, projection, diagnostic, manifest, Handoff, or
  error message; they live in the Artifact Store alone.
  The service is idempotent by Changeset id: an already-`integrated`
  Changeset is never applied again, one integration runs at a time per
  Run, and the apply happens outside any transaction with the record
  written in one transaction afterwards — the Changeset `integrated`, the
  integration Snapshot, and `run.integrated` on the Run. A crash between
  the apply and its record leaves the Changeset `pending`; the next pass
  resolves and verifies the same content again, applies it again, and
  the port reports an application that already holds (`alreadyApplied`:
  the external Integration Workspace had already accepted that exact
  Changeset) so persistence catches up exactly once. Adapters keep
  whatever that idempotence needs in the Integration Workspace itself and
  never persist integration state in Agentique's database.
- A Changeset that does not apply cleanly is not applied. The runtime
  records, in one transaction, the Changeset `conflict`, a runtime-owned
  Task for the Plan Node's owner (a `replan` Coordinator Invocation for
  `coordinator_worker`, otherwise the Orchestrator) carrying a bounded
  `text/plain` conflict-report Artifact, the node `waiting` with reason
  `integration_conflict`, and — when nothing else can proceed — the Run
  likewise. When that Task completes the node resumes and the Changeset
  is applied once more; a second conflict fails the node with
  `integration_conflict`, and a Task that fails or is cancelled fails the
  node the same way. The node's `node_exit` Gate cannot pass while the
  Task is open.
- After every integration the runtime records the integration Snapshot on
  the Run; every later Invocation starts from it.

### 9.3 Verified final Snapshot

A coding Run cannot reach `awaiting_signoff` unless the `run_completion`
Gate's deterministic Acceptance Criteria have passed on the current
integration Snapshot, with the command outputs stored as Artifacts and
referenced as Evidence. Whether a Run is a coding Run is a property of the
Run declared at creation (`kind: code | other`); a coding Run must declare at
least one deterministic Acceptance Criterion on its `run_completion` Gate
(typically build, typecheck, test). The Snapshot the operator is asked
to accept is exactly the one the `run_completion` Gate pinned and
verified, unchanged since (§10). When the operator accepts at
`operator_signoff`, the runtime records the accepted integration Snapshot as
the Run's **final Snapshot** and the diff from the base Snapshot as the
Run's **final Changeset**. The Run is `completed`. The Target is still
untouched.

**Final Snapshot.** The final Snapshot is the signoff Gate's verified
Snapshot itself, referenced through `Run.finalSnapshotId`; no second
Snapshot row is taken to rename its purpose. Acceptance validates that it
is exactly the Snapshot the signoff Gate pinned, exactly the Snapshot the
passed completion Gate verified, that it belongs to the Run's Workspace,
that the Run's integration Snapshot has not moved since, and — through the
**Run finalization Workspace port** (`ports/run-finalization-workspace.ts`,
`RunFinalizationWorkspacePort`) — that the external Integration Workspace
still holds exactly that Snapshot with a clean working state. The port is
read-only and provider-neutral: it receives the Run and Workspace
identity, the Integration Workspace path, the base Snapshot identity, and
the verified Snapshot identity — never a store, a database handle, the
Blob Store, an Artifact lookup, a transcript, or any authority over the
Target — and returns the Snapshot the Workspace holds now, the exact,
untruncated base-to-verified diff (a zero-byte diff is valid), and whether
the working state is clean. It never modifies the Integration Workspace or
the Target, never commits, combines, rebases, or switches anything, never
publishes, and creates no provider-side marker correctness would depend
on; the signoff service calls it outside every transaction and refuses to
call it from inside one. Any other observation is **drift**, refused with
`workspace_drifted`, never reinterpreted as acceptance; an unobservable
Workspace is `finalization_failed`; both leave the boundary open and
acceptance retryable (or the operator may request changes). The "final"
status of the Snapshot is the completed Run's canonical reference, not a
Snapshot property.

**Final Changeset.** The complete base-to-final difference is one canonical
Changeset of kind `final`: the Run, no Invocation, before Snapshot = the
Run's base Snapshot, after Snapshot = the final Snapshot, a content-addressed
`text/x-diff` Artifact holding the exact bytes the port computed (digest
and byte size verified on every read), and the one terminal state
`recorded` — it has no integration retry lifecycle, no conflict state, and
no external apply action, because the Integration Workspace already holds
that state. At most one exists per Run and none before signoff acceptance
(the store and a database trigger admit it only for a Run
`awaiting_signoff`, from its base Snapshot to the open signoff Gate's
Snapshot, with a diff Artifact of the Run; a unique index holds one per
Run); it is immutable and never deleted; `Run.finalChangesetId` references
it and `Run.finalSnapshotId` equals its after Snapshot (database-enforced
on the Run row). The diff bytes live only in the Artifact Store: no
outcome, projection, Event, or manifest carries them.

### 9.4 Publication

Applying a completed Run's accepted final Changeset to its Target is a
**Publication**: the one runtime boundary that may modify the Target,
performed by the publication service
(`server/src/execution/publication.ts`) through the publication Workspace
port (`ports/publication-workspace.ts`) and never by an Invocation.
Publication is separate from Run execution, signoff acceptance, Changeset
integration, provider/model execution, and the Run scheduler: the service
holds no timer, no polling, no action graph, and invokes no model, and a
completed Run stays `completed` whatever the Publication's outcome. The
design verifies the prospective post-publication state **before** the
Target is mutated; nothing is checked "after publishing" on the theory
that nothing was written.

**Authorization is explicit and exact.** Every Publication requires its
own resolved `publish` Decision (§8.2): always `operator_required`, the
two options `publish` and `cancel`, and a typed subject naming the
completed Run, its Workspace, the exact Target, the accepted final
Snapshot, the final Changeset, and the requested strategy — immutable
once requested. Only one open publish Decision exists per Run (an
identical retry replays it; a conflicting one is refused), the Run must
already be `completed` when it is created, and signoff acceptance grants
no publish authority. There is no Conversation-level standing or
automatic publication authorization of any kind; a future
standing-authorization product would be a separate design. `cancel`
resolves the Decision and creates nothing; `publish` resolves it and
creates exactly one `requested` Publication in the same transaction.
Identical resolution replays return the canonical result; conflicting
replays are refused; resolving one Run's Decision never acts on another
Run, Target, Snapshot, or Changeset. A bounded read-only publication
projection (facts and allowed actions; never Artifact content, command
output, credentials, paths, transcripts, or Event history) serves the
later operator-facing layer.

**The lifecycle is staged and recoverable.** A Publication moves
`requested → prepared → verified → applying → succeeded | failed`
(`requested → failed` for a deterministic preparation refusal,
`prepared → failed` for a failed candidate verification,
`applying → failed` for a definite compare-and-swap refusal; `verified →
applying` is the durable commitment boundary and has no failure edge).
Each row persists its identity (Run, publish Decision, final Changeset,
requested strategy), its prepared facts once preparation persists (the
selected concrete strategy, the Target-before Snapshot, the candidate
Snapshot), the Target-after Snapshot on success (exactly the candidate),
the closed structured failure on a deterministic terminal failure, the
milestone times, the terminal publication-report Artifact, and the
durable cleanup state of its staging resources. The database enforces one
Publication per publish Decision, at most one nonterminal and one
succeeded Publication per Run, only a completed Run, only the Run's
`finalChangesetId`, immutable terminal rows, and that a succeeded Run is
never published again; a failed attempt may be retried only through a
new exact publish Decision.

**Strategy.** The Decision carries a strategy **request** — `automatic`,
or `exact` with one concrete strategy — and the concrete strategy
(`fast_forward`, `merge`, or a provider-named `other`) is selected at
publication time, never at Run creation, and is invisible to every
Invocation, Context Manifest, and model call. `automatic` selects
`fast_forward` when the Target still equals the Run's base Snapshot and
otherwise a clean `merge` where the provider supports it; an `exact`
request is honored exactly or refused, never silently widened or
replaced; `fast_forward` requires the Target to equal the base Snapshot;
a provider-named strategy must be named in the Decision and reported as
supported. Terminal failures are closed structured facts —
`strategy_unsupported`, `fast_forward_unavailable`, `candidate_conflict`,
`verification_failed`, `target_changed`, `candidate_invalid` — never
arbitrary strings; infrastructure failures are retryable nonterminal
state, not one of them.

**The flow.** SQLite and the Workspace provider never form one
transaction; every port call runs outside every database transaction and
every external-call/record crash window is bridged explicitly:

1. *Prepare* (`requested`): the port's idempotent `prepare` inspects the
   current Target, receives the runtime-verified final-Changeset content
   through a narrow content source (the same content-ownership rule as
   Changeset integration, §9.2 — the port can neither enumerate nor
   retrieve arbitrary Artifacts and receives no store, database, or
   credential), selects or validates the strategy, and constructs the
   candidate state in an isolated publication workspace/ref **without
   modifying the Target**, returning the Target-before and candidate
   identities, the selected strategy, and the verification workspace
   location; a replay returns the same prepared result. One transaction
   then records the two Snapshots and the prepared facts. A deterministic
   refusal is a terminal failure with its report; an unavailable provider
   leaves the Publication `requested`.
2. *Verify* (`prepared`): the exact deterministic Acceptance Criteria of
   the passed `run_completion` Gate behind the accepted signoff boundary
   run against a disposable view of the prepared candidate Snapshot,
   through the shared Acceptance Criterion check service (§10.1) — the
   criteria in canonical id order, outside every transaction, bounded
   output stored only as Artifacts, one canonical Evaluation per
   Publication and criterion (the typed `publication` Evaluation context:
   runtime producer only, no Gate, no Plan Node, no new Evaluator
   Invocation, no model call, no transcript, no Evaluation reused from a
   different Snapshot, no mutable Workspace-policy lookup), idempotent
   across restart. All passing — or structural candidate validation when
   no deterministic criteria apply — persists `verified`; a failing
   criterion is the terminal `verification_failed` and the Target is
   unchanged. Evaluated (model-judged) criteria never run during
   Publication.
3. *Commit* (`verified`): one transaction persists `applying` before any
   Target call, so a later unknown result is reconciled through the
   idempotent apply, never guessed.
4. *Apply* (`applying`): the port's idempotent `apply` compares the
   Target against the persisted Target-before identity and, in **one
   atomic provider operation**, updates the Target to the persisted
   candidate and writes a durable provider-owned receipt keyed by the
   Publication id — for git, an atomic reference transaction updating the
   Target ref and a publication receipt ref together. A replay whose
   receipt exists returns the applied result with the receipt's recorded
   identity, even when the Target has since moved again; success is never
   inferred from the Target merely equalling or containing the candidate,
   and no force update exists. A failed compare-and-swap is the definite
   `target_changed`: nothing was applied. One transaction then records
   `succeeded` (Target-after = the candidate) or `failed`, the canonical
   publication-report Artifact
   (`application/vnd.agentique.publication-report.v1+json`; bounded
   canonical facts, raw diagnostics in a separate referenced Artifact),
   and the Events.
5. *Release*: a terminal Publication's staging resources carry a durable
   cleanup obligation, released through the idempotent port operation
   outside every transaction, retried by recovery until `released`; a
   cleanup failure is a bounded diagnostic that never alters the outcome.
   Successful Publication releases only publication-specific staging; the
   Run's Integration Workspace is retained until an explicit
   retention/disposal policy exists.

**Recovery** (`reconcileOutstanding`) scans every nonterminal Publication
and every terminal row with pending cleanup and re-drives each through
`advance`, which always re-reads canonical state before acting:
`requested` idempotently prepares and persists; `prepared` finishes or
resumes the deterministic checks; `verified` persists `applying` before
any Target call; `applying` calls the idempotent apply and records the
canonical result; terminal rows perform pending cleanup only. The Target
mutation is never called from `requested` or `prepared`.

**Events.** Each durable boundary journals its Event —
`publication.requested`, `publication.prepared`, `publication.verified`,
`publication.applying`, `publication.succeeded`, `publication.failed`,
`publication.workspace_released` — and a terminal outcome also journals
the Run-scoped `run.published` or `run.publish_failed`. Payloads carry
ids, statuses, strategies, Snapshot references, structured failure codes,
Artifact ids, and timestamps — never diff bytes, command output,
credentials, repository paths, provider receipts, opaque Workspace keys,
transcripts, or exception stacks. None of them changes the Run's status.

**Failure is an operator-visible fact, not a model call.** No
`publication_result` Invocation, Task, coordinator turn, or automatic
model call follows a Publication outcome: a completed Run is terminal and
never resumes agent execution. After a failure the operator may retry
through a new exact `publish` Decision when retry is valid (the Target
unchanged, the failure understood) or start a new Run to reconcile the
Target.

## 10. Verification and Gates

Order is fixed: deterministic checks, then Evaluations, then the operator.

- `node_exit`: executed by the Gate engine
  (`server/src/execution/gates.ts`, reached by every Pattern runner through
  the shared node support) once a `pattern` node's candidate output is
  complete and integrated — a `single` or `chain` node's final result, a
  `route` node's inline branch result, a `parallel` node's aggregate
  result or its runtime index Artifact, a `coordinator_worker` node's
  integrated synthesis. One **cycle** is one `gates` row with a canonical
  identity: the Run, the Plan Node, the kind, the cycle **ordinal** (1, 2,
  …; at most one open Gate per node, database-enforced), the exact
  integration Snapshot pinned at opening, the exact candidate Artifact ids,
  the exact criterion ids in canonical order, its status, and its
  timestamps. Deterministic criteria run first, in id order, on a
  disposable view of the pinned Snapshot through the check service
  (§10.1), each outcome recorded once as a `runtime` Evaluation naming the
  Gate; the first failure ends the checks and no Evaluator is invoked. When
  every deterministic criterion passed, all evaluated criteria are judged
  by exactly one read-only Gate Evaluator Invocation (§6.1) whose manifest
  carries one typed `gate_candidate` input (the Gate, its Snapshot, the
  candidate, exactly the evaluated criteria) and no transcript; its
  validated result becomes one Evaluation per evaluated criterion on the
  Gate's Snapshot and candidate (one per Gate and criterion, `gateId` set,
  no optimizer context, database-enforced); an invalid result is an
  ordinary Attempt retry; a permanently failed Evaluator closes the Gate
  `failed` with the `evaluator_failed` fact and fails the node with
  `gate_evaluator_failed` — no verdict is invented. A Gate whose every
  verdict is `pass` closes `passed`, and in the same transaction the node
  succeeds with the candidate, its edge Handoffs are created, and its
  reservation is released; a Gate with any `fail` or `inconclusive`
  verdict closes `failed` on those criteria and creates exactly one
  runtime-owned **remediation Task** (`gateId` on the Task, one per Gate)
  whose inputs are the candidate and the command-output Artifacts, leaving
  the node `running`; when the closing cycle is the Run's
  `maxNodeGateCycles`, the node fails with `gate_cycles_exhausted` instead
  and no Task is created. Closed Gates never change; a later cycle is a new
  row. Remediation is owned by the node's Coordinator (§5.5) or, for every
  other Pattern, by the root Orchestrator's batched `gate_result` turn
  (§4.6). Once the remediation Task is completed, the next cycle opens a
  new Gate with the next ordinal on the current integration Snapshot and
  the persisted candidate — the Task's output Artifacts when the
  remediation replaced the output, the previous Gate's candidate when it
  did not, a Coordinator's fresh synthesis — so an ordinary Gate never
  re-judges a stale Snapshot; a remediation Task that failed or was
  cancelled fails the node with `gate_remediation_failed`. There are no
  waivers and no implicit passes: a node with Gate criteria reaches
  `succeeded` only through a `passed` Gate.
- `run_completion`: executed by the completion engine
  (`server/src/execution/completion.ts`) for one accepted Completion
  Request (§6.4) once its requesting turn completed and integrated. One
  cycle is one `gates` row with `planNodeId` null and a canonical
  identity: the Run, the kind, the cycle **ordinal** (unique per Run and
  kind; at most one open Run Gate per Run and one Gate per request,
  database-enforced), the Completion Request, the integration Snapshot
  pinned at opening, the pinned Requirement revision (the Conversation's
  current one), the exact current leaf Requirement ids of that revision,
  the exact criterion ids in canonical order, the candidate Artifact ids,
  its status and failure, its timestamps, and — once passed — the
  final-report Artifact. Cycles are bounded by the Run's
  `maxRunCompletionCycles`: a request beyond the bound is refused at the
  call (`run_completion_cycles_exhausted`) and the Run stays `running`.
  The **criterion set** is the canonical union of the Run's declared
  `runCompletionAcceptanceCriterionIds` and the Acceptance Criteria of
  every current leaf of the pinned revision that is neither `waived` nor
  `retired`, deduplicated and in id order — never a historical revision's,
  a retired Requirement's, a superseded Task's, another Conversation's or
  Run's, a historical node's, or anything read from a transcript; a leaf
  without criteria stays `open` and fails the cycle. The **candidate** is
  the deterministic, bounded, id-ordered union of the outputs of every
  succeeded current non-root node, the outputs of every completed current
  Task, and the Evidence Artifacts of the Run's `node_exit` Gate
  Evaluations; never a transcript. Beginning is one transaction: the
  preflight is revalidated (drift cancels the request with its exact
  codes, `preconditions_changed`), the Run moves `running → verifying`,
  the Gate opens, the request moves `requested → verifying`. Then, in
  order: deterministic criteria run in id order through the shared check
  service (§10.1) in a disposable view of the pinned Snapshot, each
  recorded once as a `runtime` Evaluation of the Gate (no Plan Node, no
  optimizer context), the first failure ending the checks (an
  infrastructure failure records nothing and the next pass reruns exactly
  the unrecorded checks); evaluated criteria are judged by exactly one
  read-only Gate Evaluator Invocation funded from the final reserve
  (§6.1), whose manifest carries one typed `gate_candidate` input (the
  Gate and request, the Snapshot, the revision, the candidate, exactly
  the evaluated criteria, the current Requirement and Task facts; no
  transcript, history, or continuation) and whose validated result — one
  verdict per evaluated criterion, no more and no fewer — becomes one
  Evaluation per criterion (an invalid result is an ordinary retry; a
  permanently failed Evaluator fails the cycle `evaluator_failed` with no
  verdict invented); the Requirement statuses are derived and recorded
  (§8.1); the **structural conditions** are evaluated — every leaf of the
  pinned revision `satisfied`, `waived`, or `retired`; every current Task
  `completed` or `cancelled` (a `failed` Task blocks until replaced or
  cancelled); no `operator_required` Decision open; no Changeset pending
  or in conflict; no `node_exit` Gate open and no node remediation
  unresolved; every current non-root node terminal without unresolved
  failure; every criterion of the Gate judged `pass`; the integration
  Snapshot unchanged since opening — and any unmet one fails the cycle
  `conditions_unmet` with the exact typed conditions; then the one
  read-only `final_synthesis` turn (§4.6, §6.1) is prepared from the
  final reserve, its manifest carrying one typed `final_synthesis` input
  of canonical facts only (request, Gate, Snapshot, revision, the leaf
  statuses with waiver Decisions, the Gate's Evaluations with their
  Evidence, the current Task ledger, the candidate, Usage, the final
  reserve's limit and consumption) and no transcript, message, history,
  or raw output; its result is the closed typed `FinalSynthesisResult`
  (`summary`, `completed`, `verification`, `risks`, `followUps`, bounded)
  and nothing else — an invalid one retries, a permanently failed one
  fails the cycle `final_synthesis_failed`. **Passing** is one
  transaction: the report is serialized as canonical JSON
  (`FinalReport`, version 1, naming the Run, request, Gate, Snapshot,
  and revision) into one content-addressed Artifact of media type
  `application/vnd.agentique.final-report.v1+json` (the bytes live only
  in the Artifact Store; Events carry the id), the Gate closes `passed`
  with the report, the request passes with the report, the
  `operator_signoff` Gate opens, the `signoff` Decision is requested, and
  the Run moves `verifying → awaiting_signoff`. **Failing** — a failed
  check, a failing or inconclusive verdict (`criteria_failed`), a
  permanently failed Evaluator, unmet conditions, a failed synthesis, or
  a final reserve that can no longer fund the Evaluator or the synthesis
  (`final_reserve_exhausted`; no fallback to ordinary capacity) — is one
  transaction: the Gate closes `failed` with the closed fact, the request
  ends `failed` with the same outcome, exactly one runtime-owned
  remediation Task is created on the root (`gateId` on the Task; linked
  to the failed criteria's and the open or violated Requirements, the
  pinned revision, the candidate and Evidence Artifacts), and the Run
  moves `verifying → running`; the root's batched `gate_result` turn
  remediates it together with any node-Gate Tasks (§4.6). Completion is
  never retried automatically: a later ordinary turn calls
  `request_completion` again, which is a new request and a new cycle on
  the then-current Snapshot. A closed Gate never changes.
- `operator_signoff`: opened by the passing transaction above on the same
  Snapshot, referencing the completion Gate, the request, the report
  Artifact, and the Evaluations, with no criteria of its own; one open
  per Run, one per successful request. Its one `signoff` Decision (kind
  `signoff`, `operator_required`, options `accept` and `request_changes`,
  no default policy, a typed subject naming the Run, the signoff Gate,
  the Snapshot, the completion Gate, the request, and the report; one
  per signoff Gate) carries no publish authority. The operator sees the
  Requirement statuses (waivers shown with their Decisions), the
  Evaluations, the report, and the Usage, and accepts or requests
  changes. Until the operator does, the Run performs nothing.

  **Resolution.** The signoff service (`server/src/execution/signoff.ts`,
  `RunSignoffService`) is the one boundary through which the
  operator-facing layer resolves the Decision, and it never accepts a
  caller-supplied Snapshot id, Changeset id, report Artifact id,
  Completion Request id, Run status, diff, or any Decision outcome other
  than the closed operation invoked: a caller names the Run, the Gate, the
  Decision, and (for a change request) the operator's message; everything
  else is resolved from rows. Its three operations are separated:

  - `inspect` is read-only. It returns a bounded **signoff projection**
    for an operator-facing API: the Run id and status; the signoff Gate
    and Decision ids and statuses; the verified Snapshot id; the
    Completion Request and passed completion Gate ids; the final-report
    Artifact's metadata; the pinned leaves' statuses with their waiver
    Decision ids; the completion Evaluation ids; the Run's Usage totals;
    the candidate Artifacts' metadata; the resolution, if any; the final
    references; the current blockers; and the allowed actions. It carries
    no Artifact bytes, verification output, transcript, provider message,
    continuation, worktree path, or Event history, writes nothing, and
    derives no status. A missing or inconsistent boundary is a typed
    refusal, never a guess.
  - Both `accept` and `request_changes` require, before writing anything:
    the Run `awaiting_signoff`; the named Gate the Run's open
    `operator_signoff` Gate; the named Decision that Gate's open,
    `operator_required` `signoff` Decision; the Decision subject naming
    this Run, this Gate, the passed `run_completion` Gate, the Completion
    Request, the verified Snapshot, and the final-report Artifact, all in
    agreement with the Gate row; the completion Gate `passed` and the
    request `passed` on it; the report an Artifact of the Run; the
    verified Snapshot of the Run and its Workspace; and **quiescence** —
    no active Invocation, Attempt, or capacity lease; no pending worktree
    cleanup obligation; no active reservation below the root node's own
    (ordinary or final-reserve); no `invocation` Changeset pending or in
    conflict; no open `node_exit` Gate or unresolved remediation Task; no
    other `operator_required` Decision open; no active Completion Request;
    every current Task completed or cancelled and every current non-root
    node ended; the pinned leaves `satisfied`, `waived`, or `retired` on
    the still-current Requirement revision; the integration Snapshot
    unchanged. Unexpected active state is an invariant violation
    (`active_state`): nothing is released, repaired, or written. Every
    refusal is a closed code (`SIGNOFF_REFUSAL_CODES`).
  - `accept` is one external read followed by one root transaction. The
    external read (§9.3) inspects the Integration Workspace through the
    finalization port outside every transaction. The transaction
    revalidates every row (the boundary, quiescence, and that the Run did
    not change during the inspection) and then, in order: stores the
    exact diff as a content-addressed `text/x-diff` Artifact; records the
    `final` Changeset; records the Signoff Resolution with outcome
    `accept` naming it; resolves the Decision (resolver `operator`,
    option `accept`); closes the Gate `passed`; sets `Run.finalSnapshotId`
    and `Run.finalChangesetId` and moves the Run
    `awaiting_signoff → completed`; clears the Conversation's active-Run
    reference when it still names this Run; every Event under one
    correlation chain. A database failure anywhere rolls every relational
    change back, compensates a newly written diff blob through the
    Artifact rollback mechanism, and leaves the boundary open. A repeated
    `accept` returns the canonical existing outcome from rows without
    inspecting the Workspace again and creates no second Artifact,
    Changeset, resolution, Decision resolution, Gate transition, or Run
    transition; a `request_changes` after acceptance is refused
    (`conflicting_resolution`).
  - `request_changes` requires a valid operator message — of the Run's
    Conversation, authored by the operator, non-empty, not consumed by
    another resolution — and, as a preflight, that the root node's
    effective ordinary allocation admits the follow-up turn or an
    Allocation Extension of exactly the shortfall fits the Run's effective
    ordinary capacity: when neither holds, the request is refused typed
    (`ordinary_capacity_insufficient`) before any write and the Run stays
    `awaiting_signoff`; the final reserve is never a fallback; after an
    ordinary Budget Increase the same request succeeds. In one root
    transaction it then: creates the `signoff_follow_up` Allocation
    Extension when one is needed; records the Signoff Resolution with outcome `request_changes`
    naming the message (by id; the prose is never copied into the row or
    an Event); resolves the Decision (resolver `operator`, option
    `request_changes`); closes the Gate `failed` with the precise reason
    `changes_requested` naming the Decision; moves the Run
    `awaiting_signoff → running`; prepares exactly one root Orchestrator
    Invocation — role `orchestrator`, purpose `decision_resolution`,
    the root position, continued from the previous root turn, ordinary
    root funding, no Task, no Gate — whose manifest carries the typed
    `signoff_resolution` input (the resolution, Gate, Decision,
    completion Gate, outcome, message id, verified Snapshot, and report,
    each verified against rows by the assembler) and the operator's
    message as the ordinary `operator_message` input, with the final
    report readable by id; and links that Invocation to the resolution.
    Workspace preparation inside the transaction uses the existing
    rollback-compensation contract. A repeated identical request replays
    the same outcome from rows and prepares nothing twice; a request for
    another message, or an `accept` after it, is refused
    (`conflicting_resolution`).

  **After a change request.** The follow-up turn may inspect the operator's
  request, work directly, revise the Execution Plan through later
  executable tools, and produce ordinary Changesets; a later ordinary
  turn calls `request_completion` explicitly, which is a new request and a
  new cycle on the then-current Snapshot with a new signoff boundary. The
  runtime never reopens the old completion Gate, mutates the old signoff
  Gate, reuses the old Completion Request, requests completion by itself,
  preserves `awaiting_signoff`, or spends the final reserve as ordinary
  work; the previous completion Gate, report, signoff Gate, Decision, and
  Signoff Resolution remain immutable history.

  **Signoff Resolution.** Each outcome is one append-only
  `signoff_resolutions` row (`sres_`): the Run, the signoff Gate, the
  Decision, the outcome, the operator message id (`request_changes`) or the
  final Changeset id (`accept`), the follow-up Invocation id
  (`request_changes`, linked once in the resolving transaction), and the
  resolution time. Exactly one exists per signoff Gate and per signoff
  Decision, a message answers at most one, identity and outcome are
  immutable, rows are never deleted, and the database (unique indexes and
  triggers) re-checks every relationship at insertion. The Decision and
  Gate rows alone could not carry the operator message or the follow-up
  link without reading manifest JSON or inferring the follow-up from the
  latest Orchestrator Invocation, which is why the explicit row exists.

  **Separation from publication.** Signoff accepts the verified Run result.
  The signoff service, the finalization port, and the completed Run never
  read the Target's current Snapshot, write the Target, fast-forward,
  merge, cherry-pick, rebase, push, create a Publication, choose a publish
  strategy, or create publish authorization; the Integration Workspace is
  retained (not deleted or released) because publication has not
  occurred. Publication (§9.4) is a separate, explicitly authorized
  operation.

Evaluations produced by Evaluator Invocations carry the Evaluator's
Invocation id and Agent Definition revision, so a reviewer of the Run can
see which judgments were made by which definition. An Evaluator never
evaluates an Artifact it produced.

**Pattern-internal verification is not a Gate.** The rounds of an
`evaluator_optimizer` node (§5.6) run the same deterministic-then-Evaluator
order over the node's Gate criteria, but their Evaluations carry the
explicit `optimizer_criterion` / `optimizer_verdict` context, belong to no
`gates` row, and never claim that a `node_exit` Gate passed. Under the
documented rule a passing round settles the node without a separate Gate
because the optimizer contract has consumed every one of its criteria on
the exact judged Snapshot and Artifact set; no criterion of such a node
is ever judged twice and the Gate engine never touches it. `single`,
`chain`, `route`, `parallel`, and `coordinator_worker` execute the
general `node_exit` Gate above; `run_completion` is executed by the
completion engine and opens `operator_signoff`, which the signoff service
resolves.

### 10.1 Deterministic Acceptance Criterion execution

Deterministic criteria are run by the Acceptance Criterion check service
(`server/src/execution/acceptance-checks.ts`, `AcceptanceCheckService`)
through the **Acceptance Criterion execution port**
(`ports/acceptance-criterion-execution.ts`, `AcceptanceCriterionExecutionPort`).
The runtime selects the criteria, the exact Snapshot, and the output bound,
and records every outcome; the port receives one request per command —
Run and Plan Node identity, the criterion, its command and expected exit
code, the round, the verified Snapshot identity with the Integration
Workspace it is derived from and a stable isolation key, the configured
`maxOutputBytes`, a deadline, and an abort signal — and nothing else: no
store, database handle, Blob Store, Artifact lookup, transcript, provider
continuation state, or Target write access. Its outcome is closed:
`exited` with the exit code, the bounded output bytes, and a `truncated`
flag, or `failed` with a closed infrastructure reason (`start_failed`,
`timed_out`, `aborted`, `workspace_unavailable`, `output_unavailable`)
and a bounded message.

Isolation: every command runs in a disposable view of exactly the
requested Snapshot, derived from the Run's Integration Workspace and keyed
by the isolation key; it never runs in the Integration Workspace, an
Invocation worktree, or the Target, whatever it writes is discarded with
the view, two executions never share a view, and a stale view under the
same key (a previous process died mid-check) is discarded before a fresh
one is created. Commands run outside every database transaction; the
service refuses to run inside one. Classification is fixed: the expected
exit code is a criterion `pass`, any other exit code a criterion `fail`,
and a port failure is neither — it records nothing and is returned typed
so a later pass retries. Raw command output lives only in its `text/plain`
Artifact (bounded at `maxOutputBytes`; a stored prefix is recorded as
`outputTruncated: true` on the command Evidence, never silently); Events,
outcomes, projections, diagnostics, and errors carry ids, exit status,
digest, byte size, and the truncation flag. The service is driven under
two typed scopes, an `evaluator_optimizer` round (`optimizer_round`) and a
Gate (`gate`, for a `node_exit` Gate of a node or the `run_completion`
Gate of the Run, which has no Plan Node); the scope fixes the
Evaluation's context or Gate, the isolation key, and the output
Artifact's title, and nothing else differs.

## 11. Agent Definitions

An Agent Definition is an immutable, versioned configuration. Each revision
records:

- **logical identity** — the stable `agd_` id shared by every revision of
  the same definition (for a file-sourced definition, derived from its
  source path and native name; for a built-in, fixed);
- **revision identity** — the `agdr_` id of this exact configuration;
- **content hash** — a digest of the resolved configuration;
- **provenance** — where it came from: `builtin`, `workspace_file` (path,
  Snapshot), or `conversation` (authored by the Orchestrator in a
  Conversation, with the `operator_choice` Decision that approved it);
- **model policy** — model id, effort, and context policy (maximum context
  occupancy before a `fresh` Attempt is preferred over `resumed`);
- **instructions**;
- **capabilities** — the provider-native tools and MCP servers it declares;
- **Tool Policy** — per-capability disposition `allowed`, `denied`, or
  `approval_required` (§6.4);
- **default limits** — the default Invocation allocation (cost, tokens,
  Attempts) and wall-clock limit.

Any change to any field produces a new revision with a new `agdr_` id and
hash under the same logical id. Invocations reference the revision; a
running Invocation is unaffected by a later revision.

**Provenance ownership.** When a revision is appended the store verifies
its provenance targets: a `workspace_file` revision must pin an existing
Snapshot and name a normalized definition file path
(`.claude/agents/<name>.md`, relative, POSIX separators, no `.` or `..`
segments); a `conversation` revision must name an existing Conversation and
an `operator_choice` Decision of that Conversation resolved by the
operator. Which Runs may execute a revision is decided by the
executable-revision resolver in `server/src/execution/`, used by Run
creation for the Orchestrator revision and by the plan-revision service
for every referenced revision: a `builtin` revision is executable
everywhere; a `workspace_file` revision only by a Run whose Workspace owns
the pinned Snapshot; a `conversation` revision only by a Run of that
Conversation. A revision that exists but belongs elsewhere is rejected —
before Workspace preparation or any canonical write at Run creation, and
as `invalid_agent_definition_revision` with one `execution_plan.rejected`
Event and no revision number for a plan proposal. The compiler is pure and
receives only resolved revision facts. There is no `trusted`
flag, no trust table, and no approval step for a definition as such; what a
definition may do is bounded by its capabilities and Tool Policy
intersected with role and Workspace policy, by worktree isolation, by
side-effect approval, and by Gates. A publisher-signature or package-trust
mechanism, if ever added, is a new feature with its own design.

## 12. Usage accounting

- Each Attempt writes one Usage row per provider result, tagged with the
  Attempt, Invocation, Plan Node, and Run. A `resumed` Attempt's rows
  include whatever the provider charges for the continued context.
- Roll-ups are computed on read by summing rows: Invocation total = its
  Attempts; Plan Node total = its Invocations; Run total = its Plan Nodes,
  the root node included. There is no separately stored total that can
  disagree with the rows.
- Reservation accounting (§7.6) uses the same sums for consumed amounts;
  reserved amounts come from `budget_reservations`.
- The operator-facing cost line always shows the Run total, and a per-node
  breakdown with reserved and unreserved capacity is available; the Run
  capacity projection exposes the base limits, the increases by partition,
  the effective limits, and each account's active committed, released
  consumed, and available amounts, and a Plan Node allocation projection
  exposes its original allocation, its extensions, its effective
  allocation, and its available capacity. `budget_increase.recorded` and
  `allocation_extension.created` carry ids, partition or trigger,
  quantities, Plan Node and reservation ids, and timestamps only.

## 13. Events and projections

- Every canonical state change writes exactly one Event in the same
  transaction as the change. Event types follow the glossary convention.
- The UI subscribes to the Event stream from a sequence number and rebuilds
  its views from Events plus point reads of canonical stores. There is one
  stream per server; clients filter by Workspace, Conversation, or Run.
- Streaming provider output (partial text, tool calls in progress) is
  delivered on the same stream as transient Events that are not journaled;
  they carry the Attempt id and nothing else about the system.
- No Event, log line, or API response carries a provider continuation
  payload or storage key contents; at most the existence of an index row is
  exposed. Likewise no Event, failure detail, diagnostic, or manifest
  carries the bytes of an intercepted tool call (§6.4): only its digest,
  its Artifact id, and safe metadata. A `runtime_tool_call.committed`
  Event likewise carries the call's digest and safe result, never its
  input.

## 14. Failure model

| Failure | Handling |
|---|---|
| Provider error, transient | New Attempt (`retry`) after backoff, within the Invocation's Attempt allocation. |
| Provider error, permanent | Invocation `failed`; Pattern decides node outcome. |
| Provider capacity refused by the governor | Attempt not started; Run `waiting` (`provider_capacity`); the scheduler retries when the governor signals capacity or the retry-after time passes. |
| Invocation returns an invalid result | New Attempt (`retry`) with the validation error in the rendering. |
| Invocation exhausts its allocation | Invocation `failed` with reason `allocation_exhausted`; no retry; its Task, if any, `failed`. |
| Plan Node exhausts its allocation | Per `onAllocationExhausted`: `fail` (`allocation_exhausted`), `wait` (Run may enter `waiting`/`budget`), or `extend` (exactly the shortfall as an Allocation Extension from effective ordinary Run capacity, atomically with the child; otherwise as `wait`). |
| Run Budget has no unreserved capacity for work that must proceed | Run `waiting` (`budget`); the operator approves an ordinary Budget Increase (the next pass resumes the Run and funds the same work) or cancels. Never `failed` on this alone. |
| Crash between an Allocation Extension and the child it funds | Impossible to observe: both are written in one root transaction; after restart either both exist or neither, and the next pass re-derives the shortfall from rows. |
| Crash during a `budget_increase` resolution | The Decision resolution and the increase commit together or not at all; a retried `approve` replays the recorded resolution, a conflicting retry is refused, and no Run row, Usage, or Invocation changes. |
| Plan Node fails | Successors `skipped` (or `ready` with the failure if opted in); a `node_result` Orchestrator Invocation is created. |
| `join` fan-in policy not met | Join `failed` with `join_fan_in_failed`, its index Artifact recorded on the failure Event; handled as a Plan Node failure. |
| `parallel` items do not satisfy `requireAll` | Node `failed` with `parallel_items_failed` after every item ended and every successful Changeset was integrated; the index Artifact (failed items included) is recorded on the failure Event. |
| `route` selector yields no valid label | Node `failed` with `route_selection_failed`: an unmapped or superseded selector Decision, or an Evaluator selection Invocation that failed after its permitted Attempts (an unbound label is an invalid result, retried within them). |
| Task fails or is blocked inside `coordinator_worker` | Task `failed`/`blocked`; dependents become `blocked`; the blocker joins the frontier. One consolidated `replan` turn is created only when no Worker is active or runnable and nothing can be integrated; blockers arising while a turn is active wait for the next turn. A replan without canonical progress fails the node with `coordinator_no_progress`; a frontier that outlives the turn bound fails it with `coordinator_invocations_exhausted` (§5.5). |
| `decompose` completes without an accepted proposal | Node `failed` with `coordinator_no_progress`; nothing was created. |
| `evaluator_optimizer` deterministic criterion fails | The round ends: no later command runs, no Evaluator is invoked, the runtime records the round's `fail` verdict with the failing Evaluation as Evidence; the next producer round follows (with the feedback), or the node fails with `optimizer_rounds_exhausted` at `maxRounds` (§5.6). |
| `evaluator_optimizer` Evaluator returns `fail` or `inconclusive` | As above; a non-final evaluate-only node ends `succeeded` as a control node so its `retry(round)` edge activates, and its candidate is not accepted. |
| `evaluator_optimizer` final round without a pass | Node `failed` with `optimizer_rounds_exhausted`; the last verdict and its Evidence remain the canonical diagnostic references; successors are `skipped`. |
| `node_exit` Gate deterministic criterion fails | The checks stop at that criterion, no Evaluator is invoked, the Gate closes `failed` on it, and its one remediation Task is created (or the node fails with `gate_cycles_exhausted` at the Run's `maxNodeGateCycles`); the node stays `running` (§10). |
| `node_exit` Gate Evaluator returns `fail` or `inconclusive` | Every verdict is recorded; the Gate closes `failed` on exactly those criteria with its remediation Task, as above. |
| `node_exit` Gate Evaluator fails permanently | The Gate closes `failed` with the `evaluator_failed` fact (no verdict invented, no Task) and the node fails with `gate_evaluator_failed`. |
| Root `gate_result` turn fails, ends without completing, or reports a remediation Task blocked | The affected Tasks end (`failed` under the turn, `cancelled` otherwise) and each affected node fails with `gate_remediation_failed`; the root and the Run stay `running` (§4.6). |
| Coordinator `replan` makes no progress on its node's failed Gate | Node `failed` with `coordinator_no_progress`; the remediation Task stays unaddressed and no further Gate opens (§5.5). |
| `request_completion` preflight fails | The call is rejected with the closed codes inside its transaction; no Completion Request, Gate, or Event is written; the turn continues (§6.4). |
| Requesting turn fails, is cancelled, or ends without completing | The Completion Request is cancelled (`requesting_turn_failed`) — before the Run fails when the Invocation failed — and no Gate opens (§6.4). |
| Preconditions drift between the accepted request and its beginning | The request is cancelled with the exact preflight codes (`preconditions_changed`); the Run stays `running`. |
| `run_completion` deterministic criterion fails | The checks stop at that criterion, no Evaluator is invoked, the Gate closes `failed` on it, the request fails, one remediation Task is created on the root, and the Run returns to `running` (§10). |
| `run_completion` Evaluator returns `fail` or `inconclusive` | Every verdict is recorded; the Gate closes `failed` on exactly those criteria, as above; the affected leaves are `violated`. |
| `run_completion` Evaluator fails permanently | The Gate closes `failed` with `evaluator_failed` (no verdict invented), as above. |
| A pinned leaf has no criteria, a Task is unfinished, a Decision is open, a Changeset or node Gate is unsettled, a node is unfinished, or the Snapshot moved | The Gate closes `failed` with `conditions_unmet` naming the exact typed conditions, as above. |
| Final synthesis returns an invalid result | Ordinary Attempt retry within the synthesis Invocation's final-reserve allocation. |
| Final synthesis fails permanently or returns a Changeset | The Gate closes `failed` with `final_synthesis_failed`; no report Artifact exists; as above. A Changeset from a synthesis is an invalid result. |
| Final reserve cannot fund the completion Evaluator or the synthesis | The Gate closes `failed` with `final_reserve_exhausted` naming the use; nothing is fabricated and no ordinary capacity is used; as above. |
| `run_completion` cycles exhausted | The next `request_completion` call is refused (`run_completion_cycles_exhausted`); the Run stays `running`. |
| Integration Workspace drifted or unobservable at signoff acceptance | Refused typed (`workspace_drifted`, `finalization_failed`) before any write: no Decision resolution, Gate closure, Artifact, Changeset, or Run transition; acceptance stays retryable and the operator may request changes (§9.3, §10). |
| Unexpected active state at signoff (an Invocation, Attempt, lease, reservation, cleanup obligation, Changeset, node Gate, remediation, Decision, request, Task, Requirement, or moved Snapshot) | Refused typed (`active_state`); nothing is released, repaired, or written (§10). |
| Root allocation cannot fund the follow-up turn of a change request | The root's `extend` policy funds it from effective ordinary Run capacity in the resolving transaction; when no extension fits, refused typed (`ordinary_capacity_insufficient`) before any write, the Run stays `awaiting_signoff`, and the request may be retried after an ordinary Budget Increase; the final reserve is never used (§10). |
| Database failure inside the signoff transaction (Artifact, Changeset, resolution, Decision, Gate, Run, active-Run clearing, or COMMIT) | Everything rolls back, a newly written diff blob is compensated, the boundary stays open, and the canonical failure is rethrown; the next call starts over from rows (§10). |
| Crash after a signoff resolution committed (response lost, follow-up not executed, follow-up result not integrated, restart before settlement) | The resolution, Decision, Gate, Run, and follow-up rows are the record: a repeated call replays the canonical outcome, and the scheduler executes and settles the follow-up through the ordinary root path; nothing is repeated (§10, §14 "Server restart"). |
| Crash during a completion cycle (between the request, the turn's settlement, the Gate opening, a check, the Evaluator, the derivation, the synthesis, the passing or failing transaction, or the remediation turn) | Every step is one transaction or one external step recorded once; the next pass finds the request, the open or closed Gate, the recorded checks, the existing Evaluator, statuses, synthesis, report, Task, or signoff boundary, and repeats nothing (§10). |
| Crash during a Gate cycle (between opening, a check, the Evaluator, settlement, the remediation turn, or a reopened cycle) | Every step is one transaction or one external step recorded once; the next pass finds the open Gate, the recorded checks, the existing Evaluator or Task, or the closed Gate, and repeats nothing (§10). |
| Deterministic check cannot run (timeout, abort, lost view, lost output, failed start) | Infrastructure failure: nothing recorded, no Evaluation fabricated, the pass stops typed (`verification_failed`); the next pass reruns exactly the unrecorded checks (§10.1). |
| Crash between a check's command and its record | The command reruns in a fresh view (the stale one is discarded); the output Artifact and its Evaluation are recorded once, in one transaction. |
| Runtime-tool call fails or crashes | A failure inside the call's transaction commits nothing and returns `failed` with a bounded message and one `runtime_tool_call_failed` diagnostic; a crash after the commit leaves the row, and the retry or approval successor replays it by digest instead of repeating the effect (§6.4). |
| Changeset conflict | Changeset `conflict`; Task with a bounded report Artifact created for the node owner; node (and, when nothing else can proceed, the Run) `waiting` with `integration_conflict`; applied once more when the Task completes; a second conflict, or a failed or cancelled Task, fails the node with `integration_conflict` (§9.2). |
| Crash between an external Changeset application and its record | The Changeset stays `pending`; the next pass applies it again and the port reports the application that already holds; the record is written exactly once (§9.2). |
| Crash during a scheduler pass | Nothing is lost: every action is one transaction; the next pass re-projects from rows, retries interrupted Attempts through recovery, and repeats no Invocation, Handoff, integration, or provider call (§7.1). |
| Publication preparation is refused (unsupported or unavailable strategy, candidate conflict, invalid candidate) | Target untouched; Publication `failed` with the closed structured fact and its report Artifact; the operator may retry through a new exact `publish` Decision or start a new Run (§9.4). No Invocation is created. |
| Publication candidate verification fails | Target untouched; Publication `failed` with `verification_failed` naming the criteria; as above (§9.4). |
| Target changed between preparation and apply | The compare-and-swap definitely did not apply; Publication `failed` with `target_changed`; Target untouched by this Publication (§9.4). |
| Publication provider unavailable (prepare, verify, or apply result unknown) | Nonterminal state is kept — `requested`, `prepared`, or `applying` — and recovery retries or reconciles through the idempotent port operations; no terminal outcome is fabricated (§9.4). |
| Crash after the atomic Target update and durable receipt, before SQLite records success | The Publication stays `applying`; the retried apply finds the durable receipt and reports the applied identity — even when the Target has since moved again — and success is recorded exactly once (§9.4). |
| Crash during a Publication (between the Decision, the resolution-plus-creation transaction, external preparation, the prepared facts, the deterministic checks, `verified`, `applying`, the apply, the success or failure record, or the staging release) | Every step is one transaction or one idempotent external step recorded once; `reconcileOutstanding` re-drives the Publication from canonical rows and the provider's durable state, repeating nothing (§9.4). |
| Publication staging release fails | The terminal outcome never changes; the obligation stays `pending` with a bounded diagnostic and recovery retries until `released` (§9.4). |
| Provider continuation payload missing, expired, or corrupt | The Attempt starts `fresh`; no other effect. |
| Approval claim transaction fails (callback or COMMIT) | No use row, no Event, no execution; the adapter learns `failed` and ends the Attempt as a tool failure with a bounded message; one `tool_call_authorization_failed` diagnostic; the retry may claim again. |
| Provider fails after an approval claim | The use stays committed; the retry receives the same manifest but the grant is refused; repeating the call needs a new `side_effect_approval` Decision. |
| Crash after an approval claim, before the external call | The approval is conservatively consumed (recovery repairs nothing); the retry cannot repeat the call under the original Decision and intercepts it again for a new approval. |
| Server restart | Recovery (`server/src/execution/recovery-service.ts`) runs once at startup in one transaction: every `pending` or `running` Attempt of the previous process is marked `interrupted` with its consumed Attempt kept and its durable retry decision recorded; every stale lease is released and the governor is rebuilt from canonical lease state; an Invocation with no Attempt remaining is `failed` with `allocation_exhausted` (its Task failing likewise); every other interrupted Invocation is left `running` with durable retry eligibility under the same Invocation-wide deadline (§7.6), `resumed` only where §6.6 permits and `fresh` when the payload is absent or invalid. After that transaction recovery retries, outside any transaction, every worktree cleanup obligation still `pending` on a terminal Invocation (§9.1). Recovery is idempotent, reads no transcript and no provider message, and executes nothing: recoverable work is returned for an explicit execution call, which the scheduler drives. The worktree of a retry-eligible Invocation is preserved and reattached by Invocation id; reservations are read as persisted. |
| Operator cancels a Run | All Attempts interrupted, all nodes `cancelled`, all reservations released, Integration Workspace left in place, Run `cancelled`. |
| Operator pauses a Run | The scheduler stops starting Attempts for that Run; running Attempts are allowed to finish (`soft`) or interrupted (`hard`); Run `waiting` with reason `operator`. Other Runs are unaffected. |

## 15. Invariants

The implementation is accepted when every one of these holds and is covered
by a test.

1. **Single-agent execution is the default.** A Run's Execution Plan begins
   as one `single` node (the Orchestrator). Any additional node is an
   explicit source revision by the Orchestrator with a stated Pattern.
2. **The Orchestrator may work directly.** The Orchestrator's Agent
   Definition grants read, write, and shell capabilities, and work it does
   in its own Invocations is recorded (Changesets, Artifacts, Usage)
   exactly like any other Invocation's.
3. **Patterns are typed Execution Plan nodes, not persistent agent chat
   topologies.** A Pattern exists only as the `pattern` field of a
   `kind: pattern` Plan Node and as an expression in a source revision. No
   table, object, or process represents a group of agents outside a Plan
   Node's lifetime, and no agent addresses another agent.
4. **Supported patterns are exactly** `single`, `chain`, `route`,
   `parallel`, `coordinator_worker`, and `evaluator_optimizer`. No other
   value is accepted, `join` is a deterministic node kind and not a
   Pattern, and none of the six is implemented by delegating ordering or
   fan-in to an agent.
5. **The deterministic runtime owns scheduling, retries, dependencies,
   waiting, progress, budgets, and fan-in.** No runtime tool exposes any of
   these to an agent except as read-only facts; no prompt asks an agent to
   perform any of them.
6. **Agent transcripts are diagnostic records, never canonical state.** No
   code path reads a transcript Artifact or a provider continuation payload
   to make a decision, build a manifest, recover from a restart, or
   compute a projection.
7. **Workers do not communicate peer-to-peer by default.** There is no
   message tool between Invocations. A Worker's only outputs are Artifacts
   and its typed result; its only inputs are its Context Manifest.
8. **Handoffs reference Artifacts and contain minimal routing metadata.** A
   Handoff row holds source, target, Task ids, Artifact ids, a status, and a
   summary bounded at 500 characters. It holds no other fields.
9. **Requirements, Decisions, Tasks, and Artifacts are canonical objects
   referenced by id.** Every Context Manifest, Handoff, Evaluation, and
   result refers to them by id; the runtime rejects results that reference
   ids that do not exist in the Run.
10. **All child Usage is included in Run totals.** The Run total is the sum
    of every Usage row tagged with the Run id, and every Attempt of every
    Invocation of every Plan Node writes rows tagged with that Run id;
    final-reserve Invocations are included once, through the root node, and
    charged to their own Run-level reservation rather than the root's.
11. **Deterministic verification precedes LLM evaluation.** In every Gate
    and in the `evaluator_optimizer` Pattern, deterministic Acceptance
    Criteria are run first, in stable criterion id order, stopping at the
    first failure, and an Evaluator is not invoked while a deterministic
    criterion is failing. Every optimizer round verdict is one canonical
    `optimizer_verdict` Evaluation naming its node, round, judged Snapshot,
    and judged Artifacts (one per node and round, database-enforced), and
    a `retry(round)` edge activates from that fact alone. Every
    `node_exit` Gate cycle is one `gates` row with its ordinal, pinned
    Snapshot, candidate, and criteria; it has at most one active Evaluator
    Invocation, one Evaluation per criterion, and, once failed, exactly one
    remediation Task; closed Gates never change; and a node with Gate
    criteria succeeds only through a `passed` Gate (all database-enforced).
12. **Completed coding Runs must finish on a verified integration state.** A
    Run with `kind: code` cannot leave `verifying` for `awaiting_signoff`
    unless its `run_completion` Gate — one `gates` row per cycle with its
    ordinal, pinned Snapshot, pinned Requirement revision and leaves,
    criterion set, and candidate — closed `passed`: every deterministic
    criterion passed through the check service and every evaluated
    criterion passed by exactly one final-reserve Evaluator on the
    integration Snapshot that the operator is then asked to accept, with
    the Evidence stored as Artifacts, every structural condition met, and
    one typed final report serialized to one canonical Artifact; the
    `operator_signoff` Gate and its one `signoff` Decision open in that
    same transaction, one per Run and per successful request. Any other
    ending of `verifying` is `running` with exactly one remediation Task,
    and completion is never retried without a new `request_completion`
    call (all database-enforced where a row expresses it).
13. **Requirement satisfaction derives from Acceptance Criteria and
    Evidence.** No tool, result, or Task transition sets a Requirement to
    `satisfied`; only a Gate's recorded Evaluations do, through the
    runtime's derivation at the `run_completion` Gate, each change
    referencing the Gate and its Evaluation Evidence and no change written
    for a status that already holds. `waived` is set
    only after the operator resolves a `requirement_waiver` Decision; no
    policy, tool, or setting can resolve one.
14. **Coordination depth is one.** A Coordinator cannot revise the plan,
    create Invocations, or address Workers; a Worker cannot propose or
    create anything; a `coordinator_worker` expression cannot contain a
    composite operand or another `coordinator_worker`.
15. **The persisted plan is flat and compiler-written.** Every accepted
    source revision compiles to a graph of Plan Nodes and typed Plan Edges
    with no nesting, no cycles, and bounded size, recorded as an explicit
    immutable membership and revision-owned edges; only the plan-revision
    service, through the compiler (and Run creation for the root and
    revision 1), writes `plan_nodes`, `plan_revision_nodes`, `plan_edges`,
    and `plan_node_requirements`; Coordinator-proposed Tasks never change
    them; the current executable graph is read from the latest accepted
    revision and never inferred.
16. **The Target is never modified by a Run.** Only a Publication of a
    `completed` Run, authorized by its own operator-resolved `publish`
    Decision, writes to the Target (§9.4): the candidate is prepared and
    deterministically verified without modifying the Target, `applying` is
    durably persisted before the external call, and the one Target
    mutation is an idempotent atomic compare-and-swap against the
    persisted Target-before state with a durable provider receipt — no
    force update, at most one Target mutation per Publication, at most one
    succeeded Publication per Run, and a definite not-applied failure when
    the Target changed. Signoff acceptance reads the Integration Workspace
    through a read-only port, writes the Target nothing, and grants no
    publish authority; no Invocation or provider adapter can reach the
    Target, and no standing or automatic publish authorization exists.
17. **Provider resumption is optional and non-canonical.** Every Attempt
    can start `fresh` from its Context Manifest; deleting every
    continuation payload and index row changes no outcome; no payload
    appears in a canonical row, Event, log, or API response.
18. **The resource governor is deterministic backpressure.** It never
    invokes a model, emits text, or holds semantic Run state; refusal is a
    structured reason on a `waiting` Run.
19. **No Decision resolves silently.** Every resolution — operator,
    Orchestrator, or `use_default_after_deadline` — writes a
    `decision.resolved` Event, and a policy resolution requires a recorded
    recommendation, deadline or condition, rationale, and affected ids.
20. **One Invocation per logical turn.** Every Invocation has one immutable
    Context Manifest and one `purpose`; new logical input creates a new
    Invocation, never an Attempt; Attempts are only `initial` or `retry`;
    at most one Orchestrator Invocation per Run and one Coordinator
    Invocation per `coordinator_worker` node is active at any time; routine
    progress creates neither.
21. **Plan Node Requirement scope is exact, pinned, and immutable.** A
    `pattern` node's scope is the exact leaf set expanded from its
    expression's roots at one pinned Requirement revision, persisted in
    `plan_node_requirements`, and never changed by a later Requirement
    revision; Coordinator-proposed Tasks reference a non-empty subset of
    it.
22. **Budget allocation is explicit and atomic.** Every `pattern` Plan
    Node and every Invocation has an `active` or `released`
    `budget_reservations` row created before it becomes runnable; the root
    node's allocation is an explicit initial amount, never the Run Budget;
    a reservation is created only when the parent's limit minus its active
    reservations and released actual consumption covers it, and released
    consumption is actual — never clamped — so an overrun is recorded as
    negative available capacity rather than hidden; an active child is
    charged `max(reserved, actual)` so an overrun is visible before release;
    the persisted final reserve is a separate partition that ordinary
    reservations never consume, reachable only by a `final_synthesis` or
    `run_completion` Invocation's own `Run → Invocation` reservation, and
    both partitions are bounded by the global Run Budget; Budget exhaustion
    places a Run in `waiting`, never `failed`. The base Budget, the base
    final reserve, and every reservation's own amounts are immutable;
    growth exists only as append-only `budget_increases` (one per approved
    operator `budget_increase` Decision) and `allocation_extensions`
    (exactly the shortfall of the child created in the same transaction,
    from effective ordinary capacity, never from the final reserve);
    effective limits are derived from those rows on read and never
    stored; neither record creates Usage, mutates a Run, Invocation,
    Usage, or reservation row, or changes a deadline or concurrency limit;
    and no model, policy, or runtime tool can create either.
23. **Task states are complete and runtime-owned.** A Task is always in
    exactly one of `pending`, `ready`, `running`, `blocked`, `completed`,
    `failed`, `cancelled`; only the runtime transitions it; a `failed` Task
    is never reclassified `cancelled`.
24. **Side-effect approval is exact-digest and at-most-once.** An
    `approve_once` resolution authorizes exactly one tool and canonical
    call digest at most once across the Run: the grant in the immutable
    manifest is eligibility input only; a call executes only after the
    runtime claimed the grant in a committed `approved_tool_call_uses`
    row (one per Decision, enforced by the database); the claim survives
    provider failure, retries, failed finalization, and restart and is
    never repaired, deleted, or reconstructed from Events; no adapter
    holds correctness-critical consumption state; and no raw call bytes
    appear outside the call Artifact.
25. **Runtime-tool calls are canonical, bounded, and replayed, never
    repeated.** A mutating runtime-tool call is executed only through the
    per-Attempt port, only for a tool in the effective callable set, in
    its own short root transaction outside provider execution; an
    accepted call is one append-only `runtime_tool_calls` row (unique per
    Invocation, tool, and digest; at most one accepted `propose_tasks`
    per Invocation and per logical turn) that a retry or approval
    successor replays by digest; a rejected call writes nothing; a Task
    proposal is validated as one atomic batch against the node's exact
    scope, bounds, and allocation; the Coordinator proposes and the
    runtime alone creates, orders, funds, integrates, and fans in.
26. **Run completion is requested once, verified by the runtime, and
    never inferred.** `request_completion` is callable only by the root
    Orchestrator's ordinary turn, refuses transactionally with closed
    codes, and an accepted call is exactly one `completion_requests` row
    with a closed lifecycle (at most one non-terminal per Run, never
    deleted, one Event per transition, replayed by the same turn, never
    reconstructed from Events); one request has at most one
    `run_completion` Gate; the criterion set, candidate, Snapshot, and
    revision are pinned on the Gate; the final synthesis is read-only,
    funded from the final reserve, and its report is the only
    model-authored completion output — no model sets a Requirement
    status, closes a Gate, ends a request, resolves signoff, or changes
    the Run's state.
27. **Signoff is resolved once, by the operator, from rows.** The
    `operator_signoff` Gate ends only through the signoff service's
    `accept` or `request_changes`, each recorded as exactly one
    append-only Signoff Resolution per Gate and per Decision
    (database-enforced), never inferred from prose, a result, a manifest,
    or an unresolved Decision. Acceptance requires quiescence and an
    Integration Workspace that still holds exactly the verified Snapshot,
    records the final Snapshot by reference and one `final` Changeset
    (kind `final`, `recorded`, base to final, exact `text/x-diff` bytes,
    one per Run, none before acceptance) in one transaction with the
    Decision resolution, Gate closure, and Run completion, and completes
    a Run only with both final references (database-enforced). A change
    request records the operator's message by id, fails the Gate
    `changes_requested`, reopens the Run, and prepares exactly one
    ordinary-funded root `decision_resolution` turn linked once; it never
    requests completion or spends the final reserve. Identical replays
    return the canonical outcome; conflicting replays are refused; a
    drifted or unobservable Workspace is refused before any write.

## 16. Non-goals

- No benchmark or evaluation harness for orchestration quality. The
  implementation ships correctness and integration tests only.
- No numeric quality scores anywhere in the model.
- No agent-to-agent messaging, mailbox, or routing surface.
- No canonical dependence on provider session state, and no provider
  payload in any canonical row.
- No nested persisted Plan Nodes and no nested Runs; composition is
  compiled flat.
- No long-lived Invocation: an Invocation never receives new logical input
  after creation.
- No global pause product state; backpressure is the resource governor.
- No runtime behaviour selected by a feature flag.
