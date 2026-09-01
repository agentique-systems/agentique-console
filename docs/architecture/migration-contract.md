# Migration contract

This document states the terms under which the orchestration architecture
defined in [glossary.md](glossary.md) and
[execution-model.md](execution-model.md) replaces the current
implementation. It is a contract: every rule here is binding on every
commit on the `rewrite/orchestration-core` branch and on the cutover merge.
The inventory of what is removed is in
[legacy-removal.md](legacy-removal.md). Delivery against this contract —
the original phases 0–10, what each has shipped, the evidence, and what
remains — is tracked in [implementation-roadmap.md](../implementation-roadmap.md);
that ledger records progress and never defines semantics.

## 1. Statement

This is a full replacement of the Agentique Console orchestration
implementation. There is:

- **no data migration** — nothing in an existing database is read,
  converted, imported, or interpreted;
- **no compatibility period** — no release runs both implementations, and
  no release accepts both old and new inputs;
- **no legacy API** — no old route, event type, wire type, or tool name is
  served, aliased, or redirected;
- **no alternate runtime** — there is one scheduler, one plan model, one
  invocation path, and one store;
- **no feature flag** — no environment variable, setting, header, or
  parameter selects old or new behaviour.

After cutover the repository contains one architecture and one code path.
Git history is the only rollback mechanism: reverting to the last commit
before the cutover merge restores the previous implementation in full, and
nothing else does.

## 2. Scope

Replaced in full:

- the domain model (`shared/src/*`) — replaced by the permanent,
  provider-neutral package `@agentique-console/core` (`core/`)
- the persistence schema and every migration (`server/src/db/*`) —
  replaced by the permanent server persistence boundary
  `server/src/persistence/`
- the server runtime, services, tools, prompts, and HTTP API
  (`server/src/*`)
- the web application's domain views, stores, and API client (`web/src/*`
  except the presentational primitives listed as retained in
  [legacy-removal.md](legacy-removal.md))
- the evaluation harness (`server/evals/*`) — deleted with no replacement
- the console skills plugin's orchestration doctrine skills
  (`server/skills/skills/*`) — replaced or deleted per the inventory
- the top-level `README.md` and the documents under `docs/` other than
  `docs/architecture/`

Not in scope: the build toolchain (`package.json` workspaces, TypeScript,
Vite, Vitest, Tailwind, `server/drizzle.config.ts`), the dev script, and
the presentational UI primitives. These are retained because they contain
no orchestration semantics; they may be modified but are not part of the
replacement. In particular `server/drizzle.config.ts` is retained as a
tool, not byte-for-byte: it points at the final persistence schema and
migration directory from Phase 1 onward, and there is only ever one
Drizzle configuration file.

### Final module boundaries

The replacement is built inside two permanent boundaries that exist from
Phase 1 and remain after cutover:

- **`core/` — `@agentique-console/core`.** The provider-neutral domain
  package: final domain types, identifier types and generation, state sets
  and transition validation, runtime schemas and validators, Execution Plan
  source types, Pattern and join types, Requirement and Decision types,
  Task, Artifact, Handoff, Agent Definition, Tool Policy, Invocation,
  Attempt, Budget, Usage, Event contracts, persistence-facing value types,
  and eventually the final API contracts. It depends on no other workspace
  package and on no Node-only module (a portable validation or
  cryptographic primitive is the only permitted exception). The final
  server and the final web application both import it. It replaces
  `shared/` completely at cutover.
- **`server/src/persistence/` — the server persistence boundary.** The
  final SQLite schema (`schema.ts`), database client (`client.ts`),
  database-open guard (`database.ts`), transaction helpers
  (`transactions.ts`), baseline migration
  (`migrations/0000_orchestration_core.sql`), stores (`stores/`), the
  content-addressed Artifact blob store (`blob-store.ts`), and
  provider-continuation pointer persistence. It imports only
  `@agentique-console/core`, infrastructure-neutral database libraries,
  and final neutral server utilities that are not scheduled for deletion.
  It replaces `server/src/db/` completely at cutover.

- **`server/src/execution/` — the execution boundary.** The final
  provider-neutral runtime: the deterministic plan compiler and its
  source-path grammar (`compiler/`), the plan-revision service
  (authorization, validation, compilation, reconciliation, atomic
  application or structured rejection), the Run creation service (atomic
  Run bootstrap), the Context Manifest assembler and deterministic
  renderer (`manifest/`), the Invocation preparation service, the result
  validator, the retry and continuation policies, the resource governor,
  the Attempt executor, restart recovery, the Run start service, the pure
  readiness evaluator with its condition-fact projection, the Handoff
  router, the Changeset integration service, the `single`, `chain`,
  `route`, `parallel`, `coordinator_worker`, and `evaluator_optimizer`
  Pattern runners with the root-node support, the deterministic join
  settler, the pure Task projection, the runtime-tool call executor with
  the Task proposal service, the deterministic Acceptance Criterion check
  service, the bounded scheduler, the Gates, the completion engine, the
  signoff service, and the operator Run-control service (cancel, pause,
  resume) with its shared cancellation convergence. It
  imports only `@agentique-console/core`, the persistence boundary, `zod`,
  the provider-neutral adapter contract under `server/src/provider/`, and
  the narrow capability ports it declares under `ports/`
  (`RunWorkspacePreparationPort`, `ExecutionWorkspacePort`,
  `IntegrationWorkspacePort`, `AcceptanceCriterionExecutionPort`,
  `RunFinalizationWorkspacePort`, and `PublicationWorkspacePort`,
  implemented by the Workspace provider in the Workspace phase). Nothing legacy
  imports it and it imports nothing legacy; the persistence boundary and
  the provider boundary never depend on it.

- **`server/src/provider/` — the provider boundary.** The
  provider-neutral adapter contract (one Attempt execution request in,
  one typed outcome out), the scripted fake provider used by the default
  suite, the continuation service with its memory- and file-backed
  payload stores, and, in a later subphase, the provider-specific
  adapters extracted from `server/src/sdk/` under rule 7. It imports only
  `@agentique-console/core`, Node built-ins, and the continuation index
  store; it never imports another store or the execution boundary, and
  an adapter never makes a Run, Plan, Pattern, Invocation, Task,
  Requirement, Decision, Budget, or retry decision. The import-boundary
  test enforces both.

None of these boundaries is staging, `v2`, `next`, `new`, or compatibility
code; each is the final production location of what it contains.

## 3. Binding rules

1. **One architecture, one code path.** At cutover, every request, event,
   invocation, and store goes through the new implementation. No file that
   implements the legacy model survives.
2. **No backward compatibility.** New code does not accept, detect, or
   tolerate legacy inputs: legacy wire shapes, legacy event types, legacy
   database contents, legacy environment variables, legacy agent file
   fields. A legacy input is an error with a message naming the
   replacement, or it is ignored as unknown; it is never honoured.
3. **No adapters between old and new domain models.** There is no function,
   type, or module whose purpose is to convert a legacy object into a new
   one or vice versa.
4. **No shims, aliases, dual writes, fallback reads, compatibility exports,
   runtime flags, or legacy routes.** Specifically:
   - no re-export of a new symbol under a legacy name;
   - no writing the same fact to a legacy table and a new table;
   - no reading a new table and, on miss, a legacy table;
   - no `export { NewName as OldName }`;
   - no `if (config.legacyMode)`, `CONSOLE_USE_*`, `X-Console-Compat`, or
     any equivalent;
   - no `/api/user-sessions`, `/api/agent-sessions`, or any other legacy
     path, and no redirect from one.
5. **No `v2` names.** No module, directory, type, table, route, event,
   tool, or prompt carries `v2`, `new`, `next`, `legacy`, `old`, `compat`,
   or a similar qualifier. New code uses its final name from its first
   commit. "Final name" means the module's permanent production location;
   it does not require overwriting a legacy file when a different,
   permanent architectural boundary is the more correct home. The domain
   lives in `core/` and persistence in `server/src/persistence/` precisely
   because those are the correct final boundaries, not because the legacy
   paths were occupied. When a final name does collide with a legacy file
   or directory (for example `server/src/events/`, `server/src/api/`), the
   legacy file is deleted and the new one takes the path in the same
   change; nothing is renamed to make room, and no temporary package is
   later renamed into place.
6. **Old database contents are unsupported.** See section 4.
7. **New code never depends on legacy runtime code.** No file created for
   the new architecture imports a legacy `AgentSession`, lane, seat,
   generation, attention, mailbox, continuation, or checkpoint type, or any
   module listed for deletion in [legacy-removal.md](legacy-removal.md).
   This is checked by an import test on the branch and holds for every
   intermediate commit; the same test confines `server/src/execution/` to
   `@agentique-console/core`, `server/src/persistence/`, and its own ports.
   Utilities that the new code needs are written under their final names;
   the legacy utility is deleted when its last legacy importer is deleted.

   **Provider implementation reuse is permitted under this rule.** The
   legacy `server/src/sdk/` directory remains scheduled for deletion, but
   provider-neutral algorithms, protocol handling, message mapping, usage
   normalization, failure classification, environment setup, the scripted
   fake, and their tests may be extracted, rewritten, or moved into the
   final `server/src/provider/` architecture. Source-level reuse is allowed
   exactly when the resulting code depends exclusively on the new domain
   (`@agentique-console/core` and `server/src/provider/*`) and on nothing
   scheduled for deletion. No compatibility adapter between the new
   runtime and the legacy SDK runtime may exist in either direction. A
   full migration removes legacy architecture; it does not require
   reimplementing correct low-level provider mechanics.
