# Glossary

This is the vocabulary of the Agentique Console orchestration architecture.
It is authoritative: code identifiers, table names, event names, API routes,
prompts, and UI labels use these terms and no others. Where a term here
conflicts with a term used elsewhere in this repository, this document wins;
the conflicting text is legacy and is scheduled for removal
([legacy-removal.md](legacy-removal.md)).

Related documents:

- [execution-model.md](execution-model.md) — how these objects behave at runtime.
- [migration-contract.md](migration-contract.md) — the terms of the clean-break replacement.
- [legacy-removal.md](legacy-removal.md) — what is deleted and what replaces it.

## Conventions

- A capitalized term (Run, Task, Artifact) names a canonical object or role
  defined below. The same word in lower case is ordinary English.
- "The runtime" means the deterministic, non-model part of the server: the
  scheduler, the journal, the stores, the gates. It never means a model.
- "The provider" means the model API and its SDK. Provider identifiers
  (provider session ids, message uuids) are opaque handles and are never
  domain identity.
- "The operator" is the human using the console.
- Every canonical object has a runtime-minted id. Ids are opaque strings
  with a fixed prefix (listed per term) and are never derived from provider
  identifiers, file paths, or display names.
- "Canonical" means the single authoritative record of a fact. Anything
  that restates a canonical fact (a transcript, a prompt, a UI card, a
  summary) is a projection and may be regenerated at any time.

## Scope objects

### Workspace

A directory on the local filesystem that a Run operates on. Usually a git
repository. Holds no orchestration state itself; the runtime keeps all state
outside it (except worktrees and the Run's Integration Workspace, see
Snapshot and Changeset). A Workspace has a **Workspace provider** — the
runtime component that implements Snapshots, worktrees, Changeset
integration, and publishing for its kind (git, or plain directory).

- Id prefix: `ws_`
- Owned by: the operator
- Store: `workspaces`
- Related: Conversation, Snapshot, Changeset

### Conversation

The operator's ordered exchange with the Orchestrator inside one Workspace.
A Conversation persists across Runs: it carries the operator messages, the
Orchestrator's replies, and the Decisions, Requirements, and Artifacts that
earlier Runs produced, so a later Run can reference them by id. A
Conversation has zero or more Runs and at most one active Run at a time.

- Id prefix: `cv_`
- Owned by: the operator (messages) and the runtime (structure)
- Store: `conversations`, `conversation_messages`
- Related: Workspace, Run, Orchestrator, Decision
- Not: a provider session. Not a transcript. Not a Run.

### Run

One bounded unit of execution started from a Conversation. A Run owns
exactly one Execution Plan, one Budget, one Usage total, and one terminal
state. Everything an Invocation does is attributed to exactly one Run. A
Run ends in one of the terminal states defined in
[execution-model.md](execution-model.md); it never resumes after ending,
and continuing the work means starting a new Run in the same Conversation.
A Run has a Target and a Run-owned Integration Workspace; it never writes
to the Target itself — that is a Publication.

- Id prefix: `run_`
- Owned by: the runtime
- Store: `runs`
- Related: Conversation, Execution Plan, Budget, Usage, Gate, Snapshot, Target, Publication

## Planning objects

### Orchestrator

The single agent role that talks to the operator. It runs in the root Plan
Node of the Execution Plan as a sequence of Orchestrator Invocations, one
per logical turn, of which at most one is active at any time. The
Orchestrator proposes Requirements, records its own Decisions, proposes
Requirement waivers for the operator to resolve, creates Tasks, authors
and revises the source Execution Plan, and reads compiled plan state and
results through runtime tools. It may also do work directly (read, edit,
run commands) without revising the plan. It never writes compiled plan
structure: the runtime validates each proposed source revision and the
deterministic compiler materializes the Plan Nodes and Plan Edges.

The Orchestrator is a role held by an Agent Definition named
`orchestrator`. It has no special runtime privileges beyond the tools that
definition grants; the runtime enforces every rule identically for it and
for every other Invocation.

- Not an object with its own store; it is the root Plan Node's role.
- Related: Conversation, Execution Plan, Plan Node, Invocation, Agent Definition

