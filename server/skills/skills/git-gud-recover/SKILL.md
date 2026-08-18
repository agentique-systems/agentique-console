---
name: git-gud-recover
description: Diagnose and safely recover Git repositories after accidental reset, rebase, commit amendment, branch deletion, bad merge, lost commits, interrupted operations, worktree damage, or regression introduction. Use when work appears missing, history moved unexpectedly, a destructive command may have run, an operation must be unwound, a published change needs reversal, reflog or fsck recovery is needed, or bisect can locate a bad commit.
version: 1.0.0
provenance: git-gud skill pack, imported 2026-08-17
status: validated
requires:
  tools: [Bash]
whenToUse: Whenever work looks missing or history moved unexpectedly — a bad reset/rebase/amend, a lost branch, a wedged operation — before any further destructive command.
costNote: ~100 lines when invoked; references/recovery-matrix.md on demand.
---

# Recover Git State Safely

Freeze destructive activity first. Do not run garbage collection, prune objects, force-push, hard reset, clean, or forced worktree removal while evidence may still be recoverable.

## Capture the current state

```bash
git status --short --branch
git rev-parse --show-toplevel
git rev-parse --path-format=absolute --git-common-dir
git worktree list --porcelain
git branch --all --verbose --no-abbrev
git reflog --all --date=iso
git log --graph --decorate --oneline --all -n 60
```

Record current `HEAD`, the expected branch, affected worktree, publication state, and the last known good action. Preserve raw terminal output when available.

If a conflicted operation contains edits made after it began, do not rely on `git stash`. Preserve status, unmerged index entries, binary working-tree and cached diffs, untracked paths, and irreplaceable files in a policy-appropriate snapshot outside the worktree before continuing or aborting.

## Protect candidate commits before moving refs

When a plausible lost OID appears, make it reachable immediately:

```bash
git branch rescue/<case>/<timestamp> <candidate-oid>
```

Use a branch or tag, not a pasted short OID. Inspect the candidate before restoring anything:

```bash
git show --stat --decorate <candidate-oid>
git diff <current-oid>..<candidate-oid>
```

## Choose the least destructive repair

- Published bad change: create a new `git revert` commit.
- Lost private commits: recover from reflog to a rescue branch, then merge, rebase, or cherry-pick deliberately.
- Accidental amend/rebase/reset: find the pre-operation OID in the reflog and preserve both old and new tips before choosing.
- Interrupted operation: identify its exact type; continue or abort with the matching command.
- Lost path: restore from a known commit only after preserving current path changes.
- Deleted worktree: recover branch/dirty files separately; worktree metadata cannot restore uncommitted files after deletion.
- Regression with unknown origin: use `git bisect` in an isolated worktree.

Read [references/recovery-matrix.md](references/recovery-matrix.md) for exact evidence and repair options.

## Recover common history mistakes

### Accidental reset, amend, or rebase

```bash
git reflog show --date=iso <branch>
git reflog show --date=iso HEAD
```

Create rescue refs at the pre- and post-operation tips. Compare with `git range-diff` for rewritten series and `git diff` for tree state. Move a private branch only after choosing the correct tip.

### Deleted branch

Search reflogs for its last tip. If reflog evidence is absent, use `git fsck --no-reflogs --unreachable` as a last-resort inventory. Do not run `git gc` or `git prune` first.

### Bad published commit

Use `git revert <oid>` or revert a reviewed range. Reverting a merge requires selecting the correct mainline parent with `-m`; inspect parents and future merge implications before proceeding.

## Restore files narrowly

Before overwriting a path, inspect both current changes and source content:

```bash
git diff -- path/to/file
git show <source-oid>:path/to/file
```

Prefer restoring into the index or worktree separately as intended:

```bash
git restore --source=<source-oid> --staged -- path/to/file
git restore --source=<source-oid> --worktree -- path/to/file
```

Never use a broad pathspec until the exact affected paths are reviewed.

## Bisect in isolation

Create a detached diagnostic worktree, then bisect there so normal agent work continues. Use a deterministic test command. For `git bisect run`, exit `0` for good, `1` through `127` except `125` for bad, and `125` to skip an untestable commit.

Reset the bisect state when finished and report the first bad OID plus the test command and any skipped range.

## Verify recovery

Confirm recovered commits are reachable, worktrees are clean or intentionally dirty, no operation remains active, and required tests pass. Keep rescue refs until the user confirms the recovered result is safely integrated or published.