8. **Temporary coexistence is construction only.** While the new runtime is
   built, legacy modules remain in the tree so that the legacy application
   keeps building, starting, and passing its tests. `shared/` and
   `server/src/db/` are not touched during construction. Coexistence is
   permitted only because the old and new modules are independent: new
   modules never import from, export to, re-export, or call their legacy
   counterparts, legacy code never imports `core/` or
   `server/src/persistence/`, no runtime path selects between them, no
   production request reaches the new code before cutover, and the legacy
   application never writes the new schema (it opens its own database
   through its own client). Legacy code may not be extended, fixed, or made
   to call new code. At cutover, every file in the legacy-removal inventory
   is deleted in one commit series and the legacy test suites go with them.
9. **No benchmark harness.** The new implementation ships correctness and
   integration tests. It does not ship an orchestration-quality evaluation
   suite, rubrics, judges, live scenario runners, or baseline files.
10. **Terminology is enforced.** The retired terms in
    [glossary.md](glossary.md) do not appear in new code identifiers,
    schema, routes, events, prompts, tests, or UI text. A grep-based test
    on the new source directories enforces this.
11. **Directory paths are not legacy; their contents are.** A conventional
    path the legacy code occupied (`server/src/events/`, `server/src/tasks/`,
    `server/src/api/routes/`, `server/src/workspaces/`,
    `server/src/handoffs/`, `server/src/capacity/`, and similar) may be
    reused for final modules when everything under it conforms to the new
    architecture and depends on nothing scheduled for deletion. The removal
    inventory targets legacy files, symbols, schemas, dependencies, and
    behaviour, never a directory name as such. Paths whose names are
    themselves retired terms (`agent-sessions/`, `agent-profiles/`,
    `sessions/`, `lane-runtime/`, `continuation/`) are deleted. `shared/`
    and `server/src/db/` are not reused: their replacements are the
    permanent boundaries `core/` and `server/src/persistence/` (§2), and
    both legacy paths are deleted whole at cutover.

## 4. Database

- The new application starts with a fresh schema. The schema has one
  baseline migration
  (`server/src/persistence/migrations/0000_orchestration_core.sql`)
  generated from `server/src/persistence/schema.ts` by
  `server/drizzle.config.ts`, with the `schema_info` insert and the
  append-only guard triggers appended to the generated DDL. Every legacy
  migration file and the legacy migration journal under `server/src/db/`
  are deleted at cutover; no new legacy migration is ever generated.
- The schema includes a `schema_info` table with a single row:
  `application = 'agentique-console'`, `schema = 'orchestration-core'`,
  `version = <integer>`. The baseline migration writes this row.
- On open (`server/src/persistence/database.ts`), before running
  migrations, the server inspects the database file:
  - a file that does not exist, or has no user tables, is initialised;
  - a file whose `schema_info` row matches is opened and migrated forward;
  - any other file — including one with the legacy `user_sessions`,
    `agent_sessions`, or `__drizzle_migrations` tables and no
    `schema_info` row — is refused. The server exits with a non-zero code
    and the message:

    ```
    reset-required: <path> was created by a previous, unsupported schema.
    Delete the file or point CONSOLE_DATA_DIR at an empty directory.
    ```

- The server never reads, converts, backs up, renames, or deletes an old
  database on its own. The operator resets it. The presence of a
  `__drizzle_migrations` journal is never taken as proof of compatibility;
  only the `schema_info` row is.
- During construction the legacy application keeps opening its own
  database through `server/src/db/client.ts` and its already-generated
  legacy migrations; the new schema is written only by
  `server/src/persistence/` and only in the new runtime's tests until
  cutover. The two never share a database file.
- A database file and its Artifact blob store are opened and written by
  exactly one runtime process at a time, which runs restart recovery —
  including the blob store's pending-area reconciliation — before it
  admits work. Transactional compensation and startup reconciliation for
  blobs ([execution-model.md](execution-model.md) §2.1) rely on that
  single owner and are not multi-process safe; no lock service
  establishes the owner. The blob store's pending area holds markers and
  protocol temporary files only — no Artifact content, path, credential,
  or provider input — and no table or migration accompanies it.
- The legacy import and profile migration scripts
  (`server/scripts/import-legacy.ts`, `server/scripts/migrate-profile.ts`)
  are deleted with no replacement. Provider JSONL transcripts are not
  imported; they have no canonical role in the new model.
- Table names are the final names listed in [glossary.md](glossary.md).
  None of them coincides with a legacy table name except `workspaces`,
  `tasks`, `task_dependencies`, and `events`; these are new tables with new
  columns, created only in a fresh database, and the reset rule above
  guarantees a legacy table of the same name is never encountered.
- `provider_continuations` is an index, not a payload store: one row per
  Attempt with provider, storage key, digest, creation time, and optional
  expiry. The opaque payload lives in a replaceable store owned by the
  provider adapter (interface `ContinuationPayloadStore` in
  `server/src/provider/continuation-store.ts`) and is never
  embedded in a canonical row, Artifact, Context Manifest, Event, log, or
  API response. The index is never read to decide anything except whether
  a `resumed` Attempt is possible, and both index and payloads may be
  truncated at any time.
- `budget_reservations` is the only allocation record. Reservations are
  never inferred from limits and Usage. `budget_increases` is the only
  record of growth of a Run's effective Budget and `allocation_extensions`
  the only record of growth of a Plan Node's effective allocation; both are
  append-only, both are re-checked by triggers at insertion, and the Run's
  base Budget, base final reserve, and every reservation's own amounts are
  never rewritten — effective limits are derived on read from these rows
  and no aggregate limit is stored.
- `plan_node_requirements` is the only record of a Plan Node's Requirement
  scope; it is written by the compiler and never updated.
- `plan_revision_nodes` is the only record of which Plan Nodes belong to an
  accepted Execution Plan revision, and `plan_edges` rows belong to exactly
  one revision; the current executable graph is read from the latest
  accepted revision's rows and never inferred.
- The Run's final reserve is persisted on `runs` at creation and never
  updated; there is no runtime default read back into an existing Run. Only
  an Invocation whose row names `allocationSource: run_final_reserve` and a
  permitted `finalReserveUse` can hold a `Run → Invocation` reservation
  from it; the persistence API has no parameter that selects final
  capacity.
- An Agent Definition revision's provenance targets (Snapshot, Conversation,
  approving Decision) are verified when the revision is appended, and the
  execution boundary refuses to execute a revision whose provenance belongs
  to another Workspace or Conversation.

### Phase 1 schema expectations

The baseline creates exactly these 40 tables, with the ownership and
cardinality stated here and in [glossary.md](glossary.md). Column design
beyond identifiers, keys, and the fields the architecture names is
implementation work; the baseline is regenerated in place whenever the
architecture corrects it before cutover, because nothing has shipped.

