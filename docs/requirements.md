# The requirement graph

The canonical committed specification of an Agentique Console run: what must
become true of the finished work, held as a tree of declarative statements
with mechanically derived roll-up. This document is the reference for the
model — grammar, state, derivation, delegation, verification, termination —
the way `docs/orchestration.md` is the reference for the reasoning doctrine.
The compact forms live in the prompts and tool descriptions; the enforcement
lives in `shared/src/requirements.ts` (parser, renderers, derivation),
`server/src/orchestrator/requirements.ts` (the service), and the
`requirement_*` tables.

## The node model

A **requirement** is a declarative statement of something that must be true
of the finished work — *what*, never *how*. Requirements form a tree: the
root is the run's objective; an internal node composes its children with
`all` (every child must hold) or `any` (one sufficient child establishes the
parent). Depth is bounded only by the limits below — a node is a node,
whether it came from the operator's goals, main's decomposition, or a child
session's refinement. Execution structure (patterns, sessions, the task
ledger) is a different object entirely; they join by reference
(`tasks.requirement_id`, delegation records), never merge.

Each node carries:

- **id** — `r1`, `r2`, …: flat ids minted by the Console at approval in
  document order, per-session monotonic, never reused. Hierarchy lives in
  nesting (parentId), never in the id. The id is the stable key: status
  survives amendments because it is keyed by id, not by revision.
