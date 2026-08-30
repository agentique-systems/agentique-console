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
readiness evaluator, the Handoff router, the Changeset integration
service, the `single` and `chain` Pattern runners, the scheduler, and in
later phases the remaining Pattern runners, joins, and Gates — lives behind
`server/src/execution/`, which depends only on the core package, the
persistence boundary, the provider-neutral adapter contract under
`server/src/provider/` (§6.5), and narrow ports for capabilities
implemented in later phases (the Workspace preparation port, §3, the
execution-workspace port, §9.1, and the integration-workspace port,
§9.2). The provider boundary
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
| Provider continuation index | Provider adapter | `provider_continuations` (index) + adapter-owned payload store | Attempt inspector (existence only) |
| Context Manifest | Runtime | `context_manifests` | Invocation inspector |
| Evaluation, Gate | Runtime | `evaluations`, `gates` | Gate view |
| Snapshot, Changeset | Runtime | `snapshots`, `changesets` | Run view |
| Publication | Runtime (publish action) | `publications` | Run view |
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
  together, the allocation never being the whole Budget. A preparation
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
  `budget` (the Run Budget has no unreserved capacity for work that must
  proceed), `provider_capacity` (the resource governor has no lease to
  grant), `integration_conflict` (a Changeset conflict Task is open, §9.2),
  `operator` (the operator paused the Run). The scheduler records the
  Run `waiting` only when no action remains, no Attempt is executing, and
  no ready node is merely held back by the concurrency limit; the reason
  is the earliest waiting node's reason, and the Run resumes through an
  explicit `resume_run` action when that exact reason has cleared.
- `verifying`: the Orchestrator has requested completion; the runtime is
  executing the `run_completion` Gate.
- `awaiting_signoff`: the `run_completion` Gate passed; the
  `operator_signoff` Gate is open.
- `completed`: the operator accepted the verified final Snapshot. Terminal.
  A completed Run may then be published (§9.4); publishing does not change
  the Run's state.
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
| `retry(round)` | A `sequence` edge into a later unrolled round of an `evaluator_optimizer` expression; active only when the source's Evaluation failed. When the Evaluation passed, every later round is `skipped`. |

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
(`server/src/execution/readiness.ts`) over the current graph alone: given
the nodes and edges of the latest accepted revision it returns, per node,
`remain_pending`, `become_ready`, `become_skipped` (with the cause and the
failed predecessors), or the observation that the node is already ready,
active, or terminal. It reads no clock, no store, and no Invocation. Work
the runtime does not yet support — `join` nodes, `branch`, `fan_in`, and
`retry` edges, `sequence` edges out of a `route` node, and the `route`,
`parallel`, `coordinator_worker`, and `evaluator_optimizer` Patterns — is
returned as a typed deferral, never as readiness and never as success.
Nodes are considered in membership order.

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
   `maxTasks`). Its operands must be leaves. It may not be an operand of
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
| `decision_resolution` | A Decision the Orchestrator requested or that affects the Run was resolved or superseded. |
| `gate_result` | A `run_completion` or `node_exit` Gate produced a result the Orchestrator must act on. |
| `plan_revision` | The Orchestrator's previous Invocation ended by returning `blocked` on a rejected plan revision or by requesting continuation after a revision, and the compiled outcome is now available. |
| `publication_result` | A Publication succeeded or failed. |
| `final_synthesis` | The `operator_signoff` Gate opened, or the Run reached a terminal state, and the Orchestrator produces the final report. |

There is never more than one active Orchestrator Invocation for a Run.
Inputs that arrive while one is active are queued; when it ends, the
runtime creates exactly one new Invocation whose Context Manifest carries
every queued input and whose `purpose` is the first in the table order
above that applies. Routine progress — an Invocation starting, a Task
changing state, Usage accruing, a lease being granted — never creates an
Orchestrator Invocation. Each Orchestrator Invocation records
`continuedFromInvocationId` pointing at the previous one; its initial
Attempt may be `resumed` across that boundary under §6.6.

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
- Deterministic Acceptance Criteria on the node's `node_exit` Gate are
  checked by the runtime before the node reaches `succeeded`.
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
  the node becomes `succeeded` with the result's output Artifacts (or
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

