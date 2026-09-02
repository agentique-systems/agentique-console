# Legacy removal inventory

This document lists every existing module, table, route, type, event, tool,
prompt, test, script, configuration variable, document, and UI component
that the clean-break migration deletes or replaces, and maps each legacy
concept to its final replacement or to "deleted with no replacement". The
rules under which this happens are in
[migration-contract.md](migration-contract.md); the replacement vocabulary
is in [glossary.md](glossary.md); the replacement behaviour is in
[execution-model.md](execution-model.md).

Paths are relative to the repository root and were verified against the
tree at commit `1e7f771` (branch base). "Replaced by" names the final
module, table, or concept that takes over the responsibility; it does not
imply any code is ported. "Deleted" means the responsibility itself does
not exist in the new architecture.

Final module layout referenced below (to be created under these names).
`core/` and `server/src/persistence/` are permanent production boundaries
created in Phase 1 (see [migration-contract.md](migration-contract.md) §2,
"Final module boundaries"); they are not transitional and are not renamed
at cutover:

```
core/                      package @agentique-console/core
  package.json  tsconfig.json
  src/
    index.ts  ids.ts  validation.ts  errors.ts  transitions.ts
    workspaces.ts  conversations.ts  runs.ts  budgets.ts  plans.ts
    requirements.ts  decisions.ts  tasks.ts  artifacts.ts  handoffs.ts
    agents.ts  invocations.ts  verification.ts  workspace-state.ts
    capacity.ts  usage.ts  events.ts  schema-info.ts  api.ts
server/src/
  main.ts  app.ts  config.ts  boot.ts
  persistence/   schema.ts  client.ts  database.ts  transactions.ts  context.ts
                 blob-store.ts  journal.ts  test-support.ts
                 stores/{index,support,workspaces,conversations,runs,plans,requirements,
                         decisions,tasks,artifacts,handoffs,agents,invocations,
                         continuations,verification,workspace-state,capacity,budgets,usage,
                         runtime-tool-calls,budget-increases,allocation-extensions}.ts
                 migrations/0000_orchestration_core.sql  migrations/meta/*
  events/        stream.ts
  workspaces/    service.ts  fs-browse.ts
  conversations/ service.ts
  execution/     index.ts  run-creation-service.ts  plan-revision-service.ts  run-start-service.ts
                 invocation-preparation-service.ts  invocation-lifecycle.ts  attempt-executor.ts
                 result-validator.ts  retry-policy.ts  continuation-policy.ts  governor.ts
                 recovery-service.ts  workspace-cleanup.ts  tool-call-authorization.ts  agent-definitions.ts
                 readiness.ts  readiness-facts.ts  handoff-routing.ts  integration-service.ts  join.ts  scheduler.ts  test-support.ts
                 runtime-tools.ts  task-proposals.ts  task-projection.ts  coordinator-test-support.ts
                 plan-node-capacity.ts  budget-increases.ts
                 compiler/{compile,input,source-path}.ts  manifest/{assembler,renderer}.ts
                 ports/{workspace-preparation,execution-workspace,integration-workspace}.ts
                 patterns/{index,support,root,single,chain,route,parallel,coordinator-worker}.ts
                 (later subphases) patterns/evaluator-optimizer.ts  tools.ts  gates.ts
  agents/        definitions.ts  revisions.ts  native-agent-file.ts  builtins.ts  policy.ts
  provider/      adapter.ts  continuations.ts  continuation-store.ts  fake.ts  mapping.ts  env.ts  usage-normalization.ts  failure-classifier.ts
  capacity/      governor.ts  leases.ts
  artifacts/     store.ts
  handoffs/      service.ts
  tasks/         service.ts
  requirements/  service.ts  outline.ts
  decisions/     service.ts  policies.ts
  evaluations/   service.ts  gates.ts  deterministic.ts
  workspace-state/ snapshots.ts  changesets.ts  worktrees.ts  integration.ts  publish.ts  providers/{git,directory}.ts
  api/           server.ts  errors.ts  routes/*.ts
web/src/
  app/  api/  live/  conversation/  run/  plan/  tasks/  requirements/
  decisions/  artifacts/  agents/  workspaces/  components/ui/  lib/  stores/
```

### Directory policy

The inventory targets legacy **files, symbols, schemas, dependencies, and
behaviour**. A directory name is legacy only when the name itself is a
retired term (`agent-sessions/`, `agent-profiles/`, `sessions/`,
`lane-runtime/`, `continuation/`, `portfolio/`, `compose/`, `timeline/`,
`completion/`, `system/`, `orchestrator/`); those directories are deleted.
Conventional paths — `events/`, `tasks/`, `handoffs/`, `workspaces/`,
`capacity/`, `api/`, `api/routes/`, `runtime/`, `web/src/app/`,
`web/src/api/`, `web/src/live/`, `web/src/stores/`, `web/src/lib/`,
`web/src/tasks/`, `web/src/agents/` — remain appropriate final locations.
For these the disposition below reads "legacy contents replaced": every
legacy file under the path is deleted or rewritten, and what remains
conforms completely to the new architecture and depends on nothing
scheduled for deletion. `server/src/sdk/` is deleted as a path; its
provider-neutral mechanics may be extracted into `server/src/provider/`
under [migration-contract.md](migration-contract.md) rule 7. `shared/`
and `server/src/db/` are deleted whole at cutover, untouched until then;
their replacements are the permanent boundaries `core/` and
`server/src/persistence/`, which exist alongside them during construction
with no import, export, or runtime call in either direction.

## 1. Concept map

