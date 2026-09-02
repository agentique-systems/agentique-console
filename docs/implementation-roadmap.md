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
| 3 Execution adapters, context, Artifact delivery | 3 Runtime core | 2B (manifest, adapter contract, scripted fake), 2G-A (`read_artifact`, `write_artifact`); production Claude adapter (`51a78ae`) |
| 4 Workspaces, Changesets, tools, verification gates | 3 and 4 | 2A (preparation port), 2B (execution-workspace port, authorization), 2C (integration), 2D-B1 (runtime-tool boundary), 2D-B2 (checks), 2E-A/B/C/D (Gates, completion, signoff, publication), 2G-A (reads, writes); Workspace providers (`2933af7`), Workspace-file Agent Definitions (`c289f63`), authoring tools and supersession (`552d655`) |
| 5 Single-agent Pattern and Orchestrator | 3 | 2B (Run start, root turn), 2C (`single`, root settlement), 2E-B/C (completion, signoff turns), 2F-B (`request_decision`); authoring, steering (`552d655`), `node_result` turns (`48947c9`), composition and the real end-to-end path (`0839a21`) |
| 6 Chain, routing, parallel Patterns | 3 | 2C (`chain`), 2D-A (`route`, `parallel`, `join`) |
| 7 Evaluator-optimizer | 3 | 2D-B2 |
| 8 Coordinator-worker and Pattern selection | 3 | 2D-B1 (runner), 2A (compiler selects Patterns from the plan source), `revise_execution_plan` (`552d655`) |
| 9 Complete application cutover | 5 and 6 | publication correction (`9f32ebd`), API contract (`b27e3a4`), server and web cutover (`0c8a61a`), application path and restarts (`5936f14`) |
| 10 Eradicate legacy and harden | 6 and 7 | inventory executed with the cutover (`0c8a61a`), documents, terminology, and invariant audit (this commit); merge to `main` pending review |

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
positions` on Invocations, the runtime-tool call boundary
(`runtime-tools.ts`), and the operator Run-control boundary
(`run-control.ts`: cancel, pause `soft`/`hard`, resume; the shared
cancellation convergence `run-cancellation.ts`; the persisted
`operatorPause` on `runs` with its database invariants; the one admission
rule `runAdmitsNewWork` revalidated by the scheduler, the executor's
preparation, dispatch, and finalization, the runners, the Gate and
completion engines, the join settler, the Invocation preparation service,
and the Decision continuation). The per-item evidence is in the exit
checklist below.

**Evidence.** Injected ports and test doubles for provider and Workspace
behaviour (`ScriptedProvider`, `Fake*Workspace`); real execution for
persistence (file-backed restart suites: `*-restart.test.ts`,
`recovery-service.test.ts`, `data-access-restart.test.ts`) and for process
death (`data-access-crash.test.ts`, a real child process killed with
`SIGKILL` over a real SQLite file and `FileBlobStore`).

**Operator control (the two exit rows that were open).** Both are
Run-lifecycle operations of the engine (execution-model §3, §14), not API
work: the API of Phase 9 will call them. Cancellation
(`run-control.test.ts`): a durable barrier from every nonterminal status,
paused ones included; convergence of executing, prepared, waiting,
blocked, removed-membership, Coordinator, and chain work with terminal
history preserved, Usage retained once, reservations and leases settled
once by their owners, the Integration Workspace kept, late provider
results discarded, repeated cancels replayed, ended Runs refused. Pause
and resume (`run-control-pause.test.ts`, `persistence/stores/run-control.test.ts`,
`core/src/runs.test.ts`): the state/operation matrix with closed outcomes
and refusals; a soft pause that drains admitted Attempts without
starting, settling, or integrating anything and leaves other Runs
untouched; a hard pause that interrupts into the ordinary `interrupted`
class with identity, Task ownership, limits, and the deadline kept; the
prepared-but-undispatched boundary; runtime-tool and capability refusal
under a hard pause with replay kept; and a resume that recomputes
readiness from rows across Decisions, budget waits, chains, parallel
items, Coordinator Workers, completion verification, and signoff.
Races (`run-control-races.test.ts`) are driven by deterministic barriers
in both orders; the restart windows (`run-control-restart.test.ts`) are
file-backed. The earlier wording of this section overstated one
primitive: node removal by plan revision cancels only unstarted removed
nodes (`plan-revision-service.ts`, `planNodeIsUnstarted`); a running,
waiting, or terminal node that leaves the membership keeps its state and
finishes its own work (`settle_removed_node`) — the Run-wide cancellation
is what ends such a node, with reason `run_cancelled`.

**Dependencies.** Phase 1.

**Completion condition.** Every row of the exit checklist below is
*implemented and verified* or *superseded* with its replacement verified.
Met.

**Status: implemented and verified** — with the evidence qualification
above: provider and Workspace behaviour are injected ports and test
doubles (the engine's contracts with them are proven, no production
adapter is), persistence and process death are real execution.

### Original Phase 2 exit checklist

| Item | Status | Replacement (where superseded) and evidence |
|---|---|---|
| Plan validation, node readiness, dependencies, fan-in | implemented and verified | `compiler/compile.test.ts` (every §4.4 rule and rejection), `plan-revision-service.test.ts` (reconciliation, started-node conflicts), `readiness.test.ts` (pure evaluator over the current graph plus condition facts), `join.test.ts` (`require_all` / `require_any`, index order), `pattern-positions.test.ts`. |
| Deterministic scheduling and duplicate-execution protection | implemented and verified | `scheduler.test.ts` (membership order, `maxActions`, closed stop reasons, concurrent callers share one pass), `scheduler-restart.test.ts`; at most one non-terminal Invocation per node and position enforced by a unique index (`persistence/schema.ts`); Handoff keys unique per Run (`handoff-routing.test.ts`); runtime-tool replay by digest (`decision-requests.test.ts`, `artifact-writes.test.ts`). |
| Concurrency and capacity | implemented and verified | `governor.test.ts` (deterministic leases, structured refusals, `provider_capacity` wait), `patterns/parallel.test.ts` (Run, node, and governor limits), `plan-node-capacity.test.ts`, `budget-increases.test.ts`. |
| Pause/resume | implemented and verified (superseded wording: the pause is the persisted `operatorPause` mode on a `waiting`/`operator`, `verifying`, or `awaiting_signoff` Run, never a Run status; automatic waits are the same `waiting` state with their own reasons, resumed from rows) | Automatic waiting and resumption on `decision`, `budget`, `provider_capacity`, and `integration_conflict` (`scheduler.test.ts`, `decision-blocking.test.ts`, `budget-increases.test.ts`, `integration-service.test.ts`); operator `soft` and `hard` pause, escalation, resume, the matrix, and the admission rule (`run-control-pause.test.ts`, `run-control-races.test.ts`, `run-control-restart.test.ts`, `persistence/stores/run-control.test.ts`, `core/src/runs.test.ts`, the boundary guard in `persistence/boundaries.test.ts`). |
| Cancellation and propagation | implemented and verified | Propagation at every level the engine drives itself (unstarted-node removal by plan revision, Invocation cancellation, Task and Completion Request cancellation; `plan-revision-service.test.ts`, `patterns/*.test.ts`, `completion.test.ts`); the operator's Run-wide cancellation and its convergence, interruption, late-result, restart, and race behaviour (`run-control.test.ts`, `run-control-races.test.ts`, `run-control-restart.test.ts`, `recovery-service.test.ts`). |
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

**Implemented (`51a78ae`, `0839a21`).** The production adapter
`provider/claude-adapter.ts` over the Claude Agent SDK (`claude-sdk.ts`
is the narrow surface the adapter uses; `claude-sdk-binding.ts` the real
binding): the rendered manifest as the one user message under a fixed
protocol system prompt; native tools exposed exactly per the effective
capability set (`native-tools.ts`, with the SDK's own tool list pinned by
a tripwire test); every native call authorized by a `PreToolUse` hook
against the runtime's authorization port with a fail-closed `canUseTool`
behind it (`approval_required` ends the turn, a denial is a denied call,
`settingSources: []`, `strictMcpConfig`, `permissionMode: default`, no
skills); the runtime tools as an in-process MCP server whose handlers call
the runtime-tool port, with `return_result` ending the Attempt and a
blocking `request_decision` stopping the turn; structured results;
complete Usage from the SDK's per-model figures (`modelUsage`) with the
fallbacks recorded as such; interruption through the abort signal
(cancellation, pause, deadline); native continuation through session
resumption with a fresh fallback once when the session is gone; failure
classification (`failure-classifier.ts`, twelve closed kinds, secrets
redacted); the filtered subprocess environment (`env.ts`: host coupling
and feature flags stripped, retries and updater pinned); a bounded,
redacted JSONL transcript. Verified by the deterministic
`claude-adapter.test.ts` over `FakeClaudeSdk`
(`claude-sdk-test-support.ts`), which applies the SDK's exact tool path
(unknown tool → hooks → permission evaluation → execution) so the tests
prove the hook, not the SDK's defaults, decides; `native-tools.test.ts`,
`env.test.ts`, `failure-classifier.test.ts`, `runtime-tool-shapes.test.ts`
(the MCP input shapes through the real `createSdkMcpServer` and an MCP
client). The boundary test applies the provider rules to the adapter.

**Evidence.** Real execution: the opt-in live smoke `claude-live.test.ts`
(one read-only Attempt through the real SDK: authorized reads, a returned
typed result, measured Usage, a redacted transcript, no credential in any
output) and the live coding Run of Phase 5; deterministic suites over the
SDK fixture for every path.

**Remaining.** Nothing.

**Dependencies.** Phase 2.

**Completion condition.** Met: one Attempt of a root Orchestrator
Invocation executes against the production provider through the adapter
contract with Usage, transcript Artifact, result validation, and tool-call
authorization recorded exactly as with the fake, behind the opt-in smoke
test; the boundary test covers the adapter.

**Status: implemented and verified.**

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

**Implemented (production side).** `server/src/workspace-state/`
(`2933af7`): one production implementation of every port over a
Workspace state root — preparation (`preparation.ts`: the Target Snapshot
pinned by commit and tree, the Run's integration checkout on
`agentique/run/<runId>`), execution (`execution.ts`: one worktree per
Invocation at the integration head, its Changeset collected as a
binary-safe diff with before and after Snapshot identities), integration
(`integration.ts`: apply with `--3way` onto the integration branch, drift
detection, the `Agentique-Changeset` trailer, refs per Changeset,
conflicts as typed outcomes), checks (`checks.ts`: an isolated view
worktree per isolation key under the Run directory, the command as a real
subprocess with a bounded capture, the whole process tree ended at the
deadline, a filtered environment), finalization (`finalization.ts`: the
final diff observed between the pinned Target and the integration head),
and publication (`publish.ts`: prepared staging, byte-equality
verification of the candidate, fast-forward or merge, an atomic
`update-ref` transaction with compare-and-swap, receipts, a
plain-directory kind through a bare shadow repository with content
digests). Everything under it imports no store, blob store, or database
module. Workspace-file Agent Definitions (`c289f63`,
`server/src/agents/`): `.claude/agents/*.md` read from the exact pinned
Snapshot through `git ls-tree`/`cat-file` (never the working tree), the
native-field acceptance rule (`native-agent-file.ts`: every field read
with its native meaning, informational, or rejected by name; the retired
overlay refused), one revision per content hash with `workspace_file`
provenance, the built-ins ensured (`builtins.ts`). The remaining tools
(`552d655`): `update_task` in full (`task-authoring.ts`), `create_tasks`,
`record_decision` (`decision-records.ts`), `propose_requirements` with
the operator approve/edit/reject boundary (`requirement-proposals.ts`),
`revise_execution_plan` through the one plan-revision service. Operator
supersession of a policy-resolved Decision
(`decision-requests.ts` `supersede`, `552d655`).

**Evidence.** Real execution: `workspace-state/git-workspace.test.ts`,
`directory-workspace.test.ts`, `checks.test.ts`, `publish.test.ts`,
`capabilities.test.ts` over real repositories, worktrees, and
subprocesses; `agents/definitions.test.ts` over a real repository with
committed symlink objects and later commits; the composition end-to-end
(`composition/coding-run.e2e.test.ts`) over every port at once. Tools and
supersession: `execution/authoring-tools.test.ts`,
`requirement-proposals.test.ts`, `decision-supersession.test.ts`
(continuation before and after work proceeded, replays, refusals).

**Remaining.** Nothing.

**Dependencies.** Phase 2.

**Completion condition.** Met: every port has one production
implementation exercised over a real repository, the remaining tools are
executable at their bound positions with replay tests, supersession is
implemented and tested, and Workspace-file Agent Definitions are read and
pinned.

**Status: implemented and verified.**

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

**Implemented (`552d655`, `48947c9`, `0839a21`).** The authoring tools
from the root turn (`revise_execution_plan`, `propose_requirements`,
`create_tasks`, `record_decision`, full `update_task`; Phase 4 above).
Service-level operator steering: `orchestrator-inputs.ts` posts an
operator message to the Run's Conversation and queues it as a typed
input (`orchestrator_inputs`); the root advises one turn from rows once
the latest turn is settled, the scheduler's `prepare_root_turn` prepares
it with every queued input, and nothing is ever injected into an active
provider session. The Orchestrator's `node_result` turns
(`patterns/root.ts`): an ended current node whose result no root turn
received is delivered as a typed input of one batched turn, so the
Orchestrator acts on planned work (requests completion, revises the plan)
through canonical turns. The production composition
(`server/src/composition/console-runtime.ts`) and the first real
end-to-end path: `coding-run.e2e.test.ts` (default suite; real files,
git, subprocess checks, SQLite, blob and continuation stores, the SDK
fixture on the SDK's exact tool path) and `coding-run.live.test.ts` /
`npm run verify:coding-run --workspace server` (opt-in; the real SDK)
walk the fourteen steps — Workspace and Conversation, pinned
Workspace-file definition, operator Requirement and deterministic
criterion, Run creation and start, plan revision by tool, an isolated
Worker change, real integration, the `node_result` turn requesting
completion, the completion check as a real subprocess, final synthesis,
operator signoff with real finalization, a separately authorized
publication onto the fixture Target, then a restart and replays that
change nothing.

**Evidence.** Real execution for the whole path with the SDK fixture in
the default suite; real provider Attempts behind the opt-in — the live
verification ran on 2026-09-02 with `claude-haiku-4-5-20251001` at low
effort and completed all fourteen steps (root turns `operator_input`,
`node_result`, `final_synthesis`; one `revise_execution_plan` and one
`request_completion` call; the Worker's `Edit` in its worktree; the check
passed as a runtime Evaluation; the fixture Target fast-forwarded; about
0.11 USD); steering, node results, and supersession in
`operator-steering.test.ts`, `patterns/root-node-results.test.ts`,
`decision-supersession.test.ts`.

**Remaining.** Nothing.

**Dependencies.** Phases 3 and 4.

**Completion condition.** Met: the authoring tools are executable from the
root turn with replay tests, and the real end-to-end path runs behind the
opt-in (and, over the SDK fixture, in the default suite).

**Status: implemented and verified.**

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

**Remaining.** Nothing: the Orchestrator selects Patterns at runtime
through `revise_execution_plan` (`552d655`, credited here from Phase 5's
authoring work), exercised from the root turn in
`execution/authoring-tools.test.ts` and in the end-to-end coding Run.

**Dependencies.** Phase 6, Phase 7.

**Completion condition.** Met: every rule of execution-model §5.5 has a
test, every Coordinator window converges across a restart, and the
Orchestrator revises a plan through its tool.

**Status: implemented and verified** (against injected ports for the
Pattern; the tool over the real composition).

## Phase 9 — Perform the complete application cutover

**Deliverables.** The API (`core/src/api.ts` route table, `/api/*`
resources, the event stream), the web application over the new routes,
the rewritten entrypoints (`main.ts`, `app.ts`, `boot.ts`, `config.ts`),
production wiring of the clean-break runtime (database open with the
reset-required check, `RecoveryService.recover()` before any work is
admitted, the scheduler as the one driver), operator operations exposed
through the API (Run creation, cancel, pause/resume, Decision resolution,
Budget Increase, signoff, publication).

**Implemented.**

- *Publication correction first* (`9f32ebd`). The git provider's
  destructive checkout synchronization (`reset --hard` behind a stale
  clean-tree observation) is gone: the receipted compare-and-swap of the
  Target ref is unchanged, and the checkout is brought forward only by a
  non-destructive `read-tree -m -u` from the observed HEAD to the
  candidate, reported truthfully as `synchronized`, `not_checked_out`,
  `unchanged` (with `local_changes`, `head_moved`, or `operation_failed`),
  or `unknown` on a receipt replay. The directory kind no longer publishes
  through a non-atomic tree write: it refuses every strategy before
  touching the Target (`strategy_unsupported`), stated in the capability
  table, the API, and the web application; execution and inspection keep
  working. Preparation markers are validated, repaired, and rebuilt.
  Real-filesystem evidence: `workspace-state/publish.test.ts`,
  `composition/publication-git.test.ts` (a later commit and a later edit
  survive, a moved Target is refused, a real process death after the ref
  update and before the record replays the receipt exactly once, a damaged
  marker is repaired, a cleanup failure keeps the outcome).
- *The API contract* (`b27e3a4`): `core/src/api.ts` is the single route
  table (every resource of execution-model §13 and legacy-removal §5),
  with strict request schemas, bounded bodies, deterministic keyset
  pagination, typed error codes, response projections (`RunOverview` with
  the derived `RunPhase`, plan, ledger, Decisions with their operator
  action, Budget, signoff, publications), and the event-stream frame.
- *The server cutover* (`0c8a61a`): `config.ts` (validated `CONSOLE_*`
  configuration), `app.ts` (one composition for production, the HTTP
  tests, and verification), `boot.ts` (validate → open with the
  reset-required check → construct → recover → refuse admission while
  `RecoveryReport.blobs.complete` is false → reconstruct runnable Runs and
  outstanding Publications → serve; shutdown stops admission, interrupts
  executing Attempts with cause `shutdown`, waits a bounded time, closes),
  `main.ts`; the `host/` driver around `RunScheduler` (coalesced
  notifications after operator actions, completions, and capacity;
  bounded concurrency; fairness on `action_limit`; one cancellable
  one-shot timer per Run from the scheduler's `wakeAt`, never an interval;
  bounded retry after infrastructure failure; reconstruction from rows;
  a stop signal the scheduler consults before each action); the
  `events/` committed-event stream over the transaction commit listener
  (journal replay by sequence, reconnect from `Last-Event-ID`, filters,
  bounded pages and buffers, transient Attempt output routed by Attempt
  and never persisted); the `operator/` services and projections; the
  `api/` routes (membership validation, replay and refusal semantics, no
  generic status edit, signoff separate from publication, no actor from
  request fields, no credentials or storage keys in responses, bounded
  Artifact content and download, browse-root protections; every legacy
  route a standard 404). Evidence: `config.test.ts`, `host/run-host.test.ts`,
  `events/stream.test.ts`, `api/api.test.ts` (every contract route served,
  every removed route 404, validation, membership, admission),
  `boot.test.ts` (recovery before admission, `recovery_incomplete`
  refusal, shutdown keeps a soft pause and records the interruption, the
  real `main.ts` refuses a legacy database with exit code 2 and an invalid
  variable with exit code 1).
- *The web application* (`0c8a61a`): Workspaces (gate, wizard, browse
  roots), Conversations and messages, Run creation with the canonical
  defaults (the final reserve from the allocation rules), the Run views
  (overview with the derived phase and the next step, Requirements and
  proposals, the plan graph with node and Invocation inspection, the Task
  ledger, Decisions with the dedicated operations, verification with
  Gates and Evaluations and the final report, signoff and publication,
  usage and Budget, Agent Definitions, Artifacts with bounded content),
  the operator controls (pause soft/hard, resume, cancel with
  confirmation), the event subscription that refreshes projections
  (no polling driver), and the loading, empty, validation, stale,
  disconnected, and recovery-unavailable states.
- *The application-level path* (`5936f14`): `api/application.e2e.test.ts`
  drives the production composition through HTTP alone — Workspace,
  Conversation, a coding Run whose goal and completion check become the
  operator's Requirement, the Orchestrator's `propose_requirements` and
  blocking `request_decision`, the operator's approval and resolution
  through the API, `create_tasks` and `revise_execution_plan`, the
  Worker's change in an isolated worktree with `write_artifact` and
  `update_task` output and evidence, real integration, a real subprocess
  completion check, completion and the final report, signoff acceptance,
  and a separate publication whose receipt names the Target head — plus
  three file-backed restarts (the blocked proposal-and-Decision boundary,
  a Worker Attempt interrupted by the shutdown and retried, a Target
  update committed before the SQLite record). `web/tests/application.test.tsx`
  renders the application against a separately spawned server process for
  the normal flow and the operator controls.

**Evidence.** The suites named above; the root `npm run verify`; the
startup smoke of `main.ts`; drizzle `check`/`generate` reporting no
schema change against the single baseline migration.

**Deviations recorded.** No `plan-nodes/:id/cancel` route exists: the
execution model defines operator control at Run level only (§3: cancel,
pause soft/hard, resume) and node removal as the Orchestrator's plan
revision (§4); legacy-removal §5 now maps the legacy interrupt route to
the Run-level operations. The retained-variable list of legacy-removal
§9 named `CONSOLE_SKILLS_DIR`, `CONSOLE_AUTO_INIT_GIT`,
`CONSOLE_MCP_TOOL_TIMEOUT_MS`, `CONSOLE_WORKTREES`, and
`CONSOLE_ATTEMPT_START_TIMEOUT_MS`; the new configuration consumes none
of them (skills are not loaded into Attempts; the console never
initializes git — a Workspace is adopted as it is, a repository root as
`git` and anything else as `directory`; MCP tool timeouts and Attempt
start timeouts are the adapter's bounds; worktree isolation is the git
provider's only mode) and, per the same section, ignores unknown
`CONSOLE_*` names.

**Completion condition.** Contract §9 acceptance: every route served,
every legacy route 404, a fresh database starts, a legacy database is
refused, `npm run verify` green.

**Status: complete.**

## Phase 10 — Eradicate legacy architecture and harden the result

**Deliverables.** Deletion of every entry in the removal inventory in one
commit series with the legacy tests and the evaluation harness; `README.md`
and `docs/` replaced; the terminology test over the whole tree; every
invariant of execution-model §15 referenced by a test; the merge to
`main`.

**Implemented.**

- *The inventory executed* (`0c8a61a`): the `shared/` package; the legacy
  server modules (`agent-profiles`, `agent-sessions`, `capacity`,
  `completion`, `compose`, `continuation`, `db`, `handoffs`,
  `lane-runtime`, `orchestrator`, `portfolio`, `runtime`, `sdk`,
  `sessions`, `system`, `tasks`, `timeline`, the legacy `workspaces`,
  `api`, and `events`), the legacy entrypoints and helpers, the
  evaluation harness, the legacy scripts, the doctrine skills; the legacy
  web sources; the legacy database (a database not created by the
  baseline migration is refused without modification, with reset
  instructions); workspace, script, dependency, and lockfile entries.
  The seven legacy real-git failures of the baseline disappeared with
  their files.
- *Documents and terminology* (this commit): `README.md` and `docs/README.md`
  rewritten; the four legacy documents deleted; the retained skills
  reworded; the terminology test now also scans the skills, the
  repository scripts, and the top-level documents, with no new exception.
- *Invariant coverage* (`5936f14`, this commit): every invariant 1–29 of
  execution-model §15 is referenced by number in at least one test, and
  `persistence/boundaries.test.ts` asserts that coverage against the
  document.

**Remaining.** The merge to `main`, pending review of the branch.

**Completion condition.** Contract §9 in full.

**Status: implemented on the branch; merge pending review.**

## Formerly deferred tools and behaviour

Every tool the runtime-tool contract (`core/src/runtime-tools.ts`) once
listed as permitted-but-not-executable is now executable at exactly its
bound positions; the boundary test pins the complete handler set and that
each authoring tool binds to the Orchestrator's authoring purposes alone.

| Deliverable | Owner in the original roadmap | Delivered in | Where |
|---|---|---|---|
| Full `update_task` (`cancel`, `add_evidence`, `add_outputs`) | Phase 4 (tools), used by Phase 5 authoring | `552d655` | `execution/task-authoring.ts`, `TaskStore.recordEvidence`; `authoring-tools.test.ts` |
| `create_tasks` | Phase 5 (Orchestrator authoring) | `552d655` | `execution/task-authoring.ts`; `authoring-tools.test.ts` |
| `record_decision` | Phase 5 (Orchestrator authoring) | `552d655` | `execution/decision-records.ts` (the Orchestrator's `orchestrator_choice`, never a waiver); `authoring-tools.test.ts` |
| `propose_requirements` | Phase 5 (Orchestrator authoring) | `552d655` | `execution/requirement-proposals.ts`, `requirement_proposals` table; `requirement-proposals.test.ts` |
| `revise_execution_plan` | Phase 5 (Orchestrator authoring), enabling Phase 8 Pattern selection | `552d655` | `execution/runtime-tools.ts` through `PlanRevisionService`; `authoring-tools.test.ts`, the coding Run |
| Operator supersession of a policy-resolved Decision | Phase 4 (verification and Decisions) | `552d655` | `DecisionRequestService.supersede`; `decision-supersession.test.ts` |

## The "Phase 2" label carries no unfinished work

Contract §7 step 3 ("Runtime core", the Phase 2 subphases) was the label
under which Phases 2–8 were built. Everything that remained under it has
been delivered under its original phase:

| Item once carrying a Phase 2 subphase label | Original phase | Delivered in |
|---|---|---|
| Production provider adapter | Phase 3 | `51a78ae` |
| Real Workspace adapters for the six ports | Phase 4 | `2933af7` |
| Remaining runtime tools (table above) | Phases 4 and 5 | `552d655` |
| Operator supersession of a policy-resolved Decision | Phase 4 | `552d655` |
| Workspace-file Agent Definitions | Phase 4 | `c289f63` |
| First real end-to-end single-agent path | Phase 5 | `0839a21` |

## Next unfinished deliverable

No original-phase deliverable is unfinished on the branch. Phases 0–9 are
complete; Phase 10 is implemented and its one remaining item, the merge to
`main`, awaits review of the branch.

## Revision history

- 2026-09-01 — created with the Artifact crash-recovery correction of
  Phase 2G-A (pending-write markers, `afterCommit`, reconciliation at the
  clean-break recovery boundary); every status above reflects the tree at
  that commit.
- 2026-09-01 — Phase 2 closed: two blob-protocol corrections (owned-path
  safety against symlinks and junctions; bounded, handle-releasing pending
  enumeration), operator Run cancellation, and operator pause/resume with
  the persisted `operatorPause`; the plan-revision overstatement in this
  section corrected; the next unfinished deliverable is Phase 3 item 1.
- 2026-09-02 — Phases 3, 4, 5, and 8 closed: two lifecycle corrections
  (`055a001`: a cancelled Run's interrupted Attempt settles as
  `cancelled`, and recovery cancels the work of a Run cancelled while its
  Attempt was blocked); the production Claude adapter (`51a78ae`); the
  Workspace providers for all six ports over git and plain-directory
  Workspaces (`2933af7`); Snapshot-pinned Workspace-file Agent
  Definitions and the built-ins (`c289f63`); the authoring tools,
  Requirement proposals with the operator boundary, operator steering
  through the canonical root input queue, and operator supersession of
  a policy-resolved Decision (`552d655`); the Orchestrator's
  `node_result` turns (`48947c9`); the production composition, the
  end-to-end coding Run over real files, git, subprocess checks, and
  SQLite, and the live verification entrypoint (`0839a21`). The baseline
  migration was regenerated for `requirement_proposals`,
  `orchestrator_inputs`, the `xhigh` effort, and an Orchestrator's own
  `orchestrator_choice`. The next unfinished deliverable is Phase 9.
- 2026-09-02 — Phases 9 and 10 delivered on the branch: the publication
  correction (non-destructive checkout, directory refusal, preparation
  repair), the API contract, the server and web cutover with the legacy
  inventory executed, the application-level HTTP path with three
  file-backed restarts and the browser flow, the documents and terminology
  pass, and the §15 invariant coverage audit. Merge to `main` pending
  review.