- Invocations: 0 or 1 selector (`evaluator`, `select`), then 1 inline branch (`worker`, `step`) when the selected branch is a leaf
- Input: the node manifest; the branch additionally receives the selection Evaluation reference
- Output: the inline branch's result Artifacts, or nothing when the selected branch is composite (its subgraph's exits deliver)
- Fan-in: none
- Failure: a selector that returns no valid label fails the node

### 5.4 `parallel`

A static, non-empty list of independent leaf items, each one Invocation,
run concurrently up to the node's `maxConcurrency`. The runtime collects
every item result into one index Artifact (the ordered list of item
results with their Artifact ids and outcomes) and optionally runs one
aggregation Invocation over that index inside the node. Composite items
never live in a `parallel` node; the compiler lifts them into subgraphs
that fan into a `join` node (§4.4).

- Invocations: one `worker` (`step`) per item, then 0 or 1 aggregation `worker` (`step`)
- Input: each item receives the node manifest plus its item payload; the aggregation receives the manifest plus a Handoff to the index Artifact
- Output: the aggregation's result Artifacts, or the index Artifact when there is no aggregation
- Fan-in: the runtime waits for every item to reach a terminal state, then writes the index
- Failure: an item that fails after its Attempts is recorded as failed in the index; whether that fails the node is a node option (`requireAll`, default true)

Items never see each other's results. A `parallel` node whose items are
not independent is a plan error; the Orchestrator should use `chain`.

### 5.5 `coordinator_worker`

One Coordinator role proposes Tasks; the runtime creates Worker Invocations
for them; a Coordinator synthesizes the results. The node is bounded and
the coordination depth is one by construction.

Roles and what each may do:

- A **Coordinator Invocation** proposes Tasks through `propose_tasks` and
  returns through `return_result`. It does not revise the Execution Plan,
  does not create Invocations, and does not call, message, or address
  Workers. It never sees a Worker except as a Handoff the runtime delivers.
- The **runtime** validates every proposed Task (§5.5.1), reserves a Worker
  Invocation allocation for it from the node's allocation, persists it, and
  schedules one Worker Invocation per Task when the Task becomes `ready`.
  The runtime records each Worker result as a Handoff on the node and
  decides when a new Coordinator Invocation is created.
- A **Worker Invocation** (purpose `task`) executes exactly one Task and
  returns a result. A Worker cannot propose or create Tasks, Workers,
  Coordinators, or Plan Nodes, and cannot address any other Invocation.

The node owns separate Coordinator Invocations, each with its own immutable
Context Manifest and one purpose, created only on these occasions:

1. `decompose` — once, at node start, to produce the initial Task set.
2. `replan` — when a Task becomes `blocked` or `failed` and the runtime
   cannot resolve it deterministically (a retry within the Task's Attempt
   allocation is deterministic; a change in what should be done is not).
   The Coordinator may propose replacement Tasks, cancel `pending`,
   `ready`, or `blocked` Tasks, or fail the node.
3. `synthesize` — once, when every Task is `completed` or `cancelled`, to
   produce the node's output.

There is never more than one active Coordinator Invocation for a node.
Blockers that arise while one is active are queued and delivered in the
next `replan` Invocation's manifest. Routine progress — a Task completing,
a Worker starting, Usage accruing — never creates a Coordinator Invocation.
The runtime advances the Task graph on its own. Each Coordinator Invocation
records `continuedFromInvocationId` pointing at the node's previous
Coordinator Invocation; its initial Attempt may be `resumed` across that
boundary under §6.6.

- Invocations: `coordinator` Invocations with purposes `decompose`, `replan` (0..n), `synthesize`; N `worker` Invocations with purpose `task` (one per Task)
- Input: a Coordinator Invocation receives the node manifest and, for `replan` and `synthesize`, Handoffs to every Worker result since the previous Coordinator Invocation; each Worker receives the manifest restricted to its Task plus Handoffs to the Artifacts the Task lists as inputs
- Output: the `synthesize` Invocation's result Artifacts
- Fan-in: performed by the runtime as described above
- Bounds: node limits cap `maxTasks`, `maxConcurrentWorkers`, and `maxCoordinatorInvocations`; the node allocation caps total cost, tokens, and Attempts
- Failure: a `replan` Invocation failing the node, exhausting `maxCoordinatorInvocations`, or a node allocation exhausted under policy `fail` fails the node

