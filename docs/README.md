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

## Legacy documents (scheduled for deletion at cutover)

These describe the current implementation. They are superseded by the
architecture documents above and are listed in the legacy-removal inventory.

- [orchestration.md](orchestration.md)
- [agent-handoffs.md](agent-handoffs.md)
- [requirements.md](requirements.md)
- [agent-stack-simplification-plan.md](agent-stack-simplification-plan.md)
