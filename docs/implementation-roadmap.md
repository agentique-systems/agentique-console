# Implementation roadmap

This document tracks **delivery** of the clean-break orchestration
architecture on the branch `rewrite/orchestration-core`: what each original
phase was to deliver, what exists, what evidence supports it, what remains,
and what "done" means for it. It is a ledger, not a specification. Domain
semantics live only in the four architecture documents
([glossary.md](architecture/glossary.md),
[execution-model.md](architecture/execution-model.md),
[migration-contract.md](architecture/migration-contract.md),
[legacy-removal.md](architecture/legacy-removal.md)); where this ledger
and those documents disagree, they win and this ledger is corrected.

Two numbering schemes coexist in the history and both are kept:

- **Original phases 0–10** — the delivery sequence this document is
  organised by.
- **Contract steps 1–7 and the "Phase 2x" subphase labels** — the
  migration contract's §7 process and the labels the commits on the branch
  carry (`2A` … `2G-A`). Much of original Phases 3–8 was built under
  Phase 2 subphase labels; that work is credited below where it belongs
  and its labels are not rewritten.

| Original phase | Contract §7 step | Subphase labels that delivered it |
|---|---|---|
| 0 Clean-break contract | 1 Architecture documents | — (commits `4043e52`, `21a7309`, `6fd8dfc`) |
| 1 Domain and persistence model | 2 Domain and schema | Phase 1 (`ab2cd7d`) |
| 2 Durable generic execution engine | 3 Runtime core | 2A, 2B, 2C (scheduler), 2F-A, 2F-B (blocking boundary), 2G-A correction (this document's first revision) |
| 3 Execution adapters, context, Artifact delivery | 3 Runtime core | 2B (manifest, adapter contract, scripted fake), 2G-A (`read_artifact`, `write_artifact`) |
| 4 Workspaces, Changesets, tools, verification gates | 3 and 4 | 2A (preparation port), 2B (execution-workspace port, authorization), 2C (integration), 2D-B1 (runtime-tool boundary), 2D-B2 (checks), 2E-A/B/C/D (Gates, completion, signoff, publication), 2G-A (reads, writes) |
| 5 Single-agent Pattern and Orchestrator | 3 | 2B (Run start, root turn), 2C (`single`, root settlement), 2E-B/C (completion, signoff turns), 2F-B (`request_decision`) |
| 6 Chain, routing, parallel Patterns | 3 | 2C (`chain`), 2D-A (`route`, `parallel`, `join`) |
| 7 Evaluator-optimizer | 3 | 2D-B2 |
| 8 Coordinator-worker and Pattern selection | 3 | 2D-B1 (runner), 2A (compiler selects Patterns from the plan source) |
| 9 Complete application cutover | 5 and 6 | not started |
| 10 Eradicate legacy and harden | 6 and 7 | not started |

## Status vocabulary

- **implemented and verified** — exists under its final name and its
  completion condition is met by tests that exercise the real mechanism
  (a real SQLite file, a real blob store, a real child process where the
  claim is about a process).
- **implemented, verification pending** — exists, but the tests that
  would meet the completion condition do not yet exist or exercise a
  double where the condition demands the real thing.
- **partial** — some deliverables exist; the remaining ones are named.
- **not implemented** — nothing under a final name exists for it.
- **superseded** — the original wording was replaced by an accepted
  architectural decision; the replacement and its evidence are named.

Evidence is classified as **real execution** (real files, processes, or
stores), **injected ports** (the engine drives a fake implementation of a
declared port, so the engine's contract with the port is proven but no
production adapter is), or **test doubles** (in-memory SQLite,
`MemoryBlobStore`, the scripted provider). A passing fake-provider test
proves the engine, not the adapter; an interface name proves nothing.

Test file paths below are relative to `server/src/` unless they start with
`core/`.

## Phase 0 — Establish the clean-break contract

**Deliverables.** The four authoritative documents; the binding rules (no
data migration, compatibility period, legacy API, alternate runtime, or
feature flag); the removal inventory; the enforcement tests.

**Implemented.** `docs/architecture/*` (commits `4043e52`, `21a7309`,
`6fd8dfc`); the import-boundary and terminology tests
(`persistence/boundaries.test.ts`), run on every commit since Phase 1.

**Evidence.** Real: the boundary test scans the real tree.

**Remaining.** None. The documents are amended in place as later phases
correct them (each amendment is a `docs:` commit beside the code it
records).

**Dependencies.** None.

**Completion condition.** The four documents exist and every later commit
keeps the boundary and terminology tests green. Met.

**Status: implemented and verified.**

## Phase 1 — Implement the domain and persistence model

**Deliverables.** `@agentique-console/core` (final types, identifiers,
state sets, transition validators, runtime schemas, Event contracts);
`server/src/persistence/` (final schema, baseline migration, reset-required
open guard, stores, content-addressed blob store, transactor, Event
journal).

**Implemented.** `core/src/*` (20 test files); `persistence/schema.ts`,
`migrations/0000_orchestration_core.sql` (40 tables, append-only guard
triggers), `database.ts` (`database.test.ts`: missing, empty, matching,
legacy, unrelated, reset-required), `transactions.ts` (root/nested writes,
rollback-only, `afterRollback`, `afterCommit`; `transactions.test.ts`),
`journal.ts` (`journal.test.ts`), `blob-store.ts` (`FileBlobStore` with the
pending-marker protocol, `MemoryBlobStore`; `blob-store.test.ts`), every
store under `stores/` with its test, `schema.test.ts`.

**Evidence.** Real: the database-open cases and the blob store run over
real files; the schema tests run the real migration. Test doubles: most
store tests use in-memory SQLite and `MemoryBlobStore`.

**Remaining.** None for the model. The baseline migration is regenerated
in place whenever the architecture corrects the schema before cutover
(contract §4); `npx drizzle-kit check` and `generate` report no pending
change at the current head.

**Dependencies.** Phase 0.

**Completion condition.** Every table of contract §4 exists with its
ownership and immutability enforced at the store and the database; the
open guard refuses a legacy database; the blob store publishes and
verifies content-addressed blobs. Met.

**Status: implemented and verified.**

## Phase 2 — Implement the durable generic execution engine

**Deliverables.** The deterministic, provider-neutral engine under
`server/src/execution/`: plan compilation and validation, readiness,
scheduling, capacity, Invocation and Attempt lifecycle, retries and
deadlines, durable waiting, restart recovery, reservations and Usage,
immutable Events.

**Implemented.** `compiler/*` (`compile.test.ts`, `source-path.test.ts`),
`plan-revision-service.ts`, `run-creation-service.ts`, `run-start-service.ts`,
`readiness.ts` + `readiness-facts.ts`, `scheduler.ts`, `governor.ts`,
`plan-node-capacity.ts`, `budget-increases.ts`,
`invocation-preparation-service.ts`, `attempt-executor.ts`,
`retry-policy.ts`, `continuation-policy.ts`, `invocation-lifecycle.ts`,
`recovery-service.ts`, `workspace-cleanup.ts`, `decision-requests.ts`,
`handoff-routing.ts`, `join.ts`, `task-projection.ts`, `pattern
positions` on Invocations, and the runtime-tool call boundary
(`runtime-tools.ts`). The per-item evidence is in the exit checklist below.

**Evidence.** Injected ports and test doubles for provider and Workspace
behaviour (`ScriptedProvider`, `Fake*Workspace`); real execution for
persistence (file-backed restart suites: `*-restart.test.ts`,
`recovery-service.test.ts`, `data-access-restart.test.ts`) and for process
death (`data-access-crash.test.ts`, a real child process killed with
`SIGKILL` over a real SQLite file and `FileBlobStore`).

**Remaining (evidence-backed, finite).**

1. **Operator cancellation of a Run** — execution-model §14 "Operator
   cancels a Run" (every Attempt interrupted, every node `cancelled`,
   every reservation released, Integration Workspace left in place, Run
   `cancelled`). Propagation primitives exist and are tested (node removal
   by plan revision cancels running nodes, `plan-revision-service.ts`; an
   Invocation's cancellation settles its node, `patterns/support.ts`; Task
   cancellation, `task-proposals.ts`, `gates.ts`; Completion Request
   cancellation, `completion.ts`), but no operation performs the Run-wide
   cancellation; tests cancel a Run through store transitions directly
   (`data-access-test-support.ts` `cancelRun`).
