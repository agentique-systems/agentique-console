# Conflict Resolution Playbook

## Contents

1. Operation semantics
2. Evidence collection
3. Conflict classes
4. Rerere safeguards
5. Preserve post-start edits before aborting
6. Completion checklist

## Operation semantics

| Operation | `ours` / stage 2 | `theirs` / stage 3 | Continue command |
| --- | --- | --- | --- |
| Merge | Current `HEAD` | Commit being merged | `git merge --continue` |
| Rebase | New base plus replayed commits | Commit currently replayed | `git rebase --continue` |
| Cherry-pick | Current `HEAD` | Picked commit's change | `git cherry-pick --continue` |
| Revert | Current `HEAD` | Inverse change being applied | `git revert --continue` |

Treat these as index-stage meanings, not labels for which code is correct.

## Evidence collection

Capture:

```bash
git status
git ls-files -u
git diff --cc
git diff --name-status --diff-filter=U
```

For one path, inspect base/stages and relevant history:

```bash
git show :1:<path>
git show :2:<path>
git show :3:<path>
git log --merge --oneline -- <path>
```

During rebase or cherry-pick, inspect the current patch with `git show REBASE_HEAD` or `git show CHERRY_PICK_HEAD` when those refs exist.

## Conflict classes

### Content conflict

Translate both sides into behavioral requirements. Reimplement the union against the final API when line-based splicing would preserve obsolete code.

### Add/add

Compare file purpose and public names. One side may supersede the other, or both may need renaming and registration.

### Modify/delete

Inspect the deleting commit message and replacements. If deletion is correct, port still-required edits to the replacement before staging the removal.

### Rename conflicts

Use `git diff --summary` and history to determine identity. After choosing paths, search for old names in imports, build files, ownership rules, and tests.

### Lockfiles and generated files

Do not manually weave outputs. Resolve human-authored inputs, use the pinned generator/package manager, inspect the regenerated diff, and run integrity checks.

### Binary files

Find the authoritative source or generating process. If neither exists, require an owner decision; textual merge tools cannot establish semantic correctness.

### Submodules

Inspect both gitlink OIDs inside the submodule. Choose a descendant when it contains both histories; otherwise integrate the submodule first and point the parent repository at the resulting commit.

## Rerere safeguards

`git rerere` records conflict preimages and resolutions in shared repository administration.

- Review with `git rerere diff` before staging.
- Do not assume a matching textual conflict has matching business intent.
- Avoid automatic staging in high-risk code.
- Forget a bad recorded resolution with `git rerere forget -- <path>` only after confirming the exact conflict context.

## Preserve post-start edits before aborting

When an agent edited files after the operation stopped, create evidence outside the worktree before aborting:

- `git status --porcelain=v2 --branch`
- `git ls-files --unmerged`
- `git diff --binary --no-ext-diff`
- `git diff --cached --binary --no-ext-diff`
- `git ls-files --others --exclude-standard`
- copies of untracked and irreplaceable working files
- rescue refs for the stopped `HEAD` and verified pre-operation tip

Do not rely only on a stash; unmerged entries can make it fail. A patch does not preserve every untracked file or every working version of a conflicted path, so retain file copies or a policy-appropriate filesystem snapshot too.

## Completion checklist

- no unmerged index entries
- no unintended conflict markers
- no operation-specific path left unresolved
- generated files regenerated from resolved inputs
- staged diff reviewed
- whitespace and syntax checks pass
- targeted tests pass
- combined integration tests pass
- resulting history and `HEAD` match the intended operation
- non-obvious resolution decisions documented