| Legacy concept | Where it lives today | Final replacement |
|---|---|---|
| UserSession (operator thread + run state + mode + phase + pause) | `shared/src/domain.ts`, `user_sessions`, `server/src/sessions/service.ts` | Conversation (thread) + Run (execution). Mode and phase deleted: one Run kind (`code`/`other`), no plan mode. |
| Project (durable requirement scope across sessions) | `projects`, `server/src/db/stores/project-store.ts` | Conversation. Requirements and Decisions belong to the Conversation. |
| Project continuation / continuation checkpoint | `continuation_checkpoints`, `server/src/continuation/*`, `POST /api/user-sessions/:id/continue` | Deleted with no replacement. A new Run in the same Conversation starts from canonical objects, never from a checkpoint document. |
| AgentSession (managed team running a pattern, with roster, mailbox, budget, nesting) | `agent_sessions`, `agents`, `server/src/agent-sessions/*` | Plan Node + Invocations. No roster, no nesting, no persistent group. |
| Orchestration pattern as topology contract (hub_and_spoke, pipeline, evaluator_optimizer, map_reduce, debate, peer_to_peer, plan_execute) | `server/src/agent-sessions/topology-contract.ts`, `patterns/catalog.ts`, `patterns/engine.ts`, `pattern_state` | Pattern as Plan Node type: `single`, `chain`, `route`, `parallel`, `coordinator_worker`, `evaluator_optimizer`. `hub_and_spoke` → `coordinator_worker`; `pipeline` → `chain`; `map_reduce` → `parallel`; `debate`, `peer_to_peer`, `plan_execute` → deleted with no replacement. |
| Main / Master Orchestrator lane | `server/src/orchestrator/runner.ts`, `prompt.ts` | Orchestrator: the root `single` Plan Node's Invocation. |
| Seat (durable named agent position in a roster) | `agents` table, `agent-sessions/runtime.ts`, `lanes.ts` | Invocation. |
| Specialist | prompts, `AgentSession.agents` | Worker or Evaluator role. |
| Coordinator (console-seated hub authority) | `agent-profiles/registry.ts` builtin `coordinator`, `topology-contract.ts autoCoordinatorRole` | Coordinator role inside a `coordinator_worker` node only. |
| Generation / context rotation / retirement | `agents.generation`, `agent_session.context.rotated`, `handoffRecords.generation`, `usage_samples.generation`, `lane-runtime/checkpoint.ts` | Invocation per logical turn (with `purpose` and `continuedFromInvocationId`) and Attempt (`initial` or `retry`). No rotation: a failed Attempt is followed by a `retry`; new input is a new Invocation; provider resumption is an optional adapter decision. |
| Serialized main turns / seat turns on one long-lived provider session | `orchestrator/runner.ts`, `agent-sessions/runtime.ts` turn loop | One Invocation per logical turn owned by the stable Plan Node (root node or `coordinator_worker` node); at most one active Orchestrator Invocation per Run and one Coordinator Invocation per node. |
| Lane / resident agent / parked agent / wake / reap | `agent-sessions/runtime.ts`, `liveness.ts`, `capacity/service.ts` residency knobs | Deleted with no replacement. An Attempt is a process that exists for its duration; nothing is parked. |
| Attention / material wake / coalesced milestones | `agent-sessions/attention.ts`, `EdgeSpec.attention`, `web/src/live/attention.tsx` | Deleted with no replacement. Orchestrator turns are started by the runtime on dependency, Gate, Decision, and Budget events. |
| Mailbox / mailroom / delivery states / redelivery | `mailbox_deliveries`, `agent-sessions/mailroom.ts`, `messages` | Deleted with no replacement. Handoffs are delivered inside Context Manifests. |
| Handoff core + extension, `send_handoff`, `forward_message`, `read_handoff`, `report_handoff_discrepancy` | `shared/src/handoffs.ts`, `handoff_records`, `server/src/handoffs/*`, `agent-tools.ts` | Handoff (routing metadata + Artifact ids). Typed content → typed Artifacts. Extensions, forwarding, paging, and discrepancy reports deleted. |
| Route law / topology edges / join gates | `topology-contract.ts` `EdgeSpec`, `JoinSpec`, `agent-sessions/routing.ts` | Plan Node dependencies and runtime fan-in. |
| Task ledger keyed to AgentSession (states `pending`, `in_progress`, `completed`, `deleted`), scheduled assignments, assignment scheduler | `tasks`, `scheduled_assignments`, `task_dependencies`, `server/src/tasks/*` | Task (Run-scoped) with the seven runtime-owned states `pending`, `ready`, `running`, `blocked`, `completed`, `failed`, `cancelled`, plus `task_dependencies`; scheduling by the runtime's plan scheduler. `scheduled_assignments` and the `in_progress`/`deleted` states deleted. |
| Interaction (ask_operator card), decision issue, decision ledger, operator decisions, deferred asks with auto-proceed timers | `interactions`, `decision_issues`, `server/src/orchestrator/interactions.ts`, `decision-issues.ts`, `decisions.ts` | Decision with a kind and an explicit resolution policy (`operator_required`, `use_default_after_deadline`); every resolution is a `decision.resolved` Event. Issue merging, urgency classes, detach timers, silent auto-proceed → deleted. |
| Requirement graph (revisions, nodes, status changes, delegations, links, assumptions, change impacts, verification tiers, frontier) | `requirement_*`, `assumptions`, `change_impacts`, `server/src/orchestrator/requirements.ts`, `assumptions.ts`, `change-impact.ts`, `shared/src/requirements.ts` | Requirement (tree, `all`/`any`, semantic status incl. `waived`, revisions for outcome/constraint changes only) + Acceptance Criterion + Evaluation. Delegations → Plan Node input. Links, assumptions as an entity, change impacts, verification tiers, frontier annotations → deleted with no replacement. |
| Orchestration working state / objective assessment | `orchestration_state_revisions`, `server/src/orchestrator/state.ts`, `objective.ts` | Deleted with no replacement. The Execution Plan, Tasks, and Decisions are the working state. |
| Run summary, completion coverage report, typed coverage exceptions, sign-off waivers | `run_summaries`, `server/src/completion/*`, `POST /api/user-sessions/:id/signoff` | Gate (`run_completion`, `operator_signoff`) + Evaluations. Coverage exceptions deleted. Waivers are kept as `requirement_waiver` Decisions (actor, rationale, Requirement id, timestamp, optional Artifact ids) that set a Requirement `waived`; the legacy per-exception waiver rows are deleted. |
| Workstream links, ownership claims | `workstream_links`, `agents.owns/sharedOwns`, `server/src/portfolio/*` | Deleted with no replacement. Plan Edges express ordering; worktrees and Changeset integration handle overlap. |
| Worktree binding, landing ledger, land-on-report merge into the operator's branch | `worktree_landings`, `server/src/workspaces/landings.ts`, `agent-sessions/worktree-binding.ts`, `runtime/worktree-manager.ts` | Snapshot + Changeset + Integration Workspace (`workspace-state/`), and a separate Publication to the Target after completion. No Run writes to the operator's branch. |
| Provider journal mirror (SDK SessionStore), provider-session resume handles on seats | `provider_entries`, `server/src/sdk/session-store.ts`, `agents.provider_session_id` | Transcript Artifact per Attempt; a `provider_continuations` index row (Attempt id, provider, storage key, digest, times) pointing at an opaque payload in the adapter-owned payload store, used only for optional `resumed` Attempts. No SessionStore mirror; no durable seat identity; no provider payload in any canonical row. |
| Commission budget (per AgentSession ceiling summed from usage), run-level budget pause | `agent_sessions.budget_usd`, `capacity/service.ts` budget pause, `usage_samples` sums | Run Budget as the allocation pool; explicit Plan Node and Invocation allocations recorded atomically in `budget_reservations`; Run `waiting`/`budget` on exhaustion. |
| Requirement delegations (subtree scoping of sessions by delegated requirement ids) | `requirement_delegations`, `assertWithinDelegation` | `plan_node_requirements`: the compiler-expanded exact leaf set at a pinned Requirement revision, immutable per Plan Node; Coordinator Task proposals validated against it. |
| Usage samples per participant/generation | `usage_samples`, `agent-sessions/usage-accounting`, `lane-runtime/usage.ts` | `usage` rows per Attempt, rolled up by sum. |
| Event spine with user_session/agent_session scoping | `events`, `shared/src/events.ts`, `server/src/events/*` | `events` with Run/Plan Node/Invocation scoping and new type namespace. |
| Agent profiles (builtins, native files with `agentique:` overlay, minting, trust by source revision) | `agent_profile_trust`, `minted_profiles`, `server/src/agent-profiles/*` | Agent Definition with immutable revisions (`server/src/agents/`): logical id, revision id, content hash, provenance, model policy, instructions, capabilities, Tool Policy, default limits. Overlay, sidecar, bundle, minting, `specialize_profile`, and the trust-by-source-revision system deleted with no replacement; no `trusted` flag or trust table. |
| Console skills plugin doctrine | `server/skills/skills/orchestration-patterns`, `handoff-discipline`, `requirements-mechanics`, `wrap-up-and-landing`, `worktree-etiquette`, `long-build-discipline`, `probe-method` | Deleted with no replacement. Pattern behaviour is runtime code, not prompt doctrine. |
| System-wide pause product model, capacity pause, budget pause, machine-wide resident-agent caps | `server/src/system/pause.ts`, `capacity/service.ts`, `user_sessions.pause_reason`, `CONSOLE_MAX_RESIDENT_*` | Per-Run `waiting` with structured reason (`decision`, `budget`, `provider_capacity`, `operator`) plus the deterministic Resource Governor (`capacity/governor.ts`, `capacity_leases`) for provider quota, provider concurrency, process concurrency, and configured limits. The global-pause product state is deleted. |
| Deadlines / cron fallback | `crons`, `set_deadline`, `runner.startCronFallback` | Deleted with no replacement. |
| Compose improve | `server/src/compose/*`, `POST /api/compose/improve` | Deleted with no replacement. |
| Timeline service | `server/src/timeline/*`, `GET /api/user-sessions/:id/timeline` | Plan view built from Events (`web/src/plan/`). |
| Evaluation harness and rubrics | `server/evals/*` | Deleted with no replacement. |