2. **Operator pause and resume** — execution-model §14 "Operator pauses a
   Run" (`soft`: the scheduler starts nothing new; `hard`: running Attempts
   interrupted; Run `waiting` with reason `operator`; resume clears it).
   The canonical state exists (`RUN_WAIT_REASONS` includes `operator`,
   `core/src/runs.ts`) and the scheduler already waits and resumes a Run on
   every other reason from rows; no operation sets or clears the `operator`
   reason and the scheduler has no `hard` interruption path.

Both are Run-lifecycle operations of the engine (execution-model §3, §14),
not API work: the API of Phase 9 will call them, but the operations and
their restart tests belong here.

**Dependencies.** Phase 1.

**Completion condition.** Every row of the exit checklist below is
*implemented and verified* or *superseded* with its replacement verified.
Not yet met: the two rows above.

**Status: partial** — the generic engine is implemented and verified for
everything but operator cancellation and pause/resume.

### Original Phase 2 exit checklist

| Item | Status | Replacement (where superseded) and evidence |
|---|---|---|
| Plan validation, node readiness, dependencies, fan-in | implemented and verified | `compiler/compile.test.ts` (every §4.4 rule and rejection), `plan-revision-service.test.ts` (reconciliation, started-node conflicts), `readiness.test.ts` (pure evaluator over the current graph plus condition facts), `join.test.ts` (`require_all` / `require_any`, index order), `pattern-positions.test.ts`. |
| Deterministic scheduling and duplicate-execution protection | implemented and verified | `scheduler.test.ts` (membership order, `maxActions`, closed stop reasons, concurrent callers share one pass), `scheduler-restart.test.ts`; at most one non-terminal Invocation per node and position enforced by a unique index (`persistence/schema.ts`); Handoff keys unique per Run (`handoff-routing.test.ts`); runtime-tool replay by digest (`decision-requests.test.ts`, `artifact-writes.test.ts`). |
| Concurrency and capacity | implemented and verified | `governor.test.ts` (deterministic leases, structured refusals, `provider_capacity` wait), `patterns/parallel.test.ts` (Run, node, and governor limits), `plan-node-capacity.test.ts`, `budget-increases.test.ts`. |
| Pause/resume | **partial** (canonical equivalent accepted: Run `waiting` with a reason, resumed from rows) | Waiting and resumption on `decision`, `budget`, `provider_capacity`, and `integration_conflict` are implemented and verified (`scheduler.test.ts`, `decision-blocking.test.ts`, `budget-increases.test.ts`, `integration-service.test.ts`). The `operator` reason and the `hard` interruption path are not implemented (Phase 2 remaining work 2). |
| Cancellation and propagation | **partial** | Propagation is implemented and verified at every level the engine drives itself (node removal, Invocation cancellation, Task and Completion Request cancellation; `plan-revision-service.test.ts`, `patterns/*.test.ts`, `completion.test.ts`); the operator's Run-wide cancellation is not implemented (Phase 2 remaining work 1). |
| Retry classification, Attempt creation, retry limits, timeout behaviour | implemented and verified (superseded wording: "timeout" is the persisted Invocation-wide wall-clock deadline of execution-model §7.6 — no timer) | `retry-policy.ts`, `attempt-executor.test.ts` (closed failure classes, `initial`/`retry`, `fresh`/`resumed`), `wall-clock.test.ts` (deadline derived from persisted facts), `continuation.test.ts`, `allocation-recovery.test.ts`. |
| Durable waiting | implemented and verified (superseded wording: no timers or scheduled resumptions; the scheduler reports the resumption time from rows and the clock) | `scheduler.test.ts` (retry and deadline resumption times, never polls), `decision-blocking.test.ts`, `decision-recovery.test.ts`, `budget-increases.test.ts`; the boundary test forbids `setTimeout`/`setInterval`/polling in the engine. |
| Crash recovery | implemented and verified | `recovery-service.test.ts` (interrupted Attempts, released leases, `allocation_exhausted`, resumed retries), the file-backed restart suites for every Pattern, Gate, completion, signoff, publication, budget, and Decision window, `workspace-cleanup.test.ts`, and `data-access-crash.test.ts` (six `write_artifact` death windows plus recovery-death, cross-Run reference, restoration, same-transaction, unmarked-content, lost-response, and failed-cleanup cases with a real child process). |
| Hierarchical reservations, budget consumption, complete Usage aggregation | implemented and verified | `persistence/stores/budgets.test.ts`, `budget-growth.test.ts`, `final-reserve.test.ts`, `usage.test.ts`, `allocation-recovery.test.ts`, `plan-node-capacity.test.ts` (Run → Plan Node → Invocation and Task transfers, the final reserve, increases and extensions, overrun visibility, totals once per level). |
| Immutable runtime Events | implemented and verified | `persistence/journal.test.ts`, `schema.test.ts` (append-only triggers on `events` and the immutable tables), every store test asserting its Event sequence. |
| Leases (early illustrative wording) | superseded | Capacity leases are the resource governor's persisted grants (`capacity_leases`, `governor.ts`); no lease subsystem for rows, blobs, or workers exists or is planned (execution-model §7.8). |

