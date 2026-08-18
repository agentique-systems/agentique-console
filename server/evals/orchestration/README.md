# Orchestration evaluation framework

Measures whether the Master Orchestrator actually orchestrates well — not
merely whether its tools work. Two tiers share one checker library
(`checks.ts` over `trace.ts`), so a check validated here means the same thing
against a live run.

## Tier A — structural (fake SDK, deterministic, gates CI)

```
npm test                # picked up by the normal suite
npx vitest run evals/orchestration/structural.eval.test.ts
```

Every Tier A scenario ships an `exemplary` program variant AND at least one
violation variant — a meta-assertion in the suite enforces it, because a
checker only counts as validated once a violating trace has proven it can
flag. (visual-judgment is live-only by design and exempt.) **Tier A cannot
measure orchestration judgment** — main's turns are scripted by us. Its
real products are: a regression net over the substrate (alarms, interrupts,
routing, recovery, restart phases), the *evaluability contract* (every
signal a judge or metric needs is actually journaled — if a refactor stops
journaling question events, this suite goes red), and a validated checker
library for Tier B. Never present Tier A green as "orchestration improved."

## Tier B — live (real model, priced, manual, informs — never gates)

```
AGENTIQUE_LIVE_ORCH_EVAL=1 npm run eval:orchestration:live -- --scenario smoke --runs 2 --label after-charter
AGENTIQUE_LIVE_ORCH_EVAL=1 npm run eval:orchestration:judge -- evals/orchestration/results/runs/<seriesDir> --reps 3
npm run eval:orchestration:compare -- evals/orchestration/results/runs/<seriesDir>
```

**Two kinds of repetition, never blended.** `--runs N` executes the
orchestrator N independent times (behavioral variance; cheap scenarios
default to 2–3 via `defaultRuns`, expensive ones to 1). `--reps M` re-judges
one frozen trace M times (judge variance). The compare report shows each
axis separately; an N=1 series is labeled a **single behavioral sample** and
makes no behavioral-variance or stability claim. A failed judgment is
recorded as an error entry and reported as `k/M judgments succeeded` — never
silently absent.

Each run gets a fresh data dir and fixture workspace (committed as a
`fixture-baseline` for the artifact diff), the real app over the real SDK, the
scenario's scripted operator, and hard budget/timeout guards. Outputs per run:
`console.db`, `run.json` (mechanical metrics), `transcript.md` (judge input),
`checks.json` (the shared checkers), `workspace/` (the artifact snapshot, with
git history), `worktrees/` (unmerged seat work), `judgment.json`
(per-dimension scores + verbatim notes).

**Prerequisites (clean checkout):** `npm ci` at the repo root;
`AGENTIQUE_LIVE_ORCH_EVAL=1` (the spend gate); real SDK credentials in the
environment; `git` on PATH. Fixtures are committed under `fixtures/` — nothing
to download. A scenario whose prerequisite is missing (a fixture, a browser
MCP) **SKIPs with a printed reason**; `--scenario all` and `smoke` always
complete.

`--scenario smoke` = vague-greenfield, wasteful-parallelism,
hidden-constraint — the routine charter-iteration trio. `--scenario all` =
every live-enabled scenario, for post-change reference series.

**Structural-only scenarios** (no live block, by design): agent-failure and
hung-agent — their premises are induced failures (an error-streak corpse, a
wedged tool call) that cannot be reproduced deterministically live, and a
nondeterministic premise makes their checks flag for want of a premise, not
for want of orchestration quality. Tier A owns that substrate; live
supervision quality is judged opportunistically wherever a real alarm fires.

## The reference series (post-change)

The skipped pre-change baseline was a deliberate operator decision — this
framework measures the CURRENT orchestrator forward. The first accepted
series after a behavior-affecting change becomes the reference:
`results/baseline.json` holds its per-scenario, per-dimension medians, and
updating it is an explicit, human-reviewed commit citing trace evidence.

## Goodhart policy (binding)

1. Judged scores never gate merges; only Tier A's structural invariants do.
2. No scalar collapse: reports are per-dimension, and a delta without its
   qualitative note is not evidence.
3. Rubric text must never enter any orchestrator prompt. (Enforced by
   `rubric-leak.test.ts` in CI.)
4. Never score pivot counts (score evidence-responsiveness) and never reward
   reviewer counts (score evidence sufficiency relative to stakes).
5. Trace quality and artifact quality are separate axes: a beautiful trace
   with an inferior artifact is a failure; a good artifact from a poor process
   is flagged as luck.
6. Rotate fresh scenarios in periodically; keep 1–2 unpublished hold-outs for
   major evaluations.
7. Baseline bumps are explicit, human-reviewed commits citing trace evidence.

## Ablations (deliberately deferred)

No ablation mechanism exists, on purpose. Ablations answer "which expensive
capability earns its cost" — a question that is only posable against a
reference series, and none has been run yet. Building env-gated prompt
excision now would create unexercised config paths and push the brief toward
a template engine. When a reference series exists and a capability's
contribution is genuinely uncertain, add the narrowest switch that answers
that one question (a scalpel, never a standing experimental program).

## Layout

```
trace.ts               journal read API (both tiers)      scenario.ts   types
checks.ts              dimension-tagged checkers          programs.ts   fake-program combinators
structural-runner.ts   Tier A engine (proposals, restart phases)
structural.eval.test.ts  CI gate                          scenarios/    the suite + PLANNED list
live/run-live.ts       Tier B runner (--runs series)      live/operator-policy.ts  scripted operator
live/export-trace.ts   run.json + transcript + spine + evidence packets
live/export-evidence.ts  the artifact bundle (tree/diff/validator/screenshots)
live/judge.ts          trace + outcome axes               live/compare.ts  two-axis baseline diff
rubrics/               one .md per judged dimension       fixtures/     committed workspace seeds
rubric-leak.test.ts    Goodhart rule 3, enforced          export.test.ts  export logic, CI-proven
results/baseline.json  committed medians                  results/runs/ raw runs (gitignored)
```
