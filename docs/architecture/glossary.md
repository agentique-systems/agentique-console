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
- The TypeScript type, identifier prefix, state set, transition table, and
  runtime validator for every term below live in the permanent,
  provider-neutral domain package `@agentique-console/core` (`core/src/`),
  which the final server and the final web application both import. The
  canonical stores live behind the permanent server persistence boundary
  `server/src/persistence/`, and the deterministic runtime (plan compiler,
  plan-revision service, Run creation, the scheduler, the six Pattern
  runners, join settlement, the deterministic Acceptance Criterion check
  service, the Gates, and the publication service) behind the permanent
  execution boundary
  `server/src/execution/`, which depends only on the core package, the
  persistence boundary, and narrow ports for capabilities implemented in
  later phases. None of them imports the legacy `shared/` package or the
  legacy `server/src/db/` schema; see
  [migration-contract.md](migration-contract.md) §3.

## Scope objects

### Workspace

A directory on the local filesystem that a Run operates on. Usually a git
repository. Holds no orchestration state itself; the runtime keeps all state
outside it (except worktrees and the Run's Integration Workspace, see
Snapshot and Changeset). A Workspace has a **Workspace provider** — the
runtime component that implements Snapshots, worktrees, Changeset
integration, and publishing for its kind. The git kind publishes through
one atomic reference transaction; the plain-directory kind cannot update
its Target atomically with a durable receipt and therefore publishes
nothing (its provider refuses before the directory is touched), while it
executes, integrates, verifies, and is signed off like a git Workspace.

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