Tasks proposed inside a `coordinator_worker` node are Tasks of the Run (they
appear in the ledger, reference Requirements, and carry Evidence) and are
tagged with the node id. They are internal execution records of the node:
they do not appear in the source Execution Plan and their existence never
changes a Plan Node, Plan Edge, or scope row.

#### 5.5.1 Task proposal validation

The runtime accepts a proposed Task only when all of the following hold;
otherwise the proposal is rejected in the tool result with the failing
rule, and nothing is persisted:

- it is well-formed (subject, inputs by Artifact id, dependencies by Task id
  within the node, expected outputs);
- it references a non-empty subset of the node's exact persisted
  Requirement scope (`plan_node_requirements`), every reference naming the
  node's pinned Requirement revision;
- it references no Requirement outside that scope, none from another
  Conversation, none at a different revision, none that is `retired`, and
  no internal (non-leaf) Requirement;
- the node's dependency graph stays acyclic and the Task count stays within
  `maxTasks`;
- a Worker Invocation allocation for it can be reserved from the node's
  unconsumed, unreserved allocation (§7.6).

### 5.6 `evaluator_optimizer`

One producer Invocation and one Evaluator Invocation alternate until the
Evaluator passes the result or the round limit is reached. Between them the
runtime runs the node's deterministic Acceptance Criteria; a deterministic
failure skips the Evaluator for that round and is fed back as Evidence.

- Invocations: per round, 1 producer `worker` (`step`) then (deterministic checks, then) 1 `evaluator` (`evaluate`)
- Input: round 1 producer receives the node manifest; each later producer receives the manifest plus a Handoff to the previous result and the previous Evaluation; the Evaluator receives the manifest plus a Handoff to the current result and the Acceptance Criteria or rubric
- Output: the last passing result Artifacts
- Fan-in: none
- Bounds: `maxRounds` on the node (default 3)
- Failure: round limit reached without a pass fails the node; the last Evaluation is attached

The producer of round `n+1` is a new Invocation (with
`continuedFromInvocationId` pointing at round `n`'s producer). What it knows
about round `n` is in its manifest. A composite producer is unrolled by the
compiler (§4.4), in which case the node runs in evaluate-only form.

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
| `orchestrator` | `operator_input`, `node_result`, `decision_resolution`, `gate_result`, `plan_revision`, `publication_result`, `final_synthesis` |
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
The `purpose` value set is closed: exactly the fourteen values in the table
above, enforced by the `InvocationPurpose` union in `core/src/invocations.ts`
and a database check constraint on `invocations.purpose`; each purpose is
valid for exactly one role.

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
outcome; a Decision resolution; a Gate result; a plan-revision outcome; a
Publication result), each delivered Handoff's routing metadata, and
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

The runtime validates the result: every referenced id must exist and belong
to this Run; every `completed` Task must carry Evidence and its required
output Artifacts; a writing Invocation must have produced a Changeset
(possibly empty, stated as such). An Attempt that ends without a valid
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
| `request_decision` (any kind except `orchestrator_choice`; `requirement_waiver` is always `operator_required`) | yes | yes | yes | no |
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
  `skip_node`, `start_node`, `execute_invocation`, `settle_node`,
  `settle_removed_node`, `resume_node`, `wait_node`, `settle_root`,
  `wait_run`), the nodes that are waiting and why, the work deferred to a
  later phase, the ready nodes held back by the Run's `maxConcurrency`,
  the Invocations executing in this process, and the earliest resumption
  time (retry `notBefore`, provider `retryAfter`, or an Invocation
  deadline). One action is projected per node per iteration, in
  membership order; the root node is settled first.
