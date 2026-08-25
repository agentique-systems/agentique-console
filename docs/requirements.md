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
- **verify expectation** — optional `(verify: independent)` or
  `(verify: operator)`: the verification this requirement's satisfaction
  deserves, declared in the committed outline — the proof method chosen
  before the work, not after it. Absent means the doing seat's own evidenced
  claim suffices. A declaration covers its whole subtree (strongest ancestor
  wins), so decomposed children inherit it.
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
  - r2 (verify: independent): `--help` output matches the documented flags
  - r3 (any of): Config is loadable
    - r4: TOML config parses
    - r5: JSON config parses
- r6: `npm run verify` passes from a clean checkout
```

Rules: only list items under `## Requirements` are nodes; a node is
`- [id][ markers]: statement` where the markers are `(any of)` and/or
`(verify: independent|operator)` in any order and case (the canonical render
emits `(any of)` first); an id must look like `r<digits>` (the parser
also tolerates dotted forms such as `r1.2` for compatibility, but the
Console never mints them and rejects ids it never minted) — any other
leading token (`- latency: 200ms`) is part of a new statement, but an
unknown or duplicate paren marker AFTER a valid id (`- r4 (any off): x`) is
a line error, never a silent fresh mint that retires the old node's status
history; a line
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

- id present in old and new → statement/composition/position/expectation
  update; a
  **changed statement resets status to `open`** with a journaled
  console-actor change (the old evidence attested to different words), while
  a **changed verify expectation never resets status** — the statement the
  evidence attested to is unchanged; the gap simply derives from the
  standing claim.
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
- `verifiedBy` records the tier, and the Console **derives** it from who
  stood behind the claim — the reporting model never selects it (the
  measured party does not classify its own measurement's independence):
  `operator` for the operator's own verdicts (their word IS the gate;
  evidence optional); `independent` only when the claim was filed by a seat
  whose commission-time profile snapshot is a **write-isolated reviewer**
  (role `reviewer`, no Edit/Write) — which is why reviewer-archetype seats
  hold `report_requirement` wherever they sit in a topology; `self` for main
  and every write-capable seat (a read-only coordinator relaying an
  implementer's claim records `self`: relaying is not verifying — the
  reviewer files its own verdict); `console` for mechanical resets such as
  "statement amended in rev N".
- The review ladder in `docs/orchestration.md` decides which tier a given
  risk deserves. The Console records and displays the tier; it never blocks
  work on it. An unmet declared expectation reaches sign-off as a typed
  coverage exception for the operator to explicitly waive — the operator
  remains the gate.

Two verification read-models derive from the journal, displayed everywhere
statuses appear (digest, `read_requirements`, the panel, the completion
nudge, the persisted run summary and sign-off card). Neither blocks work or
the completion proposal; a verification gap does surface at sign-off as a
typed coverage exception the operator must explicitly waive to accept
(under the default `waiver_required` completion policy — see Termination):

- **Verification gaps** — satisfied leaves whose recorded tier falls below
  their effective declared expectation (own or inherited `(verify: …)`
  marker, strongest wins; an operator verdict satisfies an `independent`
  expectation).
- **Reversals** — terminal claims the run itself later withdrew (a status
  CHANGE away from satisfied/violated/infeasible by anyone but the console;
  a reviewer's same-status tier upgrade withdraws nothing; the operator's
  own reopen counts, attributed). Each reversal carries both sides — who
  withdrew it and the tier/actor of the original claim — the honest measure
  of verification quality, exported to the Tier-B evaluation.

## Delegation and subtrees

Commissions (`create_agent_session`) and mid-run steers
(`send_to_coordinator`, assignment or update alike) carry
`requirements: [ids]` — the open obligations the work serves. The journal
records who delegated, three ways: `commission` (at creation),
`assignment` (main, mid-run — either message category), `child` (a
controller passing a subset down). The
Console journals the join (`requirement_delegations`, `requirement.delegated`)
before the briefing dispatches, renders the delegated statements and
statuses into the recipient's delivery, and scopes the session's requirement
tools to those **subtrees**: a seat may report or decompose any descendant
of a delegated node, and nothing outside. `create_child_session` passes a
subset down — each requested id must sit within the parent session's
delegated subtrees — so nesting is visible as deepening decomposition of one
graph rather than a fork of it.

Two session-level annotations ride the delegation model, both derived and
neither a gate:

- **Unscoped** — an open session commissioned after requirements began
  governing, holding zero delegations. Rendered on every read surface and in
  the Tier-B export, with a `scopeNote` in the create tool's result — never
  a rejection: exploration before decomposition and utility sessions are
  legitimate, and the operator sees which is which.
- **Commission budget** — `create_agent_session` may set a `budgetUsd`
  ceiling covering the session and its children. Crossing it fires two
  one-shot notices (an honest wrap-up instruction to the entry agent, an
  escalation to main naming the delegated open frontier) — stop-and-escalate
  like the run-level budget pause, but scoped: nothing is cancelled, the run
  does not pause, no final is blocked. A resource cap, not a score.

## The frontier