### Execution Plan

The plan of Plan Nodes that a Run executes. It has two forms, both owned by
the runtime. The **source form** is a tree of Pattern expressions the
Orchestrator authors and revises; operands are leaf operations or nested
Pattern expressions, so Patterns compose structurally. The **compiled
form** is the flat directed acyclic graph of Plan Nodes and Plan Edges that
the deterministic plan compiler materializes from a source revision and
that the scheduler executes. Only the Orchestrator authors and revises the
source form; the runtime validates each proposed revision; only the
compiler writes the compiled form. Every source revision is append-only; a
compiled node that has started cannot be altered, only cancelled. The
compiler rejects recursion, unbounded composition, nesting beyond
configured limits, invalid Requirement references, and allocations that
cannot be reserved.

- Id: the owning Run's id; source revisions are numbered from 1.
- Owned by: the runtime
- Store: `execution_plan_revisions` (source); `plan_nodes`, `plan_edges`, `plan_node_requirements` (compiled)
- Related: Run, Plan Node, Plan Edge, Plan Node Requirement Scope, Pattern

### Plan Node

One unit of the compiled Execution Plan. A Plan Node has a **kind** —
`pattern` or `join` — a status, the position in the source expression it
was compiled from, a Budget allocation, and, when finished, a set of output
Artifacts. A `pattern` node has exactly one of the six Pattern values, a
set of inputs (a Context Manifest template), Agent Definition revisions per
role, an exact Requirement scope, and creates Invocations. A `join` node
has no Pattern value, no Agent Definition, no scope, zero allocation, and
creates no Invocation: it executes deterministically when its `fan_in`
predecessors are terminal, produces an index Artifact of the ordered
predecessor references, outcomes, and output Artifact ids, and succeeds or
fails by its fan-in policy. `join` is a deterministic node kind, not a
seventh Pattern. A persisted Plan Node does not contain other Plan Nodes;
composition between nodes is expressed only by Plan Edges. Only the plan
compiler writes Plan Nodes.

- Id prefix: `pn_`
- Owned by: the runtime (plan compiler)
- Store: `plan_nodes`
- Related: Execution Plan, Plan Edge, Plan Node Requirement Scope, Pattern, Invocation, Handoff, Budget, Gate

### Plan Edge