## 2. Shared package (`shared/`)

The whole `shared/` workspace package (`@agentique-console/shared`) is
deleted at cutover and replaced by `core/` (`@agentique-console/core`).
Nothing in `shared/` is edited during construction; no file in `core/`
imports, re-exports, or aliases anything from it. Per-file replacements:

| File | Disposition |
|---|---|
| `domain.ts` | Deleted. Replaced by `core/src/workspaces.ts`, `conversations.ts`, `runs.ts`, `plans.ts`, `tasks.ts`, `decisions.ts`, `agents.ts`, `invocations.ts`, `verification.ts`, `workspace-state.ts`. Types deleted with no replacement: `SessionMode`, `SessionPhase`, `AgentSession*`, `AgentRunSummary`, `Speaker`, `SessionMessage`, `ScheduledAssignment*`, `SessionTreeBranch`, `AgentProfile*`, `Timeline*`, `Interaction*`, `DecisionIssue*`, `Assumption*`, `RequirementFrontier*`, `RequirementVerificationGap`, `RequirementReversal`, `ChangeImpact*`, `WorkstreamLink*`, `Completion*`, `Coverage*`, `Continuation*`, `Objective*`, `PATTERN`, `PatternId`, `RunSummaryStats`, `SystemPauseState`, `PauseReason`. |
| `events.ts` | Deleted. Replaced by `core/src/events.ts`, the new event catalogue. Every `user_session.*`, `agent_session.*`, `handoff.*`, `task.assignment.*`, `task.sync.*`, `workstream.*`, `change_impact.*`, `assumption.*`, `decision_issue.*`, `requirement.delegated`, `requirement.link.changed`, `project.continuation.recorded`, `run.capacity.*`, `run.completion.proposed`, `run.signoff.resolved`, `run.reopened`, `system.pause.changed`, `agent_profile.*`, `operator.decision.recorded`, `tool.denied`, `usage.recorded` type is deleted. New namespaces: `workspace.*`, `conversation.*`, `run.*`, `execution_plan.*`, `plan_node.*`, `invocation.*`, `attempt.*`, `requirement.*`, `acceptance_criterion.*`, `decision.*`, `task.*`, `artifact.*`, `handoff.*`, `evaluation.*`, `gate.*`, `snapshot.*`, `changeset.*`, `usage.*`; transient `stream.*`. |
| `api.ts` | Deleted. Replaced by `core/src/api.ts`. Every legacy request/response type and path comment is deleted (section 5). |
| `handoffs.ts` | Deleted. Replaced by `core/src/handoffs.ts`, the single Handoff shape. `HandoffCore`, `HandoffExtension`, `*HandoffData`, `HandoffDraft`, `HandoffMetadata`, `HandoffSummary`, `HandoffPage`, `HandoffTrigger`, `HandoffRisk`, `HANDOFF_READ_*` deleted. `EvidenceRef` → `Evidence` in `core/src/requirements.ts`. |
| `models.ts` | Deleted. Replaced by `core/src/agents.ts` (model catalogue on Agent Definitions). `ORCHESTRATOR_MODELS`, `DEFAULT_ORCHESTRATOR_MODEL`, `isOrchestratorModel`, `orchestratorModelLabel` deleted. |
| `requirements.ts` | Deleted. Replaced by `core/src/requirements.ts`. Outline grammar, `parseRequirementsDocument`, `renderCommitted`, `renderStatusOutline`, `flattenRequirementGraph`, `deriveComposedStatus`, `requirementStatusCounts` are rewritten against the new Requirement type; `RequirementVerifiedBy`, `RequirementVerifyExpectation`, `(verify: …)` markers deleted. |
| `index.ts`, `package.json`, `tsconfig.json` | Deleted with the package. `core/src/index.ts` is the final public surface. |

## 3. Server (`server/src/`)

### 3.1 Entrypoints and composition