| Table | Owner (writer) | Cardinality and immutability |
|---|---|---|
| `schema_info` | baseline migration | one row |
| `workspaces` | operator via API | mutable |
| `conversations` | runtime | one per operator thread; mutable title/policy |
| `conversation_messages` | runtime | append-only per Conversation |
| `runs` | runtime (Run creation service) | one per Run; state, wait reason, the operator's pause mode (`operator_pause`: `soft` or `hard`, held only by a `waiting`, `verifying`, or `awaiting_signoff` Run; a Run waits on `operator` exactly when it is paused — both database-enforced), Target, base/integration/final Snapshot ids, final Changeset id (both final references exactly when `completed`, immutable afterwards), Run Budget limits, persisted final reserve (immutable) |
| `execution_plan_revisions` | runtime (plan-revision service; revision 1 by Run creation) | append-only per Run; accepted revisions only, numbered consecutively |
| `plan_nodes` | plan-revision service (compiler); root by Run creation | one per compiled node; `kind`, `pattern`, immutable `shape`, creating revision, status, allocation; definition immutable from insertion |
| `plan_revision_nodes` | plan-revision service; revision 1 by Run creation | immutable ordered membership, one row per (Run, revision, Plan Node); root first in every revision |
| `plan_edges` | plan-revision service (compiler) | append-only; every edge owned by exactly one accepted revision; typed |
| `plan_node_requirements` | plan-revision service (compiler) | one row per (Plan Node, Requirement, pinned Requirement revision) with position; never updated |
| `requirements` | runtime | one per Requirement id (stable across revisions); current status |
| `requirement_revisions` | runtime (operator approval) | append-only per Conversation |
| `requirement_status_changes` | runtime | append-only journal with Evidence |
| `acceptance_criteria` | runtime (Orchestrator authoring) | attached to a Requirement or Task; revisioned with the Requirement |
| `decisions` | runtime | one per Decision; kind, policy, request and resolution fields, the typed `side_effect_approval` subject; append-only with supersession by id |
| `tasks` | runtime | one per Task; the seven states; `replacesTaskId` (unique: a Task is replaced at most once) |
| `task_dependencies` | runtime | edges between Tasks of one Run |
| `artifacts` | runtime | immutable metadata; blob store separate |
| `handoffs` | runtime | immutable routing rows |
| `agent_definitions` | runtime | one per logical id |
| `agent_definition_revisions` | runtime | immutable; one per content hash under a logical id |
| `invocations` | runtime | one per logical execution; role, purpose, `continuedFromInvocationId`, allocation source and final-reserve use (immutable), status with `blockedByDecisionId`, the Workspace cleanup obligation; manifest immutable |
| `attempts` | runtime | one per provider execution; `kind`, `startMode`, `resumedFromAttemptId` |
| `approved_tool_call_uses` | runtime (tool-call authorization) | append-only; one per claimed `approve_once` Decision (unique), naming tool, digest, Run, Plan Node, successor Invocation, claiming Attempt; every ownership fact re-checked at insertion |
| `runtime_tool_calls` | runtime (runtime-tool executor) | append-only (triggers refuse update and delete); one per accepted mutating runtime-tool call, unique per (Invocation, tool, digest), at most one accepted `propose_tasks` per Invocation, and at most one accepted blocking `request_decision` per Invocation (the logical turn it ends); safe result only, never the raw input |
| `provider_continuations` | provider adapter | index keyed by Attempt; truncatable |
| `context_manifests` | runtime | exactly one per Invocation; immutable |
| `evaluations` | runtime / Evaluator via runtime | append-only |
| `gates` | runtime | one per Gate instance with outcome |
| `snapshots` | runtime (Workspace provider) | immutable |
| `changesets` | runtime (Workspace provider; the signoff service for the `final` kind) | immutable metadata + diff Artifact; kind `invocation` (integration lifecycle) or `final` (one per Run, `recorded`, only at signoff acceptance, never changed) |
| `signoff_resolutions` | runtime (signoff service, from the operator) | append-only; exactly one per `operator_signoff` Gate and per `signoff` Decision; identity and outcome immutable; the follow-up Invocation linked once |
| `publications` | runtime (publication service) | recoverable lifecycle rows: one per resolved `publish` Decision, at most one nonterminal and one succeeded per Run, only for a `completed` Run applying its final Changeset; prepared facts recorded once; terminal rows immutable except the staging-cleanup obligation |
| `capacity_leases` | resource governor | one per granted lease; grant and release times |
| `budget_reservations` | runtime | one per allocation; capacity source and final-reserve use derive from the creating operation; `active` → `released` once; reserved amounts immutable |
| `budget_increases` | runtime (Budget Increase service, from the operator's `approve`) | append-only; exactly one per approved `budget_increase` Decision (unique), agreeing with the Decision's Run, partition, and quantities; non-negative, not all zero; never updated or deleted |
| `allocation_extensions` | runtime (Plan Node capacity operation) | append-only; one per deterministic extension of a nonterminal `pattern` node's active ordinary `Run → Plan Node` reservation, created with the work it funds; non-negative, not all zero; never updated or deleted |
| `usage` | runtime | append-only per Attempt |
| `events` | runtime | append-only, global sequence |

## 5. API

- All routes live under `/api/` with the final resource names:
  `workspaces`, `conversations`, `runs`, `plan-nodes`, `invocations`,
  `attempts`, `requirements`, `acceptance-criteria`, `decisions`, `tasks`,
  `artifacts`, `handoffs`, `agent-definitions`, `evaluations`, `gates`,
  `snapshots`, `changesets`, `publications`, `usage`, `events`, `system`
  (health, config, resource-governor status), `fs`. The exact route table
  is defined with the implementation in `core/src/api.ts` and is the only
  route table.
- Legacy paths return the standard 404 body. There is no redirect, no
  deprecation header, and no message naming the new path.
- The event stream (`GET /api/events`) carries only the new event types.

## 6. Agent Definitions

- An Agent Definition is an immutable, versioned configuration with a
  stable logical identity, a revision identity, a content hash, provenance,
  a model policy, instructions, capabilities, a Tool Policy, and default
  limits ([execution-model.md](execution-model.md) §11). Changing a
  definition creates a new immutable revision; nothing is edited in place.
- Definitions are read from the Workspace's native `.claude/agents/*.md`
  files (provenance `workspace_file`, pinned to the Snapshot they were read
  at) and from the console's built-in set (provenance `builtin`). The
  native file format is the provider's; the console reads the native fields
  it can execute faithfully and rejects a file that uses a native field it
  cannot.
- The legacy trust-by-source-revision system is not ported. There is no
  general-purpose `trusted` boolean, no trust table, and no approval step
  for a definition as such. Safety is enforced by capability policy, Tool
  Policy, worktree isolation, side-effect approval, and Gates. Any future
  publisher-signature or package-trust design is a new feature with its own
  specification, not a port.
- The legacy `agentique:` frontmatter map, the `.agentique/agents/*.overlay.json`
  sidecar, the `.agentique/agents/<id>/` bundle format, and minted variants
  are deleted with no replacement.

## 7. Process

The branch `rewrite/orchestration-core` is built in these steps. Each step
is one or more commits; each commit keeps `npm run typecheck` and
`npm test` green for the code that exists at that commit.

1. **Architecture documents** (this step). No runtime code.
2. **Domain and schema.** `core/` (`@agentique-console/core`) final
   types, validators, and transition tables; `server/src/persistence/`
   final schema, baseline migration, reset-required check, stores, blob
   store, Event journal with transactional projections. `shared/` and
   `server/src/db/` are left untouched; nothing legacy is deleted in this
   step, and the legacy application keeps building and passing its tests.
   The import-boundary test (rule 7) and the terminology test (rule 10)
   are added in this step and run on every later commit.
3. **Runtime core.** Built in subphases under `server/src/execution/`.
   Phase 2A (done): the execution boundary, explicit plan-revision
   membership, the persisted final reserve, the deterministic compiler,
   the plan-revision service with reconciliation, and atomic Run bootstrap
   behind the Workspace preparation port. Phase 2B (done): the durable
   Invocation execution substrate — Context Manifest assembly and
   deterministic rendering with a persisted renderer version, atomic
   Invocation preparation behind the execution-workspace port, the
   provider-neutral adapter contract and scripted fake under
   `server/src/provider/`, the deterministic resource governor with
   persisted leases, Attempt execution with Usage and transcript
   recording, result validation, closed failure classification with
   durable retry decisions, optional pointer-based provider continuation,
   idempotent restart recovery, and the first root Orchestrator
   Invocation through the Run start service. Phase 2C (done): canonical
   typed Pattern positions persisted on Invocations with exact
   per-operation manifest selection, the pure readiness evaluator,
   idempotent Handoffs with database-enforced keys, the Changeset
   integration port and service with the conflict lifecycle, the
   `single` and `chain` Pattern runners over a shared sequential step
   engine, root-node settlement, and the event-driven bounded scheduler
   (`reconcileRun` projection, `advanceRun` pass) with restart and
   concurrency guarantees. Phase 2D-A (done): readiness as a pure
   function over the current graph plus explicit canonical condition
   facts (`ReadinessInput`, projected from `route_selection`
   Evaluations), the `route` Pattern runner (Decision and Evaluator
   selectors, one canonical selection Evaluation per node enforced by a
   unique index, inline and composite branches, `branch(label)` edge
   activation), the `parallel` Pattern runner (concurrent items under
   Run, node, and governor limits, index-ordered integration, the
   versioned parallel index Artifact, `requireAll`, aggregation over one
   `parallel_index` Handoff), deterministic `join` settlement (`fan_in`
   readiness, `require_all` / `require_any` over non-skipped sources, the
   versioned join index Artifact), `sequence` edges out of a route, the
   `branch` and `parallel_index` Handoff routes, and the typed
   `routeSelection` result member. Phase 2D-B1 (done): the canonical
   runtime-tool call boundary (`RuntimeToolCallPort` bound per Attempt,
   the effective callable set as the intersection of manifest
   permission, runtime handlers, and role/purpose validity, canonical
   digests, own short root transactions, replay across a logical turn
   through the append-only `runtime_tool_calls` table), atomic
   Coordinator Task proposals (`propose_tasks`, cancelling `update_task`)
   validated against the node's exact scope, bounds, and allocation, the
   pure Task projection (canonical order, readiness, blockers, the
   superseded set), and the `coordinator_worker` Pattern runner (one
   `decompose` turn, bounded concurrent Workers funded by Task-reservation
   transfer, integration in canonical Task order with `worker_result`
   Handoffs, one consolidated `replan` turn per blocker frontier with
   `coordinator_no_progress` and `coordinator_invocations_exhausted`,
   one `synthesize` turn, Gate-phase deferral, and restart safety).
   Phase 2D-B2 (done): typed Evaluator results (`evaluation` on the
   result contract, validated against the immutable manifest's evaluated
   criteria), optimizer Evaluations with explicit round context and judged
   Snapshot (one verdict per node and round, one criterion Evaluation per
   node, round, and criterion, database-enforced), the deterministic
   Acceptance Criterion check service behind the
   `AcceptanceCriterionExecutionPort` (isolated views of the exact
   Snapshot, fail-fast criterion order, bounded output Artifacts with
   canonical truncation, infrastructure failures that record nothing), the
   `evaluator_optimizer` Pattern runner in inline and evaluate-only form
   (producer rounds as new Invocations with `continuedFromInvocationId`,
   the `optimizer_candidate` and `optimizer_feedback` Handoffs and typed
   manifest inputs, `optimizer_rounds_exhausted`), `retry(round)` edge
   activation from the `optimizer_verdict` readiness fact, the
   `verify_node` scheduler action, and restart safety across every round
   boundary. Phase 2E-A (done): the immutable Run verification policy
   (Gate Evaluator revision resolved through the executable-revision
   resolver, never the Orchestrator; `maxNodeGateCycles`), plan validation
   refusing evaluated Gate criteria without an Evaluator
   (`gate_evaluator_unavailable`), the general `node_exit` Gate engine for
   `single`, `chain`, `route`, `parallel`, and `coordinator_worker` (one
   `gates` row per cycle with ordinal, pinned Snapshot, candidate, and
   criteria; deterministic-first fail-fast checks through the shared check
   service; one read-only Gate Evaluator Invocation per Gate owned through
   the immutable `gateId` with a typed `gate_candidate` input; one
   Evaluation per Gate and criterion; settlement with Handoffs and
   reservation release in one transaction; `gate_evaluator_failed`,
   `gate_cycles_exhausted`, `gate_remediation_failed`), remediation by the
   root Orchestrator's batched `gate_result` turn or by the Coordinator's
   frontier (`gate_failed` blocker with `gate_result` facts), the
   `open_node_gate`, `run_gate_checks`, `prepare_gate_evaluator`,
   `settle_node_gate`, `prepare_gate_remediation`, and
   `settle_gate_remediation` scheduler actions, and restart safety across
   every Gate window; `awaiting_gate_phase` no longer exists. Phase 2E-B
   (done): the executable `request_completion` runtime tool with its
   transactional preflight; canonical Completion Requests
   (`completion_requests`, `crq_`, closed lifecycle, one non-terminal per
   Run); the immutable completion policy (`maxRunCompletionCycles`,
   `runCompletionAcceptanceCriterionIds`); the `run_completion` Gate
   executed by the completion engine (pinned Snapshot, revision, leaves,
   criterion set, and candidate; deterministic checks through the shared
   check service; one final-reserve Gate Evaluator; Requirement-status
   derivation from the Gate's Evaluations; structural conditions; the
   read-only `final_synthesis` turn and its canonical final-report
   Artifact; one remediation Task on failure); the `operator_signoff`
   Gate and its `signoff` Decision opened on passing; the
   `begin_run_completion`, `run_completion_checks`,
   `prepare_run_completion_evaluator`, `settle_run_completion_evaluator`,
   `derive_requirement_statuses`, `prepare_final_synthesis`,
   `settle_final_synthesis`, and `complete_run_verification` scheduler
   actions; and restart safety across every completion window. Phase
   2E-C (done): operator signoff resolution through the signoff service
   (`RunSignoffService`: read-only bounded inspection, `accept`,
   `request_changes`; caller-supplied ids limited to the Run, Gate,
   Decision, and message); the canonical Signoff Resolution
   (`signoff_resolutions`, `sres_`, one per Gate and per Decision,
   append-only); the closed Changeset kind with the Run's one `final`
   Changeset (`recorded`, base to final, exact `text/x-diff` bytes, one
   per Run, none before acceptance) and `Run.finalChangesetId` beside
   `Run.finalSnapshotId` (both exactly when `completed`); the read-only
   `RunFinalizationWorkspacePort` (Integration Workspace observation and
   the exact base-to-verified diff, outside every transaction, drift
   refused); the `changes_requested` Gate failure; the one follow-up
   root `decision_resolution` turn over the typed `signoff_resolution`
   input, funded from the root's ordinary allocation with a typed
   preflight refusal (`ordinary_capacity_insufficient`); the
   Conversation's active-Run reference cleared only when it still names
   the terminal Run; and restart safety across every signoff window.
   Phase 2E-D (done): safe, explicitly authorized, crash-recoverable
   Publication — the recoverable Publication lifecycle (`requested →
   prepared → verified → applying → succeeded | failed`) with its closed
   structured failures, prepared facts, terminal publication-report
   Artifact, and durable staging-cleanup obligation; the `publish`
   Decision with its typed subject (completed Run, Workspace, exact
   Target, final Snapshot, final Changeset, requested strategy), the
   options `publish` and `cancel`, one open per Run, and the atomic
   resolve-plus-create; the strategy request (`automatic` | `exact`)
   beside the concrete strategy selected at publication time; the narrow
   `PublicationWorkspacePort` (idempotent `prepare` over the
   runtime-verified final-Changeset content constructing the candidate
   without touching the Target, idempotent atomic
   compare-and-swap-plus-durable-receipt `apply`, idempotent `release`);
   candidate verification through the shared Acceptance Criterion check
   boundary under the typed `publication` Evaluation context (the
   accepted completion boundary's deterministic criteria, one Evaluation
   per Publication and criterion, runtime producer only); the
   publication service (`request`, `resolve`, `inspect`, `advance`,
   `reconcileOutstanding`, `releaseOutstanding`) with one durable
   boundary per advance and recovery from every nonterminal status; the
   removal of the provisional `publication_result` Orchestrator purpose
   and of Conversation-level automatic publish authorization; and
   restart and concurrency safety across every publication window.
   Phase 2F-A (done): deterministic Allocation Extensions and
   operator-approved Run Budget Increases — the append-only
   `budget_increases` and `allocation_extensions` records with their
   closed partition and trigger vocabularies; effective Run capacity
   derived from the immutable base Budget plus approved increases (base,
   increases, effective global, final-reserve, and ordinary limits; active,
   released, and available per account) and effective Plan Node
   allocations derived from the immutable reservation plus its extensions;
   the one Plan Node capacity operation (`ensure`, with the read-only
   `admits`) that funds every node-funded child — Pattern Invocations,
   root turns, `gate_result` remediation turns, Coordinator Task batches,
   `node_exit` Gate Evaluators, approval successors, the signoff change
   request's follow-up — by creating exactly the component-wise shortfall
   under the node's `extend` policy in the transaction that creates the
   child, or refusing by policy; the operator-only `budget_increase`
   Decision with its typed subject and the Budget Increase service
   (`request`, `resolve`, `inspect`) whose approval records exactly one
   increase without creating an Invocation, Usage, or Run transition; the
   scheduler's `budget` wait for a root or node whose required work no
   extension can fund and the ordinary resume once an increase makes it
   fundable; the removal of the typed allocation-extension deferral from the
   scheduler, the runners, the Gate engine, the root support, the tests,
   and these documents; and restart and concurrency safety across every
   extension and increase window.
   Phase 2F-B (done): the executable `request_decision` runtime tool —
   the closed requestable kinds (`operator_choice`; `requirement_waiver`
   from the root Orchestrator only) with every other kind left to its
   owning service; the bounded request contract, the role and purpose
   bindings (an Orchestrator turn but the final synthesis, a Coordinator
   turn, a Worker), and scope validation against the caller's own Tasks,
   node, and Requirements; the decision-request service that creates the
   one Decision in the call's transaction, refuses typed, replays by
   digest, and refuses a second request of the turn; the hard logical-turn
   boundary under both resolution policies (the typed `decision_requested`
   adapter completion, the closed Attempt failure class and refused retry,
   the blocked Invocation with its Tasks, one Usage record, no provider
   process held open, nothing the provider returns afterwards recorded);
   the operator's resolution through the service boundary (replay,
   conflict, Evidence, waiver rationale) and the scheduler's
   `resolve_decision_default` action from rows and the clock with the
   deadline as the Run's resumption time; the waiver's revision pinning,
   its `waived` status change in the resolving transaction, and its
   `requirement_waiver_stale` supersession; the scheduler's
   `continue_decision_request` action preparing exactly one successor at
   the requesting role, purpose, and position with one typed
   `decision_resolution` input and no relay turn, funded through the one
   capacity operation (`fail`, `wait`, `extend`; a Budget Increase alone
   never enlarges a `wait` node); capacity ineligibility of terminal Plan
   Nodes before any arithmetic; and restart and concurrency safety across
   every request, blocking, resolution, and continuation window. No typed
   deferral remains in the runtime-tool bindings.
   Phase 2G-A (done): bounded canonical read tools and runtime-owned
   Artifact creation — the closed runtime-tool outcome model separating a
   successful read (a typed bounded projection; no `runtime_tool_calls`
   row, no Event, no Usage row, no invented digest or call id) from an
   accepted recorded mutation; the six executable read tools
   (`read_requirements`, `read_decisions`, `read_tasks`, `read_artifact`,
   `read_execution_plan`, `read_agent_definitions`) under one common
   contract (strict closed schemas, per-role canonical scopes over the
   caller's immutable manifest and rows, execution outside every
   transaction, deterministic canonical order, the stateless keyset
   cursor with default 25 and maximum 100 over bounded keyset store
   queries whose visibility predicates run in the database, Decision
   projections filtered to the caller's canonical scope, the plan's
   canonical edge order, the 64 KiB serialized-outcome ceiling with the
   typed oversized-record reference, refusal of malformed, foreign,
   other-view, superseded-revision, and left-scope cursors, no stored
   cursor or read receipt); `read_artifact` as the one content-returning
   tool (manifest or exact-current-Invocation `write_artifact`
   authorization validated before any byte loads — never the logical
   turn's replay scope — Artifact-Store-verified bytes, 16 KiB default and
   64 KiB maximum pages with `maxBytes` an upper bound under the
   serialized ceiling, UTF-8-boundary-safe `utf8` and decoded-byte-paged
   `base64`, closed missing/corrupt failures); infrastructure failures
   reported by closed failure kind, never thrown text; the
   executable `write_artifact` mutation (runtime-derived id, digest,
   size, and producer ownership; 200-byte title and media type, 48 KiB
   decoded per call, 32 calls and 1 MiB per logical turn from accepted
   rows; blob-compensated one-transaction commit; digest replay of the
   same Artifact id; its own 96 KiB canonical call bound) with Evaluator
   Artifact creation for bounded Evidence reports and immediate
   same-turn visibility; the complete executable handler set (the read
   tools, `write_artifact`, `propose_tasks`, `update_task` in full,
   `request_completion`, `request_decision`, `create_tasks`,
   `record_decision`, `propose_requirements`, `revise_execution_plan`;
   the `final_synthesis` turn reads only); and
   restart safety across every write-replay, rollback, routing,
   corruption, and Evaluator-Evidence window. Phase 2G-A correction
   (done): the pending-write marker protocol of the blob store, the
   transactor's `afterCommit` completion hooks, the Artifact Store's
   marker lifecycle and pending-area reconciliation, its invocation by
   the clean-break `RecoveryService` after the worktree releases with the
   typed `blobs` report, and the abrupt-death windows verified with a
   real child process over a real SQLite file and `FileBlobStore` — after
   which a successful exclusive recovery removes every unreferenced blob
   and temporary the protocol published, keeps every blob committed
   metadata references, and resolves every marker (execution-model §2.1;
   process death only, no power-loss claim, unmarked historical orphans
   excluded). The authoring tools of execution-model §6.4
   (`create_tasks`, `record_decision`, `propose_requirements`,
   `revise_execution_plan`, `update_task` in full), operator supersession
   of a policy-resolved Decision, service-level operator steering through
   the canonical root input queue, and the Orchestrator's `node_result`
   turns are implemented (`server/src/execution/task-authoring.ts`,
   `decision-records.ts`, `requirement-proposals.ts`,
   `orchestrator-inputs.ts`, `decision-requests.ts`, `patterns/root.ts`;
   roadmap Phases 4 and 5). Operator Run cancellation and pause/resume are implemented under
   this step as internal execution services
   (`server/src/execution/run-control.ts`, `run-cancellation.ts`; the
   `runs.operator_pause` column of the regenerated baseline; execution-model
   §3, §14) and are not agent tools or routes — the API of the cutover
   calls them. The production provider adapter
   (`server/src/provider/claude-adapter.ts` over the Claude Agent SDK,
   with the hook-enforced authorization boundary, the in-process MCP
   runtime-tool server, native session resumption, Usage from the SDK's
   per-model figures, the redacted transcript, and the filtered
   subprocess environment; roadmap Phase 3) and the real Workspace
   adapters for the six ports over git and plain-directory Workspaces
   (`server/src/workspace-state/`; roadmap Phase 4) are implemented, and
   `server/src/composition/` wires them with every service for
   production use. Everything the
   original wording of this step listed as future — Runs, Execution Plan
   source validation and the compiler, Plan Nodes of both kinds
   (`pattern`, `join`), Plan Edges, Plan Node Requirement scope, the
   scheduler, the resource governor, Budget reservations, Invocations (one
   per logical turn, with purposes), Attempts (`initial`, `retry`, with
   the provider adapter's optional pointer-based resumption), Context
   Manifests, results, Task states, Usage, Events, and all six Patterns
   with composition and joins in the compiler — is implemented and
   verified with the scripted fake provider for every Pattern, every
   compilation rule, and every invariant, as credited in the roadmap.
4. **Specification and verification.** Requirements (including
   `requirement_waiver` Decisions), Acceptance Criteria, Decisions with
   resolution policies, Evaluations, Gates, Agent Definition revisions and
   Tool Policy interception, Snapshots, Changesets, the Integration
   Workspace, and publishing. Status: implemented and verified against
   the declared Workspace ports and their fake implementations under the
   Phase 2 subphase labels; the production Workspace adapters
   (`server/src/workspace-state/`), Workspace-file Agent Definitions read
   from a pinned Snapshot with the native-field acceptance rule
   (`server/src/agents/`), and operator supersession of a policy-resolved
   Decision are implemented (roadmap Phase 4).
5. **API and web.** Routes, event stream, views. Status: not started
   (roadmap Phase 9), together with the rewritten entrypoints that open
   the database, run recovery, and start the scheduler.
6. **Cutover.** Delete every entry in [legacy-removal.md](legacy-removal.md),
   delete the legacy tests, delete the evaluation harness, replace
   `README.md` and `docs/`, remove legacy environment variables from
   `config.ts`. After this commit series the import test in rule 7 has
   nothing left to check, and the terminology test in rule 10 runs over
   the whole tree.
7. **Verification.** `npm run verify` green; a fresh database starts; a
   legacy database is refused with the reset-required message; every
   invariant in [execution-model.md](execution-model.md) §15 has a named
   test.

Merge to `main` happens after step 7 as one merge commit. Rollback is
`git revert` of that merge commit or a checkout of its first parent.

## 8. Testing requirements

The full suite is `npm test` at the repository root (`npm run test
--workspaces --if-present`: each workspace's own `vitest run` under its own
configuration), and every reported count names its workspace. Running
`npx vitest run` at the repository root is not a result: it collects the
`web/` and `server/evals` fixture files outside their configurations and
reports their collection failures beside the suites. Per-phase counts are
compared per workspace and by collected file and case identity, not by
the passing total alone.

- Unit tests for every store, the scheduler, Budget arithmetic, result
  validation, manifest assembly, Changeset integration, and Gate ordering.
- Integration tests, using a scripted fake provider, that run a complete
  Run for each Pattern and assert the Event sequence, the Usage roll-up,
  the Snapshot chain, and the Gate outcomes.
- Restart tests: a Run interrupted mid-Attempt continues from persisted
  manifests after a simulated server restart with `retry` Attempts, and
  nothing is read from a transcript. A variant truncates the continuation
  index and payload store first and asserts the same outcome with every
  Attempt `fresh`.
- Operator control tests: cancellation from every nonterminal Run status
  (paused ones included) and its refusal for ended Runs; convergence of
  executing, prepared, waiting, blocked, removed-membership, Coordinator,
  and chain work with terminal history preserved, Usage retained once,
  and reservations and leases settled once; soft pause draining an
  admitted Attempt without starting, settling, or integrating anything;
  hard pause interrupting into the ordinary `interrupted` class with the
  Invocation's identity, Task ownership, limits, and deadline kept; the
  prepared-but-undispatched boundary; resume recomputing readiness from
  rows (open Decision, unfunded `wait` node, verification cycle, signoff)
  without restoring a stale reason or repeating finished work; races
  driven by deterministic barriers in both orders (pause versus
  preparation and dispatch, cancel and hard pause versus provider
  completion, stale projections, repeated and lost requests, Decision
  resolution and completion or signoff advancement under a pause); and
  file-backed restart windows (pause committed before delivery,
  interruption recorded before resume, cancellation committed before
  cleanup, soft-paused work completed before the restart, resume committed
  before its response, control from two connections).
- Provider resumption tests: an Attempt is `resumed` only when the fake
  adapter reports support, safety, an unexpired index row whose payload is
  present and matches its digest, and allocation headroom; each missing
  condition yields `fresh`; resumption across an Invocation boundary
  (`continuedFromInvocationId`) is exercised; no payload or storage key
  appears in any Event, log line, or API response.
- Invocation tests: every logical input creates a new Invocation with an
  immutable manifest and a purpose; Attempts are only `initial` or
  `retry`; at most one Orchestrator Invocation per Run and one Coordinator
  Invocation per node is active; queued inputs coalesce into the next
  Invocation; routine progress creates neither.
- Compiler tests: each compilation rule in
  [execution-model.md](execution-model.md) §4.4 including `join` emission
  for composite `parallel` items and terminal parallels, aggregation as a
  subsequent `single`, the absence of any zero-item `parallel`, each
  rejection, scope expansion into `plan_node_requirements`, atomic
  allocation reservation, and reconciliation of a revision against started
  nodes.
- Coordinator tests: separate Coordinator Invocations exist exactly for
  `decompose`, `replan`, and `synthesize`; Task proposals are validated
  against the node's persisted scope (out-of-scope, other-Conversation,
  other-revision, retired, and internal Requirements are rejected), Budget
  is reserved by the runtime before a Task becomes `ready`; a Worker cannot
  propose anything.
