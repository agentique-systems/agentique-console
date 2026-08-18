---
name: long-build-discipline
description: How to run builds and test suites that take minutes without blocking turns, polling, or getting killed — background + Monitor, never sleep loops.
version: 1.0.0
provenance: distilled from the straf3 live run, 2026-08-15
status: validated
requires:
  tools: [Bash]
whenToUse: Before running any command expected to exceed ~2 minutes (cargo build/clippy/test, full JS test suites, docker builds, dataset jobs).
costNote: ~40 lines when invoked; pays for itself the first time a build is not re-run.
---

# Long-build discipline

Cold builds and full test suites routinely run 5–10 minutes. A live run lost
whole sessions to the wrong pattern: foreground calls that looked wedged,
poll loops that burned entire model turns on `true`, and a `pgrep -f` that
matched its own command line and never terminated.

## The one correct pattern

1. Start the command in the background:
   `Bash { command: "cargo test --workspace 2>&1 | tail -50", run_in_background: true }`
   The result gives you a task id and an output file path.
2. Wait on it — do not poll:
   - `TaskOutput { task_id, block: true, timeout: 600000 }` blocks until it
     finishes and returns the output, or
   - `Monitor` with a command that exits when the condition is true, when you
     want to keep working meanwhile.
   These tools are DEFERRED: if absent from your tool list, call
   `ToolSearch {"query": "select:Monitor,TaskOutput,TaskStop"}` once.
3. Read the tail of the output file with Read if you need more than the
   returned excerpt.

## Never

- Never wait with `sleep` loops, `until`/`while` polls, or repeated `Read`s
  of a log file — each is a full model turn spent on nothing.
- Never spend a turn on `true` / `echo waiting` "to yield" — end your turn
  with the blocking TaskOutput instead.
- Never poll with `pgrep -f <pattern>` — the pattern matches your own poll
  loop's command line and reports the job alive forever.
- Never re-run a build because a watchdog or timeout killed it — say in your
  report that the call needs N minutes; long calls on real work are expected.

## Expectations to state in reports

When a validation step ran long, report the wall time ("full suite: 7m40s
cold, 90s warm") so your coordinator and successors budget for it instead of
diagnosing a hang.