## Phase 3 — Implement execution adapters, context, and Artifact delivery

**Deliverables.** Context Manifest construction and deterministic
rendering; Artifact delivery to Invocations; the provider-neutral adapter
boundary; production provider execution.

**Implemented.** `manifest/assembler.ts` + `manifest/renderer.ts`
(`manifest.test.ts`; persisted renderer version; typed operation inputs
for every Pattern position); Artifact delivery by manifest listing and by
`read_artifact` (`runtime-reads.ts`, `artifact-reads.test.ts`,
`artifact-paging.test.ts`, `artifact-bom-paging.test.ts`,
`artifact-visibility.test.ts`); `write_artifact` (`artifact-writes.ts`,
`artifact-writes.test.ts`); the provider boundary contract
(`provider/adapter.ts`), the scripted fake (`provider/fake.ts`,
`fake.test.ts`), the continuation service and payload stores
(`provider/continuation.ts`, `continuation-store.ts`).

**Evidence.** Injected ports and test doubles: every Attempt in the suite
runs against `ScriptedProvider`. Real execution: none for a production
provider.

**Remaining.**

1. **Production provider adapter(s)** under `server/src/provider/`,
   extracted and rewritten from `server/src/sdk/` where contract rule 7
   permits (protocol handling, message mapping, usage normalization,
   failure classification, environment setup), depending only on core and
   `server/src/provider/*`; the fake keeps proving the engine.
