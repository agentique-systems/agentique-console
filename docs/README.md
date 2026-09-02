# Documentation index

## Architecture (authoritative)

The orchestration architecture is defined by four documents under
`docs/architecture/`. They are authoritative over every other document in
this repository, including the top-level `README.md`.

- [Glossary](architecture/glossary.md) — the canonical vocabulary, object
  ownership, identifier conventions, and the list of retired terms.
- [Execution model](architecture/execution-model.md) — actors, state
  ownership, Run lifecycle, the Execution Plan (source form, compiler, flat
  compiled graph of `pattern` and `join` nodes, pinned Requirement scope),
  the six Patterns, one Invocation per logical turn, runtime
  responsibilities including Budget reservations, Task states, and the
  resource governor, Decisions and operator-only waivers, Agent Definition
  revisions, verification and Gates, integration and publishing, usage
  accounting, and the invariants (§15).
- [Migration contract](architecture/migration-contract.md) — the terms
  under which the clean-break replacement was built and cut over: no data
  migration, no compatibility period, no legacy API, no alternate runtime,
  no feature flag. Its §9 acceptance is the definition of done that the
  roadmap's Phases 9 and 10 report against.
- [Legacy removal](architecture/legacy-removal.md) — the inventory of
  modules, tables, routes, types, events, tools, prompts, tests, scripts,
  configuration, documents, and UI components that the cutover deleted or
  replaced, each mapped to its final replacement. Every entry has been
  executed; the inventory remains as the record of what was removed and
  where each responsibility now lives.

## Module boundaries

- `core/` (`@agentique-console/core`) — the provider-neutral domain
  package: types, identifiers, state sets, transition validators, runtime
  schemas, the Event contracts, and the HTTP API contract
  (`core/src/api.ts`: the route table, request schemas, response types,
  bounds, and error codes the server serves and the web application
  consumes).
- `server/src/persistence/` — the persistence boundary: SQLite schema, the
  single baseline migration, the database-open guard that refuses any
  database not created by it, stores, transactions with commit listeners,
  the journal, and the Artifact blob store with its crash-recovery
  protocol.
- `server/src/execution/` — the durable execution engine: the scheduler,
  Invocation and Attempt execution, runtime tools, Gates, completion,
  signoff, publication, Budget growth, run control, and recovery.
- `server/src/provider/`, `server/src/workspace-state/`,
  `server/src/agents/` — the Claude Agent SDK adapter and its fixture, the
  git and directory Workspace providers behind the six ports, and Agent
  Definitions.
- `server/src/composition/` — one composition of the runtime for
  production, tests, and the verification entrypoint.
- `server/src/host/`, `server/src/events/`, `server/src/operator/`,
  `server/src/api/`, `server/src/workspaces/` — the process host around
  the scheduler, the committed-event stream, the operator services and
  projections, the HTTP routes, and browse-root file access.
- `web/` — the operator web application over the API and the event
  stream.

`server/src/persistence/boundaries.test.ts` enforces the import rules
between these boundaries, the retired vocabulary across `core/`, `server/`,
and `web/`, the single scheduler, and the startup order.

## Delivery tracking (not binding on semantics)

- [Implementation roadmap](implementation-roadmap.md) — the original
  phases 0–10 of the replacement, what each shipped, the evidence, and
  each phase's completion condition. Phases 0–9 are complete; Phase 10 is
  implemented on the branch with its merge to `main` pending review. The
  architecture documents define the semantics; the roadmap is a ledger.

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
