# Execution model

This document defines how a Run executes: which component owns which state,
how the Execution Plan is authored, compiled, and scheduled, what each
Pattern does, how work and results move between Invocations, how
verification, completion, and publishing work, and how usage and capacity
are accounted. Terms are defined in [glossary.md](glossary.md). The
replacement rules are in [migration-contract.md](migration-contract.md).
Everything here is normative; the invariants in §15 are the acceptance test
for the implementation.

## 1. Actors

There are five actors and each has a fixed responsibility.

| Actor | Responsibility | Never does |
|---|---|---|
| Operator | Starts Conversations and Runs, approves Requirements, answers Decisions, accepts or rejects a Run at the `operator_signoff` Gate, publishes a completed Run. | Edit runtime state directly. |
| Orchestrator | The agent that talks to the operator. Proposes Requirements, records Decisions, creates Tasks, authors and revises the source Execution Plan, reads results, works directly when that is cheaper than delegating. | Schedule, retry, wait, or account for anything. Talk to Workers. |
| Runtime | Deterministic code. Owns the compiled Execution Plan, scheduling, retries, dependencies, waiting, progress, Budgets, fan-in, Gates, Snapshots, Changesets, publishing, the journal. | Decide what the work should be. |
| Resource governor | Deterministic code inside the runtime process. Owns provider quota, provider concurrency, and machine concurrency; grants capacity leases to Runs. | Invoke a model, generate text, or hold semantic Run state. |
| Provider | Executes one Attempt: a model plus its native tools against a Context Manifest. | Hold any state the runtime depends on for correctness. |

The Orchestrator is an agent and is subject to every rule below. It is
distinguished only by being the root Plan Node and by being the one
Invocation whose Context Manifest includes the operator's messages.

## 2. State ownership

Every fact in the system has exactly one canonical store and one writer.

| Object | Writer | Canonical store | Projections |
|---|---|---|---|
| Workspace | Operator via API | `workspaces` | — |
| Conversation, messages | Operator, Orchestrator via runtime | `conversations`, `conversation_messages` | Conversation view |
| Run | Runtime | `runs` | Run view, Run list |
| Execution Plan (source) | Runtime (from Orchestrator revisions) | `execution_plan_revisions` | Plan view |
| Plan Node, Plan Edge (compiled) | Runtime (plan compiler) | `plan_nodes`, `plan_edges` | Plan view |
| Requirement | Runtime (from Orchestrator proposal, operator approval) | `requirements`, `requirement_revisions`, `requirement_status_changes` | Requirements panel |
| Acceptance Criterion | Runtime (from Orchestrator) | `acceptance_criteria` | Requirements panel, Gate view |
| Decision | Runtime (from operator, Orchestrator, or a resolution policy) | `decisions` | Decision cards |
| Task | Runtime (from Orchestrator or Coordinator proposals) | `tasks`, `task_dependencies` | Task ledger |
| Artifact | Runtime | `artifacts` + blob store | Artifact viewer |
| Handoff | Runtime | `handoffs` | Plan view |
| Agent Definition, revision | Runtime (from files and built-ins) | `agent_definitions`, `agent_definition_revisions` | Agents view |
| Invocation, Attempt | Runtime | `invocations`, `attempts` | Plan view, transcript viewer |
| Provider continuation metadata | Provider adapter | `provider_continuations` | Attempt inspector (diagnostic) |
| Evaluation, Gate | Runtime | `evaluations`, `gates` | Gate view |
| Snapshot, Changeset | Runtime | `snapshots`, `changesets` | Run view |
| Publication | Runtime (publish action) | `publications` | Run view |
| Capacity lease | Resource governor | `capacity_leases` | System view |
| Context Manifest | Runtime | `context_manifests` | Invocation inspector |
| Usage | Runtime | `usage` | Every view's cost line |
| Event | Runtime | `events` | Everything |

