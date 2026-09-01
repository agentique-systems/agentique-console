# Documentation index

## Architecture (authoritative)

The orchestration architecture is defined by four documents under
`docs/architecture/`. They are authoritative over every other document in
this repository, including the top-level `README.md`, until the cutover
described in the migration contract replaces the rest.

- [Glossary](architecture/glossary.md) — the canonical vocabulary, object
  ownership, identifier conventions, and the list of retired terms.
- [Execution model](architecture/execution-model.md) — actors, state
  ownership, Run lifecycle, the Execution Plan (source form, compiler, flat
  compiled graph of `pattern` and `join` nodes, pinned Requirement scope),
  the six Patterns, one Invocation per logical turn, runtime
  responsibilities including Budget reservations, Task states, and the
  resource governor, Decisions and operator-only waivers, Agent Definition
  revisions, verification and Gates, integration and publishing, usage
  accounting, and the invariants.
- [Migration contract](architecture/migration-contract.md) — the terms of
  the clean-break replacement: no data migration, no compatibility period,
  no legacy API, no alternate runtime, no feature flag.
- [Legacy removal](architecture/legacy-removal.md) — the inventory of
  modules, tables, routes, types, events, tools, prompts, tests, scripts,
  configuration, documents, and UI components that are deleted or replaced,
  each mapped to its final replacement.

## Final module boundaries

The replacement is built inside two permanent boundaries that coexist with
the legacy code during construction and remain after cutover:

- `core/` (`@agentique-console/core`) — the provider-neutral domain
  package: types, identifiers, state sets, transition validators, runtime
  schemas, and Event contracts. Replaces `shared/` at cutover.
- `server/src/persistence/` — the server persistence boundary: SQLite
  schema, client, database-open guard, baseline migration, stores,
  transaction helpers, Artifact blob store. Replaces `server/src/db/` at
  cutover.

Neither imports from, exports to, or is selected against its legacy
counterpart; see the migration contract §2–§4.

## Delivery tracking (not binding on semantics)

- [Implementation roadmap](implementation-roadmap.md) — the original
  phases 0–10 of the replacement, what each has shipped under which
  subphase label, the evidence, the remaining work, and each phase's
  completion condition. A ledger of progress; the architecture documents
  define the semantics.

## Proposals (not binding)

Design proposals under `docs/proposals/` are reviewable drafts. They bind
nothing until a decision moves their content into the architecture
documents; a proposal never describes a guarantee as implemented. Once
decided, a proposal records its disposition and points at the binding
text.

- [Artifact blob crash recovery](proposals/artifact-crash-recovery.md) —
  the pending-write marker protocol; accepted with amendments and
  implemented on 2026-09-01, now binding as execution-model §2.1. The
  proposal keeps the options considered and its disposition.

## Legacy documents (scheduled for deletion at cutover)

These describe the current implementation. They are superseded by the
architecture documents above and are listed in the legacy-removal inventory.

- [orchestration.md](orchestration.md)
- [agent-handoffs.md](agent-handoffs.md)
- [requirements.md](requirements.md)
- [agent-stack-simplification-plan.md](agent-stack-simplification-plan.md)
