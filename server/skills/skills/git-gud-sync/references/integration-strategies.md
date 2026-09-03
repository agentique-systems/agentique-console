# Integration Strategies

## Contents

1. Decision matrix
2. Rebase patterns
3. Merge patterns
4. Selective transplantation
5. Publication safety
6. Verification

## Decision matrix

| Branch state | Goal | Preferred method | Reason |
| --- | --- | --- | --- |
| Private and unpublished | Update onto new base | Rebase | No collaborators depend on old OIDs |
| Published but single-owner | Rewrite with explicit coordination | Rebase plus exact lease | Preserves control while protecting remote movement |
| Shared by several agents | Incorporate upstream | Merge | Avoid invalidating collaborators' bases |
| Accepted branch contains destination | Integrate | Fast-forward | Adds no unnecessary merge structure |
| Need only selected commits | Transplant | Cherry-pick | Keeps accepted scope explicit |
| Patch already exists under different OID | Avoid duplicate | `--cherry-pick` inspection / `patch-id` | Detects equivalent changes |
| Stacked topic changes parent | Retarget child | `rebase --onto` | Moves only the intended range |

## Rebase patterns

### Linear topic

```bash
git rebase <new-base>
```

### Topic containing intentional merges

```bash
git rebase --rebase-merges <new-base>
```

Review recreated merge commits carefully; resolution intent may not replay automatically.

### Retarget a range

```bash
git rebase --onto <new-base> <old-base> <topic>
```

Confirm `<old-base>..<topic>` is exactly the range to move before running the command.

### Remove already-upstream patches

Inspect first:

```bash
git log --left-right --cherry-mark --oneline <upstream>...HEAD
```

Use `git patch-id --stable` for exact patch-equivalence investigations. Patch equivalence does not prove semantic redundancy when surrounding code differs.

## Merge patterns

- `--ff-only`: enforce that no divergent merge commit is created.
- `--no-ff`: preserve a topic boundary when project policy values it.
- `--no-commit`: inspect the merge result before committing; remember an operation is now in progress.
- `--log`: include summarized topic commits when the repository uses merge commits.

Avoid strategy options such as `-Xours` or `-Xtheirs` as blanket conflict solutions; they can silently discard valid changes.

## Selective transplantation

Use `git cherry-pick <oid>` for a cohesive commit. Use an ordered OID list for a series. Add `-x` when the new commit should record its source OID, especially across maintenance branches.

Cherry-picking a merge requires choosing a mainline parent with `-m`; do this only after inspecting the merge parents and understanding which parent represents the destination lineage.

## Publication safety

Before a rewritten push:

1. Confirm current branch ownership.
2. Confirm no other agent based work on the old tip.
3. Fetch the exact remote branch.
4. Save the observed remote OID.
5. Push with `--force-with-lease=<remote-ref>:<observed-oid>`.
6. Stop on lease failure.

Do not rely on a stale remote-tracking ref. Do not use `--force-if-includes` as a substitute for ownership coordination.

## Verification

Use both history and tree checks:

- `git range-diff` for rewritten commit series
- `git diff <old-tree> <new-tree>` when tree equivalence is expected
- `git diff --check` for conflict-marker and whitespace problems
- `git merge-base --is-ancestor <tip> <destination>` for reachability
- targeted tests after each branch
- full required suite after the final combined integration

Range-diff is a review aid, not proof. Builds and tests validate semantics.