- `advanceRun(runId, { maxActions })` is a bounded pass. It performs the
  projected actions one at a time, re-projecting the current graph before
  every state-changing action; every mutation runs inside a Pattern
  runner transaction that revalidates the revision, membership, node
  status, and active Invocation, so a stale projection changes nothing
  (`stale`, `no_change`). Provider executions run outside every
  transaction; independent Attempts execute concurrently within one pass
  up to the Run's `maxConcurrency` and the governor's leases (§7.8), and
  the pass awaits the batch only when no other action can proceed — an
  Attempt's completion is what re-triggers projection. The pass stops with
  a closed reason: `quiescent` (nothing to do), `waiting` (the Run
  waits, an Attempt is still in flight, or a resumption time is pending),
  `action_limit`, `run_terminal`, `unsupported` (only later-phase work
  remains), or `infrastructure_failure` (a store or port threw; the
  bounded message is returned and the next pass resumes from rows).
  Concurrent calls for one Run share one pass in-process; canonical
  database constraints (one active Invocation per position, one Handoff
  per key, one active Attempt per Invocation) remain the source of
  correctness across processes.
- Node readiness is computed from Plan Edges and allocation as defined in
  §4.3. Within a node, the Pattern runner (`patterns/`) decides Invocation
  order (§5); an Invocation starts only after its allocation is reserved
  (§7.6) and executes only under a lease. A node whose allocation cannot
  be reserved follows its `onAllocationExhausted` policy: `fail` fails it
  with `allocation_exhausted`, `wait` waits it with `budget`, and
  `extend` is deferred (`awaiting_allocation_extension_phase`) until
  extension exists.
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
- Task dependencies order Worker Invocation creation inside a
  `coordinator_worker` node (§7.9) and are otherwise informational.
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
Invocation, and Attempt counts against it.

**Reservations.** Allocation is accounted with canonical
`budget_reservations` rows, never inferred from limits and Usage. A
reservation identifies the parent bounded object (Run, Plan Node, or
Invocation), the child bounded object or proposed work item (Plan Node,
Invocation, or Task), the reserved cost, tokens, and Attempts, the creation
time, the release time, and the status (`active`, `released`). Wall-clock
deadlines and concurrency ceilings are limits enforced by the runtime and
the resource governor; they are not reserved quantities.

- Unreserved capacity of a parent = its limit − Σ(reserved amounts of its
  `active` reservations) − Σ(final consumed amounts of its `released`
  reservations) − its own direct consumption (an Invocation's Attempts).
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
  raises the limit.
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
immutable for its life. "Configured final reserve" always means this
persisted value; a runtime configuration value is never read back into an
existing Run. The Run Budget is thereby partitioned: the **ordinary pool**
(the Budget less the final reserve) is the only capacity plan revisions
and root-node extensions can reserve; the final reserve is spent only on
`final_synthesis` Orchestrator Invocations and `run_completion` Gate
Evaluator Invocations, each reserved with the explicit capacity source
`final_reserve`. Unused node allocation is released when the node reaches
a terminal state. A `join` node's allocation is zero.

**Global and partition availability.** The ordinary pool and the final
reserve are partitions of one Run Budget, not independent Budgets.
`runCapacity` reports three accounts, each with `limit`, `reserved` (Σ
active reserved amounts), `consumed` (Σ released consumption), `committed`
(Σ active charges + consumed), and signed `available = limit − committed`:

- the **global** account charges every Run-level child of either partition
  against the whole Budget;
- the **ordinary** partition charges its Plan Node children against the
  Budget less the final reserve;
- the **final** partition charges its final-reserve Invocations against
  the final reserve;

and each partition reports `effectiveAvailable = min(available, global
available)` component-wise, which is what a reservation is checked
against. An **active** child is charged component-wise `max(reserved,
actual attributable consumption so far)` — a Plan Node's consumption from
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
- A Plan Node whose unconsumed, unreserved allocation cannot cover the next
  Invocation it must create acts on its `onAllocationExhausted` policy:
  `fail` (default) fails the node; `wait` puts the node in `waiting` with
  reason `budget` until the operator raises the Run Budget or the
  Orchestrator revises the node's expression; `extend` (the root node's
  policy) has the runtime reserve a further increment from unreserved Run
  capacity outside the final reserve and, when none is available, behaves
  as `wait`.
