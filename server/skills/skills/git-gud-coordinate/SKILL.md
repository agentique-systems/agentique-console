---
name: git-gud-coordinate
description: Coordinate concurrent Git work by multiple AI agents with isolated branches and worktrees, explicit ownership, dependency-aware integration, safe handoffs, and shared-state safeguards. Use when planning or running multi-agent repository work, assigning parallel tasks, preventing agents from interfering with one another, setting up an integration lane, or reconciling several agents' branches.
version: 1.0.0
provenance: git-gud skill pack, imported 2026-08-17
status: validated
requires:
  tools: []
whenToUse: When planning or reconciling parallel git work across several agents — ownership, integration order, handoff contract.
costNote: ~100 lines when invoked; references/collaboration-protocol.md and scripts/git-gud-preflight.sh on demand.
---

# Coordinate Multi-Agent Git Work

Treat the repository as shared state. Give every agent a private worktree, a private branch, a bounded path/task scope, and an explicit handoff contract.

## Start with read-only discovery

Run `bash "${CLAUDE_SKILL_DIR}/scripts/git-gud-preflight.sh" <path>` from this skill when available. Otherwise inspect:

```bash
git status --short --branch
git rev-parse --show-toplevel
git rev-parse --git-common-dir
git worktree list --porcelain
git branch --all --verbose --no-abbrev
git log --graph --decorate --oneline --all -n 30
```

Stop and diagnose any merge, rebase, cherry-pick, revert, or bisect already in progress. Preserve unrelated dirty changes; never assume they belong to the current agent.

## Establish the collaboration contract

Record these fields before assigning work:

- repository and integration worktree
- base ref and pinned base commit OID
- agent/task owner
- unique branch and worktree path
- owned paths or subsystem and explicit exclusions
- dependencies and integration order
- required checks and definition of done
- whether the branch is private, published, or shared

Use a dedicated integration worktree. Do not integrate from an agent's implementation worktree.

## Allocate isolated lanes

Create one branch per task and one worktree per branch. Use `$git-gud-worktrees` for lifecycle details.

Prefer branch names such as `agent/<agent>/<task>` or the repository's established convention. Pin every branch to the recorded base OID so agents start from identical history even if the remote moves.

Do not let two worktrees mutate the same branch. Avoid overlapping path ownership; when overlap is unavoidable, make the dependency explicit and serialize those edits.

## Coordinate execution

Require each agent to:

1. Confirm its branch, worktree, base OID, and scope.
2. Modify only owned paths unless the coordinator approves a scope change.
3. Recheck `git status --short --branch` before staging.
4. Create atomic commits with `$git-gud-commits`.
5. Report scope expansion, generated-file changes, migrations, or API changes immediately.
6. Avoid repository-global configuration and destructive cleanup.

Treat stashes, refs, object storage, hooks, config, remotes, and worktree administration as shared. A worktree isolates the index and working tree, not the entire repository.

## Require a structured handoff

Accept a branch only with:

- branch name and current tip OID
- original base OID
- ordered commit list and concise intent
- changed paths and any ownership exceptions
- commands run and results
- generated artifacts or migrations
- known risks, follow-ups, and unresolved conflicts
- expected integration dependencies

Reject handoffs with unexplained dirty files or missing verification.

## Integrate dependency-first

In the integration worktree:

1. Fetch or resolve every candidate tip to an immutable OID.
2. Recheck the integration branch is clean and current.
3. Order branches by dependencies, then by conflict risk.
4. Integrate one branch at a time with `$git-gud-sync`.
5. Resolve conflicts with `$git-gud-conflicts` and rerun affected checks.
6. Verify the combined result, not only each branch in isolation.
7. Record the integrated OIDs before cleaning worktrees.

Do not silently rewrite a branch another agent may still use. Coordinate a new base or integrate through a new branch instead.

## Apply hard safeguards

- Never use `git reset --hard`, `git clean -fd`, forced worktree removal, or broad restore commands without explicit authorization and a recovery ref.
- Never use plain `--force`; use an exact `--force-with-lease=<ref>:<expected-oid>` only for an owned rewritten branch.
- Never delete a branch until its required commits are reachable from the intended destination or a recovery ref exists.
- Prefer a temporary WIP commit on an owned branch over `git stash`; the stash namespace is shared and easy to misattribute.
- Avoid `git rebase --update-refs` in concurrent work unless every affected branch owner agrees.
- Keep hooks enabled unless the user explicitly authorizes bypassing them.

Read [references/collaboration-protocol.md](references/collaboration-protocol.md) when designing a multi-agent plan, handoff template, or integration policy.