- Task state tests: every transition in
  [execution-model.md](execution-model.md) §7.9; a `failed` Task is never
  `cancelled` by the runtime; a dependency failure blocks rather than
  cancels; completing a Task never changes a Requirement status.
- Budget tests: reservations are created atomically before a node or
  Invocation becomes runnable; the root node's allocation is the
  configured initial amount; a revision whose allocations exceed unreserved
  capacity (after the final reserve) is rejected; release returns the
  unused remainder; Run Budget exhaustion yields `waiting`/`budget`, never
  `failed`; `fail`, `wait`, and `extend` node policies behave as specified.
- Budget Increase and Allocation Extension tests: the base Budget is never
  rewritten and every effective limit derives from it plus approved
  increases; the ordinary and final partitions stay disjoint (an ordinary
  increase never enlarges the final reserve; a final-reserve increase
  enlarges the global and final limits together); an Allocation Extension
  raises only the selected node's effective allocation, an active charge
  is `max(original + extensions, actual)`, a released charge is complete
  actual consumption once, Usage totals are unchanged by both records,
  overruns are never clamped and negative availability stays visible;
  `fail` and `wait` never extend, `extend` creates exactly the minimum with
  no speculative remainder and waits without partial state when the Run's
  effective ordinary capacity cannot cover it, an approved increase makes
  the same work fundable, the final reserve is never an extension's
  source, and an existing Invocation is never enlarged; extension is
  exercised through an ordinary Pattern Invocation, a root turn, a
  Coordinator Task batch, a Worker transfer or successor, a Gate Evaluator
  and remediation turn, and a signoff change request; a non-operator or
  policy resolution, a foreign Run, a mismatched subject, a terminal Run,
  and a final-reserve increase during verification or signoff are refused,
  `deny` creates nothing, `approve` creates exactly one increase, identical
  retries replay, conflicting retries write nothing, and no Orchestrator
  Invocation results; the boundary test proves no legacy import, no
  compatibility mechanism, no model or provider dependency, no transcript
  read, no timer, no second scheduler, no mutable historical amounts, and
  that the retired allocation-extension deferral is absent from the new
  source, its tests, and these documents; and eighteen file-backed and
  multi-connection windows (crash before an extension; after an extension
  and before its child; child, Event, and COMMIT failures; two processes
  funding one position; two Task batches racing; two increase requests
  racing; duplicate and conflicting approval replays; an approved increase
  after reopen; a waiting Run resuming after reopen; a change request
  retried after reopen; a final-reserve increase followed by the
  completion preflight; a released reservation and a terminal node refusing
  a late extension; overrun plus extension accounting; negative
  availability followed by a sufficient increase) converge without a
  duplicate increase, extension, Task, Invocation, reservation, Event,
  scheduler action, or Usage row.