2. **Provider-neutral boundary verification against the real adapter**:
   the boundary test's provider rules (no Run, Plan, Pattern, Invocation,
   Task, Requirement, Decision, Budget, or retry decision in an adapter)
   applied to the production adapter, and a live smoke test behind an
   explicit opt-in (contract §8, last bullet).

**Dependencies.** Phase 2 (the executor and the adapter contract are
fixed).

**Completion condition.** One Attempt of a root Orchestrator Invocation
executes against a production provider through the adapter contract with
Usage, transcript Artifact, result validation, and tool-call authorization
recorded exactly as with the fake, behind the opt-in smoke test; the
boundary test covers the adapter. Not met.

**Status: partial** — context and delivery implemented and verified;
production provider execution not implemented.

## Phase 4 — Implement workspaces, Changesets, tools, and verification gates

**Deliverables.** Workspace isolation (preparation, per-Invocation
worktrees, cleanup), Snapshots, Changesets and their integration,
verification (deterministic checks, Gates), the runtime-tool boundary and
the console's tools, publication.

**Implemented (engine side, behind declared ports).** The six ports under
`execution/ports/` (`RunWorkspacePreparationPort`, `ExecutionWorkspacePort`,
`IntegrationWorkspacePort`, `AcceptanceCriterionExecutionPort`,
`RunFinalizationWorkspacePort`, `PublicationWorkspacePort`);
`invocation-preparation-service.ts`, `workspace-cleanup.ts`
(`workspace-cleanup.test.ts`), `integration-service.ts`
(`integration-service.test.ts`, `integration-content.test.ts`),
`acceptance-checks.ts` (`acceptance-checks.test.ts`), `gates.ts`
(`gate-policy.test.ts`, `gates.test.ts`, `gate-remediation.test.ts`,
`gate-restart.test.ts`), `completion.ts` + `completion-requests.ts`
(`completion*.test.ts`, `final-synthesis.test.ts`), `signoff.ts`
(`signoff*.test.ts`), `publication.ts` (`publication*.test.ts`),
`tool-call-authorization.ts` (`approval*.test.ts`), `runtime-tools.ts` +
`task-proposals.ts` + `decision-requests.ts` + `runtime-reads.ts` +
`artifact-writes.ts` (the executable tools: `propose_tasks`, the
Coordinator's cancelling `update_task`, `request_completion`,
`request_decision`, `write_artifact`, and the six read tools), Agent
Definition resolution (`agent-definitions.ts`, `agent-definitions.test.ts`).

