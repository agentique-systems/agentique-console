---
name: git-gud-worktrees
description: Create, inspect, lock, repair, and safely remove Git worktrees for isolated concurrent development. Use when assigning separate working directories to AI agents, creating branches from pinned bases, diagnosing worktree registry or already-checked-out-branch problems, cleaning completed agent worktrees, or preventing concurrent agents from sharing an index or working tree.
version: 1.0.0
provenance: git-gud skill pack, imported 2026-08-17
status: validated
requires:
  tools: [Bash]
whenToUse: Before creating, inspecting, repairing or removing a git worktree — including diagnosing already-checked-out or registry problems.
costNote: ~105 lines when invoked; references/worktree-layout.md and scripts/git-gud-worktree.sh on demand.
---

# Manage Git Worktrees

Use one unique branch and one unique worktree per agent task. Treat worktree administration as shared repository state.

## Inspect before changing anything

```bash
git rev-parse --show-toplevel
git rev-parse --path-format=absolute --git-common-dir
git worktree list --porcelain
git branch --all --verbose --no-abbrev
git status --short --branch
```

Use `bash "${CLAUDE_SKILL_DIR}/scripts/git-gud-worktree.sh" inspect` for a compact inventory.

## Create from a pinned base

Fetch only when network access and task scope permit it. Resolve the selected base to an immutable OID before creating the worktree:

```bash
git fetch --prune origin
base_oid=$(git rev-parse 'origin/main^{commit}')
git worktree add -b 'agent/alex/parser' '../repo-wt-alex-parser' "$base_oid"
git -C '../repo-wt-alex-parser' status --short --branch
```

Or use:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/git-gud-worktree.sh" create <path> <new-branch> <start-point>
```

Require the path not to exist, the new branch not to exist, and the start point to resolve to a commit. Never reuse one branch in two worktrees.

If the branch already exists and is not checked out elsewhere, attach it without `-b`:

```bash
git worktree add <path> <existing-branch>
```

Use detached worktrees only for read-only inspection, testing, or bisecting:

```bash
git worktree add --detach <path> <commit>
```

Create a branch before making durable changes there.

## Name and place worktrees predictably

- Follow the repository's branch convention; otherwise use `agent/<owner>/<task>`.
- Put worktrees beside the main checkout, not inside it.
- Record the absolute path, branch, owner, task, and base OID.
- Avoid symbolic-link aliases that make the same path appear under different names.
- Lock worktrees on removable volumes or long-lived agent worktrees:

```bash
git worktree lock --reason 'agent task in progress' <path>
```

Unlock only after confirming the owner is finished.

## Operate inside the target worktree

Use `git -C <path> ...` so commands cannot accidentally target the coordinator's checkout. Confirm branch and status before every mutating Git command.

Remember that branches, tags, objects, stashes, rerere data, worktree metadata, and commonly config/hooks are shared even though working files, `HEAD`, and the index are isolated.

## Remove safely

Before removal:

1. Confirm the exact registered path and branch.
2. Confirm no Git operation is in progress.
3. Inspect tracked and untracked changes.
4. Confirm required commits are integrated or protected by a recovery ref.
5. Remove without `--force`.

```bash
git -C <path> status --short --branch
git branch --contains <tip-oid> <destination>
git worktree remove <path>
```

The bundled `remove` command refuses dirty or mid-operation worktrees and deliberately retains the branch:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/git-gud-worktree.sh" remove <path>
```

Delete the retained branch only after a separate reachability check. Never combine forced worktree removal and branch deletion into routine cleanup.

## Repair conservatively

- If a worktree moved manually, run `git worktree repair <new-path>` from a valid checkout.
- If administrative metadata looks stale, preview with `git worktree prune --dry-run`.
- Lock a temporarily unavailable worktree instead of pruning it.
- If Git says a branch is checked out elsewhere, inspect `git worktree list --porcelain`; do not bypass the guard with force.

Read [references/worktree-layout.md](references/worktree-layout.md) for shared-state behavior, patterns, and repair cases.
