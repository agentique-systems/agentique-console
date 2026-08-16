---
name: worktree-etiquette
description: Working inside a Console-managed isolated worktree — what the Console does for you (commits, landing, salvage) and what never to do (git commit/merge/push yourself).
version: 1.0.0
provenance: distilled from the straf3 live run, 2026-08-15
status: validated
requires:
  tools: [Bash]
whenToUse: Whenever your cwd is an isolated worktree (your capability brief says so), especially before any git operation or any conclusion drawn from another directory's contents.
costNote: ~35 lines when invoked.
---

# Worktree etiquette

Your cwd is an isolated git worktree the Console provisioned. The Console —
not you — snapshots your files at every turn, lands your work when you
report completed, and archives it when things fail. Trust that machinery.

## Do

- Work normally in your cwd; files you create are committed for you at each
  turn boundary and when you hand off.
- Report `completed` when the work is done — landing is triggered by your
  report, not by a git command.
- If the Console says prior work was preserved, look for it before
  restarting: check your cwd first, then `git branch -a | grep agentique/`
  — salvaged work lives on `agentique/archive/seat/...` branches and is
  recoverable with `git show <branch>:<path>`.

## Never

- Never `git commit`, `git merge`, `git rebase`, or `git push` yourself —
  the Console owns the landing path; your commits collide with its
  snapshots.
- Never conclude from `ls` of the canonical workspace that a teammate did
  nothing — their work is invisible to you until the Console merges it.
- Never edit files outside your declared ownership scope; a merge-conflict
  failure on your report means the workspace advanced — expect reassignment
  against the new HEAD, not a retry of the same diff.

## If your worktree looks wrong

A missing or empty worktree is a provisioning fault, not your fault: report
it as a failure handoff with what you observed (path, contents) instead of
working in whatever directory happens to exist.
