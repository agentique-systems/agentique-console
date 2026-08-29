# Migration contract

This document states the terms under which the orchestration architecture
defined in [glossary.md](glossary.md) and
[execution-model.md](execution-model.md) replaces the current
implementation. It is a contract: every rule here is binding on every
commit on the `rewrite/orchestration-core` branch and on the cutover merge.
The inventory of what is removed is in
[legacy-removal.md](legacy-removal.md).

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

Neither boundary is staging, `v2`, `next`, `new`, or compatibility code;
each is the final production location of what it contains.

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
   intermediate commit. Utilities that the new code needs are written under
   their final names; the legacy utility is deleted when its last legacy
   importer is deleted.

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
  exactly one runtime process at a time. Transactional compensation for
  blobs ([execution-model.md](execution-model.md) §2.1) relies on that
  single owner and is not multi-process safe.
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
  never inferred from limits and Usage.
- `plan_node_requirements` is the only record of a Plan Node's Requirement
  scope; it is written by the compiler and never updated.

### Phase 1 schema expectations

Phase 1 must create exactly these tables, with the ownership and
cardinality stated here and in [glossary.md](glossary.md). Column design
beyond identifiers, keys, and the fields the architecture names is Phase 1
work.

| Table | Owner (writer) | Cardinality and immutability |
|---|---|---|
| `schema_info` | baseline migration | one row |
| `workspaces` | operator via API | mutable |
| `conversations` | runtime | one per operator thread; mutable title/policy |
| `conversation_messages` | runtime | append-only per Conversation |
| `runs` | runtime | one per Run; state, Target, base/integration/final Snapshot ids, Run Budget limits |
| `execution_plan_revisions` | runtime (validated Orchestrator revisions) | append-only per Run, numbered |
| `plan_nodes` | plan compiler | one per compiled node; `kind`, `pattern`, status, allocation limits; definition immutable after start |
| `plan_edges` | plan compiler | append-only per compiled revision; typed |
| `plan_node_requirements` | plan compiler | one row per (Plan Node, Requirement, pinned Requirement revision); never updated |
| `requirements` | runtime | one per Requirement id (stable across revisions); current status |
| `requirement_revisions` | runtime (operator approval) | append-only per Conversation |
| `requirement_status_changes` | runtime | append-only journal with Evidence |
| `acceptance_criteria` | runtime (Orchestrator authoring) | attached to a Requirement or Task; revisioned with the Requirement |
| `decisions` | runtime | one per Decision; kind, policy, request and resolution fields; append-only with supersession by id |
| `tasks` | runtime | one per Task; the seven states; `replacesTaskId` |
| `task_dependencies` | runtime | edges between Tasks of one Run |
| `artifacts` | runtime | immutable metadata; blob store separate |
| `handoffs` | runtime | immutable routing rows |
| `agent_definitions` | runtime | one per logical id |
| `agent_definition_revisions` | runtime | immutable; one per content hash under a logical id |
| `invocations` | runtime | one per logical execution; role, purpose, `continuedFromInvocationId`, status; manifest immutable |
| `attempts` | runtime | one per provider execution; `kind`, `startMode`, `resumedFromAttemptId` |
| `provider_continuations` | provider adapter | index keyed by Attempt; truncatable |
| `context_manifests` | runtime | exactly one per Invocation; immutable |
| `evaluations` | runtime / Evaluator via runtime | append-only |
| `gates` | runtime | one per Gate instance with outcome |
| `snapshots` | runtime (Workspace provider) | immutable |
| `changesets` | runtime (Workspace provider) | immutable metadata + diff Artifact |
| `publications` | runtime (publish action) | one per publish action on a `completed` Run |
| `capacity_leases` | resource governor | one per granted lease; grant and release times |
| `budget_reservations` | runtime | one per allocation; `active` → `released` once |
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
3. **Runtime core.** Runs, Execution Plan source validation and compiler,
   Plan Nodes of both kinds (`pattern`, `join`), Plan Edges, Plan Node
   Requirement scope, scheduler, resource governor, Budget reservations,
   Invocations (one per logical turn, with purposes), Attempts (`initial`,
   `retry`, with the provider adapter's optional pointer-based resumption),
   Context Manifests, results, Task states, Usage, Events. The provider
   adapter and its continuation payload store are built in
   `server/src/provider/` by extraction and rewrite from `server/src/sdk/`
   where rule 7 permits. Patterns `single` and `chain` first, then `route`,
   `parallel`, `coordinator_worker`, `evaluator_optimizer`, then
   composition and joins in the compiler. Integration tests with a fake
   provider for every Pattern, every compilation rule, and every invariant.
4. **Specification and verification.** Requirements (including
   `requirement_waiver` Decisions), Acceptance Criteria, Decisions with
   resolution policies, Evaluations, Gates, Agent Definition revisions and
   Tool Policy interception, Snapshots, Changesets, the Integration
   Workspace, and publishing.
5. **API and web.** Routes, event stream, views.
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
- Requirement tests: `satisfied` follows only from Gate Evaluations;
  `waived` follows only from a `requirement_waiver` Decision resolved by
  the operator with actor, rationale, Requirement id, timestamp;
  `record_decision` cannot create or resolve one; no policy resolves one; a
  later Requirement revision leaves existing scope rows unchanged.
- Decision tests: `use_default_after_deadline` is accepted for
  `operator_choice` only and resolves only with a recorded recommendation,
  deadline or condition, rationale, and affected ids, always writing
  `decision.resolved`.
- Publishing tests: a Run never writes to the Target; publish revalidates
  the Target, selects the strategy at publish time, fails without writing
  when the Target moved and the operation is not clean, and records a
  Publication, Event, and Artifact.
- Governor tests: leases are granted and refused deterministically with
  structured reasons; a refused Run is `waiting` with `provider_capacity`;
  the governor has no dependency on any model or prompt module.
- A database-open test for each of the three cases in section 4, run
  against a missing file, an empty database, a matching database, a legacy
  database, and an unrelated SQLite database.
- An import-boundary test (rule 7) proving that `core/` imports no other
  workspace package, that `server/src/persistence/` imports neither
  `shared/` nor `server/src/db/` nor any legacy runtime module, that no
  legacy module imports `core/` or `server/src/persistence/`, and that no
  legacy migration creates a new-schema table; and a terminology test
  (rule 10) over the new source directories.
- No live-provider tests in the default suite. A live smoke test may exist
  behind an explicit opt-in environment variable and is not a benchmark.

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
