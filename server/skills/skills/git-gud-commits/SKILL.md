---
name: git-gud-commits
description: Turn working-tree changes into atomic, reviewable, well-verified Git commits while preserving unrelated user or agent work. Use when staging selected changes, splitting mixed diffs, writing commit messages, amending or fixing up private commits, preparing a clean handoff, auditing commit hygiene, or using interactive rebase and autosquash safely.
version: 1.0.0
provenance: git-gud skill pack, imported 2026-08-17
status: validated
requires:
  tools: [Bash]
whenToUse: Before staging or committing in any worktree — splitting mixed diffs, writing messages, amending private commits, preparing a clean handoff.
costNote: ~110 lines when invoked; references/commit-patterns.md on demand.
---

# Craft High-Quality Git Commits

Make each commit one coherent, buildable explanation of change. Preserve unrelated edits and follow repository-local conventions.

## Inspect before staging

```bash
git status --short --branch
git diff --stat
git diff
git log -n 12 --format='%h %s'
```

Identify which changes belong to the task, which belong to another agent or the user, and which are generated. Never stage the whole tree merely because `git add -A` is convenient.

## Design commit boundaries

Split by semantic dependency, not file count. Prefer this order when applicable:

1. mechanical rename or movement
2. behavior change
3. tests and fixtures tied to that behavior
4. generated artifacts tied to their source change
5. documentation or migration notes

Combine tests with the behavior they prove unless the repository convention requires separate commits. Keep formatting-only churn separate from logic.

## Stage deliberately

Use explicit paths for cleanly separated files:

```bash
git add -- path/to/file path/to/test
```

Use patch staging for mixed files:

```bash
git add -p -- path/to/file
```

For a new file that needs partial staging:

```bash
git add -N -- path/to/new-file
git add -p -- path/to/new-file
```

Reinspect both sides of the index boundary:

```bash
git diff --cached --stat
git diff --cached
git diff
git diff --cached --check
```

Do not use a broad reset or restore to unstage. Prefer `git restore --staged -- <path>` after confirming the path.

## Verify the exact staged snapshot

Run the narrowest relevant tests, lint, type checks, and build steps. If tools modify files, inspect and stage only intentional results, then rerun checks as needed.

Verify generated files by running the documented generator rather than hand-editing output. Keep hooks enabled. If a hook changes the index, inspect the new staged diff before committing.

## Write the message

Match recent repository history. If no convention exists:

- Use a short imperative subject describing the outcome.
- Explain motivation and non-obvious tradeoffs in the body.
- Mention compatibility, migration, or operational effects.
- Link issues or trailers only when they are real and required.

Do not claim tests were run if they were not. Avoid vague subjects such as `fix`, `updates`, or `changes`.

## Reinspect after committing

```bash
git show --stat --oneline --decorate HEAD
git show --check HEAD
git status --short --branch
```

Confirm unrelated changes remain untouched and the commit contains only intended content.

## Amend and autosquash only owned history

Amend only the current private, unpublished tip:

```bash
git commit --amend
```

For an older private commit, create a fixup:

```bash
git commit --fixup=<target-oid>
git rebase -i --autosquash <base-oid>
```

Create a backup ref and use `git range-diff` before and after rewriting a nontrivial series. Never rewrite commits another agent may have based work on without coordination.

Prefer a named WIP commit on an owned branch over an anonymous stash. Do not hand off WIP commits as finished history; fix them up before integration.

Read [references/commit-patterns.md](references/commit-patterns.md) for split patterns, audit checks, fixups, and handoff conventions.