- The Run enters `waiting` with reason `budget` when a node that must
  proceed is waiting on allocation and no unreserved Run capacity exists.
  The operator may raise the Run Budget (which makes the waiting node's
  extension or the Orchestrator's next revision possible) or cancel the
  Run. Budget exhaustion never transitions the Run to `failed`; `failed` is
  reached only through the terminal failure transitions in §3.

### 7.7 Fan-in

Fan-in is performed by the runtime: by `join` nodes for `fan_in` edges, by
the `parallel` Pattern for its inline items, and by the
`coordinator_worker` Pattern for Worker results. It waits for the required
results, writes the index Artifact or records the Handoffs, and creates the
next Invocation or marks the node terminal. No agent waits for another
agent.

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
  for it; `blocked → cancelled` when a `replan` cancels it.
- `pending → blocked` when a dependency becomes `failed` or `cancelled`
  (never a silent cancellation; the Coordinator or Orchestrator decides).
- `pending | ready | blocked → cancelled` by the Orchestrator, a
  Coordinator `replan`, or operator cancellation of the Run or node.
- `failed` and `completed` are terminal; a failed Task is never
  reclassified as `cancelled`, and a replacement is a new Task that
  records `replacesTaskId`.

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
  Requirement.
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
`requirement_waiver`, `side_effect_approval`, `signoff`, and `publish`
Decisions always use `operator_required` and are resolved only by the
operator. No policy, delegation, or Conversation-level setting can resolve
them or transfer that authority. The one automatic capability that exists
is the separate publish authorization in §9.4, which authorizes the
runtime to perform a publish after `completed`; it is not a Decision
resolution mechanism and does not generalize to any other kind.

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
  records the Changeset (before Snapshot, after Snapshot, diff Artifact,
  integration status `pending`), and integrates the Changeset into the
  Integration Workspace in Plan Edge order — before the node is settled,
  the next `chain` step is prepared, or a successor is readied.
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
(typically build, typecheck, test). When the operator accepts at
`operator_signoff`, the runtime records the accepted integration Snapshot as
the Run's **final Snapshot** and the diff from the base Snapshot as the
Run's **final Changeset**. The Run is `completed`. The Target is still
untouched.

### 9.4 Publishing

Applying the final Changeset to the Target is a separate **publish**
action on a completed Run. It is performed by the runtime's Workspace
provider (the git implementation for git Workspaces) and never by an
Invocation.

Publishing:

- requires a `publish` Decision by the operator, unless a Conversation-level
  publish authorization recorded by the operator (itself a Decision of kind
  `operator_choice` naming the Target) authorizes automatic publishing for
  that Target, in which case the runtime publishes immediately after
  `completed` and records the authorizing Decision id on the Publication;
  this authorization covers publishing only;
- revalidates the Target: the Target's current Snapshot is taken and
  compared with the Run's base Snapshot;
- selects the strategy at publish time from what the Workspace provider
  supports (`fast_forward` when the Target still equals the base Snapshot,
  `merge` when it has moved and the merge is clean, or another provider
  strategy the operator named in the `publish` Decision);
- fails safely: if the Target changed and the chosen strategy is not clean,
  or if any deterministic verification the Workspace policy requires on the
  post-publish state fails, nothing is written to the Target, the
  Publication is recorded `failed` with the reason, and a
  `publication_result` Orchestrator Invocation is created so it can propose
  a new Run to reconcile;
- records the result as a Publication row, a `run.published` or
  `run.publish_failed` Event, and a publish Artifact (strategy, before and
  after Target Snapshots, command output).

Git strategy is Workspace-provider behaviour selected at publish time. It is
not a Run mode, is not chosen at Run creation, and is not visible to any
Invocation.

## 10. Verification and Gates

Order is fixed: deterministic checks, then Evaluations, then the operator.

- `node_exit`: runs when a Pattern produces its output. Deterministic
  Acceptance Criteria run on the node's integrated Snapshot. Evaluated
  criteria create one Evaluator Invocation (purpose `evaluate`) per
  criterion group. A failing Gate creates Tasks describing the failures and
  leaves the node in `running` for the Pattern to handle (a
  `coordinator_worker` node gets a `replan` Coordinator Invocation; other
  Patterns create one new Invocation with `continuedFromInvocationId` set
  and the failures in its manifest, and fail the node if that also fails).
- `run_completion`: runs when the Orchestrator calls `request_completion`.
  Checks every `open` Requirement's Acceptance Criteria on the integration
  Snapshot and records the resulting statuses; requires every leaf
  Requirement to be `satisfied`, `waived`, or `retired`; checks that every
  Task is `completed` or `cancelled` (a `failed` Task blocks completion
  until replaced or cancelled by a recorded action); checks that no
  `operator_required` Decision is unanswered; then runs the Run's evaluated
  criteria from the final reserve. A failure returns the Run to `running`
  with Tasks created and a `gate_result` Orchestrator Invocation.
- `operator_signoff`: opens when `run_completion` passes. The operator sees
  the Requirement statuses (waivers shown with their Decisions), the
  Evaluations, the final Changeset, and the Usage, and accepts or requests
  changes through a `signoff` Decision. Requesting changes returns the Run
  to `running`.

Evaluations produced by Evaluator Invocations carry the Evaluator's
Invocation id and Agent Definition revision, so a reviewer of the Run can
see which judgments were made by which definition. An Evaluator never
evaluates an Artifact it produced.

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
  breakdown with reserved and unreserved capacity is available.

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
  its Artifact id, and safe metadata.

## 14. Failure model

| Failure | Handling |
|---|---|
| Provider error, transient | New Attempt (`retry`) after backoff, within the Invocation's Attempt allocation. |
| Provider error, permanent | Invocation `failed`; Pattern decides node outcome. |
| Provider capacity refused by the governor | Attempt not started; Run `waiting` (`provider_capacity`); the scheduler retries when the governor signals capacity or the retry-after time passes. |
| Invocation returns an invalid result | New Attempt (`retry`) with the validation error in the rendering. |
| Invocation exhausts its allocation | Invocation `failed` with reason `allocation_exhausted`; no retry; its Task, if any, `failed`. |
| Plan Node exhausts its allocation | Per `onAllocationExhausted`: `fail`, `wait` (Run may enter `waiting`/`budget`), or `extend`. |
| Run Budget has no unreserved capacity for work that must proceed | Run `waiting` (`budget`); operator raises the Budget or cancels. Never `failed` on this alone. |
| Plan Node fails | Successors `skipped` (or `ready` with the failure if opted in); a `node_result` Orchestrator Invocation is created. |
| `join` fan-in policy not met | Join `failed`; handled as a Plan Node failure. |
| Task fails or is blocked inside `coordinator_worker` | Task `failed`/`blocked`; a `replan` Coordinator Invocation is created unless one is active (then queued). |
| Changeset conflict | Changeset `conflict`; Task with a bounded report Artifact created for the node owner; node (and, when nothing else can proceed, the Run) `waiting` with `integration_conflict`; applied once more when the Task completes; a second conflict, or a failed or cancelled Task, fails the node with `integration_conflict` (§9.2). |
| Crash between an external Changeset application and its record | The Changeset stays `pending`; the next pass applies it again and the port reports the application that already holds; the record is written exactly once (§9.2). |
| Crash during a scheduler pass | Nothing is lost: every action is one transaction; the next pass re-projects from rows, retries interrupted Attempts through recovery, and repeats no Invocation, Handoff, integration, or provider call (§7.1). |
| Publish fails | Target untouched; Publication `failed`; a `publication_result` Orchestrator Invocation is created. |
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
    Criteria are run first, and an Evaluator is not invoked while a
    deterministic criterion is failing.
12. **Completed coding Runs must finish on a verified integration state.** A
    Run with `kind: code` cannot leave `verifying` unless its deterministic
    `run_completion` criteria passed on the integration Snapshot that the
    operator is then asked to accept, and the Evidence for that pass is
    stored as Artifacts.
13. **Requirement satisfaction derives from Acceptance Criteria and
    Evidence.** No tool, result, or Task transition sets a Requirement to
    `satisfied`; only a Gate's recorded Evaluations do. `waived` is set
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
16. **The Target is never modified by a Run.** Only a publish action on a
    `completed` Run writes to the Target, after revalidating it, and it
    fails without writing when the operation is not clean.
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
    places a Run in `waiting`, never `failed`.
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