| Path | Disposition |
|---|---|
| `main.ts` | Rewritten: opens the database with the reset-required check, builds the new app graph, runs the clean-break restart recovery (`execution/recovery-service.ts`, including the blob store's pending-area reconciliation) and admits work only when it is complete, then starts the one scheduler. Not yet rewritten: the replacement runtime is not wired into the legacy entrypoint during construction (roadmap Phase 9). |
| `app.ts` | Rewritten: composes the new services. Every legacy service construction deleted. |
| `boot.ts` | Rewritten: startup recovery is the clean-break `RecoveryService` (Attempts from rows, leases, worktree obligations, pending blobs), nothing from a transcript. `expirePendingOnBoot`, delivery requeue, `reconcileDurableCommunication`, orphan worktree recovery by session, orphan child archival, scheduled-assignment redrive, cron fallback, governance sweep deleted. |
| `context.ts` | Retained in shape (`AppContext`), retyped to the new `App`. |
| `config.ts` | Rewritten. See section 9 for variables. |
| `ids.ts` | Deleted. Replaced by `core/src/ids.ts` (the glossary prefixes). Legacy prefixes `us`, `as`, `msg`, `int`, `turn`, `delivery`, `cron`, `proc`, `draft`, `rnd`, `sched`, `spec`, `ost`, `rqs`, `rqd`, `proj`, `rql`, `chg`, `wl`, `di`, `ckpt`, `land` deleted. |
| `errors.ts`, `late.ts`, `async-queue.ts` | Generic; rewritten under the same names if the new code needs them (rule 7 of the contract), otherwise deleted. |
| `paging.ts`, `paging.test.ts` | Deleted with no replacement (existed for `read_handoff` and tool-output windowing; Artifacts are read by id and range). |
| `recovery.ts`, `recovery.test.ts` | Deleted. Replaced by `execution/recovery-service.ts` (`recovery-service.test.ts`). |
| `test-helpers.ts` | Deleted. New harness under `server/src/test/`. |
| `requirements-format.test.ts` | Deleted. |

### 3.2 Orchestrator (`orchestrator/`)

| Path | Disposition |
|---|---|
| `runner.ts`, `runner.test.ts`, `runner-model.test.ts` | Deleted. Replaced by the Orchestrator root-node Invocation in `execution/`. Serialized main turns, wake coalescing, cron fallback, lane recycling on model change deleted. |
| `tools.ts`, `tools-bytes.test.ts`, `tools-paging.test.ts` | Deleted. Replaced by `invocations/tools.ts` (section 7). |
| `prompt.ts` | Deleted. Replaced by the `orchestrator` built-in Agent Definition in `agents/builtins.ts`. |
| `options.ts`, `options.test.ts`, `permissions.ts` | Deleted. Replaced by `agents/policy.ts` and `provider/adapter.ts`. |
| `requirements.ts`, `requirements.test.ts`, `requirements-continuity.test.ts` | Deleted. Replaced by `requirements/service.ts`. |
| `assumptions.ts`, `assumptions.test.ts` | Deleted with no replacement. |
| `change-impact.ts`, `change-impact.test.ts` | Deleted with no replacement. |
| `commissions.ts`, `commissions.e2e.test.ts` | Deleted. Replaced by `execution/plan-revision-service.ts` (authorization, validation, reconciliation, atomic application) and `execution/compiler/`. |
| `decision-issues.ts`, `decision-issues.test.ts`, `decisions.ts`, `decisions.test.ts`, `interactions.ts`, `interactions.test.ts` | Deleted. Replaced by `decisions/service.ts`. |
| `grants.ts` | Deleted. Replaced by `invocations/tools.ts` role table. |
| `objective.ts`, `objective-progress.test.ts`, `state.ts`, `spec-state.e2e.test.ts` | Deleted with no replacement. |
| `titler.ts` | Deleted. Conversation titles are set by the Orchestrator's first result or the operator. |

### 3.3 Agent sessions (`agent-sessions/`) — the whole directory is deleted

| Path | Disposition |
|---|---|
| `service.ts`, `runtime.ts`, `lifecycle.ts`, `lanes.ts`, `liveness.ts`, `mailroom.ts`, `routing.ts`, `seams.ts`, `session-tree.ts`, `nesting.ts`, `attention.ts`, `names.ts`, `ledger-sync.ts`, `worktree-binding.ts`, `delivery-view.ts`, `final-gate.ts`, `operator.ts`, `grants.ts`, `composer.ts`, `presets.ts`, `topology.ts`, `topology-contract.ts`, `patterns/catalog.ts`, `patterns/engine.ts`, `agent-tools.ts` | Deleted. Responsibilities: scheduling and fan-in → `execution/scheduler.ts` and `execution/patterns/*`; Invocation process lifetime → `execution/attempts.ts`; prompt assembly → `execution/manifest.ts`; tools → `execution/tools.ts`; worktrees → `workspace-state/worktrees.ts`. Mailroom, routing, liveness, nesting, attention, names, ledger sync, delivery view, final gate, operator-path prompts, presets, topology, catalog, engine → deleted with no replacement. |
| Every `*.test.ts` and `*.e2e.test.ts` in this directory (48 files) and `__snapshots__/prompt-snapshot.e2e.test.ts.snap` | Deleted. |

### 3.4 Agent profiles (`agent-profiles/`)

| Path | Disposition |
|---|---|
| `registry.ts`, `registry.test.ts`, `registry-models.test.ts` | Deleted. Replaced by `agents/definitions.ts` and `agents/builtins.ts`. Built-ins `coordinator`, `explorer`, `planner`, `implementer`, `frontend-implementer`, `reviewer`, `visual-reviewer`, `researcher` are deleted; the new built-in set is `orchestrator`, `worker`, `reviewer` (an Evaluator definition), plus any the implementation phase adds under final names. |
| `native-agent-file.ts`, `native-agent-file.test.ts` | Deleted. Replaced by `agents/native-agent-file.ts` (new parser; no `agentique:` map, no overlay). |
| `capability-catalog.ts`, `capability-catalog.test.ts` | Deleted with no replacement. |

### 3.5 Persistence (`db/`)

The whole `server/src/db/` directory is deleted at cutover and replaced by
the permanent persistence boundary `server/src/persistence/`. Nothing
under `server/src/db/` is edited during construction; nothing under
`server/src/persistence/` imports from it; the legacy application keeps
opening its own database through `db/client.ts` and its already-generated
legacy migrations, and no new legacy migration is generated
(`server/drizzle.config.ts` points at `persistence/` from Phase 1).

| Path | Disposition |
|---|---|
| `schema.ts` | Deleted. Replaced by `persistence/schema.ts` (section 4). |
| `client.ts`, `client.test.ts` | Deleted. Replaced by `persistence/client.ts` and `persistence/database.ts` (the reset-required check) with their tests. |
| `repo.ts` | Deleted. Replaced by the per-aggregate stores under `persistence/stores/`. |
| `stores/*.ts` (`assignment-store`, `assumption-store`, `change-impact-store`, `continuation-store`, `cron-store`, `decision-issue-store`, `handoff-store`, `index`, `interaction-store`, `landing-store`, `message-store`, `pattern-state-store`, `project-store`, `requirement-store`, `session-store`, `state-store`, `task-store`, `usage-store`, `workspace-store`, `workstream-store`) | Deleted. Replaced by `persistence/stores/*.ts`. |
| `stores/requirement-store.test.ts`, `stores/requirement-projection.test.ts` | Deleted. |
| `migrations/0000_baseline.sql` … `0027_right_mandarin.sql`, `migrations/meta/*` | Deleted. Replaced by `persistence/migrations/0000_orchestration_core.sql` and its journal. |
| `glossary-migration.test.ts`, `mailbox-timing.test.ts`, `objective-migration.test.ts`, `projection-migration.test.ts`, `spec-migration.test.ts` | Deleted. |

### 3.6 Other services

| Path | Disposition |
|---|---|
| `sessions/service.ts`, `sessions/service-model.test.ts` | Deleted. Replaced by `conversations/service.ts` and `execution/run-creation-service.ts` (atomic Run bootstrap) with the Run lifecycle in `execution/`. |
| `handoffs/service.ts`, `handoffs/schema.ts`, `*.test.ts` | Legacy contents replaced: `handoffs/service.ts` is rewritten for the single Handoff shape; `schema.ts` and the tests are deleted. |
| `tasks/service.ts`, `tasks/scheduler.ts`, `tasks/scheduler.test.ts` | Legacy contents replaced: `tasks/service.ts` is rewritten for Run-scoped Tasks; `scheduler.ts` (assignment scheduling) and its test are deleted, scheduling moves to `execution/scheduler.ts`. |
| `completion/service.ts`, `coverage.ts`, `coverage.test.ts`, `summary.ts`, `summary.test.ts`, `completion.e2e.test.ts` | Deleted. Replaced by `evaluations/gates.ts`. |
| `continuation/service.ts`, `continuation.e2e.test.ts` | Deleted with no replacement. |
| `compose/improve.ts`, `improve.test.ts` | Deleted with no replacement. |
| `capacity/service.ts`, `service.test.ts` | Legacy contents replaced: the provider-usage-window pause and resident-agent caps are deleted; `capacity/governor.ts` and `capacity/leases.ts` (the Resource Governor) take the path. Budget ceilings move to `runs/budgets.ts`. |
| `system/pause.ts`, `pause.e2e.test.ts` | Deleted. Replaced by per-Run pause in `execution/` (Run `waiting`, reason `operator`). No process-wide pause state. |
| `portfolio/ownership.ts`, `ownership.test.ts`, `workstreams.ts`, `workstreams.e2e.test.ts` | Deleted with no replacement. |
| `timeline/service.ts`, `service.test.ts` | Deleted with no replacement (plan view reads Events). |
| `workspaces/service.ts`, `service.test.ts`, `fs-browse.ts` | Replaced at the same paths (new Workspace type). |
| `workspaces/landings.ts` | Deleted. Replaced by `workspace-state/integration.ts` (Integration Workspace) and `workspace-state/publish.ts` (Publication to the Target). |
| `runtime/worktree-manager.ts`, `worktree-manager.test.ts`, `auto-init.test.ts` | Deleted. Replaced by `workspace-state/worktrees.ts`; git-level mechanics may be extracted where they depend on nothing legacy. |
| `lane-runtime/checkpoint.ts`, `lane-runtime/usage.ts` | Deleted. Checkpoint reconstruction has no replacement. Usage → `runs/usage.ts`. |
| `events/bus.ts`, `bus.test.ts`, `projections.ts`, `runtime.ts`, `artifact-store.ts` | Legacy contents replaced: the Event journal is `persistence/journal.ts` and `events/stream.ts` takes the path; the artifact blob store is `persistence/blob-store.ts` behind `artifacts/` (service); legacy projections and the bus are deleted. |
| `sdk/client.ts`, `types.ts`, `mapping.ts`, `mapping.test.ts`, `env.ts`, `env.test.ts`, `effort.ts`, `fake.ts`, `failure-classifier.ts`, `tool-result.ts` | The `sdk/` path is deleted. Provider-neutral mechanics — SDK resolution, message-stream mapping, usage normalization (uncached / cache-creation / cache-read accounting), failure classification, environment setup, effort mapping, tool-result shaping, the scripted fake, and their tests — may be extracted and rewritten into `server/src/provider/*` under [migration-contract.md](migration-contract.md) rule 7, provided the result depends only on the new domain. Anything in these files that references seats, lanes, generations, rotation, or wake digests is deleted. |
| `sdk/session-store.ts` | Deleted with no replacement (the SessionStore mirror). The optional resumption path keeps an index in `provider_continuations` (written through `persistence/stores/`) pointing at opaque payloads in the adapter-owned store (`provider/continuation-store.ts`), keyed by Attempt; payloads never enter canonical rows. |
| `sdk/native-capability-policy.ts`, `native-capability-policy.test.ts` | Deleted as legacy behaviour (seat-oriented classification). The classification data and the tripwire test over the installed SDK's tool schemas may be extracted into `agents/policy.ts` (role-based capability policy and Tool Policy intersection). |
| `api/server.ts`, `api/errors.ts`, `api/sse.ts`, `api/wire.ts` | Legacy contents replaced at the same paths. |
| `api/routes/agent-profiles.ts`, `agent-sessions.ts`, `compose.ts`, `events.ts`, `fs.ts`, `system.ts`, `tasks.ts`, `user-sessions.ts`, `workspaces.ts` | Legacy contents replaced: `api/routes/` remains the location of the final routes, named for the new resources (section 5). Files named for retired resources are deleted; `events.ts`, `fs.ts`, `system.ts`, `tasks.ts`, `workspaces.ts` are rewritten. |
| `api/routes/continuation.routes.test.ts`, `system.test.ts` | Deleted. |

### 3.7 Scripts and skills

| Path | Disposition |
|---|---|
| `server/scripts/import-legacy.ts` | Deleted with no replacement. |
| `server/scripts/migrate-profile.ts` | Deleted with no replacement. |
| `server/scripts/eval-handoffs.ts` | Deleted with no replacement. |
| `server/scripts/verify-sdk/agents-file-semantics.ts`, `bypass-disallowed.ts`, `tools-semantics.ts` | Deleted with no replacement. |
| `server/skills/skills/orchestration-patterns/`, `handoff-discipline/`, `requirements-mechanics/`, `wrap-up-and-landing/`, `worktree-etiquette/`, `long-build-discipline/`, `probe-method/` | Deleted with no replacement. |
| `server/skills/skills/git-gud-commits/`, `git-gud-conflicts/`, `git-gud-coordinate/`, `git-gud-recover/`, `git-gud-sync/`, `git-gud-worktrees/`, `build-hygiene/`, `wsl2-host/`, `server/skills/.claude-plugin/plugin.json` | Retained as Workspace-facing capability skills; every sentence that uses a retired term (`seat`, `handoff`, `coordinator`, roster language in `git-gud-coordinate` and `git-gud-commits`) is rewritten at cutover. |
| `package.json` scripts `eval:handoffs`, `eval:orchestration`, `eval:orchestration:live`, `eval:orchestration:judge`, `eval:orchestration:compare`; `server/package.json` scripts `eval:*`, `import-legacy` | Deleted. |

### 3.8 Evaluation harness (`server/evals/`) — deleted with no replacement

`handoffs/baseline.json`, `handoffs/cases.json`, `orchestration/README.md`,
`checks.ts`, `checks.test.ts`, `export.test.ts`, `programs.ts`,
`rubric-leak.test.ts`, `scenario.ts`, `structural-runner.ts`,
`structural.eval.test.ts`, `trace.ts`, `trace.test.ts`,
`live/compare.ts`, `live/export-evidence.ts`, `live/export-trace.ts`,
`live/judge.ts`, `live/operator-policy.ts`, `live/run-live.ts`,
`rubrics/*.md` (21 files), `scenarios/*.ts` (21 files),
`fixtures/pinned-node-repo/*`, `fixtures/small-cli/*`,
`results/baseline.json`, `results/.gitignore`.

## 4. Database tables

| Legacy table | Disposition |
|---|---|
| `workspaces` | Replaced by new `workspaces` (fresh schema). |
| `projects` | Deleted. → `conversations`. |
| `user_sessions` | Deleted. → `conversations`, `conversation_messages`, `runs`. |
| `run_summaries` | Deleted. → `gates`, `evaluations`. |
| `agent_sessions` | Deleted. → `plan_nodes`. |
| `agents` | Deleted. → `invocations`. |
| `worktree_landings` | Deleted. → `changesets`, `snapshots`. |
| `pattern_state` | Deleted with no replacement (Pattern state is Plan Node + Invocation status). |
| `messages` | Deleted. → `conversation_messages` (operator ↔ Orchestrator only) and `handoffs`. |
| `interactions` | Deleted. → `decisions`. |
| `decision_issues` | Deleted. → `decisions`. |
| `crons` | Deleted with no replacement. |
| `tasks` | Replaced by new `tasks`. |
| `scheduled_assignments` | Deleted with no replacement. |
| `task_dependencies` | Replaced by new `task_dependencies`. |
| `agent_profile_trust` | Deleted with no replacement. → `agent_definition_revisions` records identity, hash, and provenance; there is no trust table. |
| `minted_profiles` | Deleted with no replacement. |
| `events` | Replaced by new `events`. |
| `requirement_revisions` | Replaced by new `requirement_revisions`. |
| `requirement_nodes` | Deleted. → `requirements`. |
| `requirement_status_changes` | Replaced by new `requirement_status_changes` (no verification tier). |
| `assumptions` | Deleted with no replacement. |
| `requirement_links` | Deleted with no replacement. |
| `requirement_delegations` | Deleted. → `plan_node_requirements` (exact leaf set per Plan Node at a pinned revision). |
| `change_impacts` | Deleted with no replacement. |
| `workstream_links` | Deleted with no replacement. |
| `continuation_checkpoints` | Deleted with no replacement. |
| `orchestration_state_revisions` | Deleted with no replacement. |
| `mailbox_deliveries` | Deleted with no replacement. |
| `event_artifacts` | Deleted. → `artifacts`. |
| `provider_entries` | Deleted. → transcript Artifacts. |
| `usage_samples` | Deleted. → `usage`. |
| `handoff_records` | Deleted. → `handoffs`. |
| `__drizzle_migrations` (legacy journal) | Deleted with the migration files; a fresh journal starts at `0000_orchestration_core`. |

New tables not derived from any legacy table: `schema_info`,
`execution_plan_revisions`, `plan_nodes`, `plan_edges`,
`plan_node_requirements`, `acceptance_criteria`, `agent_definitions`,
`agent_definition_revisions`, `invocations`, `attempts`,
`provider_continuations` (index only; payloads in the adapter store),
`context_manifests`, `evaluations`, `gates`, `snapshots`, `changesets`,
`publications`, `capacity_leases`, `budget_reservations`,
`budget_increases`, `allocation_extensions`. The complete
Phase 1 table list with ownership and cardinality is in
[migration-contract.md](migration-contract.md) §4.

## 5. HTTP routes

| Legacy route | Disposition |
|---|---|
| `GET /api/health`, `GET /api/config`, `GET /api/stats` | Retained in shape; `ConfigResponse` retyped. |
| `GET /api/events` (SSE), `GET /api/artifacts/:id` | Replaced at the same paths with the new event types and Artifact store. |
| `GET/POST /api/system/pause`, `POST /api/system/resume` | Deleted. → `POST /api/runs/:id/pause`, `POST /api/runs/:id/resume` (per Run); `GET /api/system/capacity` (Resource Governor status and leases, read-only). |
| `GET /api/fs/roots`, `GET /api/fs/dirs` | Retained in shape. |
| `GET/POST /api/workspaces`, `GET/PATCH /api/workspaces/:id` | Replaced at the same paths (new Workspace type). |
| `GET /api/workspaces/:id/projects` | Deleted. → `GET /api/workspaces/:id/conversations`. |
| `GET /api/workspaces/:id/session-tree` | Deleted. → `GET /api/workspaces/:id/runs`. |
| `GET /api/workspaces/:id/tasks` | Deleted. → `GET /api/runs/:id/tasks`. |
| `GET /api/workspaces/:id/agent-profiles`, `GET …/:profileId` | Deleted. → `GET /api/workspaces/:id/agent-definitions`, `GET …/:definitionId`, `GET …/:definitionId/revisions`. |
| `POST /api/workspaces/:id/agent-profiles/:profileId/trust` | Deleted with no replacement. |
| `GET/POST /api/user-sessions`, `GET/PATCH /api/user-sessions/:id` | Deleted. → `GET/POST /api/conversations`, `GET/PATCH /api/conversations/:id`; `POST /api/conversations/:id/runs`. |
| `POST /api/user-sessions/:id/continue` | Deleted. → `POST /api/conversations/:id/runs`. |
| `POST /api/user-sessions/:id/messages` | Deleted. → `POST /api/conversations/:id/messages`. |
| `POST /api/user-sessions/:id/interactions/:interactionId` | Deleted. → `POST /api/decisions/:id/answer`. |
| `GET /api/user-sessions/:id/decision-issues` | Deleted. → `GET /api/conversations/:id/decisions`. |
| `POST /api/user-sessions/:id/signoff` | Deleted. → `POST /api/runs/:id/gates/operator-signoff` (a `signoff` Decision). Publishing is separate: `POST /api/runs/:id/publications` (a `publish` Decision), `GET /api/runs/:id/publications`. |
| `GET /api/user-sessions/:id/run-summaries/:summaryId` | Deleted. → `GET /api/runs/:id/gates`. |
| `GET /api/user-sessions/:id/transcript` | Deleted. → `GET /api/conversations/:id/messages`. |
| `GET /api/user-sessions/:id/agent-sessions` | Deleted. → `GET /api/runs/:id/plan`. |
| `GET /api/user-sessions/:id/tasks` | Deleted. → `GET /api/runs/:id/tasks`. |
| `GET /api/user-sessions/:id/requirements`, `POST …/requirements/:requirementId/status` | Deleted. → `GET /api/conversations/:id/requirements`, `POST /api/requirements/:id/status`. |
| `POST /api/user-sessions/:id/assumptions/:assumptionId/resolve` | Deleted with no replacement. |
| `GET /api/user-sessions/:id/orchestration` | Deleted with no replacement. |
| `GET /api/user-sessions/:id/timeline` | Deleted. → `GET /api/runs/:id/plan` + events. |
| `POST /api/user-sessions/:id/interrupt` | Deleted. → `POST /api/runs/:id/cancel`. |
| `POST /api/user-sessions/:id/resume-capacity` | Deleted. → `POST /api/runs/:id/resume`. |
| `GET /api/agent-sessions/:id`, `GET …/:id/transcript`, `GET …/:id/activity` | Deleted. → `GET /api/plan-nodes/:id`, `GET /api/invocations/:id`, `GET /api/attempts/:id/transcript`. |
| `POST /api/agent-sessions/:id/agents/:agent/interrupt` | Deleted. → Operator control is Run-level (execution-model §3): `POST /api/runs/:id/pause` with mode `hard` interrupts executing Attempts, `POST /api/runs/:id/cancel` ends the Run; a Plan Node is removed only by the Orchestrator's plan revision (§4). No per-node operator route exists. |
| `POST /api/scheduled-assignments/:id/cancel` | Deleted with no replacement. |
| `GET /api/handoffs/:id` | Deleted. → `GET /api/handoffs/:id` (new shape; no paging). |
| `POST /api/compose/improve` | Deleted with no replacement. |

## 6. Console tools exposed to agents

Legacy tools are registered in `server/src/orchestrator/tools.ts` (the main
lane) and `server/src/agent-sessions/agent-tools.ts` (every seat). All are
deleted. The replacement tool table is in
[execution-model.md](execution-model.md) §6.4.

| Legacy tool | Disposition |
|---|---|
| `propose_requirements`, `read_requirements`, `report_requirement`, `decompose_requirement` | → `propose_requirements`, `read_requirements`; status changes come through `update_task` Evidence and Gates. `decompose_requirement` deleted (new revision instead). |
| `link_requirements`, `unlink_requirements`, `record_assumption`, `resolve_assumption`, `reconcile_change_impact` | Deleted with no replacement. |
| `create_agent_session`, `add_agent`, `close_agent_session`, `list_agent_sessions`, `read_agent_session`, `session_activity`, `send_to_coordinator`, `interrupt_agent`, `create_child_session`, `abandon_child_session`, `dispatch_work_items` | → `revise_execution_plan` (Orchestrator only; proposes a source revision that the runtime validates and the compiler materializes — the Orchestrator never writes Plan Nodes or Plan Edges), `read_execution_plan`, `read_tasks`; cancellation is an operator/API action. Child sessions and runtime-minted mappers have no replacement. |
| `list_agent_profiles`, `specialize_profile` | → `read_agent_definitions`; minting deleted. |
| `send_handoff`, `forward_message`, `read_handoff`, `report_handoff_discrepancy`, `write_note`, `roster_status` | → `return_result`, `write_artifact`, `read_artifact`. |
| `ask_operator` (blocking / deferred with auto-proceed), `list_decisions`, `list_decision_issues`, `resolve_decision_issue`, `merge_decision_issues` | → `request_decision` with an explicit resolution policy (`operator_required`, or `use_default_after_deadline` for `operator_choice` only, with recorded default, deadline or condition, rationale, affected ids); `record_decision` (kind `orchestrator_choice` only — it cannot create or resolve a `requirement_waiver`); `read_decisions`. |
| `task_list`, `task_create`, `task_update`, `assignment_cancel` | → `read_tasks`, `create_tasks` (Orchestrator), `propose_tasks` (Coordinator; validated, Budget-reserved, and persisted by the runtime), `update_task`. |
| `update_orchestration_state`, `assess_objective_progress`, `record_completion`, `read_continuation` | → `request_completion`; the rest deleted with no replacement. |
| `set_deadline` | Deleted with no replacement. |
| `link_workstreams`, `unlink_workstreams` | Deleted with no replacement. |
| `read_artifact` | → `read_artifact` (new shape). |

## 7. Prompts

| Legacy prompt | Disposition |
|---|---|
| `ORCHESTRATOR_BRIEF`, `ORCHESTRATOR_DELEGATION_BRIEF`, `PLAN_MODE_BODY` (`orchestrator/prompt.ts`) | Deleted. → the `orchestrator` built-in Agent Definition's instructions, written against the new tool table. Plan mode deleted. |
| `PROTOCOL_INTRO`, `OPERATOR_PATH_BULLETS`, `TERMINAL_REPORT_BULLET`, `SESSION_PROTOCOL`, hub work bullet (`agent-sessions/presets.ts`) | Deleted. → the fixed Context Manifest rendering in `invocations/manifest.ts`. |
| Per-role `promptPack` text in `patterns/catalog.ts` (hub, pipeline, evaluator_optimizer, map_reduce, debate, peer_to_peer, plan_execute) | Deleted. Pattern position is one line in the manifest. |
| Capability brief, roster lines, messaging brief, decision delta, requirements pointer (`agent-sessions/composer.ts`) | Deleted. → manifest rendering. |
| Built-in profile instructions in `agent-profiles/registry.ts` | Deleted. → `agents/builtins.ts`. |
| Console-synthesized handoff prose (restart digest in `boot.ts`, budget notices, closeout notices, recovery checkpoints) | Deleted. Failures and restarts are Events and Handoff status values. |
| Doctrine skills (section 3.7) | Deleted. |
| Eval rubrics (section 3.8) | Deleted. |

## 8. Web (`web/src/`)

| Path | Disposition |
|---|---|
| `main.tsx`, `app/app.tsx`, `app/shell.tsx`, `app/providers.tsx`, `app/topbar.tsx`, `app/theme-toggle.tsx` | Rewritten against the new routes: `/conversations`, `/runs`, `/agents`. |
| `app/conversation-region.tsx`, `inspector-region.tsx`, `session-details.tsx`, `sidebar-region.tsx`, `strip-region.tsx`, `system-pause.tsx`, `*.test.tsx` | Deleted. → `conversation/`, `run/`, `plan/`. |
| `api/client.ts`, `keys.ts`, `mutations.ts`, `queries.ts` | Rewritten against `core/src/api.ts`. |
| `live/boot.ts`, `event-router.ts`, `spine.ts`, `stream-kit.ts`, `watched.ts`, `attention.tsx`, `*.test.ts` | Rewritten as one event subscription in `live/`; `attention.tsx` deleted with no replacement. |
| `session/*` (composer, draft-view, model-picker, orchestration-panel, plan-card, project-status, question-card, requirements-panel, run-summary-card, session-header, user-fold, user-groups, user-parts, user-stream, user-transcript, tests) | Deleted. → `conversation/` (message list, composer), `requirements/`, `decisions/`, `run/` (Run header, Gate view). |
| `agents/*` (accents, active-session, agent-card, agent-fold, agent-groups, agent-pane, agent-parts, agent-stream, agent-strip, agent-transcript, flow-stem, tests) | Deleted. → `plan/` (plan graph, Plan Node inspector, Invocation and Attempt views) and `agents/` (Agent Definition list). |
| `sidebar/session-tree.tsx`, `sidebar/sidebar.tsx` | Deleted. → `conversation/list.tsx`, `run/list.tsx`. |
| `views/sessions-view.tsx`, `agents-view.tsx`, `tasks-view.tsx`, `timelines-view.tsx` | Deleted. → `conversation/view.tsx`, `run/view.tsx`, `agents/view.tsx`. |
| `tasks/task-ledger.tsx` | Deleted. → `tasks/ledger.tsx` (new). |
| `stores/agent-session-streams.ts`, `user-session-streams.ts`, `flow.ts`, `flow.test.ts`, `panels.ts`, `runtime.ts`, `scope.ts`, `ui.ts` | Deleted. → new stores per view. `stores/connection.ts`, `stores/theme.ts` retained. |
| `lib/session-state.ts`, `session-state.test.ts`, `lib/status.ts`, `lib/tool-text.ts` | Deleted. `lib/utils.ts` retained. |
| `components/handoff-card.tsx`, `components/working-line.tsx`, `working-line.test.tsx` | Deleted. |
| `components/ai-elements/*` | Retained as presentational primitives; any legacy-term prop or label is renamed. |
| `components/ui/*` | Retained. |
| `workspaces/*` (directory-picker, path, workspace-gate, workspace-selector, workspace-wizard, tests) | Retained in shape, retyped. |
| `styles/globals.css`, `tests/setup.ts`, `index.html`, `vite.config.ts`, `vitest.config.ts` | Retained. |

## 9. Configuration variables (`server/src/config.ts`)

| Variable | Disposition |
|---|---|
| `CONSOLE_DATA_DIR`, `CONSOLE_PORT`, `CONSOLE_HOST`, `CONSOLE_FS_ROOTS`, `CONSOLE_SKILLS_DIR`, `CONSOLE_MODEL`, `CONSOLE_EFFORT`, `CONSOLE_AUTO_INIT_GIT`, `CONSOLE_MCP_DISABLED`, `CONSOLE_BROWSER_MCP`, `CONSOLE_MCP_TOOL_TIMEOUT_MS` | Retained. |
| `CONSOLE_IMPROVE_MODEL` | Deleted with no replacement. |
| `CONSOLE_AGENT_CONTEXT_RETIRE_TOKENS`, `CONSOLE_AGENT_IDLE_REAP_MS`, `CONSOLE_AGENT_SPAWN_TIMEOUT_MS`, `CONSOLE_MAX_RESIDENT_AGENTS`, `CONSOLE_MAX_RESIDENT_AGENTS_PER_SESSION`, `CONSOLE_PEER_NAME_PREFIX` | Deleted. → Resource Governor limits `CONSOLE_PROVIDER_MAX_CONCURRENCY`, `CONSOLE_PROCESS_MAX_ATTEMPTS`, `CONSOLE_PROVIDER_QUOTA_*`; Run Budget concurrency; Attempt start timeout `CONSOLE_ATTEMPT_START_TIMEOUT_MS`; context policy on the Agent Definition revision. |
| `CONSOLE_AGENT_WORKTREES` | → `CONSOLE_WORKTREES` (0 disables isolation for non-git Workspaces only). |
| `CONSOLE_TOOL_ALARM_MS`, `CONSOLE_TURN_QUIET_ALARM_MS`, `CONSOLE_WATCHDOG_IDENTICAL_CALLS`, `CONSOLE_WATCHDOG_ERROR_STREAK`, `CONSOLE_MAX_REDELIVERY_ATTEMPTS`, `CONSOLE_GOVERNANCE_SWEEP_MS`, `CONSOLE_OPERATOR_ASK_DETACH_MS`, `CONSOLE_DEFERRED_AUTO_PROCEED_MS`, `CONSOLE_BLOCKING_ASK_ESCALATE_MS`, `CONSOLE_COMPLETION_QUIET_MS`, `CONSOLE_PATTERN_HANDOFF_CAP`, `CONSOLE_PATTERN_STALL_MS`, `CONSOLE_CHILD_SESSIONS`, `CONSOLE_MAX_CHILD_SESSIONS`, `CONSOLE_MAX_SESSION_DEPTH`, `CONSOLE_COMPLETION_POLICY` | Deleted. → Budget fields (`maxAttempts`, `maxWallClockMs`, `maxConcurrency`, `maxRounds`) with defaults `CONSOLE_DEFAULT_*`. |
| Retired-name boot checks for `CONSOLE_CONTEXT_ROTATION`, `CONSOLE_CONTEXT_TOKEN_LIMIT`, `CONSOLE_CONTEXT_TURN_LIMIT`, `CONSOLE_CHECKPOINT_TIMEOUT_MS`, `CONSOLE_MAX_RESIDENT_SEATS*`, `CONSOLE_SEAT_*`, `CONSOLE_MAX_RESIDENT_AGENTS_PER_TREE` | Deleted. The new config ignores unknown `CONSOLE_*` names; it does not name legacy replacements. |

## 10. Documents

| Path | Disposition |
|---|---|
| `README.md` | Rewritten at cutover against the new architecture; until then it carries a pointer to `docs/architecture/`. |
| `docs/orchestration.md` | Deleted. → `docs/architecture/execution-model.md`. |
| `docs/agent-handoffs.md` | Deleted. → `docs/architecture/execution-model.md` §6 and the Handoff entry in the glossary. |
| `docs/requirements.md` | Deleted. → the Requirement, Acceptance Criterion, Evaluation, and Gate entries plus `execution-model.md` §8 and §10. |
| `docs/agent-stack-simplification-plan.md` | Deleted with no replacement (completed plan for the legacy stack). |
| `agentic-software-factory-operating-model-merged.md` | Deleted with no replacement (background essay; not a specification). |
| `docs/README.md` | Created in this phase as the documentation index; retained. |

## 11. Tests

All 130 legacy test files are deleted with their subjects: 103 under
`server/src/`, 5 under `server/evals/`, 22 under `web/src/`. The new
suites are written against the new modules per
[migration-contract.md](migration-contract.md) §8. The one permitted
exception is provider mechanics: tests under `server/src/sdk/`
(`mapping.test.ts`, `env.test.ts`, the policy tripwire) may be extracted
and rewritten into `server/src/provider/` and `server/src/agents/` where
the subject under test survives extraction and the test depends on nothing
legacy. The legacy `server/vitest.config.ts` exclusion of
`evals/orchestration/fixtures/**` is removed with the harness.

## 12. Retained without change

`package.json` (minus the deleted scripts, plus the `core` workspace),
`package-lock.json`, `tsconfig.base.json`, `server/tsconfig.json`,
`web/tsconfig.json`, `scripts/dev.mjs`, `server/drizzle.config.ts`
(retained as a tool; it points at `server/src/persistence/schema.ts` and
`server/src/persistence/migrations` from Phase 1 and is the only Drizzle
configuration), `.gitignore`, `web/index.html`, `web/vite.config.ts`,
`web/vitest.config.ts`, `web/tests/setup.ts`, `web/src/styles/globals.css`,
`web/src/components/ui/*`, `web/src/lib/utils.ts`,
`web/src/stores/connection.ts`, `web/src/stores/theme.ts`, the
`git-gud-*`, `build-hygiene`, and `wsl2-host` skills (text edited for
terminology only).
