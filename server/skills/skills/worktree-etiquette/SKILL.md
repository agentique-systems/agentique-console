---
name: worktree-etiquette
description: Working inside a Console-managed isolated worktree — what the Console does for you (turn snapshots, landing on report, salvage) and how that composes with the git-gud skills, which govern every git operation you run yourself.
version: 1.1.0
provenance: distilled from the straf3 live run, 2026-08-15; git-gud precedence added 2026-08-17
status: validated
requires:
  tools: [Bash]
whenToUse: Whenever your cwd is an isolated worktree (your capability brief says so), especially before drawing conclusions from another directory's contents or reporting completion.
costNote: ~30 lines when invoked.
---

# Worktree etiquette

Your cwd is an isolated git worktree the Console provisioned on its own
branch. The Console snapshots your files at every turn boundary, lands the
branch tip on the workspace's main line when you report `completed`, and
archives it when things fail. That machinery is yours to rely on, not to
replace.

## Git operations: git-gud governs

For any git operation you perform yourself — staging, committing, resolving
conflicts, syncing with the base branch, recovering lost work, managing
worktrees — follow the `git-gud-*` skills (`git-gud-commits`,
`git-gud-conflicts`, `git-gud-sync`, `git-gud-recover`, `git-gud-worktrees`,
`git-gud-coordinate`). **They take precedence over this note.** Committing
atomic commits on your own branch is welcome: the Console lands whatever the
branch tip holds, committed or not. Leave the final landing onto main to the
Console unless the orchestrator asks you to integrate yourself.

## Do

- Work normally in your cwd; uncommitted files are still snapshotted for you
  at each turn boundary and when you hand off.
- Report `completed` when the work is done — landing is triggered by your
  report.
- If the Console says prior work was preserved, look for it before
  restarting: check your cwd first, then `git branch -a | grep agentique/`
  — salvaged work lives on `agentique/archive/seat/...` branches and is
  recoverable with `git show <branch>:<path>` (see `git-gud-recover`).

## Don't

- Don't conclude from `ls` of the canonical workspace that a teammate did
  nothing — their work is invisible to you until the Console merges it.
- Don't edit files outside your declared ownership scope; a merge-conflict
  failure on your report means the workspace advanced — expect reassignment
  against the new HEAD, not a retry of the same diff.

## If your worktree looks wrong

A missing or empty worktree is a provisioning fault, not your fault: report
it as a failure handoff with what you observed (path, contents) instead of
working in whatever directory happens to exist.