A typed, directed relation between two Plan Nodes in the compiled Execution
Plan. Edge types are `sequence` (target eligible when source is terminal;
source outputs delivered as a Handoff), `branch(label)` (a `sequence` edge
active only when a `route` source selected the label), `fan_in` (an edge
into a `join` node; the join is eligible when every `fan_in` source is
terminal and records their outcomes and outputs in its index Artifact in
edge order), and `retry(round)` (a `sequence` edge into a later unrolled
round of an `evaluator_optimizer` expression, active only when the
source's Evaluation failed). Node readiness is computed from edges and
allocation alone. Only the plan compiler writes Plan Edges.

- Id prefix: `pe_`
- Owned by: the runtime (plan compiler)
- Store: `plan_edges`
- Related: Execution Plan, Plan Node, Handoff

### Plan Node Requirement Scope

The exact set of leaf Requirement ids a `pattern` Plan Node serves, at one
pinned Requirement revision, expanded by the compiler from the Requirement
roots its source expression named and persisted as one row per (Plan Node,
Requirement id, Requirement revision). The scope of an existing node never
changes; a later Requirement revision leaves it untouched, and revised
Requirements reach execution only through a source plan revision that
produces replacement nodes. Coordinator-proposed Tasks must reference a
non-empty subset of their node's scope at the pinned revision. The root
Orchestrator node and `join` nodes have no scope rows.

- Key: (Plan Node id, Requirement id, Requirement revision id); no own prefix.
- Owned by: the runtime (plan compiler)
- Store: `plan_node_requirements`
- Related: Plan Node, Requirement, Task, Coordinator

### Pattern

The orchestration shape of a `kind: pattern` Plan Node. A Pattern is a
fixed execution shape the runtime knows how to run: how many Invocations it
creates, in what order, what each receives, and how their results are
combined. The supported Patterns are exactly `single`, `chain`, `route`,
`parallel`, `coordinator_worker`, and `evaluator_optimizer`, defined in
[execution-model.md](execution-model.md). A Pattern is a property of a node
for the duration of that node; it is not a persistent group of agents, not
a chat topology, and not a routing table between agents. The deterministic
`join` node kind is not a Pattern. Patterns compose structurally in the
source Execution Plan; the compiler materializes the composition flat.

- Value set: `single | chain | route | parallel | coordinator_worker | evaluator_optimizer`
- Related: Plan Node, Worker, Coordinator, Evaluator

## Specification objects

### Requirement

A declarative statement of something that must be true of the finished work.
Requirements form a tree per Conversation: an internal node composes its
children with `all` or `any`; a leaf is checked directly. A Requirement has
a semantic status (`open`, `satisfied`, `violated`, `infeasible`, `waived`,
`retired`) and never a numeric score. `satisfied` derives only from its
Acceptance Criteria and Evidence recorded at a Gate — never from a Task
completing or an agent's claim. `waived` is reached only through a
`requirement_waiver` Decision. Parent statuses are derived from children by
the runtime. A Requirement revision represents a change to an intended
outcome or constraint (statement, composition, Acceptance Criteria, which
Requirements exist); changes to how the work is done change Tasks or the
Execution Plan, never the Requirement. The id is stable across revisions.

- Id prefix: `req_`
- Owned by: the operator (approval) and the Orchestrator (proposal)
- Store: `requirements`, `requirement_revisions`, `requirement_status_changes`
- Related: Acceptance Criterion, Task, Evidence, Decision, Gate

### Acceptance Criterion

A concrete, checkable condition attached to a Requirement or a Task that
says how satisfaction is established. An Acceptance Criterion is either
`deterministic` (a command the runtime runs and whose exit status and
output decide it, such as a test or build command) or `evaluated` (a
question an Evaluator answers with an Evaluation). Deterministic criteria
are always checked before evaluated ones.

- Id prefix: `ac_`
- Owned by: the Orchestrator (authoring), the runtime (checking)
- Store: `acceptance_criteria`
- Related: Requirement, Task, Gate, Evaluation, Evidence

### Decision

A recorded choice: the question, the options considered, the requester's
recommended option, the chosen answer, who resolved it (`operator`,
`orchestrator`, or `policy:use_default_after_deadline`), the rationale, the
timestamp, and the ids of the Run, Requirements, Tasks, and Plan Nodes it
affects. A Decision has a **kind** — `operator_choice`,
`orchestrator_choice`, `requirement_waiver`, `side_effect_approval`,
`signoff`, `publish` — and a **resolution policy** — `operator_required`
(resolves only when the operator answers) or `use_default_after_deadline`
(resolves to the recorded recommended option at a recorded deadline or
deterministic activation condition; permitted for `operator_choice` only).
A `requirement_waiver` is proposed by the Orchestrator, always
`operator_required`, resolved only by the operator, and never delegated or
auto-resolved; its resolution records actor, rationale, Requirement id,
timestamp, and optional Artifact ids, after which the runtime sets the
Requirement `waived`. Every resolution writes one `decision.resolved`
Event; no Decision resolves silently. Decisions are append-only; a later
Decision may supersede an earlier one by id. An unanswered
`operator_required` Decision is the only thing that makes a Plan Node wait
on a human.

- Id prefix: `dec_`
- Owned by: whoever resolved it
- Store: `decisions`
- Related: Conversation, Requirement, Task, Plan Node, Publication

## Work objects

### Task

One unit of work in a Run's ledger. A Task has a subject, a state, an
optional assignee (a Plan Node and Invocation), the leaf Requirement ids
it serves (for a Coordinator-proposed Task, a non-empty subset of its
node's scope), dependencies on other Tasks, its required outputs, and the
Artifact ids it produced. The states are exactly `pending` (dependencies
or required inputs not satisfied), `ready` (eligible for execution),
`running` (assigned to an active Invocation), `blocked` (cannot continue
without a Decision, replacement input, or Coordinator replanning),
`completed` (finished with required Artifacts and Evidence; terminal),
`failed` (Attempts exhausted or permanent failure; terminal), and
`cancelled` (deliberately stopped; terminal). Only the runtime transitions
a Task; a `failed` Task is never reclassified `cancelled`; completing a
Task never satisfies a Requirement.

- Id prefix: `task_`
- Owned by: the runtime (identity, state transitions); created from
  Orchestrator `create_tasks` or validated Coordinator `propose_tasks`
- Store: `tasks`, `task_dependencies`
- Related: Requirement, Plan Node, Plan Node Requirement Scope, Invocation, Artifact, Acceptance Criterion, Budget Reservation

### Artifact

An immutable, content-addressed record produced by an Invocation or by the
runtime: a file, a report, a diff, a command log, a transcript, a
structured result. Artifacts have a media type, a byte size, a digest, a
producer (Invocation or runtime), and a Run. Anything an Invocation wants
another Invocation to read is an Artifact; nothing is passed as prose in a
prompt if it can be passed as an Artifact id.

- Id prefix: `art_`
- Owned by: the runtime
- Store: `artifacts` (metadata) and the artifact blob store
- Related: Handoff, Task, Changeset, Evidence, Context Manifest

### Handoff

The record the runtime carries from one Plan Node or Invocation to another
when work moves. A Handoff contains routing metadata only: source, target,
the Task ids concerned, the Artifact ids to read, a one-line summary, and a
status. It contains no free-form state and no instructions. A Handoff is
delivered by the runtime as part of a Context Manifest; agents never send
messages to each other directly.

- Id prefix: `ho_`
- Owned by: the runtime
- Store: `handoffs`
- Related: Artifact, Task, Plan Node, Invocation, Context Manifest

## Agent objects

### Agent Definition

An immutable, versioned configuration an Invocation runs with. A definition
has a **stable logical identity** (`agd_`) shared by all its revisions and,
per revision, a **revision identity** (`agdr_`), a **content hash**,
**provenance** (`builtin`, `workspace_file` with path and Snapshot, or
`conversation` with the approving Decision), a **model policy** (model,
effort, context policy), **instructions**, **capabilities** (declared
provider-native tools and MCP servers), a **Tool Policy**, and **default
limits** (default Invocation allocation and wall-clock limit). Any change produces a new
revision; a running Invocation keeps the revision it started with. There is
no `trusted` flag and no trust table: what a definition may do is bounded
by capability policy, Tool Policy, worktree isolation, side-effect
approval, and Gates.

- Id prefixes: `agd_` (logical), `agdr_` (revision)
- Owned by: the workspace author (files), the console (built-ins), the operator (conversation-authored)
- Store: `agent_definitions`, `agent_definition_revisions`
- Related: Tool Policy, Invocation, Worker, Coordinator, Evaluator, Orchestrator

### Tool Policy

The per-capability disposition an Agent Definition revision carries for
each provider-native tool it declares: `allowed`, `denied`, or
`approval_required`. An `approval_required` call is intercepted by the
runtime and turned into a `side_effect_approval` Decision before it may
proceed. The effective policy for an Attempt is the intersection of the
revision's Tool Policy with the role policy (Evaluators are read-only) and
the Workspace policy. Tool Policy is one of the five safety mechanisms
(with capability policy, worktree isolation, side-effect approval, and
Gates) and is the only way a definition's reach is widened or narrowed.

- Stored on the Agent Definition revision; no separate table.
- Related: Agent Definition, Decision, Attempt

### Invocation

One logical execution of an Agent Definition revision inside a `pattern`
Plan Node: one role (`orchestrator`, `worker`, `coordinator`,
`evaluator`), one **purpose** (for example `operator_input`,
`node_result`, `decision_resolution`, `gate_result`, `plan_revision`,
`publication_result`, `final_synthesis` for the Orchestrator; `decompose`,
`replan`, `synthesize` for a Coordinator; `step`, `task` for a Worker;
`select`, `evaluate` for an Evaluator), one immutable Context Manifest, one
Budget allocation, one or more Attempts, a status, Usage, and one typed
result. New logical input always creates a new Invocation; an Invocation
never receives input after creation. An Invocation that logically follows
an earlier one records `continuedFromInvocationId`. The root Plan Node owns
a sequence of Orchestrator Invocations and a `coordinator_worker` node owns
separate Coordinator Invocations per purpose; at most one Orchestrator
Invocation per Run and one Coordinator Invocation per node is active at any
time. The stable entity across turns is the Plan Node, never an
Invocation.

- Id prefix: `inv_`
- Owned by: the runtime
- Store: `invocations`
- Related: Plan Node, Agent Definition, Attempt, Context Manifest, Budget Reservation, Usage

### Attempt

One provider execution of an Invocation from start to a terminal result or
failure. `kind` is `initial` (the Invocation's first Attempt) or `retry`
(after a retryable failure); there is no other kind, and new logical input
never produces an Attempt. Each Attempt has its own transcript Artifact,
Usage rows, and failure classification, and records its `startMode` —
`fresh` (started from the Context Manifest) or `resumed` (continued
provider execution from the nullable `resumedFromAttemptId`, which may
name a prior Attempt of the same Invocation or the last Attempt of the
Invocation named by `continuedFromInvocationId`, when the provider adapter
determines that is supported, safe, available, and within the allocation).
Every Attempt can be started `fresh`. Attempts are numbered from 1 within
their Invocation.

- Id prefix: `att_`
- Owned by: the runtime
- Store: `attempts`; continuation index in `provider_continuations`
- Related: Invocation, Provider Continuation, Usage, Artifact (transcript)

### Worker

An Invocation role: an agent that executes assigned Tasks inside a Plan Node
and returns results as Artifacts. Workers receive their input from the
runtime, write their output for the runtime, and do not communicate with
other Workers. A Worker cannot propose or create Tasks, Workers,
Coordinators, or Plan Nodes.

- Related: Invocation, Task, Coordinator, Pattern

### Coordinator

An Invocation role used only by the `coordinator_worker` Pattern: the agent
that proposes the node's Tasks, receives Worker results as Handoffs, and
synthesizes them into the node's output. A Coordinator is scoped to one
Plan Node. It does not revise the Execution Plan, does not create
Invocations, and does not call or message Workers; it proposes Tasks and
the runtime validates them against the node's exact Requirement scope,
reserves Budget, persists them, and schedules the Workers. The node owns
separate Coordinator Invocations, each with one purpose — `decompose`
(once), `replan` (on a genuine semantic blocker), `synthesize` (once) —
and never more than one active at a time; routine progress never creates
one. Coordination depth is one: no Coordinator exists inside another
Coordinator's node.

- Related: Invocation, Worker, Task, Handoff, Pattern, Plan Node Requirement Scope

### Evaluator

An Invocation role: an agent that judges an Artifact against Acceptance
Criteria or a stated rubric and produces an Evaluation. An Evaluator has
read-only tools and never modifies the Workspace.

- Related: Invocation, Evaluation, Gate, Pattern

## Verification objects

### Evaluation

The recorded outcome of a check: which Acceptance Criterion or rubric was
checked, the verdict (`pass`, `fail`, `inconclusive`), the Evidence, and
who produced it (`runtime` for a deterministic check, an Evaluator
Invocation id otherwise). Evaluations are append-only.

- Id prefix: `eval_`
- Owned by: the runtime or the Evaluator
- Store: `evaluations`
- Related: Acceptance Criterion, Evidence, Gate, Evaluator

### Gate

A runtime checkpoint that must pass before a Plan Node completes, before a
Run completes, or before a Run is accepted by the operator. A Gate lists
the Acceptance Criteria it requires and the order they are checked:
deterministic criteria first, then evaluated criteria, then, for the
`operator_signoff` Gate, the operator's explicit acceptance. A Gate that
fails does not end the Run; it produces Tasks.

- Id prefix: `gate_`
- Kinds: `node_exit`, `run_completion`, `operator_signoff`
- Owned by: the runtime
- Store: `gates`
- Related: Acceptance Criterion, Evaluation, Plan Node, Run

### Evidence

A reference to a verifiable fact: a command and its captured output, an
Artifact id, a file path at a Snapshot, a test report, a URL. Evidence is
always attached to something (an Evaluation, a Requirement status change,
a Task completion) and is never free text. The runtime validates that
referenced Artifacts, Snapshots, and files exist when Evidence is recorded.

- Stored inline on the object it supports; no separate table.
- Related: Evaluation, Requirement, Task, Artifact, Snapshot

## Workspace state objects

### Snapshot

An immutable identification of a Workspace's complete state at a point in
time. For a git Workspace, a Snapshot is a commit id plus the tree id; for a
non-git Workspace, a content digest of the tracked files. Snapshots are
taken by the runtime at Run start, before and after every writing
Invocation, and at Run completion.

- Id prefix: `snap_`
- Owned by: the runtime
- Store: `snapshots`
- Related: Workspace, Changeset, Run, Evidence

### Changeset

The difference between two Snapshots, produced by one writing Invocation in
its isolated worktree and stored as an Artifact. The runtime integrates
Changesets into the Run's Integration Workspace in Plan Edge order and
records the resulting Snapshot. A Changeset that cannot be integrated
cleanly produces a Task; it is never applied partially. The Run's **final
Changeset** is the diff from its base Snapshot to its accepted final
Snapshot.

- Id prefix: `cs_`
- Owned by: the runtime
- Store: `changesets` (metadata) plus the diff Artifact
- Related: Snapshot, Invocation, Artifact, Task, Publication

### Target

The operator-controlled branch (or, for a non-git Workspace, the
Workspace directory itself) that a Run's result is intended for. The
runtime takes the Run's base Snapshot from the Target at Run start and
never modifies the Target while the Run executes; only a Publication
writes to it.

- Stored on the Run; no separate table.
- Related: Run, Snapshot, Publication, Integration Workspace

### Integration Workspace

The Run-owned worktree and branch, created from the base Snapshot, into
which the runtime integrates every Changeset and against which
deterministic verification runs. It is isolated from the Target and from
every Invocation's worktree.

- Stored on the Run; no separate table.
- Related: Run, Changeset, Snapshot, Target

### Publication

The record of one publish action: applying a `completed` Run's final
Changeset to its Target. A Publication records the authorizing `publish`
Decision (or the policy Decision that authorized automatic publishing),
the Target's Snapshot before and after, the strategy the Workspace
provider selected at publish time (`fast_forward`, `merge`, or another
supported strategy), the outcome (`succeeded` or `failed` with reason),
and the publish Artifact. A Publication never writes to the Target unless
the Target was revalidated and the operation is clean.

- Id prefix: `pub_`
- Owned by: the runtime (Workspace provider)
- Store: `publications`
- Related: Run, Target, Changeset, Snapshot, Decision, Event

## Records

### Event

One append-only journal entry. Every state change to a canonical object is
recorded as an Event with a global monotonic sequence number, a type, the
ids of the objects it concerns, and a payload. The UI and every projection
are rebuilt from Events; nothing in the system is knowable only from a
transcript.

- Key: global sequence number
- Owned by: the runtime
- Store: `events`
- Related: every object

### Context Manifest

The explicit, complete list of inputs the runtime assembles for an
Invocation: the Agent Definition digest, the Plan Node and Task ids, the
Requirement ids and their statements, the Decision ids and their answers,
the Handoffs delivered, the Artifact ids the Invocation may read, the
Snapshot it starts from, and the allocation it holds. Exactly one manifest
exists per Invocation; it is persisted before the initial Attempt starts
and never changes, so that any Attempt can be reproduced and audited. An
Invocation receives nothing that is not in its manifest, and never a
provider continuation payload.

- Id prefix: `cm_`
- Owned by: the runtime
- Store: `context_manifests`
- Related: Invocation, Attempt, Handoff, Artifact, Requirement, Decision

### Provider Continuation

An index row, keyed by Attempt, that lets the provider adapter find the
opaque continuation payload for a possible `resumed` Attempt: Attempt id,
provider, storage key, digest, creation time, optional expiry time. The
payload itself lives in an adapter-owned, replaceable payload store under
`server/src/provider/` and is never embedded in a canonical row. It is not
an Artifact, is not in any Context Manifest, is never read by projections
or scheduler decisions, may be deleted at any time, and never appears in
Events, logs, or API responses. A missing, expired, or mismatched payload
means the Attempt starts `fresh`.

- Key: Attempt id; no own prefix.
- Owned by: the provider adapter
- Store: `provider_continuations` (index) + adapter payload store
- Related: Attempt, Invocation

### Budget

A set of limits: maximum cost, maximum tokens, maximum wall-clock time,
maximum Attempts, and maximum concurrent Invocations. The **Run Budget** is
the global cap and allocation pool for the whole Run. A **Plan Node
allocation** is an explicit amount reserved from the Run Budget before the
node becomes runnable — the root Orchestrator node receives an explicit
initial allocation, never the entire Run Budget. An **Invocation
allocation** is an explicit amount reserved from its Plan Node before the
Invocation starts. Limits are stored on the object they bound; allocation
accounting is done with Budget Reservations. Cost, tokens, and Attempts are
reserved quantities; wall-clock deadlines and concurrency ceilings are
limits enforced by the runtime and the Resource Governor. Exhausting a
Run Budget places the Run in `waiting` with reason `budget`, never
`failed`; a node or Invocation that exhausts its allocation fails or waits
by its declared policy.

- Limits stored on the object they bound; reservations in `budget_reservations`.
- Related: Run, Plan Node, Invocation, Budget Reservation, Usage

### Budget Reservation

The canonical record of one allocation: the parent bounded object (Run,
Plan Node, or Invocation), the child bounded object or proposed work item
(Plan Node, Invocation, or Task), the reserved cost, tokens, and Attempts,
the creation time, the release time, and the status (`active`,
`released`). A reservation is created atomically with the child, before
the child becomes runnable, and only from the parent's unconsumed,
unreserved capacity; it is released with its final consumed amounts when
the child reaches a terminal state, returning the remainder to the parent.
A plan revision whose allocations cannot all be reserved is rejected.

- Id prefix: `bres_`
- Owned by: the runtime
- Store: `budget_reservations`
- Related: Budget, Run, Plan Node, Invocation, Task, Usage

### Usage

Measured consumption recorded per Attempt: input tokens (uncached, cache
creation, cache read), output tokens, cost, wall-clock and provider time,
model, and effort. Usage is rolled up by the runtime to Invocation, Plan
Node, and Run. A Run's total includes every Attempt of every Invocation of
every Plan Node in it, the Orchestrator's included.

- Id prefix: `use_`
- Owned by: the runtime
- Store: `usage`
- Related: Attempt, Invocation, Plan Node, Run, Budget

## Capacity

### Resource Governor

The deterministic, process-wide component of the runtime that manages
provider quota and capacity, global provider concurrency, machine and
process concurrency, and configured resource limits, by granting Capacity
Leases to Runs. It never invokes a model, never generates text, never
holds semantic Run state, and is not an orchestration layer; it is
backpressure. When it cannot grant a lease the affected Run enters
`waiting` with the structured reason `provider_capacity`.

- Not an object with its own store; its grants are Capacity Leases.
- Related: Capacity Lease, Run, Attempt

### Capacity Lease

A grant from the Resource Governor that permits one Attempt of a Run to
start and hold provider and process capacity until it ends. A lease
records the Run, the Attempt, the resources reserved, the grant time, and
the release time. Refusals carry a structured reason (`provider_quota`,
`provider_concurrency`, `process_concurrency`, `configured_limit`) and,
where known, a retry-after time.

- Id prefix: `lease_`
- Owned by: the Resource Governor
- Store: `capacity_leases`
- Related: Resource Governor, Run, Attempt

## Retired terms

The following terms are retired. They do not appear in new code, schema,
routes, events, prompts, tests, or UI text. Each maps to its replacement.

| Retired term | Replacement |
|---|---|
| `UserSession` | Conversation (the operator's thread) and Run (one bounded execution). A `UserSession` conflated both. |
| `AgentSession` | Plan Node (the unit of execution shape) and Invocation (the unit of agent execution). There is no persistent group of agents. |
| `Main orchestrator`, `main` | Orchestrator. There is one Orchestrator per Run and no other kind of orchestrator, so the qualifier is meaningless. |
| `seat` | Invocation. An agent does not occupy a durable position; it is invoked, produces a result, and ends. |
| `specialist` | Worker (when executing Tasks) or Evaluator (when judging). Role names describe what the Invocation does in its Pattern, not a skill category. |
| `generation` | Attempt. A retried Invocation has numbered Attempts; there is no rotating identity that survives them. |
| `attention` | Deleted with no replacement. The runtime schedules Orchestrator turns from Plan Node and Gate state; nothing is modelled as an agent's attention. |
| `wake` | Deleted with no replacement. An Invocation is scheduled by the runtime when its dependencies are satisfied; no agent is parked or woken. |
| `delegation edge` | Plan Node dependency (between nodes) and Handoff (between an Invocation and the runtime). There is no agent-to-agent routing table. |
| `handoff core` | Handoff. A Handoff has one shape; there is no core/extension split. |
| `handoff extension` | Deleted with no replacement. Typed content travels as typed Artifacts referenced from the Handoff. |

The following legacy words are also not used for new concepts, because each
carried a specific legacy meaning: `lane`, `roster`, `commission`,
`mailbox`, `mailroom`, `topology`, `contract` (as in topology contract),
`workstream`, `spec`, `interaction`, `profile` (use Agent Definition),
`crew`, `hub`, `pipeline` (use `chain`), `map_reduce` (use `parallel`),
`debate`, `peer_to_peer`, `plan_execute`, `landing`, `rotation`,
`checkpoint` (as in continuation checkpoint), `continuation` (as a
subsystem; provider continuation metadata is the one permitted use),
`trusted` / `trust` (as a definition flag or table), `deferrable`,
`pause` (as a system-wide state; a Run may be `waiting` with reason
`operator`), `turn` (as an Attempt kind or a long-lived Invocation; a
logical turn is a new Invocation), `in_progress` (as a Task state; use
`running`).

## Identifier conventions

- Table names are the plural snake_case of the term: `runs`, `plan_nodes`,
  `plan_edges`, `plan_node_requirements`, `acceptance_criteria`,
  `context_manifests`, `agent_definition_revisions`, `publications`,
  `capacity_leases`, `budget_reservations`, `provider_continuations`.
- Id prefixes: `ws_`, `cv_`, `run_`, `pn_`, `pe_`, `req_`, `ac_`, `dec_`,
  `task_`, `art_`, `ho_`, `agd_`, `agdr_`, `inv_`, `att_`, `eval_`,
  `gate_`, `snap_`, `cs_`, `pub_`, `lease_`, `bres_`, `cm_`, `use_`. A
  prefix is never reused for a second kind. `plan_node_requirements` and
  `provider_continuations` are keyed by the objects they index and carry
  no own prefix.
- Plan Node kinds are `pattern` and `join`; Invocation purposes,
  Attempt kinds (`initial`, `retry`), Attempt start modes (`fresh`,
  `resumed`), and Task states are lower snake_case as listed in their
  entries.
- The database identifies itself with a single-row `schema_info` table
  (`application`, `schema`, `version`) written by the baseline migration;
  see [migration-contract.md](migration-contract.md) §4. It is not a
  domain object.
- Type names are the singular PascalCase term: `Run`, `PlanNode`,
  `AcceptanceCriterion`, `ContextManifest`.
- Event types are `<object>.<past_tense_verb>` in snake_case:
  `run.started`, `plan_node.completed`, `invocation.failed`,
  `gate.passed`, `decision.recorded`.
- API routes are `/api/<plural-kebab-case>`: `/api/runs`,
  `/api/plan-nodes`, `/api/acceptance-criteria`.
- Roles are lower-case singular: `orchestrator`, `worker`, `coordinator`,
  `evaluator`.
- Patterns are lower snake_case: `single`, `chain`, `route`, `parallel`,
  `coordinator_worker`, `evaluator_optimizer`.
