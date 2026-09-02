---
name: git-gud-sync
description: Safely synchronize, rebase, merge, cherry-pick, transplant, publish, and integrate Git branches in concurrent development. Use when updating an agent branch from its upstream, choosing rebase versus merge, integrating several branches, handling stacked branches, preserving merge structure, comparing rewritten series, or pushing rewritten private history with a precise lease.
version: 1.0.0
provenance: git-gud skill pack, imported 2026-08-17
status: validated
requires:
  tools: [Bash]
whenToUse: Before updating a branch from its base, choosing rebase vs merge, integrating several branches, or pushing rewritten history.
costNote: ~115 lines when invoked; references/integration-strategies.md on demand.
---

# Synchronize and Integrate Branches

Choose the integration method from ownership and publication state, not aesthetic preference.

## Establish state

```bash
git status --short --branch
git branch --show-current
git branch --verbose --verbose
git remote --verbose
git log --graph --decorate --oneline --all -n 40
```

Require a clean worktree or deliberately preserve owned changes in a commit. Do not hide another agent's changes in a stash.

Fetch explicitly when permitted:

```bash
git fetch --prune <remote>
```

Resolve all moving refs to OIDs, identify the merge base, and inspect divergence:

```bash
git rev-parse <upstream>^{commit}
git merge-base HEAD <upstream>
git rev-list --left-right --count <upstream>...HEAD
git log --left-right --cherry-pick --oneline <upstream>...HEAD
```

## Choose the method

- Rebase an owned, unpublished branch to make it current or retarget a stack.
- Merge a shared or published branch when rewriting would disrupt collaborators.
- Fast-forward an integration branch when the accepted branch already contains its tip.
- Cherry-pick a cohesive subset; add `-x` when cross-branch provenance matters.
- Squash only when the intermediate history has no review, bisect, or rollback value.

Read [references/integration-strategies.md](references/integration-strategies.md) for the full decision matrix.

## Rebase an owned branch safely

Create a recovery ref before a nontrivial rewrite:

```bash
branch=$(git branch --show-current)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="backup/$branch/$stamp"
git branch "$backup" HEAD
git rebase --rebase-merges <new-base>
```

Use `--rebase-merges` only when the branch-local merge structure is intentional. Use plain rebase for a linear topic. Avoid `--update-refs` unless all potentially moved branch owners agree.

For stacked branches:

```bash
git rebase --onto <new-parent-tip> <old-parent-tip> <child-branch>
```

Afterward, compare the series and test:

```bash
git range-diff <old-base>..<backup> <new-base>..HEAD
git diff --check <new-base>...HEAD
```

## Merge or fast-forward shared history

In a dedicated integration worktree:

```bash
git merge --ff-only <accepted-tip>
```

Use a merge commit only when policy or divergent shared history requires it:

```bash
git merge --no-ff <accepted-tip>
```

Resolve and verify one branch at a time. Do not use an octopus merge for branches likely to conflict or require semantic ordering.

## Publish rewritten history with an exact lease

Only rewrite a branch owned by the current agent. Fetch immediately before pushing and capture the observed remote OID:

```bash
git fetch <remote> <branch>
expected=$(git rev-parse "refs/remotes/<remote>/<branch>")
git push --force-with-lease="refs/heads/<branch>:$expected" <remote> "HEAD:<branch>"
```

If the lease fails, stop. Someone else moved the branch. Fetch, inspect, and coordinate; never replace the lease with plain `--force`.

Use a normal push for non-rewritten history. Do not change global pull, merge, fetch, or rebase configuration as part of a task.

## Verify integration

Compare tree and history, then run combined checks:

```bash
git status --short --branch
git log --graph --decorate --oneline -n 30
git diff --check <integration-base>...HEAD
git branch --contains <accepted-tip>
```

Record the integrated tip OIDs before branch or worktree cleanup.
