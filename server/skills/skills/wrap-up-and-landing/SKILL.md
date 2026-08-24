---
name: wrap-up-and-landing
description: Ending a run well — scaling the verification ladder to stakes, the wrap-up sequence when the operator calls time, and landing in-flight work before polishing anything.
version: 1.0.0
provenance: moved from the standing orchestrator surfaces (agent-stack simplification, Stage 7b)
status: validated
requires:
  tools: []
whenToUse: When you believe the run is done, before record_completion, and whenever the operator asks to wrap up or a capacity warning lands.
costNote: ~55 lines when invoked.
---

# Wrap-up and landing

The standing rule is short: never report work as done on an agent's claim,
and the question at the end is never whether the product could still be
improved but whether another move has enough expected value to delay
completion. This skill is the procedure for both.

## The verification ladder

Scale the evidence to the consequences of being wrong:

1. Self-verification — the maker's own evidenced claim. The floor, never
   the ceiling for consequential work.
2. Independent verification against the requirements — a write-isolated
   reviewer seat reports the requirement statuses itself.
3. Adversarial review — a seat briefed to break it, not to confirm it.
4. Multiple perspectives — distinct reviewers for correctness, UX,
   performance; disagreement is signal.
5. Holistic critique — does the WHOLE deliver the intent, beyond passing
   each requirement?

On non-trivial work, let one review pass challenge the REQUIREMENTS
themselves. Read the evidence with read_artifact and read_handoff;
repository files, tasks, journal entries and artifacts stay authoritative
over any summary of them.

## Declaring done

- Every requirement satisfied with evidence, or honestly reported violated
  or infeasible. No known defect above the bar remains.
- Leftover ideas are triaged: below-value → named as not done and why;
  beyond-scope → proposed to the operator with honest cost.
- Any further iteration must first name the gap, why it matters, the
  action, and the evidence that will show closure.
- Every change impact is reconciled (read_requirements lists open ones):
  suspect claims re-verified, reopened, or judged with
  reconcile_change_impact — an open impact holds the completion proposal.
- No broken workstream link with an open consumer (list_agent_sessions
  surfaces them under attention): link a successor producer, release the
  link with unlink_workstreams (with why), or close the consumer — a broken
  link also holds the completion proposal.
- Then record_completion against the CURRENT requirements revision — the
  sign-off card shows your record beside the console's own facts.

## When the operator asks to wrap up

1. Stop opening scope — no new commissions, no new requirements.
2. Land or salvage every in-flight branch. Stranded finished work is the
   failure mode: landing beats polishing.
3. Produce the operator's deliverables, including run/usage instructions
   as a file in the workspace.
4. record_completion with honest gaps.
5. Let the sign-off propose.

Under a capacity warning, sequence landings first — the budget dies on
polish, never on unlanded work.
