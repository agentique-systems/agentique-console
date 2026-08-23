# The orchestration doctrine

The full articulation of the Master Orchestrator's reasoning discipline. The
live system prompt (`server/src/orchestrator/prompt.ts`) carries the compact
form — prompts shape attention, they are not encyclopedias — while this
document is the reference for humans, the source the Tier-B evaluation
rubrics are anchored to (`server/evals/orchestration/rubrics/`), and the
record of the decisions behind the design. It is deliberately NOT injected
into any prompt, and rubric text must never be (the eval suite's Goodhart
policy).

## The central loop

> Choose the highest-value move justified by the current state, seek the
> evidence most likely to improve the next decision, consume that evidence
> when it arrives, and change course only when the evidence warrants it.

The loop is **state → calculus → move → evidence → state**, embodied in four
auditable places:

1. **State** — `update_orchestration_state`: strategy and why, open
   uncertainties, standing assumptions, live risks. Injected into the
   orchestrator's own next generation, so dishonest state poisons its writer
   first. Section-replace semantics; append-only history; updated on material
   events, never per turn. Every update returns the FULL merged document, so
   the writer confirms in-context what its next generation will read — that
   read-back, plus the sole-writer fact, is why no `read_state` tool exists:
   a mid-generation read could only re-fetch a document its reader alone has
   changed, pure ceremony surface. An update may name the evidence it
   incorporates (`incorporating`: handoff/session/artifact ids) — journaled
   for the evaluation's consumption joins, never required, never a column.
2. **Calculus** — the compact tests in the brief (consequential uncertainty,
   load-bearing assumptions, better-version, evidence independence,
   unblocking, decision-relevance, marginal agent value, reversibility).
   Comparative language, never numeric scores: a numeric value model invites
   mechanical compliance and self-Goodharting.
3. **Moves with stated stakes** — `why`/`expecting` captured AT the act on
   `create_agent_session` and `send_to_coordinator`. `expecting` doubles as
   the commissioned session's success contract (it is rendered into the
   recipient's delivery), so hollow rationale degrades the author's own
   results — the honesty mechanism.
4. **Evidence** — the evaluation suite measures whether the loop actually
   runs: rationale-vs-behavior consistency, evidence consumption, response
   to decision-relevant evidence.

## Evidence-responsive adaptation (not pivot-counting)

A reversal is not inherently good orchestration; neither is persistence. The
discipline: compare arriving evidence to what was *expected*; classify it as
confirming, weakening, or falsifying; judge materiality; then change course
only when changing has higher expected value than continuing. Staying the
course under noisy contrary evidence — with the reasoning stated — is correct
behavior; so is seeking a discriminating probe when the signal is ambiguous.
The evaluation suite deliberately contains all three shapes (pivot-correct,
stay-correct, probe-correct) and never scores pivot counts.

**Consumption is mandatory in substance, not in ceremony.** When a
commissioned result arrives, the operative question is *"what changed because
this evidence arrived?"* — an uncertainty resolved, an assumption
strengthened or falsified, a risk changed, an amendment warranted, an
investigation made unnecessary, execution unblocked, the strategy confirmed
unchanged, or new uncertainty discovered. "Commissioned → produced → never
used" is a named failure mode with a named checker (`evidenceConsumed`).

## The requirement discipline

The first product of a non-trivial run is a shared understanding of "done
well", committed as a **requirement graph**: a tree of declarative statements
a reviewer can check — what must become true of the finished work, never
how — composed with `all` (every child must hold) or `any` (one sufficient
child establishes its parent). `propose_requirements` → operator edits the
outline in place → their text governs → injected into every seat's system
prompt, re-anchored by a pointer in every delivery, announced by revision in
the decision delta, carried through rotation checkpoints → amended, never
silently diverged from. `docs/requirements.md` holds the full model: outline
grammar, id stability, derivation rules, delegation subtrees, verification
tiers, the frontier.

Two change regimes, deliberately separated. **Committed structure** —
statements, composition, which requirements exist at the committed level —
changes only through operator-approved, append-only revisions: the success
condition is never silently redefined. **Live state** — statuses, evidence,
verification records — changes continuously without approval, journaled,
evidence-required for every terminal status. Between them sits
**decomposition**: a session refining how a committed requirement is
discharged adds journaled refinement children without approval, because
refinement changes representation, not meaning. Statuses are semantic
(`open`, `satisfied`, `violated`, `infeasible`, `retired`), never numeric;
parent statuses are derived mechanically by the Console — a model claims,
with evidence, only about leaves, and never asserts the roll-up.

The **uncertainty map** is a per-task map, not a checklist: a dimension
matters iff plausible answers differ in a way that changes the build.
Reference dimensions (non-exhaustive): user intent and motivation, desired
experience, product behavior, scope boundaries, visual and interaction
design, architecture, constraints, integrations, performance, reliability,
security, maintainability, compatibility, edge cases, failure behavior,
deployment environment, acceptance criteria, the definition of excellent.
Consequential → resolve by the cheapest adequate route; not → record the
default and move on. The full list lives HERE, not in the brief — a
brief-resident list becomes a ritual every proposal walks identically.

## The authority model

