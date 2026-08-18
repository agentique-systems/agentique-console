---
name: git-gud-conflicts
description: Diagnose and resolve Git merge, rebase, cherry-pick, and revert conflicts using index stages, operation-aware ours/theirs semantics, semantic reconciliation, rerere review, and post-resolution verification. Use when Git reports unmerged paths, a history operation stops for conflicts, rename/delete conflicts appear, lockfiles or generated files conflict, conflict markers remain, or an agent must continue or safely abort an interrupted operation.
version: 1.0.0
provenance: git-gud skill pack, imported 2026-08-17
status: validated
requires:
  tools: [Bash]
whenToUse: The moment git reports unmerged paths or a merge/rebase/cherry-pick/revert stops for conflicts — before touching any marker.
costNote: ~100 lines when invoked; references/conflict-playbook.md on demand.
---

# Resolve Git Conflicts Semantically

Resolve the intended combined behavior, not merely the textual markers. First identify the active operation because `ours` and `theirs` change meaning.

## Identify the operation and conflict set

```bash
git status
git diff --name-status --diff-filter=U
git ls-files --unmerged
git log --graph --decorate --oneline --all -n 30
```

Inspect per-worktree markers with `git rev-parse --git-path <marker>` for `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, or `REVERT_HEAD`.

Do not start another merge, rebase, cherry-pick, or revert while one is active.

## Understand the sides

For an unmerged path:

```bash
git show :1:path/to/file   # merge base
git show :2:path/to/file   # index stage 2
git show :3:path/to/file   # index stage 3
```

During a normal merge, stage 2 is the current branch (`ours`) and stage 3 is the merged branch (`theirs`). During a rebase, `ours` is the new base plus already replayed commits, while `theirs` is the commit currently being replayed. This inversion makes blanket checkout of `--ours` or `--theirs` dangerous.

Read [references/conflict-playbook.md](references/conflict-playbook.md) for operation-specific semantics and conflict classes.

## Reconstruct intent

Inspect the commits that introduced both sides:

```bash
git log --oneline --decorate -- path/to/file
git blame <side-oid> -- path/to/file
git diff <base-oid>..<side-oid> -- path/to/file
```

Determine required invariants, API contracts, data migrations, test expectations, and generated-file provenance. Ask the owning agent when intent cannot be inferred safely.

## Resolve by conflict class

- Content: combine behavior deliberately; do not just delete markers.
- Add/add: compare both complete files and reconcile names, APIs, and tests.
- Modify/delete: decide whether deletion is intentional and whether modifications must move elsewhere.
- Rename/rename: choose the canonical path, then repair imports, manifests, and references.
- Binary: select or regenerate from the authoritative source; record provenance.
- Lockfile: resolve source manifests first, then regenerate with the repository's pinned tool.
- Generated file: resolve source inputs, regenerate, and avoid manual edits to output.
- Submodule: select the intended commit only after inspecting ancestry in the submodule.

## Stage and validate each resolution

```bash
git add -- path/to/resolved-file
git diff --name-only --diff-filter=U
git diff --cached --check
git diff --cached
```

Search for conflict markers, but distinguish legitimate test fixtures:

```bash
git grep -n -e '^<<<<<<< ' -e '^=======$' -e '^>>>>>>> ' -- ':!*.lock'
```

Run focused tests for every reconciled interface, then the operation's required suite.

## Continue, skip, or abort deliberately

Use the operation-matched command only after all intended paths are staged:

```bash
git merge --continue
git rebase --continue
git cherry-pick --continue
git revert --continue
```

Skip only when the current patch is provably already present or intentionally unwanted.

Before aborting, preserve any edits made after the operation began. A stash may fail with an unmerged index and must not be the only backup. Save a policy-appropriate snapshot outside the worktree, including status, unmerged index entries, binary working-tree and cached diffs, untracked paths, and copies of irreplaceable files. Protect committed candidates with rescue refs. After aborting, reapply only genuine post-start work, not the whole conflicted snapshot.

Use the matching `--abort`, then verify status and `HEAD`. Treat `git rebase --quit` as an emergency option: it removes rebase administration while leaving `HEAD`, the index, and working tree in place, so the normal abort path is no longer available.

## Use rerere cautiously

If rerere is already enabled, inspect recorded resolutions with `git rerere diff`. Keep `rerere.autoupdate` disabled unless the team explicitly trusts automatic staging. The rerere cache is shared across worktrees; always review a reused resolution in its new context.

After completion, inspect the resulting commit or merge, run combined tests, and record any non-obvious resolution choice in the commit message or handoff.
