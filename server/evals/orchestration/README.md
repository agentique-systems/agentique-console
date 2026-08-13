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

Every scenario ships an `exemplary` program variant and violation variants;
the suite asserts the checkers pass the former and flag the latter. **Tier A
cannot measure orchestration judgment** — main's turns are scripted by us. Its
real products are: a regression net over the substrate (alarms, interrupts,
routing, recovery), the *evaluability contract* (every signal a judge or
metric needs is actually journaled — if a refactor stops journaling question
events, this suite goes red), and a validated checker library for Tier B.
Never present Tier A green as "orchestration improved."

## Tier B — live (real model, priced, manual, informs — never gates)

```
AGENTIQUE_LIVE_ORCH_EVAL=1 npm run eval:orchestration:live -- --scenario smoke --label after-charter
AGENTIQUE_LIVE_ORCH_EVAL=1 npm run eval:orchestration:judge -- evals/orchestration/results/runs/<dir>
npm run eval:orchestration:compare -- evals/orchestration/results/runs/<dir>
```

Each run gets a fresh data dir and fixture workspace, the real app over the
real SDK, the scenario's scripted operator, and hard budget/timeout guards.
Outputs per run: `console.db`, `run.json` (mechanical metrics), `transcript.md`
(judge input), `checks.json` (the shared checkers), `workspace/` (the artifact
snapshot), `judgment.json` (per-dimension scores + verbatim notes).

`--scenario smoke` = vague-greenfield, agent-failure, wasteful-parallelism —
the routine charter-iteration trio. `--scenario all` = every live-enabled
scenario, for before/after baselines. Runs are non-deterministic: always
repetitions + medians + spread, never single-run verdicts.

## The pre-change baseline (do this BEFORE the charter lands)

The point of this framework is a before/after answer to *"what behavior
actually improved because of this project?"* Before the new orchestrator brief
(A4) or behavior-affecting tools merge:

```
AGENTIQUE_LIVE_ORCH_EVAL=1 npm run eval:orchestration:live -- --scenario all --label baseline-pre
# judge each run dir, then copy the run dirs into results/baseline-pre/ and commit run.json,
# checks.json, judgment.json and transcript.md (console.db and workspace/ stay local).
```

Scenarios whose behavior depends on capabilities that did not exist before
this project are **marked `noPreChangeBaseline` and skipped — never
manufactured**: hung-agent (no alarms/interrupt existed), spec/state-dependent
checks (no propose_spec / update_orchestration_state), restart digests
(partial: recovery existed, digests did not).

## Goodhart policy (binding)

1. Judged scores never gate merges; only Tier A's structural invariants do.
2. No scalar collapse: reports are per-dimension, and a delta without its
   qualitative note is not evidence.
3. Rubric text must never enter any orchestrator prompt. (Structural check.)
4. Never score pivot counts (score evidence-responsiveness) and never reward
   reviewer counts (score evidence sufficiency relative to stakes).
5. Trace quality and artifact quality are separate axes: a beautiful trace
   with an inferior artifact is a failure; a good artifact from a poor process
   is flagged as luck.
6. Rotate fresh scenarios in periodically; keep 1–2 unpublished hold-outs for
   major evaluations.
7. Baseline bumps are explicit, human-reviewed commits citing trace evidence.

## Ablations (selective)

When a capability is expensive or its contribution uncertain, rerun a scenario
with it switched off (env/config-gated: doctrine-without-state,
state-without-why/expecting, no-opportunity-instruction, no-independent-review
instruction, no add/close levers) and compare. This is a scalpel, not a
standing experimental program.

## Layout

```
trace.ts               journal read API (both tiers)      scenario.ts   types
checks.ts              dimension-tagged checkers          programs.ts   fake-program combinators
injector.ts            bus-triggered failure injection    structural-runner.ts  Tier A engine
structural.eval.test.ts  CI gate                          scenarios/    the suite + PLANNED list
live/run-live.ts       Tier B runner                      live/operator-policy.ts  scripted operator
live/export-trace.ts   run.json + transcript.md (revived report-run)
live/judge.ts          rubric judging                     live/compare.ts  baseline diff
rubrics/               one .md per judged dimension       fixtures/     live workspace seeds
results/baseline.json  committed medians                  results/runs/ raw runs (gitignored)
```