The open requirements — every requirement whose resolution can still affect
the root (under an `any` parent, a satisfied sibling prunes the rest) —
annotated from console-owned facts only: `in_progress` (live delegation to
an open session), `blocked` (a linked task with incomplete dependencies, or
a dependency-parked assignment), `awaiting_operator` (a pending interaction
raised from a session holding the delegation), `unassigned` (none of the
above). Verification debt is its own derived list beside the frontier — the
verification gaps above — so "satisfied below its declared tier" is
structural, not a display chip. The completion nudge names both, and
steering aims at them.

## Revision currency and change impacts

Claims already carry currency: every status change stamps the governing
revision (`atRevision`) and a per-project monotonic ordinal (`ord`, shared
with assumption resolutions), the revision pointer re-anchors every seat
delivery, and `record_completion` must match the current revision. The
change-impact ledger (`change_impacts`, `ChangeImpactService`) closes the
remaining gap: when an approved amendment, a falsified assumption, or a
withdrawn terminal claim can make prior evidence or active work stale, the
Console computes the **transitive closure** — changed/retired seeds, their
descendants, dependents through `depends_on` (edges onto an *ancestor* of an
affected node fire too, since depending on a node means depending on the
subtree that composes it), and the dependents' descendants, to a fixed
point; amendments compute against pre-approval state so dependents of
retired nodes are captured before retirement removes their links — and
persists it as one impact row: suspect terminal claims, affected open
sessions, requirement-linked incomplete tasks, live scheduled assignments.
Affected sessions extend through live workstream dependency links to their
open consumers, transitively (`via` names the coupling), so an amendment
that touches a producer reaches the workstreams consuming its interface.
Idempotent per source event and per still-open seed set.

Reconciliation is **derived, never stored**: a suspect claim clears when a
strictly later claim lands on its requirement (reopen, re-verify,
retirement — acting through the normal tools IS reconciliation); an affected
session clears when archived; everything else needs a recorded judgment via
`reconcile_change_impact` (claims: `stands`/`superseded`; sessions:
`unaffected`/`steered`/`interrupted`/`superseded`; each with a why,
journaled as `change_impact.reconciled`). The Console computes consequences;
main and the operator judge meaning — nothing is auto-reopened. An open
impact holds the completion **proposal** (the nudge names its outstanding
items), so stale evidence and un-steered work cannot silently reach
sign-off, across restarts included; the operator's verdict remains theirs.

## Termination

Non-success termination is legitimate. The run verdict derives as: `failed`
(finals failed) → `infeasible` (the console-derived root marks the objective
infeasible — first-class and evidence-backed, not a failure to be hidden) →
`completed_with_caveats` (open or violated
requirements, open tasks, unresolved uncertainty, deviations, or any
coverage exception below) → `completed`.
Budget exhaustion pauses with an honest wrap-up; a decision only a human can
make routes through `ask_operator` — those are the other two legitimate
non-success stops, and both already exist outside the graph.
`record_completion` maps requirement ids to evidence against the **current**
revision (a stale `requirementsRevision` is rejected); it is main's
synthesis beside the console's facts, deliberately never the authoritative
coverage.

The authoritative accounting is the **completion coverage report**
(`completion/coverage.ts`), derived from durable state at proposal time and
persisted complete with the run summary: every live root-affecting leaf
exactly once (parents derive; unchosen alternatives under a satisfied
`any` classify as `moot`), each with its state, staleness (the invalidation
flags above), actual evidence refs, and declared-vs-recorded verification
tier — plus live requirement-linked task debt and provisionally-proceeded
decision issues. Anything unmet is a **typed exception**
(`requirement_unsatisfied`, `requirement_stale`,
`verification_below_declared`, `evidence_missing`, `task_debt`,
`decision_provisional`). Sign-off is exception-oriented: under the default
`waiver_required` policy (`CONSOLE_COMPLETION_POLICY`), accepting a run
with outstanding exceptions requires one typed waiver per exception —
recorded durably on the summary, scoped to the exception's object and the
revision accepted; under `advisory`, exceptions are enumerated but
one-click accept stays legal. The accept path recomputes coverage as a
staleness guard: if the governing revision or reconciliation state moved
while the proposal was pending, the proposal is visibly superseded and
re-proposed rather than silently accepted. The operator remains the gate —
the report changes what they are asked to accept, not who decides.

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
  operator decides. The Console does hold the *proposal* until run-level
  bookkeeping exists — a completion record against the current revision, no
  unreconciled change impacts — but those demand recorded judgment, never a
  particular verdict.
- **No separate execution-graph object** — patterns, sessions, and the task
  ledger already are the execution structure; they reference requirements,
  never duplicate them.
- **No fabricated structure from legacy markdown specs.** When migration
  0017 retired the legacy spec store, each open pre-graph run's approved
  spec became an approved *intent* revision — the prose governs, with zero
  requirement nodes minted, because minting statements would fabricate
  commitments the operator never approved as statements. Main may *propose*
  a graph derived from that prose when such a run continues; every spec
  document was archived verbatim to `event_artifacts`.