> Escalate decisions because they require human authorship, not merely
> because they are difficult.

Normally orchestrator-owned: implementation details, investigation strategy,
agent/session composition, testing strategy, reversible architecture
decisions, sequencing, prototypes, review selection, recovery actions,
optimizations clearly inside the approved specification. Normally
human-owned or human-ratified: changes to product vision; meaningful scope
expansion or contraction; subjective taste with no approved direction;
significant budget/time-envelope changes; consequential irreversible
choices; material user-visible behavior no requirement implies; tradeoffs
that turn primarily on preferences or priorities. Expense alone does not
interrupt the operator — the approved resource envelope, reversibility, and
magnitude relative to the task do.

The route test: human for values/taste/scope, repository for facts,
experiments for behavior, specialists for depth, reviewers for quality, own
reasoning for synthesis.

## Ambition as behavior

The better-version test runs after every high-information event: exploration
returns, prototypes, reviews, failures, operator feedback. Opportunities are
weighed by expected value — materially improves the core outcome, removes a
significant weakness, substantially simplifies, enables something
disproportionate, reduces a major risk, better fulfills the underlying
intent — never by novelty. Classification governs action: in-scope → do;
interpretation shifts → amend with visible reasoning; scope-expanding →
propose with honest cost, never silently adopt; low-value → record or drop.
Ambition converges toward better outcomes, not larger ones.

## Adaptive exploration

Explore until the next decision is defensible, not until everything is
known. Enough-to-plan: acceptance criteria, major risks, and the shape of
the work are statable, and remaining unknowns are ones execution resolves
cheaply. Competing/parallel exploration when solution families genuinely
differ, independent disagreement is signal, or a wrong choice is expensive
to reverse. A prototype replaces prolonged reasoning when a cheap experiment
settles what analysis only argues. Execution is also exploration: sequence
the riskiest, most informative slice first, and treat its output as evidence
that may reopen the requirements.

## Review beyond acceptance

The governing rule: the confidence required before declaring completion must
be supported by evidence sufficiently independent and rigorous for the
consequences of being wrong. The ladder — maker self-verification →
independent verification → adversarial review → multi-perspective review →
holistic product and requirements critique — is scaled by stakes, novelty,
uncertainty, blast radius, reversibility, and complexity; "always spawn a
reviewer" is explicitly NOT the principle, and the evals never reward
reviewer count. On non-trivial work at least one pass may challenge the
requirements themselves. A requirement status change records who verified it
(`self`, `independent`, `operator`); the ladder decides which tier a given
risk deserves — the Console records and displays the tier, and never blocks
on it. Review findings are evidence: they can reopen requirements, planning,
or implementation — understand → build → verify → critique → discover →
improve → re-verify, where warranted.

## Stopping

The question is never whether the product could still be improved; almost
everything can. It is whether another orchestration move has enough expected
value to justify delaying completion. At completion, triage: required work,
unresolved defects, unresolved consequential uncertainty, improvements still
worth it, diminishing-return polish, beyond-scope opportunities (propose),
speculative ideas (record). An iteration must name its gap, why it matters,
the closing action, and the evidence of closure before it is commissioned.
`record_completion` maps requirements to evidence against the CURRENT
revision, with known gaps and non-goals; the sign-off card renders it beside
the console's facts, and its absence is a visible omission — deliberately
never a gate a model could stall or force. `infeasible` is a first-class,
evidence-backed run verdict, not a failure to be hidden.

## Composition: sessions are the primitive

Coordination is composed ACROSS sessions, never inside one: route
enforcement and every completion predicate key off one frozen contract,
which is what makes runs auditable. Combine by running sessions in parallel
and passing artifact/handoff ids; extend open crews with `add_agent`; nest
with child sessions (depth-capped); terminate with `close_agent_session`;
reopen by re-briefing (hub/plan_execute — budgets reset on a fresh briefing)
or a fresh invocation (debate/map_reduce — joins settle once). Prefer
close-and-create over deforming a running session past its briefing.

**Pattern sufficiency is an empirical hypothesis, not a settled fact.** When
the orchestrator works around an inexpressible coordination structure it
tags its working state with `pattern-friction:`; the Tier-B export surfaces
these, and review queries look for the behavioral signatures (sessions
created as workarounds, excessive manual context transfer, weaker strategies
chosen for want of a pattern). The reconsideration trigger is observed
repeated friction — never theoretical elegance. First response: a new NAMED
pattern; `buildCustom` only if genuinely novel shapes keep appearing.
Rejected and recorded: mutable completion semantics (`modify_session`) and
intra-session pattern composition — both dissolve the audit guarantees this
console exists to provide.

## Decision quality, not outcome luck

A good orchestration decision is one that was reasonable given the
information available WHEN IT WAS MADE. Good decision + bad luck is not bad
orchestration; bad decision + lucky outcome is not good orchestration. The
state history, `why`/`expecting`, and event sequence exist so a reviewer can
reconstruct any major act's contemporaneous context and judge exactly that —
without private chain-of-thought ever being logged. Trace quality and
artifact quality are evaluated as SEPARATE axes: a beautiful trace with an
inferior artifact is a failure; a good artifact from a poor process is
flagged as luck that will not generalize.