- Requirement tests: `satisfied` follows only from Gate Evaluations;
  `waived` follows only from a `requirement_waiver` Decision resolved by
  the operator with actor, rationale, Requirement id, timestamp;
  `record_decision` cannot create or resolve one; no policy resolves one; a
  later Requirement revision leaves existing scope rows unchanged.
- Decision tests: `use_default_after_deadline` is accepted for
  `operator_choice` only and resolves only with a recorded recommendation,
  deadline or condition, rationale, and affected ids, always writing
  `decision.resolved`.
- Signoff tests: the bounded inspection carries no content, transcript,
  worktree path, or Event history and writes nothing; acceptance
  completes the Run on exactly the signoff Gate's Snapshot with one exact
  base-to-final `final` Changeset (a zero-byte diff included), clears the
  active Run, retains the Integration Workspace, touches no Target and
  creates no Publication, refuses drift, an unobservable Workspace,
  foreign ids, and every kind of unexpected active state without
  resolving anything, replays identically, and refuses a conflicting
  change request; a change request reopens the Run with exactly one
  ordinary-funded root `decision_resolution` turn over the typed
  `signoff_resolution` input (forged inputs refused at assembly), leaves
  the completion history immutable, requests no completion by itself,
  leaves the final reserve untouched, refuses an unfundable follow-up
  typed before any write, replays identically, and refuses a conflicting
  accept; the store and the database enforce the final Changeset's kind,
  state, uniqueness, and boundary, the completed Run's final references,
  and the Signoff Resolution's uniqueness, agreement, immutability, and
  follow-up link; and twenty-one file-backed crash windows converge
  without a duplicate resolution, Decision resolution, Gate closure,
  Artifact, Changeset, transition, Invocation, preparation, or Event.