**Evidence.** Injected ports for every Workspace capability
(`FakeWorkspacePreparation`, `FakeExecutionWorkspace`,
`FakeIntegrationWorkspace`, `FakeAcceptanceCriterionExecution`,
`FakeRunFinalizationWorkspace`, `FakePublicationWorkspace` in
`execution/test-support.ts`, the only implementations in the tree); real
execution for the content path (real Artifact and blob stores in
`integration-content.test.ts`, `data-access-crash.test.ts`).

**Remaining.**

1. **Real Workspace adapters** implementing the six ports over the
   Workspace's version control (git worktrees, Snapshot identities,
   Changeset capture and application, isolated check views, final-diff
   observation, publication candidates and receipts) under a final
   location that imports no store, blob store, or database module (the
   boundary test already pins that rule for the ports).
2. **Remaining runtime tools** (see "Deferred tools" below): full
   `update_task`, `create_tasks`, `record_decision`,
   `propose_requirements`, `revise_execution_plan`.
3. **Operator supersession of a policy-resolved Decision** (execution-model
   §8.2): the operation, its Event, and its restart test.
4. **Agent Definitions from Workspace files** (execution-model §11,
   contract §6): reading `.claude/agents/*.md` at a Snapshot with the
   native-field acceptance rule; only the builtin and Conversation
   provenances are exercised today.

**Dependencies.** Phase 2 (the engine drives the ports); item 1 also
depends on nothing in Phase 3 (the ports are provider-neutral).

**Completion condition.** Every port has one production implementation
exercised by an integration test over a real repository, the remaining
tools are executable at their bound positions with replay and restart
tests, supersession is implemented and tested, and Workspace-file Agent
Definitions are read and pinned. Not met.

**Status: partial** — verification, integration, publication, and the
runtime-tool boundary implemented and verified against injected ports;
adapters, the remaining tools, supersession, and Workspace-file
definitions not implemented.

## Phase 5 — Implement the single-agent Pattern and Orchestrator

**Deliverables.** The `single` Pattern; the root Orchestrator Invocation and
its turns; Orchestrator authoring (Requirements, plan revisions, Tasks,
Decisions) and steering; the first real end-to-end single-agent path.

**Implemented.** `patterns/single.ts` (`patterns/single.test.ts`),
`patterns/root.ts` (root settlement, `gate_result`, `decision_resolution`,
`final_synthesis` turns), `run-start-service.ts`
(`run-start-service.test.ts`), the plan-revision service that the
Orchestrator's authoring will call (`plan-revision-service.ts`), Task
proposals through the Coordinator path, `request_decision` and
`request_completion` from the root turn, the end-to-end fake-provider Run
over `single` and `chain` nodes across six process lifetimes
(contract §8 "End-to-end tests").

**Evidence.** Injected ports and test doubles throughout; no real
provider, no real Workspace.

**Remaining.**

