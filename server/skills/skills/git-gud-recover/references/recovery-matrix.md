# Git Recovery Matrix

## Contents

1. First-response rules
2. Symptom matrix
3. Special refs and logs
4. Bisect protocol
5. Recovery closeout

## First-response rules

1. Stop writes that move refs or remove objects.
2. Record worktree, branch, `HEAD`, status, and operation markers.
3. Inspect all worktrees because the missing work may exist in another lane.
4. Inspect reflogs before object-level recovery.
5. Create a rescue ref for every candidate OID before experimenting.
6. Prefer additive repairs such as revert, merge, or cherry-pick.

## Symptom matrix

| Symptom | Evidence | Safest first repair |
| --- | --- | --- |
| Commit vanished after reset | `git reflog HEAD`, branch reflog | Branch the pre-reset OID |
| Old commit vanished after amend | `HEAD@{1}` and surrounding reflog | Preserve old and new tips, compare |
| Rebase produced wrong series | reflog, `ORIG_HEAD`, backup ref | Branch pre-rebase tip, use range-diff |
| Branch deleted | all reflogs, recent logs | Recreate branch at recorded tip |
| Published change is bad | remote history and ownership | Revert with a new commit |
| Merge is bad and unpublished | merge parents, reflog | Preserve merge tip, reset only owned private branch |
| Merge is bad and published | merge parents, downstream bases | Revert merge after selecting mainline |
| File overwritten | index/worktree diff, reflog, commits | Recover to a new file or branch before replacing |
| Worktree registration stale | `worktree list`, filesystem, prune preview | Repair path or lock; prune only confirmed stale metadata |
| No reflog entry | `fsck --unreachable`, object timestamps | Inspect candidates and create rescue refs |
| Regression origin unknown | reproducible good/bad endpoints | Bisect in isolated worktree |

## Special refs and logs

- `ORIG_HEAD`: often records the previous tip for merge, reset, or rebase-related commands; verify before trusting it.
- `MERGE_HEAD`: identifies the commit currently being merged.
- `REBASE_HEAD`: identifies the commit currently stopped during rebase.
- `CHERRY_PICK_HEAD`: identifies the commit currently being picked.
- `REVERT_HEAD`: identifies the commit currently being reverted.
- `refs/bisect/*`: records active bisect state.
- `git reflog --all`: includes movements beyond the current branch, subject to expiration.

Special refs are evidence, not guaranteed restore points. Inspect their commits and operation context.

## Bisect protocol

1. Establish one known-good and one known-bad commit.
2. Create a detached worktree at the bad endpoint.
3. Run `git bisect start <bad> <good>`.
4. Test manually or use `git bisect run <command>`.
5. Treat environment failures as skip (`125`), not bad.
6. Record the first bad commit and reproducer.
7. Run `git bisect reset` and remove the diagnostic worktree safely.

Check path-limited history or first-parent history only when that matches the regression model; otherwise it can hide the culprit.

## Recovery closeout

- recovered commits have stable refs
- intended branch points to the reviewed tip
- published history was not silently rewritten
- affected worktrees and indexes were inspected
- no merge/rebase/cherry-pick/revert/bisect remains active
- tests reproduce the repaired state
- rescue refs remain until durable integration is confirmed
- no unreachable-object cleanup runs during the retention window