- Publication tests: a Run never writes to the Target and signoff
  acceptance creates no publish authority; every Publication needs its own
  operator-resolved `publish` Decision with the exact typed subject (one
  open per Run, identical retries replayed, conflicts refused, one
  Publication per Decision, none after a succeeded one); preparation
  constructs and persists the candidate without modifying the Target and
  honors an exact strategy or refuses it; verification runs the accepted
  boundary's deterministic criteria on the candidate before any Target
  call, one canonical Evaluation per Publication and criterion; `applying`
  is durably persisted before the apply; the apply is one idempotent
  atomic compare-and-swap-plus-receipt with no force update, a definite
  not-applied failure when the Target moved, and success never inferred
  from a Target that merely equals the candidate; terminal outcomes record
  the closed failure and the versioned publication-report Artifact with
  raw diagnostics in a separate Artifact; staging cleanup is a durable
  retried obligation; and twenty file-backed crash and concurrency windows
  converge with at most one Target mutation, one receipt, no duplicated
  Evaluation, Snapshot, report, or terminal Event, no external call inside
  a transaction, and identical projections after reopen.
- Governor tests: leases are granted and refused deterministically with
  structured reasons; a refused Run is `waiting` with `provider_capacity`;
  the governor has no dependency on any model or prompt module.
- A database-open test for each of the three cases in section 4, run
  against a missing file, an empty database, a matching database, a legacy
  database, and an unrelated SQLite database.
- An import-boundary test (rule 7) proving that `core/` imports no other
  workspace package, that `server/src/persistence/` and
  `server/src/execution/` import neither `shared/` nor `server/src/db/`
  nor any legacy runtime module, that `server/src/execution/` imports only
  the core package, the persistence boundary, and itself, that no legacy
  module imports `core/`, `server/src/persistence/`, or
  `server/src/execution/`, and that no legacy migration creates a
  new-schema table; and a terminology test (rule 10) over the new source
  directories.
- Compiler and plan-revision tests: every §4.4 rule and rejection, the
  source-path grammar, deterministic repeated compilation, reconciliation
  (identical revision, sibling append, branch removal, edge-only change,
  scope and allocation change, started-node conflict, removal of running
  nodes), accepted-revision atomicity and Event ordering, rejected
  proposals writing only `execution_plan.rejected`, and revision numbers
  counting accepted revisions only.
- Run bootstrap tests: complete initial state in one transaction; a second
  active Run, a Workspace preparation failure, and a persistence failure
  after preparation each create nothing, the last invoking the port's
  compensation; the initial allocation plus the final reserve must fit the
  Run Budget; the current graph survives close and reopen identically.
- Final-reserve tests: ordinary Invocations reserve from their Plan Node;
  `final_synthesis` and `run_completion` Invocations reserve directly from
  the Run final reserve, atomically with their creation; every other role,
  purpose, node, discriminator, Task, or consumer is refused at the store
  and at the database; final Usage appears once in Invocation, root node,
  and Run totals and only on its own Run-level reservation; ordinary and
  final overruns are visible while active, reduce the other partition's
  effective availability, refuse later reservations, never clamp, and read
  back identically after reopen; Task transfer stays neutral.
- Provenance tests: builtin, Workspace-file, and Conversation revisions are
  accepted where they belong and rejected elsewhere; missing Snapshots and
  missing, foreign, unresolved, or inappropriate approval Decisions are
  refused at append; a foreign Orchestrator is refused before Workspace
  preparation; a foreign plan Worker yields exactly one rejected Event and
  no revision number; the compiler receives only resolved revision facts.
- Approval-use tests: a matching resolved `approve_once` Decision is
  claimed exactly once; a second claim in the same Attempt, a retry
  Attempt, and a restarted process are refused; two connections
  competing for one grant have one committed winner; a different tool,
  digest, Run, Plan Node, predecessor, or manifest, a denied, open, or
  superseded Decision, and a non-running or foreign Attempt are refused
  at the store and at the database; an injected claim callback or COMMIT
  failure executes nothing and leaves no row or Event; provider failure
  after a claim leaves the approval consumed; no raw call bytes appear in
  Events, diagnostics, failure details, uses, or rendered inputs; and the
  scripted fake exercises the authorization port rather than adapter-local
  consumption.