- Id prefix: `cv_`; `cvm_` for a Conversation message
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
to the Target itself — that is a Publication. A Run also carries its
**final reserve**: the part of its Budget, chosen at Run creation and
persisted on the Run, that ordinary Plan Node allocations never consume
(see Budget), and its immutable **verification policy**: the Gate
Evaluator Agent Definition revision every `node_exit` Gate's evaluated
criteria are judged by (`null` for a Run whose Gates are deterministic
only; never the `orchestrator` definition), `maxNodeGateCycles`, the
bound on Gate cycles per Plan Node, `maxRunCompletionCycles`, the bound
on `run_completion` Gate cycles per Run, and
`runCompletionAcceptanceCriterionIds`, the Run's declared completion
criteria (of its Conversation, deduplicated and in id order; a coding Run
declares at least one deterministic one). Creating a Run establishes its
complete initial state atomically (execution-model §3, §4.6). A Run
reaches `awaiting_signoff` only through a passed `run_completion` Gate
(execution-model §10) and `completed` only through the operator's
`accept` at the `operator_signoff` Gate, recorded as a Signoff Resolution;
a completed Run carries exactly its **final Snapshot** (`finalSnapshotId`,
the signoff Gate's verified Snapshot by reference) and its **final
Changeset** (`finalChangesetId`, its one `final` Changeset), and no other
Run carries either (execution-model §9.3). The operator controls a Run
through three internal operations (execution-model §3, §14): **cancel**
ends any nonterminal Run `cancelled`, its work converged to its legal
cancellation states with terminal history preserved; **pause** withholds
new work — `soft` lets the admitted Attempts drain with their Usage and
results, `hard` interrupts them for a retry after the resume — and is
the persisted **operator pause** mode (`operatorPause`), held by a
`waiting` Run with reason `operator` or beside a `verifying` or
`awaiting_signoff` status, never a status of its own; **resume** clears
only that pause and lets the next scheduler pass recompute readiness
from rows.

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
compiler writes the compiled form. Only accepted revisions are persisted
and numbered; a rejected proposal consumes no number and leaves one
`execution_plan.rejected` Event. Every accepted revision has an immutable
ordered **membership** of Plan Nodes and its own Plan Edges (see Plan
Revision Membership); the current executable graph is exactly the latest
accepted revision's members and edges. A compiled node that has started
cannot be altered, only cancelled. The compiler rejects recursion,
unbounded composition, nesting beyond configured limits, invalid
Requirement references, and allocations that cannot be reserved.

- Id: the owning Run's id; accepted source revisions are numbered from 1.
- Owned by: the runtime
- Store: `execution_plan_revisions` (source); `plan_nodes`, `plan_revision_nodes`, `plan_edges`, `plan_node_requirements` (compiled)
- Related: Run, Plan Node, Plan Edge, Plan Revision Membership, Plan Node Requirement Scope, Pattern

### Plan Node

One unit of the compiled Execution Plan. A Plan Node has a **kind** —
`pattern` or `join` — a status, the canonical source path of the source
expression it was compiled from, the accepted revision that created it, a
Budget allocation, and, when finished, a set of output Artifacts. A
`pattern` node has exactly one of the six Pattern values, an immutable
pattern-specific **shape** (the Agent Definition revision, title, and
input of every operation the Pattern executes: chain steps, parallel items
and aggregation, route selector and canonical branch bindings,
coordinator and worker operands and bounds, inline or unrolled
evaluator-optimizer round), a Context Manifest template (the union of its
operations' inputs), an exact Requirement scope, and creates Invocations.
A `join` node has no Pattern value, no shape, no scope, zero allocation,
and creates no Invocation, Attempt, lease, or Usage: it executes
deterministically from `ready` when its `fan_in` predecessors are
terminal, produces an index Artifact (`application/vnd.agentique.join-index.v1+json`)
of the ordered predecessor references, outcomes, and output Artifact ids,
and succeeds or fails by its fan-in policy over the non-skipped
predecessors (skipped when all were skipped). `join` is a deterministic
node kind, not a seventh Pattern. A node that waits records one of the wait
reasons `decision`, `budget`, `provider_capacity`, `integration_conflict`,
`operator`; a node that fails records one of the failure reasons
`invocation_failed`, `result_failed`, `result_blocked`, `task_unavailable`,
`allocation_exhausted`, `integration_conflict`, `join_fan_in_failed`,
`route_selection_failed`, `parallel_items_failed`, `coordinator_no_progress`,
`coordinator_invocations_exhausted`, `optimizer_rounds_exhausted` on its
`plan_node.failed` Event, which also lists the runtime index Artifacts
recorded with a fan-in failure (or the last judged candidate of an
exhausted optimizer). A persisted Plan Node does not contain other
Plan Nodes; composition between nodes is expressed only by Plan Edges. A
node's **definition** (everything but its id, revision, status,
timestamps, and output) is immutable; reconciliation reuses a node across
revisions only when its definition is unchanged. Only the plan-revision
service, through the compiler, writes Plan Nodes; the root Orchestrator
node is written by Run creation.

- Id prefix: `pn_`
- Owned by: the runtime (plan-revision service and Run creation)
- Store: `plan_nodes`
- Related: Execution Plan, Plan Edge, Plan Node Requirement Scope, Pattern, Invocation, Handoff, Budget, Gate

### Plan Edge

A typed, directed relation between two Plan Nodes in the compiled Execution
Plan. Edge types are `sequence` (target eligible when source is terminal;
source outputs delivered as a Handoff), `branch(label)` (a `sequence` edge
active only when a `route` source selected the label), `fan_in` (an edge
into a `join` node; the join is eligible when every `fan_in` source is
terminal and records their outcomes and outputs in its index Artifact in
edge order), and `retry(round)` (a `sequence` edge from the evaluate-only
`evaluator_optimizer` node of round `round − 1` into the unrolled producer
subgraph of round `round`, active only when the source's recorded round
verdict is `fail` or `inconclusive`; a `pass` leaves it inactive and every
later round is skipped). Every Plan Edge belongs to exactly one
accepted Execution Plan revision and is append-only; reusing a node in a
later revision never reuses an earlier revision's edge row. Node readiness
is a pure function of the current accepted revision's graph plus the
explicit canonical condition facts a conditional edge needs (a `route`
node's recorded `route_selection` Evaluation for its `branch(label)` and
`sequence` edges; an evaluate-only `evaluator_optimizer` node's recorded
`optimizer_verdict` Evaluation for its `retry(round)` and `sequence`
edges), together with allocation; an edge of a historical revision never
affects readiness, and a fact is keyed by node id so a historical
selection or verdict never activates a current edge. An inactive
conditional edge is never a failed predecessor: its target is skipped.
Only the plan-revision service, through the compiler, writes Plan Edges.

- Id prefix: `pe_`
- Owned by: the runtime (plan-revision service)
- Store: `plan_edges`
- Related: Execution Plan, Plan Node, Plan Revision Membership, Handoff

### Plan Revision Membership

The immutable, ordered list of Plan Nodes that belong to one accepted
Execution Plan revision, persisted as one row per (Run, revision number,
Plan Node) with a position. The root Orchestrator node is the first member
of every accepted revision. An unchanged node appears in the membership of
every revision it survives while keeping one Plan Node row, id, state,
scope, and reservation; a node removed by a revision leaves the membership
and, if it has not started, is cancelled. The scheduler's executable graph
is exactly the latest accepted revision's membership plus that revision's
Plan Edges; nothing infers membership from timestamps, a node's creating
revision, incident edges, source-path prefixes, or status. Historical
revisions remain fully inspectable through their own membership and edges.

- Key: (Run id, revision number, Plan Node id); no own prefix.
- Owned by: the runtime (plan-revision service and Run creation)
- Store: `plan_revision_nodes`
- Related: Execution Plan, Plan Node, Plan Edge

### Plan Node Requirement Scope

The exact set of leaf Requirement ids a `pattern` Plan Node serves, at one
pinned Requirement revision, expanded by the compiler from the Requirement
roots its source expression named and persisted as one row per (Plan Node,
Requirement id, Requirement revision) with a deterministic position (tree
order). The scope of an existing node never
changes; a later Requirement revision leaves it untouched, and revised
Requirements reach execution only through a source plan revision that
produces replacement nodes. Coordinator-proposed Tasks must reference a
non-empty subset of their node's scope at the pinned revision. The root
Orchestrator node and `join` nodes have no scope rows.

- Key: (Plan Node id, Requirement id, Requirement revision id); no own prefix.
- Owned by: the runtime (plan-revision service, through the compiler)
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
- Related: Plan Node, Worker, Coordinator, Evaluator, Pattern Position

### Pattern Position

The typed place inside a Plan Node's shape that one Invocation executes.
The closed set is `orchestrator` (the root node's turns), `single`,
`chain_step` (`index`, `count`), `route_selection`, `route_branch`
(`label`), `parallel_item` (`index`, `count`), `parallel_aggregation`,
`coordinator_turn`, `worker_task` (`taskId`), `producer_round` and
`evaluator_round` (`round`, `maxRounds`; an evaluate-only
`evaluator_optimizer` node holds only the `evaluator_round` of its fixed
round). A position names exactly one
operation of the shape, and that operation fixes the Invocation's Agent
Definition revision, role, purpose, and manifest inputs; the runtime
derives all of them from the position, never from a title or an ordinal
string. The position is persisted on the Invocation with a canonical
**position key** (`chain_step:1`, `worker_task:task_…`,
`producer_round:2`), and at most one non-terminal Invocation exists per
node and position. Only a Gate Evaluator Invocation has no position; it
names its Gate (`gateId`) instead, and a positioned Invocation never does.

- Stored on the Invocation and in its Context Manifest; no separate table.
- Related: Invocation, Plan Node, Pattern, Context Manifest

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

- Id prefix: `req_` (stable across revisions); `reqr_` for a Requirement
  revision (one immutable, numbered snapshot of a Conversation's tree)
- Owned by: the operator (approval) and the Orchestrator (proposal)
- Store: `requirements`, `requirement_revisions`, `requirement_status_changes`
- Related: Acceptance Criterion, Task, Evidence, Decision, Gate

### Requirement Proposal

The canonical record of one accepted `propose_requirements` call
(execution-model §8.1): the proposed tree exactly as accepted (entries by
proposal-local key with parent, composition, statement, the Acceptance
Criteria to author, and the id of an existing Requirement an entry
keeps), the rationale, the Orchestrator Invocation that proposed it, and
its life — `proposed` until the operator approves it (creating the
Requirement revision it names, verbatim or edited), rejects it, or a
newer proposal of the Run supersedes it. A Run has at most one `proposed`
proposal. Its id is the proposal's identity in the tool result, the
operator boundary, and the `requirement_proposal_resolution` input the
Orchestrator's next turn receives. It never changes a Requirement by
itself; only the approval does, in the same transaction as its
resolution.

- Id prefix: `rqp_`
- Owned by: the Orchestrator (proposal) and the operator (resolution)
- Store: `requirement_proposals`
- Related: Requirement, Acceptance Criterion, Orchestrator Input, Invocation

### Acceptance Criterion

A concrete, checkable condition attached to a Requirement or a Task that
says how satisfaction is established. An Acceptance Criterion is either
`deterministic` (a command the runtime runs and whose exit status and
output decide it, such as a test or build command) or `evaluated` (a
question an Evaluator answers with an Evaluation). Deterministic criteria
are always checked before evaluated ones, in stable criterion id order,
stopping at the first failure; the runtime runs each command through the
**Acceptance Criterion execution port** (`AcceptanceCriterionExecutionPort`,
execution-model §10.1) in a disposable, isolated view of the exact
Snapshot being verified, stores its bounded output as an Artifact, and
records the outcome as an Evaluation with `command` Evidence. An
infrastructure failure of the port is never a criterion verdict.

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
`signoff`, `publish`, `budget_increase` — and a **resolution policy** — `operator_required`
(resolves only when the operator answers) or `use_default_after_deadline`
(resolves to the recorded recommended option at a recorded deadline or
deterministic activation condition; permitted for `operator_choice` only).
A `side_effect_approval` carries a typed **subject** — the intercepted
call's tool name, canonical call digest, call Artifact id, and originating
Run, Plan Node, Invocation, and Attempt — with exactly the options
`approve_once` and `deny`; the call's bytes exist only in the Artifact, and
an `approve_once` resolution is an **approval grant** that authorizes
exactly that digest at most once across the Run without widening any Tool
Policy — consumed by one canonical Approval Use, never by adapter memory.
A `signoff` Decision is requested by the runtime when the
`operator_signoff` Gate opens — always `operator_required`, exactly the
options `accept` and `request_changes`, no default policy, a typed
subject naming the Run, the signoff Gate, the verified Snapshot, the
completion Gate, the Completion Request, and the final-report Artifact —
one per signoff Gate, carrying no publish authority; it is resolved only
by the operator through the signoff service, and its resolution is
recorded as one Signoff Resolution. A `publish` Decision is the exact
authorization of one Publication (execution-model §9.4) — always
`operator_required`, exactly the options `publish` and `cancel`, an
immutable typed subject naming the completed Run, its Workspace, the
exact Target, the final Snapshot, the final Changeset, and the requested
strategy; only one open publish Decision exists per Run, `cancel` creates
nothing, and `publish` creates exactly one `requested` Publication in the
resolving transaction. A `budget_increase` Decision is the operator's
exact authorization of one Budget Increase (execution-model §7.6) — always
`operator_required`, exactly the options `approve` and `deny`, never a
default deadline, an immutable typed subject naming the Run, the partition
(`ordinary` or `final_reserve`), and the exact added cost, tokens, and
Attempts; requested and resolved only through the Budget Increase service
(never by a model, a policy, a Coordinator, the Orchestrator, or a runtime
tool), one open per Run, `deny` creates nothing, and `approve` records
exactly one Budget Increase in the resolving transaction without creating
an Invocation or a Context Manifest input. A
`requirement_waiver` is requested by the root Orchestrator only, always
`operator_required`, resolved only by the operator, and never delegated or
auto-resolved; its typed subject pins the Run, the Requirement, the
Requirement revision current at the request, and the Evidence Artifact
ids, with exactly the options `waive` and `deny`; its resolution records
actor, rationale, timestamp, and optional Artifact ids, and `waive` sets
the pinned Requirement `waived` in the same transaction, while a
resolution after the pinned Requirement went stale supersedes the Decision
instead. `operator_choice` and `requirement_waiver` are the only kinds an
agent may request, through the `request_decision` runtime tool
(execution-model §6.4, §8.2): an Orchestrator turn (never the final
synthesis), a Coordinator turn, or a Worker for an `operator_choice`
within its own scope, the root Orchestrator alone for a waiver; the
Decision's `requestedBy` names the requesting Invocation, and an accepted
request ends that logical turn under either resolution policy. Every
other kind is owned by a runtime service — `side_effect_approval` by the
Attempt executor, `signoff` by the completion engine, `publish` by the
publication service, `budget_increase` by the Budget Increase service —
or, for `orchestrator_choice`, is the Orchestrator's own record. Every
resolution writes one `decision.resolved` Event; no Decision resolves
silently. Decisions are append-only; a Decision that ends unresolved is
`superseded` with a closed **supersession reason** — `superseding_decision`
(a later Decision, named by id) or `requirement_waiver_stale` (the
runtime, no superseding Decision). An unanswered Decision that an
Invocation is blocked on is the only thing that makes a Plan Node wait on
a human.

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

A Task proposed inside a `coordinator_worker` node may be **superseded**
by a replacement Task that records `replacesTaskId` (at most once per
Task, only for a `failed` or `blocked` Task, never for a `completed`
one); the node's **current** Tasks are those not superseded, and every
Task ever proposed counts toward the node's `maxTasks`.

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
  (content-addressed blobs with a private pending-marker area the store
  reconciles at startup; execution-model §2.1)
- Related: Handoff, Task, Changeset, Evidence, Context Manifest

### Handoff

The record the runtime carries from one Plan Node or Invocation to another
when work moves. A Handoff contains routing metadata only: source, target,
the Task ids concerned, the Artifact ids to read, a one-line summary, and a
status. It contains no free-form state and no instructions. A Handoff is
delivered by the runtime as part of a Context Manifest; agents never send
messages to each other directly. Every Handoff carries a **handoff key**
derived from its route — `sequence:<source node>:<target node>` for the
delivery along a `sequence` Plan Edge, `chain_step:<node>:<step>` for the
delivery from one `chain` step to the next — unique per Run and enforced
by the database, so a Handoff exists at most once for a route however
many times the runtime reaches it (a pass, a retry, a restart). The closed
route set is `sequence:<source node>:<target node>` (a delivering
`sequence` edge), `branch:<source node>:<target node>` (the one active
`branch(label)` edge of a route that selected a composite branch, carrying
no Artifacts), `chain_step:<node>:<step>`, `parallel_index:<node>`
(a parallel node's index Artifact to its own aggregation),
`worker_result:<node>:<task>` (one integrated Worker result of a
`coordinator_worker` node to its next Coordinator turn),
`retry:<source node>:<target node>` (the one active `retry(round)` edge
out of an evaluate-only `evaluator_optimizer` node whose round failed,
carrying the judged candidate), `optimizer_candidate:<node>:<round>` (an
inline optimizer round's candidate from its producer to its Evaluator),
and `optimizer_feedback:<node>:<round>` (a failed inline round's judged
candidate to the next producer round; the verdict itself is a typed
Context Manifest input, never Handoff text).

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

Provenance is ownership: a `builtin` revision is usable by any Workspace
and Conversation; a `workspace_file` revision pins an existing Snapshot and
a normalized `.claude/agents/<name>.md` path and is usable only by Runs of
the Workspace that owns that Snapshot; a `conversation` revision names an
existing Conversation and an `operator_choice` Decision of that
Conversation resolved by the operator, and is usable only by Runs of that
Conversation. The store verifies the targets when a revision is appended;
the execution boundary's executable-revision resolver decides, for one
Run, whether a revision may be executed, and both Run creation and every
plan revision go through it.

- Id prefixes: `agd_` (logical), `agdr_` (revision)
- Owned by: the workspace author (files), the console (built-ins), the operator (conversation-authored)
- Store: `agent_definitions`, `agent_definition_revisions`
- Related: Tool Policy, Invocation, Worker, Coordinator, Evaluator, Orchestrator

### Tool Policy

The per-capability disposition an Agent Definition revision carries for
each provider-native tool it declares: `allowed`, `denied`, or
`approval_required`. Every provider-native call is authorized by the
runtime before it executes: an `allowed` tool needs no approval, a
`denied` (or undeclared) tool never executes, and an `approval_required`
call executes only after the runtime claimed a matching approval grant —
otherwise it is intercepted and turned into a `side_effect_approval`
Decision. The effective policy for an Attempt is the intersection of the
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
`final_synthesis` for the Orchestrator; `decompose`,
`replan`, `synthesize` for a Coordinator; `step`, `task` for a Worker;
`select`, `evaluate` for an Evaluator), one immutable Context Manifest, one
Budget allocation with its **allocation source** (`plan_node`: reserved
from the Invocation's Plan Node, the default; `run_final_reserve`: reserved
directly from the Run's final reserve, permitted only for the
`final_synthesis` Orchestrator Invocation and the `run_completion` Gate
Evaluator Invocation, each recorded as the Invocation's `finalReserveUse`
and always attached to the root Plan Node), one Pattern Position (the
operation of its node's shape it executes, which fixes its definition,
role, purpose, and inputs; a Gate Evaluator has none and names its Gate
instead, and the `final_synthesis` turn is positioned at the root and
also names the `run_completion` Gate it reports on), one or more
Attempts, a
status (`pending`, `running`, `waiting`, and the terminal `blocked`,
`succeeded`, `failed`, `cancelled` — `blocked` names the open
`side_effect_approval` Decision that ended it), one Invocation-wide
wall-clock deadline shared by every Attempt, a durable Execution Workspace
cleanup obligation (`none`, `pending`, `released`), Usage, and one typed
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
Invocation named by `continuedFromInvocationId`, when the adapter reports
support and the runtime's continuation policy finds it safe, available,
and within the allocation). Every Attempt can be started `fresh`.
Attempts are numbered from 1 within their Invocation. A terminal Attempt
that did not succeed carries a bounded, sanitized **failure detail**
(message, exact result-validation violations, tool, cancellation) and a
durable **retry decision** (permitted, closed reason, earliest time) that
a restart reads back verbatim; a `pending` Attempt whose process ended is
`interrupted` like a running one.

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
separate Coordinator logical turns, each with one purpose — `decompose`
(once), `replan` (only when unresolved blockers prevent progress, every
blocker coalesced into one turn), `synthesize` (once) — bounded by
`maxCoordinatorInvocations` and never more than one active at a time;
an approval successor continues the same turn; routine progress never
creates one. A Coordinator acts only through runtime-tool calls
(`propose_tasks`, cancelling `update_task`) and its result. Coordination
depth is one: no Coordinator exists inside another Coordinator's node.

- Related: Invocation, Worker, Task, Handoff, Pattern, Plan Node Requirement Scope, Runtime Tool Call

### Evaluator

An Invocation role: an agent that judges an Artifact against Acceptance
Criteria or a stated rubric and produces an Evaluation. An Evaluator has
read-only tools and never modifies the Workspace. Its `evaluate` result
carries the typed `evaluation` payload (`EvaluatorResult`: the overall
verdict, one verdict per evaluated criterion it was asked to judge, and
Evidence), validated against the immutable Context Manifest; the runtime
supplies what is judged (the Plan Node, round, Snapshot, and Artifacts)
and records the Evaluations. An Evaluator never claims `command` Evidence,
changes Task state, returns `blocked` or `runOutcome`, records a Changeset,
or judges an Artifact it produced.

- Related: Invocation, Evaluation, Gate, Pattern

## Verification objects

### Evaluation

The recorded outcome of a check: which Acceptance Criterion or rubric was
checked (the **subject**: `acceptance_criterion`, `rubric`,
`route_selection`, or `optimizer_round`), the verdict (`pass`, `fail`,
`inconclusive`), the Evidence, who produced it (`runtime` for a
deterministic check or a runtime-derived verdict, an Evaluator Invocation
id and Agent Definition revision otherwise), the judged Artifact ids, the
judged Snapshot (`snapshotId`), and, inside an `evaluator_optimizer`
round, an explicit **context** — `optimizer_criterion { round, maxRounds }`
for one criterion of the round or `optimizer_verdict { round, maxRounds }`
for the round's overall verdict — so round identity is never hidden in a
rubric string or narrative. A `route_selection` Evaluation is the one
canonical fact that a `route` Plan Node selected a branch label: exactly
one exists per route node (a database unique index), it names a label the
node's shape binds, and readiness reads it as an explicit condition fact.
An `optimizer_verdict` Evaluation is the one canonical fact of a round's
outcome: at most one per node and round, and at most one criterion
Evaluation per node, round, and criterion (partial unique indexes over
generated columns); readiness reads the latest round's verdict as the
condition fact of an evaluate-only node's edges. Evaluations are
append-only.

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
fails does not end the Run; it produces a Task (a failed
`operator_signoff` Gate produces the follow-up Orchestrator turn instead). A `node_exit` Gate is one
**cycle** of a Plan Node's verification with a canonical identity — the
Run, the Plan Node, the cycle ordinal, the integration Snapshot pinned
when it opened, the exact candidate Artifact ids, the exact criterion ids
in id order, its status, and, once failed, its failure (the failed
criteria, or the Evaluator Invocation that failed permanently) — with at
most one open Gate per node and at most one Gate Evaluator Invocation
active per Gate; a closed Gate never changes and a later cycle is a new
Gate. A failed `node_exit` Gate has exactly one runtime-owned remediation
Task (the Task's `gateId`), addressed by the node's Coordinator or by the
root Orchestrator's batched `gate_result` turn; cycles are bounded by the
Run's verification policy (`maxNodeGateCycles`), beyond which the node
fails with `gate_cycles_exhausted`. A `run_completion` Gate is one
cycle of the Run's own verification for one Completion Request — no
Plan Node; the Run, the ordinal (unique per Run and kind), the request,
the pinned integration Snapshot, the pinned Requirement revision and its
current leaf ids, the canonical criterion set, the candidate Artifact
ids, its status and failure, and, once passed, the final-report
Artifact — at most one open per Run, one per request, bounded by
`maxRunCompletionCycles`; failed, it has exactly one remediation Task on
the root and the Run returns to `running`. An `operator_signoff` Gate is
opened by a passed `run_completion` Gate on the same Snapshot,
referencing that Gate, the request, and the report, with no criteria of
its own and one `signoff` Decision; one open per Run. It closes only
through a Signoff Resolution: `passed` on `accept`, `failed` with the one
failure it may record, `changes_requested` (naming the Decision), on
`request_changes`. An
`evaluator_optimizer` node never has a Gate: its rounds consume its
criteria (execution-model §5.6, §10).

- Id prefix: `gate_`
- Kinds: `node_exit`, `run_completion`, `operator_signoff`
- Owned by: the runtime
- Store: `gates`
- Related: Acceptance Criterion, Evaluation, Plan Node, Run, Task, Invocation

### Evidence

A reference to a verifiable fact: a command and its captured output
Artifact (with `outputTruncated` recorded whenever the stored output is a
bounded prefix), an Artifact id, an Evaluation id, a file path at a
Snapshot, a Snapshot, a URL. Evidence is always attached to something (an
Evaluation, a Requirement status change, a Task completion) and is never
free text. The runtime validates that referenced Artifacts, Snapshots,
and files exist when Evidence is recorded; only the runtime records
`command` Evidence.

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

The difference between two Snapshots, stored as a diff Artifact. A
Changeset has a closed **kind**. An `invocation` Changeset is produced by
one writing Invocation in its isolated worktree and names it; the runtime
integrates such Changesets into the Run's Integration Workspace in Plan
Edge order and records the resulting Snapshot, through the **integration
status** `pending` until the runtime applies it, then `integrated` (with
the integration Snapshot) or `conflict`. A Changeset that cannot be
integrated cleanly is never applied partially: the runtime records the
conflict as a Task for the node's owner with a bounded conflict-report
Artifact, the node and the Run wait with reason `integration_conflict`,
and the Changeset is applied again exactly once when that Task completes.
The Run's one **final Changeset** (kind `final`) is the descriptive record
of the diff from its base Snapshot to its accepted final Snapshot,
recorded at signoff acceptance in the one terminal state `recorded`: it
names no Invocation, is never applied, retried, or resolved, holds the
exact `text/x-diff` bytes, exists at most once per Run and never before
acceptance, and never changes (execution-model §9.3).

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
every Invocation's worktree. The execution runtime resolves and verifies
Changeset content; the Integration Workspace receives a capability bound
to that exact immutable content (execution-model §9.2) and has no
persistence access.

- Stored on the Run; no separate table.
- Related: Run, Changeset, Snapshot, Target

### Publication

The recoverable record of one authorized application of a `completed`
Run's final Changeset to its Target — the one runtime boundary that may
modify the Target (execution-model §9.4). Every Publication is authorized
by its own operator-resolved `publish` Decision (one Publication per
Decision; signoff acceptance grants no publish authority and no standing
or automatic authorization exists) and moves through the closed lifecycle
`requested → prepared → verified → applying → succeeded | failed`: the
candidate post-publication state is prepared in an isolated publication
workspace and deterministically verified **before** the Target is touched,
`applying` is durably persisted before the external call, and the one
Target mutation is an idempotent atomic compare-and-swap against the
recorded Target-before state with a durable provider receipt. A
Publication records its Run, Decision, final Changeset, requested and
selected strategy (`fast_forward`, `merge`, or a provider-named `other`,
selected at publication time and invisible to every Invocation), the
Target-before, candidate, and (on success, equal to the candidate)
Target-after Snapshots, its closed structured failure when it failed
(`strategy_unsupported`, `fast_forward_unavailable`, `candidate_conflict`,
`verification_failed`, `target_changed`, `candidate_invalid`), its
terminal publication-report Artifact, and the durable cleanup state of
its staging resources. At most one nonterminal and one succeeded
Publication exist per Run; terminal rows are immutable and undeletable; a
failed attempt is retried only through a new exact `publish` Decision; a
Publication outcome never changes the Run's status and never creates an
Invocation.

- Id prefix: `pub_`
- Owned by: the runtime (publication service)
- Store: `publications`
- Related: Run, Target, Changeset, Snapshot, Decision, Evaluation, Event

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
and never changes, so that any Attempt can be reproduced and audited. It
also records the effective model policy, capabilities, Tool Policy, and
runtime tools, the typed queued inputs, and the renderer format version
it was assembled for; the rendered prompt is a deterministic projection of
it and never the record. An Invocation receives nothing that is not in
its manifest, and never a provider continuation payload.

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

### Approval Use

The canonical, append-only record that one `approve_once` side-effect
approval grant was claimed: the Decision consumed, its tool and canonical
call digest, the Run and Plan Node, the successor Invocation whose Context
Manifest carried the grant, the running Attempt that claimed it, and the
claim time. It is written by the runtime's tool-call authorization
boundary in its own short transaction before the adapter may execute the
call, and it is never rolled back because the provider later fails, the
Attempt is retried, finalization fails, or the process restarts. At most
one use exists per Decision, enforced by the database; a claim that is
refused writes nothing. A use records authorization, not completion: a
crash between the claim and the external call conservatively consumes the
approval, and executing the call again needs a new Decision.

- Id prefix: `acu_`
- Owned by: the runtime
- Store: `approved_tool_call_uses`
- Related: Decision, Context Manifest, Invocation, Attempt, Tool Policy

### Runtime Tool Call

The canonical, append-only record that the runtime executed one mutating
runtime-tool call (`propose_tasks`, `update_task`, `request_completion`,
`request_decision`, `write_artifact`, `create_tasks`, `record_decision`,
`propose_requirements`, or `revise_execution_plan`) on behalf of a running
Invocation: the Run, Plan Node, Invocation, the first Attempt
that committed it, the tool, the digest of the canonicalized call, the
safe result, and the commit time. It is written by the runtime-tool
executor in its own short transaction outside provider execution, after
the handler validated and applied the call; a rejected call writes
nothing, and a runtime read tool (`read_requirements`, `read_decisions`,
`read_tasks`, `read_artifact`, `read_execution_plan`,
`read_agent_definitions`) is never recorded here: a successful read is an
ephemeral typed projection, not a durable mutation. It is unique per
Invocation, tool, and digest, and at most one
accepted `propose_tasks` and at most one accepted `request_decision`
exist per Invocation; a retry or approval successor of the same logical
turn replays a recorded call by digest instead of repeating its effect,
and an accepted `request_decision` ends the logical turn. A
`write_artifact` row's safe result names the created Artifact's id,
media type, digest, byte size, and title; the content lives only in the
Artifact Store. It never holds the call's raw input. Replay is not read
authorization: the row makes its Artifact readable through
`read_artifact` to the exact Invocation that recorded it (any Attempt),
never to an approval successor that replays it.

- Id prefix: `rtc_`
- Owned by: the runtime
- Store: `runtime_tool_calls`
- Related: Invocation, Attempt, Task, Context Manifest, Coordinator, Completion Request

### Orchestrator Input

One queued, typed input of the Orchestrator's next logical turn
(execution-model §4.6): an `operator_message` the operator posted through
the steering service, a superseding `decision_resolution`, or a
`requirement_proposal_resolution`. Queued when the operator acts, never
injected into an active provider session, and delivered by exactly one
later Orchestrator Invocation whose Context Manifest lists it (the row
records that Invocation and the delivery time). Ended nodes' `node_result`
inputs are not queued rows: the root derives them from the current graph
and the root turns' manifests.

- Id prefix: `oin_`
- Owned by: the runtime, from the operator's operations
- Store: `orchestrator_inputs`
- Related: Invocation, Context Manifest, Conversation, Decision, Requirement Proposal

### Completion Request

The canonical record that the root Orchestrator's ordinary turn asked the
runtime, through an accepted `request_completion` call, to verify the Run
for completion: the Run, the requesting Invocation, the accepted Runtime
Tool Call, a closed status (`requested`, `verifying`, `passed`, `failed`,
`cancelled`), the `run_completion` Gate it became once it began, the
final-report Artifact once it passed, its closed outcome once it failed or
was cancelled, and its timestamps. It is created only after the
transactional completion preflight admitted the call; at most one
non-terminal request exists per Run; a replayed call of the same logical
turn names the same request; rows are never deleted, their identity never
changes, and every transition is one Event; a later attempt at completion
is a new request. Nothing infers a request from Events or a transcript.

- Id prefix: `crq_`
- Owned by: the runtime
- Store: `completion_requests`
- Related: Run, Invocation, Runtime Tool Call, Gate, Artifact, Decision

### Signoff Resolution

The canonical, append-only record of the operator's one resolution of an
`operator_signoff` Gate (execution-model §10): the Run, the signoff Gate,
its `signoff` Decision, the closed outcome (`accept` or
`request_changes`), the operator's Conversation message for
`request_changes` (by id — the prose is never copied), the Run's final
Changeset for `accept`, the one follow-up root `decision_resolution`
Orchestrator Invocation a `request_changes` resolution prepared (linked
once, in the resolving transaction), and the resolution time. Exactly one
exists per signoff Gate and per signoff Decision; a message answers at
most one; identity and outcome are immutable; rows are never deleted; the
database re-checks every relationship at insertion. It is written only by
the signoff service, from the operator's explicit operation, never
inferred from prose, a result, a manifest, or an unresolved Decision. An
identical repeated operation returns it; a conflicting one is refused.

- Id prefix: `sres_`
- Owned by: the runtime (signoff service), from the operator's resolution
- Store: `signoff_resolutions`
- Related: Run, Gate, Decision, Changeset, Snapshot, Conversation, Invocation

### Budget

A set of limits: maximum cost, maximum tokens, maximum wall-clock time,
maximum Attempts, and maximum concurrent Invocations. The **Run Budget** is
the global cap and allocation pool for the whole Run: the immutable **base
Budget** supplied at Run creation plus the Run's append-only Budget
Increases. The base Budget (maximum cost, tokens, Attempts, and the base
final reserve) is never rewritten; every **effective** limit is derived on
read and no aggregate limit is stored:

```
effective global limit        = base Budget + all approved Budget Increases
effective final-reserve limit = base final reserve + all approved final-reserve Budget Increases
effective ordinary limit      = effective global limit − effective final-reserve limit
```

An **allocation** is a child's reserved share of its parent's capacity. A
**Plan Node allocation** is an explicit amount reserved from the ordinary
pool before the node becomes runnable — the root Orchestrator node receives
an explicit initial allocation, never the entire Run Budget. An
**Invocation allocation** is an explicit amount reserved from its Plan Node
before the Invocation starts, immutable for the Invocation's life. Limits
are stored on the object they bound; allocation accounting is done with
Budget Reservations. Cost, tokens, and Attempts are reserved quantities;
wall-clock deadlines and concurrency ceilings are limits enforced by the
runtime and the Resource Governor and are never increased by a Budget
Increase or an Allocation Extension. A node or Invocation that exhausts its
allocation fails or waits by its declared `onAllocationExhausted` policy:
`fail` fails the node with `allocation_exhausted`, `wait` waits it with
reason `budget`, and `extend` has the runtime create the automatic minimal
Allocation Extension from existing effective ordinary capacity — exactly
the component-wise shortfall, atomically with the work it funds — or waits
it with reason `budget` when no such extension fits. Exhausting the
effective ordinary Run capacity places the Run in `waiting` with reason
`budget`, never `failed`, until an ordinary Budget Increase is approved. The
Run Budget is partitioned into the **ordinary pool** that compiled Plan Node
allocations and Allocation Extensions draw from and the **final reserve** —
cost, tokens, and Attempts chosen at Run creation (from a configurable
default per Run kind), validated to fit within the base Budget together
with the root node's initial allocation, persisted on the Run, immutable as
a base value, and enlarged only by an explicit `final_reserve` Budget
Increase. The final reserve is spent only on `final_synthesis`
Orchestrator Invocations and `run_completion` Gate Evaluator Invocations,
which reserve directly from the Run (`Run → Invocation`) while remaining
attached to the root Plan Node; it is accounted as its own capacity
partition, never as fabricated Usage, never as an ordinary child
reservation, and never as the source of an Allocation Extension. The two
partitions are partitions of one Budget: each may reserve only what both
its own and the global availability permit, and neither may claim the
other's unused capacity. No agent decides accounting: a Budget Increase is
the operator's, an Allocation Extension is the runtime's, and neither
creates an agent turn to announce itself.

- Limits stored on the object they bound; the base final reserve on the Run; reservations in `budget_reservations`; increases in `budget_increases`; extensions in `allocation_extensions`.
- Related: Run, Plan Node, Invocation, Budget Reservation, Budget Increase, Allocation Extension, Usage

### Budget Reservation

The canonical record of one allocation: the parent bounded object (Run,
Plan Node, or Invocation), the child bounded object or proposed work item
(Plan Node, Invocation, or Task; `Run → Invocation` exists only for a
final-reserve Invocation), the reserved cost, tokens, and Attempts,
the creation time, the release time, and the status (`active`,
`released`). A reservation is created atomically with the child, before
the child becomes runnable, and only from the parent's unconsumed,
unreserved capacity; it is released with its final consumed amounts when
the child reaches a terminal state, returning the remainder to the parent.
The consumed amounts are the child's complete actual consumption and may
exceed the reserved amounts; the reserved amounts are kept unchanged
alongside them. A Run-level reservation records its **capacity source**
(`ordinary` or `final_reserve`) and, for the latter, the final-reserve
use that authorized it; the source derives from the operation that created
the reservation (`reserveOrdinary` or `reserveFinalInvocation`), never
from a caller's parameter. A reservation's own amounts never change; an
active `Run → Plan Node` reservation's **effective reserved allocation** is
its immutable original amounts plus the sum of its Allocation Extensions.
While a reservation is active its parent charges it component-wise
`max(effective reserved allocation, actual attributable consumption)`, so
an overrun is visible at once; once released, its recorded complete
consumption alone — an Allocation Extension is never charged as a second
child and remains as provenance after release. A plan revision whose
allocations cannot all be reserved from the effective ordinary pool is
rejected.

- Id prefix: `bres_`
- Owned by: the runtime
- Store: `budget_reservations`
- Related: Budget, Run, Plan Node, Invocation, Task, Allocation Extension, Usage

### Budget Increase

The append-only canonical record of one operator-approved enlargement of a
Run's effective Budget (execution-model §7.6): the Run, the authorizing
`budget_increase` Decision, the partition (`ordinary` or `final_reserve`),
the exact added cost, tokens, and Attempts (non-negative, at least one
positive), and the creation time. Exactly one exists per approved Decision;
it is immutable and never deleted; it changes no Run row, no Usage row, no
reservation, no Invocation, no wall-clock deadline, and no concurrency
limit; it never reduces, revokes, replaces, or expires earlier capacity.
An `ordinary` increase enlarges the effective global limit and therefore
the effective ordinary limit; a `final_reserve` increase enlarges the
effective global limit and the effective final-reserve limit together.
Only the Budget Increase service records one, from the operator's
resolution; no model, Invocation, Coordinator, Orchestrator, policy, or
runtime tool can. The scheduler's next explicit pass derives the new
capacity from rows and resumes a Run waiting on `budget` through the
ordinary resume transition; no agent turn is created to report the
increase. A Budget Increase and an Allocation Extension are different
facts: the former enlarges the Run Budget, the latter reallocates capacity
already inside it.

- Id prefix: `binc_`
- Owned by: the runtime (Budget Increase service), from the operator's `approve`
- Store: `budget_increases`
- Related: Budget, Decision, Run, Allocation Extension

### Allocation Extension

The append-only canonical record of one deterministic transfer of existing
effective ordinary Run capacity to one active Plan Node (execution-model
§7.6): the Run, the Plan Node, the node's existing active ordinary
`Run → Plan Node` reservation, the exact added cost, tokens, and Attempts
(non-negative, at least one positive), the closed trigger — `invocation`,
`task_batch`, `gate_evaluator`, `gate_remediation`, `root_turn`,
`signoff_follow_up` — and the creation time. It is created by the runtime's
one Plan Node capacity operation under the node's `extend` policy, for
exactly the component-wise shortfall of the child the node must fund next,
in the same root transaction that creates that child (an Invocation, a Task
batch, a Gate Evaluator, a root turn), so both commit or neither does; it is
never speculative, rounded up, or a configured increment. It raises the
reservation's effective reserved allocation without creating a second
reservation, changing the reservation's original amounts, creating Usage,
enlarging an existing Invocation, or drawing from the final reserve. Only
a nonterminal `pattern` node's active ordinary reservation may be
extended; a released reservation, a terminal node, a join node, and a
final-reserve reservation never are. After the reservation is released the
extension is provenance only.

- Id prefix: `aext_`
- Owned by: the runtime (Plan Node capacity operation)
- Store: `allocation_extensions`
- Related: Budget, Budget Reservation, Plan Node, Budget Increase

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
`pause` (as a system-wide state; the operator pauses one Run, which is
`waiting` with reason `operator` or holds its `operatorPause` beside
`verifying` or `awaiting_signoff`), `turn` (as an Attempt kind or a long-lived Invocation; a
logical turn is a new Invocation), `in_progress` (as a Task state; use
`running`).

## Identifier conventions

- Table names are the plural snake_case of the term: `runs`, `plan_nodes`,
  `plan_edges`, `plan_revision_nodes`, `plan_node_requirements`, `acceptance_criteria`,
  `context_manifests`, `agent_definition_revisions`, `publications`,
  `capacity_leases`, `budget_reservations`, `budget_increases`,
  `allocation_extensions`, `provider_continuations`,
  `approved_tool_call_uses`, `runtime_tool_calls`, `completion_requests`,
  `signoff_resolutions`.
- Id prefixes: `ws_`, `cv_`, `cvm_`, `run_`, `pn_`, `pe_`, `req_`,
  `reqr_`, `ac_`, `dec_`, `task_`, `art_`, `ho_`, `agd_`, `agdr_`, `inv_`,
  `att_`, `eval_`, `gate_`, `snap_`, `cs_`, `pub_`, `lease_`, `bres_`,
  `binc_`, `aext_`, `cm_`, `use_`, `acu_`, `rtc_`, `crq_`, `sres_`. A prefix is never reused for a second kind.
  `plan_node_requirements`, `plan_revision_nodes`, and
  `provider_continuations` are keyed by the objects they index and carry
  no own prefix; `events`,
  `requirement_status_changes`, and `task_dependencies` are keyed by a
  sequence number or by the objects they relate and carry no prefix.
  Ids are `<prefix>_` followed by 24 lower-case hexadecimal characters,
  minted by `core/src/ids.ts`; timestamps are ISO 8601 UTC with millisecond
  precision (`2026-01-01T00:00:00.000Z`).
- Plan Node kinds are `pattern` and `join`; Invocation purposes,
  Attempt kinds (`initial`, `retry`), Attempt start modes (`fresh`,
  `resumed`), and Task states are lower snake_case as listed in their
  entries.
- The database identifies itself with a single-row `schema_info` table
  (`application`, `schema`, `version`) written by the baseline migration;
  see [migration-contract.md](migration-contract.md) §4. It is not a
  domain object.
- Type names are the singular PascalCase term: `Run`, `PlanNode`,
  `AcceptanceCriterion`, `ContextManifest`. They are exported from
  `@agentique-console/core` and nowhere else; the closed value sets are
  exported as `readonly` tuples (`RUN_STATUSES`, `PATTERNS`,
  `INVOCATION_PURPOSES`, …) with a matching `zod` schema each.
- Event types are `<object>.<past_tense_verb>` in snake_case:
  `run.started`, `plan_node.completed`, `invocation.failed`,
  `gate.passed`, `decision.recorded`.
- API routes are `/api/<plural-kebab-case>`: `/api/runs`,
  `/api/plan-nodes`, `/api/acceptance-criteria`.
- Roles are lower-case singular: `orchestrator`, `worker`, `coordinator`,
  `evaluator`.
- Patterns are lower snake_case: `single`, `chain`, `route`, `parallel`,
  `coordinator_worker`, `evaluator_optimizer`.