Agent transcripts (the provider's message stream for one Attempt) are
stored as Artifacts of media type `application/x-agent-transcript`. They
are diagnostic records. No runtime decision reads a transcript; no
projection is built from one; no state is recoverable only from one.
Provider continuation metadata (§6.5) is likewise diagnostic and
optimization-only: deleting every row of `provider_continuations` changes
no Run's outcome.

## 3. Run lifecycle

A Run has these states. Transitions are made by the runtime only.

```
created ──► running ──► verifying ──► awaiting_signoff ──► completed
               │            │               │
               │            │               └──► running   (operator requests changes)
               │            └──► running                   (run_completion Gate produced Tasks)
               ├──► waiting  ──► running                   (wait reason cleared)
               ├──► failed
               └──► cancelled
```

- `created`: the Run row exists; the Execution Plan holds only the root
  Plan Node (the Orchestrator's `single` node). A Snapshot of the target
  branch is taken and recorded as the Run's base Snapshot; the Run's
  integration Workspace is created from it (§9).
- `running`: at least one Plan Node is `ready` or `running`.
- `waiting`: no Plan Node can make progress. The Run records a structured
  reason: `decision` (an `operator_required` Decision is unanswered),
  `budget` (the Run Budget is exhausted), `provider_capacity` (the
  resource governor has no lease to grant), `operator` (the operator paused
  the Run).
- `verifying`: the Orchestrator has requested completion; the runtime is
  executing the `run_completion` Gate.
- `awaiting_signoff`: the `run_completion` Gate passed; the
  `operator_signoff` Gate is open.
- `completed`: the operator accepted the verified final Snapshot. Terminal.
  A completed Run may then be published (§9.4); publishing does not change
  the Run's state.
- `failed`: the Run's Budget was exhausted with the `run_completion` Gate
  never passed, or the root Plan Node failed after its Attempts. Terminal.
- `cancelled`: the operator cancelled. Terminal.

Terminal states are final. There is no resume. A new Run in the same
Conversation starts from the Conversation's current Requirements, Decisions,
and Artifacts, and from a fresh Snapshot of the target branch.

## 4. The Execution Plan

### 4.1 Two forms, one owner

The Execution Plan exists in two forms, both owned by the runtime:

- **Source form** — a tree of Pattern expressions authored by the
  Orchestrator. Each expression names a Pattern and its operands; an operand
  is either a leaf operation (an Agent Definition revision plus an input
  specification) or another Pattern expression. The source form is what the
  Orchestrator reads and revises. It is persisted append-only as
  `execution_plan_revisions`.
- **Compiled form** — a flat directed acyclic graph of Plan Nodes and typed
  Plan Edges materialized by the deterministic plan compiler from a source
  revision. The compiled form is what the scheduler executes. It is
  persisted in `plan_nodes` and `plan_edges`.

Only the Orchestrator revises the source form, through the
`revise_execution_plan` tool. Only the compiler writes the compiled form.
No agent reads or writes `plan_nodes` or `plan_edges` except through
read-only runtime tools.

### 4.2 Plan Node

A compiled Plan Node has:

- `id`, `runId`, `pattern`, `title`, `sourcePath` (the position in the
  source expression it was compiled from)
- `input`: a Context Manifest template — the Requirement ids, Task ids,
  Decision ids, and Artifact ids this node's Invocations receive
- `agents`: which Agent Definition revision each role in the Pattern uses
- `budget`
- `gate`: the `node_exit` Gate's Acceptance Criteria (may be empty)
- `status`: `pending | ready | running | waiting | succeeded | failed | cancelled | skipped`
- `output`: the Artifact ids produced, set when the node reaches `succeeded`

A persisted Plan Node does not contain other Plan Nodes. Everything inside
a node is an Invocation (§5). Composition between nodes is expressed only by
Plan Edges.

### 4.3 Plan Edge

A Plan Edge is a typed, directed relation between two Plan Nodes:

| Edge type | Meaning |
|---|---|
| `sequence` | The target becomes eligible when the source is terminal; the source's output Artifacts are delivered to the target as a Handoff. |
| `branch(label)` | A `sequence` edge that is active only when the source (a `route` node) selected `label`. Inactive branches' targets become `skipped`. |
| `fan_in` | The target becomes eligible when every `fan_in` source is terminal; the sources' outputs are delivered as one index Artifact. |
| `retry(round)` | A `sequence` edge into a later unrolled round of an `evaluator_optimizer` expression; active only when the source's Evaluation failed. When the Evaluation passed, every later round is `skipped`. |

Readiness is computed from edges only: a node is `ready` when every
predecessor is terminal, no predecessor is `failed` or `cancelled` (unless
the node was compiled with `runOnDependencyFailure: true`), and at least one
predecessor is `succeeded` or the node has no predecessors. A node all of
whose predecessors are `skipped` is `skipped`. A node with a `failed` or
`cancelled` predecessor is `skipped` unless `runOnDependencyFailure` is set,
in which case it becomes `ready` with the failure in its manifest.

### 4.4 Composition and compilation

Pattern composition is expressed structurally in the source form and
materialized flat by the compiler. The compiler is deterministic: the same
source revision always yields the same compiled graph.

Compilation rules, applied recursively to each expression:

1. A leaf operation compiles to one `single` node.
2. `chain(e₁ … eₙ)`: each operand compiles to a subgraph; the exits of the
   subgraph for `eᵢ` are connected to the entries of the subgraph for
   `eᵢ₊₁` by `sequence` edges. A maximal run of consecutive leaf operands
   compiles to one `chain` node whose steps are those leaves. A chain of one
   leaf compiles to a `single` node.
3. `route(selector, {label ⇒ e})`: compiles to one `route` node holding
   the selector. A leaf branch stays inside the node as its branch
   Invocation. A composite branch compiles to its own subgraph, connected
   from the `route` node by a `branch(label)` edge. Successors of the
   expression receive `sequence` edges from the `route` node and from every
   composite branch's exits; the readiness rule in §4.3 makes exactly the
   selected path deliver.
4. `parallel(items, aggregate?)`: leaf items stay inside one `parallel`
   node. A composite item compiles to its own subgraph whose entries take
   `sequence` edges from the expression's predecessors and whose exits take
   `fan_in` edges into the `parallel` node. A `parallel` node compiled this
   way may have zero inline items; it then performs only fan-in (the index
   Artifact) and the optional aggregation Invocation.
5. `evaluator_optimizer(producer, evaluator, maxRounds)`: a leaf producer
   compiles to one `evaluator_optimizer` node (§5.6). A composite producer
   is unrolled: for each round `r` in `1 … maxRounds` the compiler emits a
   copy of the producer subgraph `Pᵣ` and an `evaluator_optimizer` node
   `Eᵣ` in evaluate-only form (no inline producer; it evaluates the Handoff
   from `Pᵣ`'s exits); `Pᵣ → Eᵣ` by `sequence`; `Eᵣ → Pᵣ₊₁` by
   `retry(r+1)`; successors of the expression receive `sequence` edges from
   every `Eᵣ`. A passing `Eᵣ` skips every later round.
6. `coordinator_worker(coordinator, worker)`: compiles to one
   `coordinator_worker` node. Its operands must be leaves. It may not be an
   operand of another `coordinator_worker` expression at any depth.

Rejected at compile time, with the rejection returned to the Orchestrator
as the tool result:

- any cycle in the compiled graph;
- an expression that references itself or an ancestor expression;
- a `coordinator_worker` operand that is not a leaf, or a
  `coordinator_worker` nested inside another one;
- source nesting depth greater than `maxPlanDepth` (default 4);
- `maxRounds` greater than `maxUnrolledRounds` (default 6);
- a compiled graph with more than `maxPlanNodes` (default 200) nodes;
- any Pattern name other than the six.

Examples that compile:

- a chain whose middle stage is a route: `chain(A, route(s, {x ⇒ B, y ⇒ chain(C, D)}), E)` → `single A → route(s; inline B) → E` plus `route –branch(y)→ chain(C, D) → E`;
- an evaluator-optimizer wrapping a chain: unrolled rounds `chain(P₁a, P₁b) → E₁ –retry→ chain(P₂a, P₂b) → E₂ …`;
- a route branch that is a chain (as above);
- a parallel whose items are static subgraphs: each subgraph's exits `fan_in` to one `parallel` node that aggregates.

### 4.5 Who may change the plan

- Only the Orchestrator revises the source form. Each revision is
  append-only and is compiled immediately. Compilation reconciles the new
  compiled graph with the existing one by `sourcePath`: nodes whose
  `sourcePath` and definition are unchanged keep their id and status; nodes
  whose source was removed and that have not started become `cancelled`;
  nodes that have started or finished are never altered; new nodes are
  added `pending`. A revision that would change the definition of a node
  that has started is rejected; the Orchestrator cancels it and adds a
  new expression instead.
- Coordinators, Workers, and Evaluators cannot revise the plan. Tasks a
  Coordinator proposes are internal execution records of its node (§5.5)
  and never create, remove, or alter Plan Nodes or Plan Edges.
- A node in `pending` or `ready` may be cancelled by the Orchestrator or the
  operator. A `running` node may be cancelled; its Attempts are interrupted
  and the node ends `cancelled`.
- Every revision writes one `execution_plan.revised` Event carrying the
  source revision and one `execution_plan.compiled` Event carrying the full
  compiled node and edge list.

### 4.6 The root node

The root Plan Node is created with the Run: pattern `single`, role
`orchestrator`, no predecessors, Budget equal to the Run's Budget. Its
Invocation is the Orchestrator. The root node stays `running` for the life
of the Run and reaches `succeeded` only when the Run does.

The Orchestrator's Invocation is turn-based (§6.6): the runtime starts a turn
when there is new input for it (an operator message, a Plan Node reaching a
terminal state, a Gate result, a Decision resolved, a Budget event) and the
turn ends when the Orchestrator returns. Between turns no provider process
runs. The runtime coalesces inputs that arrive during a turn into the next
turn.

## 5. Patterns

Each Pattern is a fixed shape the runtime executes. The runtime, not an
agent, creates the Invocations, orders them, delivers Handoffs, and combines
results. A Pattern never communicates with agents outside its own Plan Node.

Common rules for every Pattern:

- Every Invocation receives exactly its Context Manifest and returns a typed
  result (§6.3).
- Every Invocation whose Tool Policy grants write capability runs in an
  isolated worktree from the node's starting Snapshot and produces a
  Changeset (§9).
- Deterministic Acceptance Criteria on the node's `node_exit` Gate are
  checked by the runtime before the node reaches `succeeded`.
- A Pattern's failure is the node's failure. The runtime retries at
  Invocation level (§7.2), never by re-running the whole node.

### 5.1 `single`

One Invocation of one Agent Definition revision. This is the default Pattern
and the only one the Orchestrator should choose unless the work has a shape
that one of the others describes exactly.

- Invocations: 1 (`worker`, or `orchestrator` for the root node)
- Input: the node's manifest
- Output: the Invocation's result Artifacts
- Fan-in: none

### 5.2 `chain`

An ordered list of leaf steps, each one Invocation. Step `n+1` starts when
step `n` has returned; it receives the node's manifest plus a Handoff
pointing at step `n`'s output Artifacts.

- Invocations: one per step, sequential, all `worker`
- Input: node manifest; step `n>1` additionally receives a Handoff from step `n-1`
- Output: the last step's result Artifacts (earlier steps' Artifacts remain readable by id)
- Fan-in: none
- Failure: a step that fails after its Attempts fails the node; later steps are `skipped`

Composite stages are compiled out of the node (§4.4); a `chain` node only
ever holds leaf steps.

### 5.3 `route`

One selector chooses exactly one branch. The selector is either a
deterministic rule the runtime evaluates (a predicate over the manifest,
such as which files a Task touches or a Decision's answer) or a read-only
`evaluator` Invocation that returns a branch label. The selection is
recorded as an Evaluation on the node. A leaf branch runs as one
Invocation inside the node; a composite branch is a subgraph reached by a
`branch(label)` edge.

- Invocations: 0 or 1 selector (`evaluator`), then 1 inline branch (`worker`) when the selected branch is a leaf
- Input: the node manifest; the branch additionally receives the selection Evaluation reference
- Output: the inline branch's result Artifacts, or nothing when the selected branch is composite (its subgraph's exits deliver)
- Fan-in: none
- Failure: a selector that returns no valid label fails the node

### 5.4 `parallel`

A static list of independent items, each one Invocation, run concurrently
up to the node Budget's concurrency limit. The runtime collects every result
into one index Artifact (the list of item results with their Artifact ids)
and optionally runs one aggregation Invocation over that index. Composite
items are compiled to subgraphs whose exits `fan_in` to this node.

- Invocations: one `worker` per inline item, then 0 or 1 aggregation `worker`
- Input: each inline item receives the node manifest plus its item payload; the aggregation receives the manifest plus a Handoff to the index Artifact
- Output: the aggregation's result Artifacts, or the index Artifact when there is no aggregation
- Fan-in: the runtime waits for every inline item and every `fan_in` predecessor to reach a terminal state, then writes the index
- Failure: an item that fails after its Attempts is recorded as failed in the index; whether that fails the node is a node option (`requireAll`, default true)

Items never see each other's results. A `parallel` node whose items are
not independent is a plan error; the Orchestrator should use `chain`.

### 5.5 `coordinator_worker`

One Coordinator proposes Tasks; the runtime creates Worker Invocations for
them; the Coordinator synthesizes the results. The node is bounded and the
coordination depth is one by construction.

Roles and what each may do:

- The **Coordinator** proposes Tasks through `propose_tasks` and returns a
  synthesis through `return_result`. It does not append or revise Plan
  Nodes, does not create Invocations, and does not call, message, or
  address Workers. It never sees a Worker except as a Handoff the runtime
  delivers.
- The **runtime** validates every proposed Task (well-formed, within the
  node's Requirement scope, dependency graph acyclic, count within the node
  Budget's `maxTasks`), reserves Budget for it, persists it, and schedules
  one Worker Invocation per Task when the Task's dependencies are
  `completed`. The runtime delivers each Worker result to the node as a
  Handoff and decides when the Coordinator is next invoked.
- A **Worker** executes exactly one Task and returns a result. A Worker
  cannot propose or create Tasks, Workers, Coordinators, or Plan Nodes, and
  cannot address any other Invocation.

The Coordinator is invoked only on these occasions, each a turn-based
Attempt of the same Coordinator Invocation with a stated `purpose`:

1. `decompose` — once, at node start, to produce the initial Task set.
2. `replan` — when a Worker returns `blocked` with a stated blocker, or a
   Task fails after its Attempts, and the runtime cannot resolve it
   deterministically (a retry within Budget is deterministic; a change in
   what should be done is not). The Coordinator may propose replacement
   Tasks, cancel open Tasks, or fail the node.
3. `synthesize` — once, when every Task is `completed` or `cancelled`, to
   produce the node's output.

Routine progress — a Task completing, a Worker starting, Usage accruing —
never invokes the Coordinator. The runtime advances the Task graph on its
own.

- Invocations: 1 `coordinator` (turn-based), N `worker` (one per Task)
- Input: the Coordinator receives the node manifest and, on `replan` and `synthesize` turns, Handoffs to every Worker result since its last turn; each Worker receives the manifest restricted to its Task plus Handoffs to the Artifacts the Task lists as inputs
- Output: the Coordinator's `synthesize` result Artifacts
- Fan-in: performed by the runtime as described above
- Bounds: node Budget caps `maxTasks`, `maxConcurrentWorkers`, and `maxCoordinatorTurns`
- Failure: the Coordinator failing the node on `replan`, exhausting `maxCoordinatorTurns`, or exhausting the node Budget fails the node

Tasks proposed inside a `coordinator_worker` node are Tasks of the Run (they
appear in the ledger, reference Requirements, and carry Evidence) and are
tagged with the node id. They are internal execution records of the node:
they do not appear in the source Execution Plan and their existence never
changes a Plan Node or Plan Edge.

### 5.6 `evaluator_optimizer`

One producer Invocation and one Evaluator Invocation alternate until the
Evaluator passes the result or the round limit is reached. Between them the
runtime runs the node's deterministic Acceptance Criteria; a deterministic
failure skips the Evaluator for that round and is fed back as Evidence.

- Invocations: per round, 1 producer `worker` then (deterministic checks, then) 1 `evaluator`
- Input: round 1 producer receives the node manifest; each later producer receives the manifest plus a Handoff to the previous result and the previous Evaluation; the Evaluator receives the manifest plus a Handoff to the current result and the Acceptance Criteria or rubric
- Output: the last passing result Artifacts
- Fan-in: none
- Bounds: `maxRounds` on the node (default 3)
- Failure: round limit reached without a pass fails the node; the last Evaluation is attached

The producer of round `n+1` is a new Invocation. What it knows about round
`n` is in its manifest. A composite producer is unrolled by the compiler
(§4.4), in which case the node runs in evaluate-only form.

## 6. Invocations

### 6.1 Creation

The runtime creates an Invocation when a Pattern calls for it. Creation
records the Agent Definition revision, the role, the Plan Node, the Task
ids, and the Budget. The runtime then assembles the Context Manifest.

### 6.2 Context Manifest

The manifest lists every input by id. The runtime renders it into the
Attempt's prompt in a fixed, documented layout; the rendering is a
projection, and the manifest is the record. It contains:

- Agent Definition revision id and content hash, and the instructions it
  carries
- Role, Pattern position (for example `chain step 2 of 3`), and, for
  turn-based roles, the turn `purpose`
- Run id, Plan Node id, Task ids and their subjects
- Requirement ids and current statements for the Requirements the Task
  serves, with their Acceptance Criteria
- Decision ids and answers for every Decision that references those
  Requirements or Tasks
- Handoffs delivered to this Invocation, including this Invocation's own
  earlier results for a turn-based role
- Artifact ids the Invocation may read (delivered Handoffs' Artifacts plus
  any the Orchestrator listed on the node)
- Starting Snapshot and the worktree path
- Budget for this Invocation
- The Tool Policy in force and the runtime tools available (§6.4)

An Invocation is told nothing else. There is no shared working state, no
narrative of what other agents are doing, and no transcript of anyone
else's Attempt. The manifest is always sufficient to start a fresh Attempt
(§6.5).

### 6.3 Result

Every Attempt must end by returning a typed result through the runtime's
`return_result` tool. The result has:

- `status`: `completed | failed | blocked`
- `artifacts`: Artifact ids produced (the runtime has already stored them
  when the Invocation wrote them)
- `tasks`: Task id → `completed | blocked | not_started`, with Evidence
  for each `completed`
- `evidence`: Evidence for the claims made
- `summary`: at most 500 characters
- `openItems`: at most 10 short strings
- `blocker`: for `blocked` only — the Decision id requested or a short
  statement of what must change

The runtime validates the result: every referenced id must exist and belong
to this Run; every `completed` Task must carry Evidence; a writing
Invocation must have produced a Changeset (possibly empty, stated as such).
An Attempt that ends without a valid result is a failed Attempt.

A Task marked `completed` in a result completes the Task. It does not
change any Requirement's status (§8.1).

Results are the only way an Invocation communicates. There is no message
tool, no peer addressing, and no channel to the operator except a Decision
request routed through the runtime (§8.2).

### 6.4 Tools and Tool Policy

An Invocation has two tool sets.

**Capability tools** (file read/write, shell, worktree, MCP servers) are
provider-native. Which of them an Attempt may use is the intersection of
the Agent Definition revision's declared capabilities, the role's policy
(Evaluators and selectors are read-only), and the Run's Workspace policy.
The console builds no capability tools.

Each capability tool carries a **Tool Policy** disposition from the Agent
Definition revision: `allowed`, `denied`, or `approval_required`. An
`approval_required` tool call is intercepted by the runtime, which requests
a `side_effect_approval` Decision (§8.2) from the operator with the exact
call, ends the Attempt `blocked`, and continues with a new Attempt when the
Decision is answered. Built-in definitions mark destructive shell
operations, network access outside declared MCP servers, and any operation
on a path outside the worktree as `approval_required` or `denied`. Tool
Policy, capability policy, worktree isolation, side-effect approval, and
Gates are the safety mechanisms; there is no trust flag.

**Runtime tools** are the same for every role, restricted by role:

| Tool | orchestrator | coordinator | worker | evaluator |
|---|---|---|---|---|
| `read_requirements`, `read_decisions`, `read_tasks`, `read_artifact`, `read_execution_plan`, `read_agent_definitions` | yes | yes | yes | yes |
| `write_artifact` | yes | yes | yes | yes |
| `update_task` (status, Evidence) | yes | own node | own Task | no |
| `create_tasks` | yes | no | no | no |
| `propose_tasks` | no | own node | no | no |
| `request_decision` (operator) | yes | yes | yes | no |
| `record_decision` (orchestrator-owned, incl. waivers the operator delegated) | yes | no | no | no |
| `propose_requirements` | yes | no | no | no |
| `revise_execution_plan` | yes | no | no | no |
| `request_completion` | yes | no | no | no |
| `return_result` | yes (per turn) | yes (per turn) | yes | yes |

No tool lets an agent see another Invocation's transcript, send a message
to another agent, or alter scheduling.

### 6.5 Attempts and provider resumption

Each Attempt is one provider execution of an Invocation. Every Attempt
records:

- `kind`: `initial | retry | turn`
- `resumedFromAttemptId`: the earlier Attempt whose provider execution this
  one continued, or null
- `startMode`: `fresh` (started from the Context Manifest) or `resumed`
  (continued provider execution from `resumedFromAttemptId`)
- the provider's opaque continuation metadata, if any, written by the
  provider adapter to `provider_continuations` keyed by Attempt id

Correctness never depends on provider state. The Context Manifest and the
canonical Run state are always sufficient to start a fresh Attempt, and the
runtime never waits on, reads, or reconstructs anything from a provider
session to decide what to do next.

A new Attempt may start `resumed` only when all of the following hold:

- the provider adapter reports that the provider supports continuation;
- the adapter determines continuation is safe for this Attempt (the prior
  Attempt ended in a state the provider can continue from, the same Agent
  Definition revision and Tool Policy apply, and the manifest has not
  changed except for the inputs the new Attempt is meant to receive);
- the continuation metadata for `resumedFromAttemptId` is present;
- the projected context size and cost stay within the Invocation's Budget
  and the Agent Definition's context policy.

Otherwise the Attempt starts `fresh` from the manifest. Resumption is an
optimization that saves re-reading the manifest; a `fresh` start is always
correct. Resumption is decided by the adapter at Attempt start and is
recorded on the Attempt; nothing else in the runtime branches on it. There
is no rotation, no generation counter, no checkpoint reconstruction, and no
continuation document.

### 6.6 Turn-based roles

The `orchestrator` and `coordinator` roles are turn-based: their
Invocation stays open across several Attempts of `kind: turn`, each started
by the runtime with new input (§4.6, §5.5). A turn Attempt may be `resumed`
from the previous turn under §6.5 or `fresh` with the Invocation's earlier
results included in its manifest as Handoffs. Either way the Attempt is a
full Attempt: it has its own Usage rows, transcript Artifact, and result.

## 7. Runtime responsibilities

The runtime owns all of the following. No agent is asked to do any of it,
and no agent can.

### 7.1 Scheduling

- Node readiness is computed from Plan Edges as defined in §4.3.
- The scheduler runs ready nodes subject to the Run Budget's concurrency
  limit, each node's own limit, and the capacity leases the resource
  governor grants (§7.8). Order among ready nodes is creation order.
- Within a node, the Pattern decides Invocation order (§5).

### 7.2 Retries

- An Invocation has a maximum Attempt count from its Budget (default 2 for
  `initial` plus `retry` Attempts; turn Attempts are bounded separately by
  `maxTurns`).
- The runtime classifies each Attempt failure: `provider_transient`
  (retry after backoff), `provider_permanent` (no retry), `result_invalid`
  (retry with the validation error in the manifest), `budget_exhausted`
  (no retry), `interrupted` (retry only if the interruption was not a
  cancellation), `tool_failure` (retry once).
- A retry is a new Attempt of `kind: retry`, started `fresh` or `resumed`
  under §6.5. The failed Attempt's transcript Artifact remains.

### 7.3 Dependencies

- Plan Edges are the only cross-node ordering mechanism.
- Task dependencies order Worker creation inside a `coordinator_worker`
  node and are otherwise informational.
- Cycles are rejected at compile time.

### 7.4 Waiting

A node or Invocation waits when it has requested an `operator_required`
Decision that is unanswered, when its Budget is exhausted and the operator
has not raised it, when the resource governor has no lease to grant, or
when the operator has paused the Run. Waiting is a recorded state with a
recorded reason. A waiting Invocation's provider execution is ended; when
the wait clears, a new Attempt starts (`resumed` if §6.5 allows, otherwise
`fresh`) with the Decision's answer in the manifest. Nothing waits by
polling, and nothing waits inside a provider process.

### 7.5 Progress

Progress is derived, never reported by an agent:

- Node progress: the count of Invocations by status.
- Run progress: the count of Plan Nodes by status, the count of Tasks by
  status, the count of Requirements by status.
- Every derivation is a query over canonical stores and is recomputed on
  read.

The UI shows these counts and the plan graph. There is no "status update"
message type.

### 7.6 Budgets

- Budgets are hierarchical: Run ≥ Plan Node ≥ Invocation. Creating a child
  with a Budget larger than the parent's remaining allowance is rejected.
- A `coordinator_worker` node reserves Budget for each Task the runtime
  accepts from a `propose_tasks` call; a proposal that cannot be reserved
  is rejected in the tool result.
- The runtime records Usage as each Attempt reports it and checks Budgets
  before starting any Attempt and on every Usage row.
- Exceeding a cost or token Budget stops the bounded object with reason
  `budget_exhausted`. Exceeding a time Budget interrupts the Attempt. The
  Run enters `waiting` with reason `budget` when its own Budget is
  exhausted, and the operator may raise it or cancel.

### 7.7 Fan-in

Fan-in is performed by the runtime for `fan_in` edges and for the
`parallel` and `coordinator_worker` Patterns: it waits for the required
results, writes the index Artifact or delivers the Handoffs, and starts the
next Invocation or turn. No agent waits for another agent.

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
release times.

The governor never invokes a model, never generates conversational text,
never holds or interprets semantic Run state, and never decides which Run
or node is more important beyond the configured ordering (creation order
by default). It is backpressure, not orchestration. There is no global
"pause" product state; the operator pauses individual Runs (§14).

## 8. Specification and decisions

### 8.1 Requirements

- The Orchestrator proposes a Requirement tree with Acceptance Criteria
  through `propose_requirements`. The operator approves, edits, or rejects.
  Approval creates a Requirement revision; every subsequent Invocation's
  manifest carries the current revision's statements for its Requirements.
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
- `waived` is reached only through a Decision of kind `requirement_waiver`
  (§8.2) recording the actor, the rationale, the affected Requirement id,
  the timestamp, and optional supporting Artifact ids. The runtime applies
  the status change when the Decision is recorded and links the two. There
  is no other path to `waived`, and a waiver never satisfies the
  Requirement's Acceptance Criteria; it records that the outcome is
  accepted without them.
- `retired` is reached through a Requirement revision that removes the
  Requirement.
- Running Invocations keep the revision in their manifest; the Orchestrator
  decides whether to cancel and re-create the affected nodes after a
  revision.

### 8.2 Decisions

A Decision is the canonical record of a choice. Every Decision has a kind:

- `operator_choice` — a question put to the operator;
- `orchestrator_choice` — a choice the Orchestrator made itself;
- `requirement_waiver` — accepts a Requirement without its Acceptance
  Criteria (§8.1);
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

Resolution, by whichever path, writes exactly one `decision.resolved`
Event recording the answer, the resolver (`operator`, `orchestrator`, or
`policy:use_default_after_deadline`), and the time. No Decision resolves
without that Event, and a policy resolution is shown in the Conversation
like any other. A Decision resolved by policy may later be superseded by
the operator; the runtime records the superseding Decision and the
Orchestrator's next turn receives it.

`requirement_waiver`, `side_effect_approval`, `signoff`, and `publish`
Decisions always use `operator_required` unless a Conversation-level policy
recorded by the operator delegates that kind to the Orchestrator (for
`requirement_waiver`) or authorizes it automatically (for `publish`, §9.4).
That policy is itself recorded as a Decision.

## 9. Workspace, Snapshots, Changesets, integration, publishing

### 9.1 Isolation

- Each Run has a **target**: the operator's branch in the Workspace that
  the Run's result is meant for. The runtime never modifies the target
  while the Run is executing.
- Each Run has an **integration Workspace**: a Run-owned worktree and
  branch created from the Run's base Snapshot of the target. All
  integration happens there.
- Every Invocation with write capability runs in its own worktree created
  from the node's starting Snapshot of the integration Workspace. Read-only
  Invocations run against the integration Workspace directly, or a
  read-only worktree when concurrent writers exist.
- The Workspace's own checkout and the target branch are never modified by
  an Invocation.

### 9.2 Integration

- When a writing Invocation returns, the runtime commits its worktree,
  records the Changeset (before Snapshot, after Snapshot, diff Artifact),
  and integrates the Changeset into the integration Workspace in Plan Edge
  order.
- A Changeset that does not apply cleanly is not applied. The runtime
  records the conflict as a Task assigned to the Plan Node's owner (the
  Coordinator for `coordinator_worker`, otherwise the Orchestrator) with the
  conflict Artifact, and the node's `node_exit` Gate cannot pass until that
  Task completes.
- After every integration the runtime records the integration Snapshot on
  the Run.

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
Run's **final Changeset**. The Run is `completed`. The target branch is
still untouched.

### 9.4 Publishing

Applying the final Changeset to the target is a separate **publish**
action on a completed Run. It is performed by the runtime's Workspace
provider (the git implementation for git Workspaces) and never by an
Invocation.

Publishing:

- requires a `publish` Decision by the operator, unless a Conversation-level
  policy Decision recorded by the operator authorizes automatic publishing
  for that target (in which case the runtime publishes immediately after
  `completed` and records the authorizing Decision id on the Publication);
- revalidates the target: the target's current Snapshot is taken and
  compared with the Run's base Snapshot;
- selects the strategy at publish time from what the Workspace provider
  supports (`fast_forward` when the target still equals the base Snapshot,
  `merge` when it has moved and the merge is clean, or another provider
  strategy the operator named in the `publish` Decision);
- fails safely: if the target changed and the chosen strategy is not clean,
  or if any deterministic verification the Workspace policy requires on the
  post-publish state fails, nothing is written to the target, the
  Publication is recorded `failed` with the reason, and the Orchestrator's
  next turn receives it so it can propose a new Run to reconcile;
- records the result as a Publication row, a `run.published` or
  `run.publish_failed` Event, and a publish Artifact (strategy, before and
  after target Snapshots, command output).

Git strategy is Workspace-provider behaviour selected at publish time. It is
not a Run mode, is not chosen at Run creation, and is not visible to any
Invocation.

## 10. Verification and Gates

Order is fixed: deterministic checks, then Evaluations, then the operator.

- `node_exit`: runs when a Pattern produces its output. Deterministic
  Acceptance Criteria run on the node's integrated Snapshot. Evaluated
  criteria create one Evaluator Invocation per criterion group. A failing
  Gate creates Tasks describing the failures and leaves the node in
  `running` for the Pattern to handle (a `coordinator_worker` node gets a
  `replan` turn; other Patterns fail the node after one automatic retry of
  the last Invocation with the failures in its manifest).
- `run_completion`: runs when the Orchestrator calls `request_completion`.
  Checks every `open` Requirement's Acceptance Criteria on the integration
  Snapshot and records the resulting statuses; requires every leaf
  Requirement to be `satisfied`, `waived`, or `retired`; checks that every
  Task is `completed` or `cancelled`; checks that no `operator_required`
  Decision is unanswered; then runs the Run's evaluated criteria. A failure
  returns the Run to `running` with Tasks created.
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
  Conversation, with the Decision that approved it);
- **model policy** — model id, effort, and context policy (maximum context
  occupancy before a `fresh` Attempt is preferred over `resumed`);
- **instructions**;
- **capabilities** — the provider-native tools and MCP servers it declares;
- **Tool Policy** — per-capability disposition `allowed`, `denied`, or
  `approval_required` (§6.4);
- **default limits** — the default Invocation Budget and, for turn-based
  roles, `maxTurns`.

Any change to any field produces a new revision with a new `agdr_` id and
hash under the same logical id. Invocations reference the revision; a
running Invocation is unaffected by a later revision. There is no `trusted`
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
- Budget checks use the same sums.
- The operator-facing cost line always shows the Run total, and a per-node
  breakdown is available.

## 13. Events and projections

- Every canonical state change writes exactly one Event in the same
  transaction as the change. Event types follow the glossary convention.
- The UI subscribes to the Event stream from a sequence number and rebuilds
  its views from Events plus point reads of canonical stores. There is one
  stream per server; clients filter by Workspace, Conversation, or Run.
- Streaming provider output (partial text, tool calls in progress) is
  delivered on the same stream as transient Events that are not journaled;
  they carry the Attempt id and nothing else about the system.

## 14. Failure model

| Failure | Handling |
|---|---|
| Provider error, transient | New Attempt after backoff, within the Attempt Budget. |
| Provider error, permanent | Invocation `failed`; Pattern decides node outcome. |
| Provider capacity refused by the governor | Attempt not started; Run `waiting` (`provider_capacity`); the scheduler retries when the governor signals capacity or the retry-after time passes. |
| Invocation returns an invalid result | New Attempt with the validation error in the manifest. |
| Invocation exceeds its Budget | Invocation `failed` with reason `budget_exhausted`; no retry. |
| Plan Node fails | Successors `skipped` (or `ready` with the failure if opted in); the Orchestrator's next turn receives the failure. |
| Changeset conflict | Task created for the node owner; Gate blocked until resolved. |
| Publish fails | Target untouched; Publication `failed`; Orchestrator's next turn receives it. |
| Server restart | Every `running` Attempt is marked `interrupted`; on boot the runtime creates new Attempts for Invocations that still have Attempt Budget, from their persisted manifests, `resumed` only where §6.5 permits. Worktrees are preserved and reattached by Invocation id. Leases are recomputed from scratch. Nothing is inferred from transcripts. |
| Operator cancels a Run | All Attempts interrupted, all nodes `cancelled`, integration Workspace left in place, Run `cancelled`. |
| Operator pauses a Run | The scheduler stops starting Attempts for that Run; running Attempts are allowed to finish their current turn (`soft`) or interrupted (`hard`); Run `waiting` with reason `operator`. Other Runs are unaffected. |

## 15. Invariants

The implementation is accepted when every one of these holds and is covered
by a test.

1. **Single-agent execution is the default.** A Run's Execution Plan begins
   as one `single` node (the Orchestrator). Any additional node is an
   explicit revision by the Orchestrator with a stated Pattern.
2. **The Orchestrator may work directly.** The Orchestrator's Agent
   Definition grants read, write, and shell capabilities, and work it does
   in its own Invocation is recorded (Changesets, Artifacts, Usage) exactly
   like any other Invocation's.
3. **Patterns are typed Execution Plan nodes, not persistent agent chat
   topologies.** A Pattern exists only as the `pattern` field of a Plan
   Node and as an expression in a source revision. No table, object, or
   process represents a group of agents outside a Plan Node's lifetime, and
   no agent addresses another agent.
4. **Supported patterns are exactly** `single`, `chain`, `route`,
   `parallel`, `coordinator_worker`, and `evaluator_optimizer`. No other
   value is accepted, and none of these is implemented by delegating
   ordering or fan-in to an agent.
5. **The deterministic runtime owns scheduling, retries, dependencies,
   waiting, progress, budgets, and fan-in.** No runtime tool exposes any of
   these to an agent except as read-only facts; no prompt asks an agent to
   perform any of them.
6. **Agent transcripts are diagnostic records, never canonical state.** No
   code path reads a transcript Artifact or provider continuation metadata
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
    Invocation of every Plan Node writes rows tagged with that Run id.
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
    only by a `requirement_waiver` Decision.
14. **Coordination depth is one.** A Coordinator cannot revise the plan,
    create Invocations, or address Workers; a Worker cannot propose or
    create anything; a `coordinator_worker` expression cannot contain a
    composite operand or another `coordinator_worker`.
15. **The persisted plan is flat.** Every source revision compiles to a
    graph of Plan Nodes and typed Plan Edges with no nesting, no cycles, and
    bounded size; Coordinator-proposed Tasks never change it.
16. **The target branch is never modified by a Run.** Only a publish
    action on a `completed` Run writes to the target, after revalidating it,
    and it fails without writing when the operation is not clean.
17. **Provider resumption is optional and non-canonical.** Every Attempt
    can start `fresh` from its Context Manifest; deleting all provider
    continuation metadata changes no outcome.
18. **The resource governor is deterministic backpressure.** It never
    invokes a model, emits text, or holds semantic Run state; refusal is a
    structured reason on a `waiting` Run.
19. **No Decision resolves silently.** Every resolution — operator,
    Orchestrator, or `use_default_after_deadline` — writes a
    `decision.resolved` Event, and a policy resolution requires a recorded
    recommendation, deadline or condition, rationale, and affected ids.

## 16. Non-goals

- No benchmark or evaluation harness for orchestration quality. The
  implementation ships correctness and integration tests only.
- No numeric quality scores anywhere in the model.
- No agent-to-agent messaging, mailbox, or routing surface.
- No canonical dependence on provider session state.
- No nested persisted Plan Nodes and no nested Runs; composition is
  compiled flat.
- No global pause product state; backpressure is the resource governor.
- No runtime behaviour selected by a feature flag.