- Pattern-position tests: every position kind validates against the
  node's shape and fixes the Invocation's definition, role, and purpose;
  a wrong revision, role, purpose, or out-of-range index is refused at the
  store and at the database; at most one non-terminal Invocation exists
  per node and position; the manifest carries the position and exactly
  the operation's inputs; the same Task in two chain steps or parallel
  items is rejected at compilation.
- Readiness tests: the evaluator is pure over the current graph plus the
  explicit condition facts (no store, clock, or Invocation read; the facts
  projection reads only `route_selection` Evaluations), decides ready,
  pending, and skipped with causes for every predecessor combination in
  §4.3, honours `runOnDependencyFailure`, activates exactly the selected
  `branch(label)` edge and a route's `sequence` edges only for an inline
  selection, makes a join ready when every `fan_in` source is terminal
  and skipped when all were skipped, fails explicitly on a missing or
  contradictory fact, ignores historical revisions' edges and historical
  facts, activates a `retry(round)` edge from the recorded round verdict
  alone (a failed or inconclusive round delivers exactly the next retry
  edge, a pass skips every later unrolled round, an inactive retry path
  is skipped and never failed, a retry edge out of anything but the
  evaluate-only node of round `round − 1` is a contradiction), and
  refuses a missing, contradictory, or historical verdict fact.
- Evaluator-result tests: an `evaluation` payload is admitted only from an
  `evaluate` Invocation and is exclusive with `routeSelection`; coverage
  of the manifest's evaluated criteria is exact (missing, duplicate,
  extra, foreign, and deterministic criteria are rejected); an overall
  pass with a failed or inconclusive criterion is rejected; a foreign
  Evidence reference, a `command` claim, a Task report, `blocked`, and a
  Changeset are rejected; the Evaluation store refuses a self-produced or
  foreign judged Artifact, the wrong node or round, a foreign Snapshot, a
  criterion the node does not gate, and a second verdict for a round at
  the store and at the database, and persists the Snapshot and judged
  Artifact set exactly.
- Deterministic-check tests: the expected exit code passes and any other
  fails; criteria execute in canonical id order and stop at the first
  failure; a deterministic failure skips the Evaluator; a port timeout,
  abort, failed start, lost view, or lost output creates no Evaluation
  and is retried by the next run; every command runs outside every
  transaction in an isolated view that never writes to the Integration
  Workspace or the Target; raw output appears only in its Artifact, bounded,
  with truncation recorded; a restart between a command and its record
  converges without a duplicate row and discards the stale view.
- `evaluator_optimizer` tests: a round-one pass; a deterministic failure
  and an Evaluator failure each followed by a passing second round;
  inconclusive continuing like failure; rounds exhausted with the last
  Evaluation retained; a producer failure failing at once; an invalid
  Evaluator result retried as an Attempt, never a round; the next
  producer's exact Handoff and typed feedback; `continuedFromInvocationId`
  across rounds; an approval continuation consuming no round; one active
  position at a time; evaluate-only rounds over a producer subgraph with
  the candidate in canonical incoming-edge order, control-node success on a
  non-final failure, `optimizer_rounds_exhausted` on the final one, a
  missing verdict fact as an infrastructure failure, and no transcript or
  Event consulted; and sixteen restart windows over a file-backed database
  (producer prepared, result committed, Changeset applied but unrecorded,
  integration recorded, command run but unrecorded, deterministic failure
  recorded, deterministic pass recorded, Evaluator result committed,
  overall failure recorded, retry verdict recorded, overall pass recorded,
  final failure recorded, final pass recorded, approval continuation, stale
  verification view) with nothing repeated and an identical projection
  after every reopen.
- Runtime-tool call tests: the effective callable set is the
  intersection of manifest permission, runtime handlers, and role and
  purpose validity (a Worker and a `synthesize` turn never see
  `propose_tasks`; `request_decision` is callable only when all three
  layers admit it — the immutable manifest Tool Policy, a registered
  runtime handler, and the exact role/purpose binding — so it is
  executable only for Orchestrator purposes other than `final_synthesis`,
  Coordinator `decompose`, `replan`, and `synthesize`, and eligible Worker
  `step` and `task` positions, never for an Evaluator or a Gate-owned
  Invocation, and it can request only an `operator_choice` or the root
  Orchestrator's `requirement_waiver` while every other Decision kind
  stays with its dedicated service); an unlisted tool is `not_callable`; a malformed or oversized call is
  `rejected` with nothing written; every mutating call runs in its own
  root transaction outside provider execution and refuses to nest; an
  identical call is replayed by digest within the logical turn (retry
  and approval successor) and never repeats its effect; a second
  proposal in one turn is `proposal_already_accepted` and a second
  Decision request in one turn is `decision_already_requested`, an
  accepted request ending the turn (`turn_ended` for every later call); a
  call from an Attempt that is no longer running is `caller_not_running`;
  a handler failure commits nothing and yields one diagnostic; no Event
  carries the raw input.
- Decision continuation tests: every position at which the canonical
  role/purpose bindings expose `request_decision` — the root Orchestrator
  at each executable purpose, `single`, every `chain_step` (first, a
  nonzero middle, last), the inline `route_branch`, a nonzero
  `parallel_item` and the `parallel_aggregation`, Coordinator `decompose`,
  `replan`, and `synthesize`, `worker_task`, and a first and a later
  `producer_round` — continues in one successor at the exact blocked
  position with the position's operation inputs and Handoffs delivered
  once and exactly one `decision_resolution` input, through the one
  `continue_decision_request` action; the Evaluator positions
  (`route_selection`, `evaluator_round`, node-exit and run-completion
  Gates) and the final synthesis are never callable; file-backed restarts
  at each Pattern-specific position, a fixed-`wait` continuation, and two
  scheduler processes racing prepare at most one successor.
- Runtime data-access tests: every read tool returns a typed projection
  with no Event, `runtime_tool_calls` row, Usage row, or stored cursor;
  paging is deterministic with default and maximum limits, stateless
  keyset continuation, refused malformed, foreign, other-view,
  superseded-revision, and left-scope cursors, the 64 KiB
  serialized-outcome ceiling measured in UTF-8 bytes, and the typed
  oversized-record reference in list and keyset pages alike; bounded
  retrieval is proven by statement and row observation of the store (at
  most `limit + 1` rows of the collection per page, batched page-local
  lookups, one row for the current Requirement revision, never an
  enumeration of a Conversation's Decisions, a Run's Tasks, or every
  Agent Definition revision); plan edges page in the canonical order
  with ids minted to sort otherwise and pages crossing target-node
  boundaries; reads are refused inside a transaction, after the caller
  stopped running, and after the logical turn ended; results repeat
  identically across a file-backed reopen; the scope matrix covers every
  read tool for the root Orchestrator, a Coordinator, a Worker, and an
  Evaluator — exact in-scope records, foreign Run, Workspace, and
  Conversation records, same-Run-but-out-of-scope records, pinned versus
  current Requirement revisions, replacement history, pagination that
  cannot enumerate beyond scope, one mixed-scope Decision projected to
  each role's exact references, and two Runs of one Conversation sharing
  Requirement identities with the other Run's Decision visible only
  where the manifest names it. `read_artifact` covers complete and
  multi-page boundary-safe UTF-8 reads, invalid-UTF-8 refusal, base64
  paging over decoded bytes, zero-byte Artifacts, maximum pages, offsets
  at and beyond the end, missing and corrupt blobs as closed typed
  failures, the absence of content bytes in Events, diagnostics,
  manifests, rows, and errors, and the serialized ceiling over
  runtime-created fixtures of 64 KiB and more listed on a node
  (binary as base64, large ASCII, multibyte Unicode, heavily escaped
  text, maximal metadata, exact boundaries with one-more-unit checks,
  complete reconstruction, malformed UTF-8, undersized requests); the
  visibility matrix separates the same Invocation's same and retried
  Attempts, an agent-requested Decision successor, one- and two-link
  approval successors (replay of the predecessor's write without
  content access), a Handoff-routed predecessor output, another
  Worker's output, a same-Invocation Artifact without an accepted write
  row, transcript and captured-call Artifacts, and a foreign Run's
  Artifact, asserting refusal before any byte loads; failure sanitization
  injects content, path, storage-key, and raw-input text into store and
  blob failures and asserts only ids, digests, and closed kinds reach
  outcomes and diagnostics, with a cleanup failure reported beside the
  canonical failure. `write_artifact` covers every permitted role,
  Evaluator Evidence Artifacts admitted by result validation, malformed
  and non-canonical content, invalid media types, the per-call,
  per-turn-count, and cumulative-byte bounds, exact and concurrent
  replay, distinct calls over deduplicated blobs, Event, insert, and
  COMMIT failures leaving no row, Event, or unreferenced blob, the
  cleanup-failure diagnostic that never replaces the canonical error,
  immediate same-turn visibility, successors unreadable without
  canonical routing, and file-backed restart windows (lost-response
  replay of the same Artifact id, rollback after the blob write, routed
  and unrouted visibility after reopen, corruption staying typed, an
  Evaluator's Evidence settling once), the 96 KiB request ceiling versus
  the 48 KiB decoded ceiling (maximal base64 with maximal metadata fits,
  heavily escaped text is refused without a write or allowance, the same
  bytes as base64 succeed), and the abrupt-death windows with a real
  child process over a real SQLite file and `FileBlobStore`, driven by
  IPC barriers and exit notifications: death after the pending marker,
  during the temporary write, after the blob publication, after the
  Artifact row and Event, after COMMIT before the marker removal, after
  COMMIT with the response lost, and inside recovery between a blob
  removal and its marker removal; a marked orphan another Run references
  before recovery, a reuse crash over another Run's committed content,
  restoration of a missing committed blob, two same-digest creates in one
  uncommitted transaction, pre-existing unmarked content, a failed cleanup
  followed by a successful repeated recovery, and on-disk corruption in a
  fresh process — each inspecting rows, blob files, and the pending area
  immediately after death, after recovery, and after a repeated recovery,
  asserting no duplicate Artifact, Event, call row, or replay result and
  no removal of committed content.
- Pending-write protocol tests: the transactor's `afterCommit` (nested
  registration on the root, registration order, never after a rollback or
  a failed COMMIT, a throwing hook reported while later hooks run, a
  throwing diagnostic sink never replacing the committed result, a hook
  opening a new root); the blob store's marker, temporary-file, symlink,
  junction, malformed-name, and unsafe-entry handling over a real
  directory (no removal through a symlink, no recursive delete, no
  `.tmp`-suffix matching, bounded sanitized identifiers); the Artifact
  Store's marker lifecycle on commit, rollback, reuse, restoration, the
  store's own put failure, and same-transaction duplicates, with every
  cleanup failure reported by closed kind beside the canonical error; and
  the reconciliation matrix (a stale marker with and without a blob,
  referenced by this or another Run, a restored blob, an interrupted
  cleanup, an unmarked orphan untouched, every failure kind reported
  truthfully and resolved by a later pass, bounded reports and
  diagnostics, refusal inside a transaction). The boundary test pins the
  protocol's single owner, its single reconciliation caller and ordering,
  the absence of timers, sweeps, fsync knobs, `durableBarriers`,
  recursive deletes, and legacy bootstrap wiring.