1. **Orchestrator authoring tools** — `revise_execution_plan` (the
   Orchestrator's route into the existing plan-revision service),
   `propose_requirements`, `create_tasks`, `record_decision`, full
   `update_task` (see "Deferred tools").
2. **The first real end-to-end single-agent path** — one Run with a
   `single` node executed by the production provider adapter (Phase 3) in
   a real Workspace (Phase 4 adapters) behind the opt-in smoke test.

**Dependencies.** Phase 3 item 1 and Phase 4 item 1 for the real path;
Phase 4 item 2 for authoring.

**Completion condition.** The authoring tools are executable from the root
turn with replay and restart tests, and the real end-to-end path runs
once behind the opt-in. Not met.

**Status: partial** — the Pattern, the root turns, and the end-to-end fake
path implemented and verified; authoring tools and the real path not
implemented.

## Phase 6 — Implement chain, routing, and parallel Patterns

**Deliverables.** `chain`, `route`, `parallel`, and `join` settlement, with
Handoff keys and readiness activation.

**Implemented.** `patterns/chain.ts`, `patterns/route.ts`,
`patterns/parallel.ts`, `join.ts`, `handoff-routing.ts`, the sequential
step engine in `patterns/support.ts`; tests `patterns/chain.test.ts`,
`patterns/route.test.ts`, `patterns/parallel.test.ts`, `join.test.ts`,
`handoff-routing.test.ts`, `readiness.test.ts`, with restart windows in
each.

**Evidence.** Injected ports and test doubles; file-backed restart
windows are real persistence.

**Remaining.** None at the engine level. Real-adapter coverage arrives
with Phase 4 item 1 and is credited there.

**Dependencies.** Phase 2, Phase 5.

**Completion condition.** Every rule of execution-model §5.2–§5.4 and §7.7
has a test and every Pattern converges across a restart. Met.

**Status: implemented and verified** (against injected ports).

## Phase 7 — Implement evaluator-optimizer

**Deliverables.** The `evaluator_optimizer` Pattern in inline and
evaluate-only form, typed Evaluator results, the deterministic check
service, `retry(round)` activation.

**Implemented.** `patterns/evaluator-optimizer.ts`,
`acceptance-checks.ts`, Evaluation store rows with round context; tests
`patterns/evaluator-optimizer.test.ts`, `optimizer-edges.test.ts`,
`optimizer-restart.test.ts` (sixteen windows), `acceptance-checks.test.ts`.

**Evidence.** Injected ports and test doubles.

**Remaining.** None at the engine level.

**Dependencies.** Phase 4 (checks), Phase 6.

**Completion condition.** Every rule of execution-model §5.6 and §10.1 has
a test and every round boundary converges across a restart. Met.

**Status: implemented and verified** (against injected ports).

## Phase 8 — Implement coordinator-worker and Pattern selection

**Deliverables.** The `coordinator_worker` Pattern; selection of Patterns
for a Run's plan.

**Implemented.** `patterns/coordinator-worker.ts`, `task-proposals.ts`,
`task-projection.ts`; tests `patterns/coordinator-worker.test.ts`,
`coordinator-restart.test.ts` (twelve windows), `task-projection` and
proposal suites. Pattern selection is the compiler's (`compiler/compile.ts`)
from the plan source an Orchestrator or operator supplies; the compiler
and the six runners are complete.

**Evidence.** Injected ports and test doubles.

**Remaining.** The Orchestrator's route to selecting Patterns at runtime is
`revise_execution_plan` (Phase 5 item 1 / deferred tools); the compiler
needs nothing further.

**Dependencies.** Phase 6, Phase 7.

**Completion condition.** Every rule of execution-model §5.5 has a test and
every Coordinator window converges across a restart (met); the
Orchestrator can revise a plan through its tool (not met — tracked under
Phase 5).

**Status: partial** — the Pattern implemented and verified; runtime
Pattern selection by the Orchestrator waits on `revise_execution_plan`.

## Phase 9 — Perform the complete application cutover

**Deliverables.** The API (`core/src/api.ts` route table, `/api/*`
resources, the event stream), the web application over the new routes,
the rewritten entrypoints (`main.ts`, `app.ts`, `boot.ts`, `config.ts`),
production wiring of the clean-break runtime (database open with the
reset-required check, `RecoveryService.recover()` before any work is
admitted, the scheduler as the one driver), operator operations exposed
through the API (Run creation, cancel, pause/resume, Decision resolution,
Budget Increase, signoff, publication).

**Implemented.** Nothing. `server/src/main.ts`, `app.ts`, and `boot.ts`
still build the legacy application over `server/src/db/`; no production
code calls the clean-break `RecoveryService` (the boundary test pins this:
its only callers are the test harnesses `execution/test-support.ts`,
`recovery-test-support.ts`, and the crash child).

**Evidence.** None.

**Remaining.** Everything above. Specifically reserved for this phase from
earlier corrections: the production startup order *open database → recover
(refuse to admit work while `RecoveryReport.blobs.complete` is false) →
start the scheduler*, which the test harnesses model
(`recoverOrRefuse` in `recovery-test-support.ts`) and no production
entrypoint yet performs.

**Dependencies.** Phases 2–5 complete enough for one real Run; Phase 3
item 1 and Phase 4 item 1 in particular.

**Completion condition.** Contract §9 acceptance: every route served,
every legacy route 404, a fresh database starts, a legacy database is
refused, `npm run verify` green.

**Status: not implemented.**

## Phase 10 — Eradicate legacy architecture and harden the result

**Deliverables.** Deletion of every entry in the removal inventory in one
commit series with the legacy tests and the evaluation harness; `README.md`
and `docs/` replaced; the terminology test over the whole tree; every
invariant of execution-model §15 referenced by a test; the merge to
`main`.

**Implemented.** Nothing (construction coexistence per contract rule 8 is
in force).

**Remaining.** Everything above.

**Dependencies.** Phase 9.

**Completion condition.** Contract §9 in full.

**Status: not implemented.**

## Deferred tools and behaviour

The runtime-tool contract (`core/src/runtime-tools.ts`) lists these tools
as permitted-but-not-executable: the manifest may grant them, no handler
exists, and the boundary test forbids binding them early. Each is an
**existing acceptance commitment** of execution-model §6.4 — the label
"later subphase" waives nothing.

| Deliverable | Owner in the original roadmap | Commitment | Notes |
|---|---|---|---|
| Full `update_task` (beyond the Coordinator's `cancel`) | Phase 4 (tools), used by Phase 5 authoring | existing (§6.4, §7.9) | Today: `update_task: [{ role: "coordinator", purposes: ["decompose", "replan"] }]` with the one `cancel` operation. |
| `create_tasks` | Phase 5 (Orchestrator authoring) | existing (§6.4) | Orchestrator-created Tasks outside a Coordinator node; the Task store and projection already accept `origin: "orchestrator"`. |
| `record_decision` | Phase 5 (Orchestrator authoring) | existing (§6.4, §8.2) | Records a Decision the Orchestrator made; can never create or resolve a `requirement_waiver` (contract §8 "Requirement tests"). |
| `propose_requirements` | Phase 5 (Orchestrator authoring) | existing (§6.4, §8.1) | Proposes a Requirement revision for operator approval; the Requirement stores and revision pinning exist. |
| `revise_execution_plan` | Phase 5 (Orchestrator authoring), enabling Phase 8 Pattern selection | existing (§4.5, §6.4) | The plan-revision service with reconciliation exists and is tested; the tool is the Orchestrator's route into it. |
| Operator supersession of a policy-resolved Decision | Phase 4 (verification and Decisions) | existing (§8.2) | Decisions carry `supersedesDecisionId`; the operator operation, its Event, and its restart test are not implemented. |

## Where the "Phase 2" label still carries unfinished work

Contract §7 step 3 ("Runtime core", the Phase 2 subphases) has been the
label under which Phases 2–8 were built. What remains under that label and
where it belongs:

| Unfinished item carrying a Phase 2 subphase label | Original phase |
|---|---|
| Production provider adapter(s) extracted from `server/src/sdk/` | Phase 3 |
| Real Workspace adapters for the six ports | Phase 4 |
| Remaining runtime tools (table above) | Phases 4 and 5 |
| Operator supersession of a policy-resolved Decision | Phase 4 |
| Workspace-file Agent Definitions | Phase 4 |
| First real end-to-end single-agent path | Phase 5 |
| Operator Run cancellation; operator pause/resume | Phase 2 (engine exit work) |

## Next unfinished deliverable

The earliest unfinished original-phase deliverable is Phase 2's operator
Run cancellation and pause/resume (the two remaining exit rows). After
those, the earliest is Phase 3 item 1, the production provider adapter,
which Phase 5's real end-to-end path and Phase 9's cutover both depend on.

## Revision history

- 2026-09-01 — created with the Artifact crash-recovery correction of
  Phase 2G-A (pending-write markers, `afterCommit`, reconciliation at the
  clean-break recovery boundary); every status above reflects the tree at
  that commit.