- **statement** — the checkable sentence. Quantitative thresholds ("p95
  latency ≤ 200 ms") belong in the statement; measured values belong in
  evidence. Neither is ever a score.
- **composition** — `all` (default) or `any`.
- **status** — `open`, `satisfied`, `violated`, `infeasible`, or `retired`.
  Semantic, never numeric.
- **origin** — `committed` (exists in an approved revision) or `refinement`
  (added by a session decomposing below a committed node).

## Scope versus state

Two change regimes, deliberately separated:

- **Committed structure** — statements, composition, which requirements
  exist at the committed level — changes only through operator-approved
  revisions (`propose_requirements` → plan-approval card → append-only
  `requirement_revisions`). Amendments supersede, never edit. The success
  condition is never silently redefined.
- **Live state** — statuses, evidence, verification records — changes
  continuously during the run without approval, journaled append-only in
  `requirement_status_changes`, evidence-required for every terminal status.
- **Decomposition** sits between them: `decompose_requirement` adds
  journaled `refinement` children under a committed (or delegated) node
  without approval, because refinement changes representation, not meaning.
  Editing a statement, retiring a node, or adding a new top-level obligation
  changes meaning → `propose_requirements`.

## The outline grammar

The one serialized form that is ever parsed (shared verbatim by the server's
approval path and the web card's live preview):

```
# <Title>

## Context          (optional prose sections — Goals, Out of scope, … — kept verbatim)

## Requirements
- r1: The CLI parses every documented flag
  - r2: `--help` output matches the documented flags
  - r3 (any of): Config is loadable
    - r4: TOML config parses
    - r5: JSON config parses
- r6: `npm run verify` passes from a clean checkout
```

Rules: only list items under `## Requirements` are nodes; a node is
`- [id][ (any of)]: statement`; an id must look like `r<digits>` (the parser
also tolerates dotted forms such as `r1.2` for compatibility, but the
Console never mints them and rejects ids it never minted) — any other
leading token (`- latency: 200ms`) is part of a new statement; a line
without an id mints a fresh id at approval; `(any of)` sets composition
`any`; nesting is by indentation (normalized on render); at most depth 8 and
200 nodes. A retired id never comes back: reintroducing a descoped
requirement means a fresh untagged line, minting a fresh id. The parser never throws — it returns structured
`{line, message}` errors, the resolve route rejects invalid operator edits
with 400 (the card stays pending), and the card disables Approve while its
live parse fails.

`renderCommitted` (structure only — the editable approval text) is a parser
fixed point: `renderCommitted(parse(x))` re-parses to the same graph.
`renderStatusOutline` (glyphs `·` open, `✓` satisfied, `✗` violated, `⊘`
infeasible, plus verification and evidence chips) is the digest/panel form
and is **never parsed**. Retired nodes are omitted from the outline
entirely — the revision history is where descoped obligations live.

## Approval diffs, id stability, retirement

On approval the service diffs the incoming outline against the live nodes in
one transaction:

- id present in old and new → statement/composition/position update; a
  **changed statement resets status to `open`** with a journaled
  console-actor change (the old evidence attested to different words).
- committed id absent from the new outline → `retired` at that revision —
  descoped, history kept — and its refinement descendants retire with it.
- line without an id → a new node, `introducedInRevision = N`.
- a refinement node named in the approved outline is **promoted** to
  committed.

Unchanged statements keep their status and evidence across amendments by
construction.

## Derivation

Parent statuses are computed by the Console from live (non-retired)
children — a pure function, never stored, never asserted by a model:

- `all`: `violated` if any child is violated; else `infeasible` if any child
  is infeasible; else `satisfied` iff every child is satisfied; else `open`.
- `any`: `satisfied` if any child is satisfied; `violated` only when every
  child is violated; `infeasible` when every child is terminal-negative and
  at least one is infeasible; else `open`.

A node with no live children derives as its own reported status. Models
report at the **leaves** (a report on a node with live children is rejected
with the leaf list); the roll-up is mechanical. This is the same stance the
pattern contracts take: the Console executes contracts and never branches on
names.

## Verification

A status change is a journaled **claim carrying evidence**, never a direct
write of truth:

- Terminal statuses (`satisfied`, `violated`, `infeasible`) require at least
  one evidence ref; `open` (reopening) does not.
- `verifiedBy` records the tier: `self` (the doing agent's claim plus its
  evidence), `independent` (a different seat — typically a reviewer-archetype
  profile, write-isolated from the work it judges — confirmed it),
  `operator` (their word IS the gate; evidence optional), and `console`
  (mechanical resets such as "statement amended in rev N" — never
  model-selectable).
- The review ladder in `docs/orchestration.md` decides which tier a given
  risk deserves. The Console records and displays the tier; it never blocks
  on it, and it never machine-gates completion — the operator remains the
  gate.

## Delegation and subtrees

Commissions (`create_agent_session`) and assignments (`send_to_coordinator`)
carry `requirements: [ids]` — the open obligations the work serves. The
Console journals the join (`requirement_delegations`, `requirement.delegated`)
before the briefing dispatches, renders the delegated statements and
statuses into the recipient's delivery, and scopes the session's requirement
tools to those **subtrees**: a seat may report or decompose any descendant
of a delegated node, and nothing outside. `create_child_session` passes a
subset down — each requested id must sit within the parent session's
delegated subtrees — so nesting is visible as deepening decomposition of one
graph rather than a fork of it.

## The frontier

The open requirements — every requirement whose resolution can still affect
the root (under an `any` parent, a satisfied sibling prunes the rest) —
annotated from console-owned facts only: `in_progress` (live delegation to
an open session), `blocked` (a linked task with incomplete dependencies, or
a dependency-parked assignment), `awaiting_operator` (a pending interaction
raised from a session holding the delegation), `unassigned` (none of the
above). A `self`-tier `satisfied` claim renders its verification chip, so
"awaiting independent verification" is visible without a bespoke state. The
frontier is what the completion nudge names and what steering aims at.

## Termination

Non-success termination is legitimate. The run verdict derives as: `failed`
(finals failed) → `infeasible` (the console-derived root marks the objective
infeasible — first-class and evidence-backed, not a failure to be hidden) →
`completed_with_caveats` (open or violated
requirements, open tasks, unresolved uncertainty, deviations) → `completed`.
Budget exhaustion pauses with an honest wrap-up; a decision only a human can
make routes through `ask_operator` — those are the other two legitimate
non-success stops, and both already exist outside the graph.
`record_completion` maps requirement ids to evidence against the **current**
revision (a stale `requirementsRevision` is rejected); it is advisory to the
sign-off card, deliberately never a gate.

## The five archetypes

Every agent profile declares a `role`; profiles stay narrow-capability, the
archetype names what kind of progress the seat produces:

- **orchestrator** — decomposes, delegates, integrates, reports
  (`coordinator`; main is the run-level instance).
- **explorer** — produces knowledge about what is (`explorer`,
  `researcher`).
- **planner** — produces strategy: refined decomposition, sequencing, task
  DAGs with per-unit acceptance stated as the requirement each unit
  discharges (`planner`).
- **implementer** — changes the artifact (`implementer`,
  `frontend-implementer`).
- **reviewer** — produces verification evidence, write-isolated from the
  work it judges (`reviewer`, `visual-reviewer`) — the seats whose reports
  warrant the `independent` tier.

Minted variants inherit their base's role.

## Non-goals

- **No numeric progress scalars** — no merit scores, percentages, weights,
  or completion fractions anywhere in the model. Counts of semantic statuses
  ("3/9 satisfied") summarize; they are never optimized against. Thresholds
  live in statements; measurements live in evidence.
- **No machine completion gate** — the Console derives and displays; the
  operator decides.
- **No separate execution-graph object** — patterns, sessions, and the task
  ledger already are the execution structure; they reference requirements,
  never duplicate them.
- **No automatic conversion of legacy markdown specs** — that would
  fabricate commitments the operator never approved. Legacy runs keep the
  spec path end to end; main may *propose* a graph derived from the old spec
  when such a run continues.