- Task proposal tests: every rule of execution-model §5.5.1 rejects the
  whole batch with its closed code and persists nothing; an accepted
  batch creates every Task, dependency, and reservation atomically;
  replacement supersedes a `failed` or `blocked` Task at most once,
  never a `completed` one, cancels a replaced `blocked` Task, keeps a
  `failed` one `failed`, and copies its dependents; cumulative
  `maxTasks` counts superseded Tasks; cancellation releases the
  reservation and is refused for started or superseded Tasks.
- `coordinator_worker` tests: decompose → Workers → synthesize with one
  accepted proposal, one Worker per Task funded by its Task reservation,
  bounded concurrency, per-Task manifests, integration in canonical Task
  order never completion order, `worker_result` Handoffs recorded once,
  coalesced replanning with only new blocker facts delivered,
  `coordinator_no_progress`, `coordinator_invocations_exhausted`
  counting approval successors as the same turn, integration conflicts
  as blockers, the `node_exit` Gate over the integrated synthesis with
  Coordinator-owned remediation, and twelve restart windows (crash
  before and after a tool-call commit, during Worker execution, before
  and after integration, before and after a Handoff, across approval
  successors, during synthesis, and after worktree-release failure)
  with nothing repeated.
- Gate tests: the verification policy and Gate ownership at the schema
  (immutable policy, Evaluator resolution and Orchestrator refusal,
  `gate_evaluator_unavailable`, Gate identity and append-only closure,
  Evaluator ownership and revision, one Evaluation per Gate and
  criterion, one remediation Task per failed Gate, the cycle bound); the
  Gate lifecycle (pinned Snapshot and candidate, deterministic-first
  fail-fast checks, infrastructure failures recording nothing, one
  Evaluator per Gate with a typed `gate_candidate` input, Evaluations on
  the Gate's rows, one-transaction settlement, invalid results as ordinary
  retries, a failed Evaluator without an invented verdict, raw output only
  in the Artifact Store, idempotent and revision-safe operations, typed
  actions, node funding); the Gate phase of every non-optimizer Pattern
  and the optimizer's absence of a Gate; root and Coordinator remediation
  (batching, Task addressing and candidate invalidation, failed and
  blocked turns, approval successors, exhaustion, unfunded root); and
  twenty file-backed crash windows of a root-remediated and a
  Coordinator-remediated cycle with nothing repeated.
- Handoff tests: a Handoff is created at most once per key across
  repeated passes, retries, and restarts; a second Handoff with the same
  key and a different route is refused; `sequence` edges, `branch(label)`
  activations, chain steps, and parallel index deliveries produce exactly
  the keys of §7.7, validated at the store and bounded at the database.
- Route, parallel, and join tests: a Decision selector selects without an
  Attempt and waits canonically while open; an Evaluator selector runs
  exactly one read-only Invocation and records exactly one Evaluation; an
  invalid label fails deterministically; a composite selection activates
  only its edge, skips every other branch, and holds successors until the
  selected exit; parallel items start concurrently within every limit,
  integrate in item order whatever the completion order, never see each
  other's outputs, honour `requireAll`, write one canonical index, and
  deliver it once to the aggregation; joins apply both policies over
  non-skipped sources, order the index by edge position, and create no
  Invocation, Attempt, lease, or Usage; every one converges across a
  restart and repeated settlement without a duplicate Evaluation,
  Invocation, index, integration, or Handoff.
- Integration tests: an integrated Changeset is never applied twice; a
  crash between the apply and its record is reconciled exactly once; a
  conflict records the Changeset, the Task, the report Artifact, and the
  node and Run waits in one transaction; a completed Task resumes and
  re-applies once; a second conflict, a failed Task, and a cancelled Task
  fail the node with `integration_conflict`; one integration runs at a
  time per Run.
- Integration content tests, over real persistence and the real Artifact
  and blob stores: the adapter observes exactly the verified diff bytes,
  digest, and size; a zero-byte diff is delivered and integrated; missing
  content, a digest or size mismatch, and an Artifact that is not a diff
  of the Run each stop integration before the port is called, change no
  projection, and record nothing; content is read and applied outside
  every transaction; after a crash between the external apply and its
  record the next process reads the same content, receives
  `alreadyApplied`, and records once; and diff bytes appear in no Event,
  diagnostic, scheduler outcome or projection, manifest, Handoff, Task,
  or error. The boundary test proves the port and every adapter location
  import no store, blob store, or database module, that the content
  source offers one parameterless read and no lookup, and that the
  integration service alone binds stored content to the port request.
- Scheduler tests: `reconcileRun` reads only canonical rows and returns
  the same projection before and after a reopen; `advanceRun` performs
  exactly `maxActions` actions in membership order, stops with each
  closed reason, executes independent Attempts concurrently within the
  Run's `maxConcurrency`, reports concurrency-limited nodes rather than
  waiting the Run, waits the Run on provider capacity, Budget, Decisions,
  and integration conflicts only when nothing else can proceed and
  resumes with the exact reason, reports retry and deadline resumption
  times, never polls, and lets concurrent callers share one pass without
  duplicating an Invocation or Attempt; removed running nodes settle
  without handing off; a terminal Run applies no settlement.
- End-to-end tests with the scripted fake: a Run whose plan is `single`
  nodes and `chain` nodes behind `sequence` edges executes each step once,
  integrates each Changeset once, delivers each Handoff once, blocks and
  continues across a `side_effect_approval` Decision, and converges from
  every durable boundary across six process lifetimes without repeating
  provider calls, Invocations, Handoffs, Attempts, or integrations.
- No live-provider tests in the default suite. Two live smoke tests exist
  behind `AGENTIQUE_LIVE_SMOKE=1` and are not benchmarks: one bounded
  read-only Attempt through the real adapter
  (`provider/claude-live.test.ts`) and the fourteen-step coding Run over
  the production composition on a disposable fixture repository
  (`composition/coding-run.live.test.ts`, also runnable as
  `npm run verify:coding-run --workspace server`). The same fourteen steps
  run in the default suite over real files, git, subprocess checks, and
  SQLite with the SDK fixture (`composition/coding-run.e2e.test.ts`). A
  live test never prints a credential, changes login or billing state, or
  publishes anywhere but the fixture Target it created.

## 9. Acceptance

Cutover is complete when all of the following are true:

- `git grep` for every legacy symbol named in the inventory (for example
  `AgentSessionService`, `OrchestratorRunner`, `TopologyContract`,
  `HandoffCore`, `UserSession`, `mailbox`) returns nothing, and every file
  path marked "deleted" in the inventory is absent.
- `git grep -i` for every retired term returns matches only inside
  `docs/architecture/` and git history.
- `npm run verify` passes.
- Starting the server against an empty `CONSOLE_DATA_DIR` creates the fresh
  schema; starting it against a legacy database prints the reset-required
  message and exits non-zero.
- Every route in `core/src/api.ts` is served; every legacy route in the
  inventory returns 404.
- Each invariant in [execution-model.md](execution-model.md) §15 is
  referenced by number in at least one test.
