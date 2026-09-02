# Worktree Topology and Repair

## Contents

1. Recommended topology
2. Common-dir implications
3. Creation patterns
4. Cleanup gate
5. Repair cases

## Recommended topology

```text
repo/                       coordinator or primary checkout
repo-wt-integration/        integration branch only
repo-wt-agent-a-task-x/     agent A private branch
repo-wt-agent-b-task-y/     agent B private branch
```

Place siblings under a stable parent. Do not nest one worktree within another checkout because scans, build tools, and cleanup commands may cross boundaries.

## Common-dir implications

Use `git rev-parse --git-common-dir` to identify the shared administrative directory. A linked worktree has its own working tree, index, `HEAD`, and per-worktree operation state. It still participates in shared refs and object storage.

Consequences:

- Deleting or rewriting a branch is visible to all agents.
- A stash created in one worktree appears in every worktree.
- Aggressive object pruning can affect every worktree and recovery attempt.
- `git worktree` add/remove/lock/prune updates shared administration.
- Repository config, hooks, and rerere resolutions often affect every agent.

## Creation patterns

| Need | Pattern | Guardrail |
| --- | --- | --- |
| New task branch | `git worktree add -b <branch> <path> <oid>` | Pin `<oid>` and require a new path/ref |
| Existing branch | `git worktree add <path> <branch>` | Confirm branch is not checked out elsewhere |
| Read-only inspection | `git worktree add --detach <path> <oid>` | Do not make durable unbranched commits |
| Remote branch | `git worktree add --track -b <local> <path> <remote>/<branch>` | Verify remote and upstream explicitly |
| Long-lived lane | `git worktree lock --reason <reason> <path>` | Record owner and unlock condition |

Avoid `--guess-remote` when several remotes contain the same branch name.

## Cleanup gate

Pass all gates before removal:

- exact path matches a registered worktree
- no tracked or untracked changes
- no merge, rebase, cherry-pick, revert, or bisect in progress
- tip OID recorded
- required commits reachable from destination or backup ref
- worktree owner finished
- lock removed intentionally

Remove the worktree first. Review the retained branch separately. This separation makes accidental data loss less likely.

## Repair cases

### Worktree moved outside Git

Run `git worktree repair <new-path>` from a valid checkout. Inspect afterward with `git worktree list --porcelain`.

### Worktree temporarily offline

Use `git worktree lock --reason 'temporarily unavailable' <path>`. Do not prune.

### Stale administrative entry

Run `git worktree prune --dry-run --verbose`. Confirm every proposed entry belongs to a permanently removed directory before running prune without `--dry-run`.

### Branch reported as already checked out

Find the owning path through `git worktree list --porcelain`. Coordinate with that owner. Do not use `-f` to make the branch active twice.

### Main checkout missing

Any valid linked worktree can inspect the common directory and refs. Avoid moving the common directory until every linked worktree is inventoried; their administrative pointers depend on it.
