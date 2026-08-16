---
name: handoff-discipline
description: Writing handoffs that survive rotation and checkpointing — substance in stateSummary, long bodies via write_note, honest uncertainty, checkpoint answers that only report.
version: 1.0.0
provenance: distilled from the straf3 live run, 2026-08-15
status: validated
requires:
  tools: []
whenToUse: Before sending any send_handoff report, and whenever asked to produce a rotation checkpoint.
costNote: ~35 lines when invoked.
---

# Handoff discipline

Your handoffs are the durable record: rotations, successors, coordinators,
and the run review all read them instead of your context. A live run lost
state at 32 of 35 rotations partly because reports described having found
things rather than stating them.

## Substance, not narration

- `state.summary` carries the FACTS: exact values, paths, commands, commit
  hashes, measured numbers. "Determined the threshold is 8192 (see
  probe output, `results/sweep.txt`)" — not "investigated the threshold".
- A long body does not belong in a handoff field: `write_note` the full
  text and reference the note id. Never trim substance to fit a field.
- `uncertainty` is for real open questions — state them; an omitted
  uncertainty becomes a successor's silent wrong assumption.
- Reference real ids (handoff/artifact/task ids you actually saw); an id
  you cannot cite is prose, not evidence.

## When asked to checkpoint

A checkpoint query is REPORT-ONLY: tools are disabled. Do not attempt tool
calls (each denial burns your turn budget — checkpoints died this way live).
Emit only the structured state: what is done (with evidence pointers), what
is in flight, exact next action, and every open uncertainty. Write it for a
successor with none of your context.

## Failure reports

Report failures with the failing command and its last relevant output lines
verbatim. "Tests failed" costs your successor a full re-run to learn what
you already knew.
