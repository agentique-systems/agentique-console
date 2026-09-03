# Multi-Agent Git Collaboration Protocol

## Contents

1. Invariants
2. Shared and isolated state
3. Task record
4. Handoff record
5. Integration policy
6. Failure containment

## Invariants

- One active agent owns one branch in one worktree.
- One coordinator owns the integration branch and integration worktree.
- Every task begins from a recorded commit OID, not a moving branch name.
- Every change has one accountable owner until it is integrated.
- Every integration is verified against the combined tree.
- Existing user changes are preserved and never silently absorbed.

## Shared and isolated state

| State | Per worktree | Shared across worktrees | Coordination consequence |
| --- | --- | --- | --- |
| Working files | Yes | No | Safe for concurrent edits in different paths |
| Index | Yes | No | Staging in one worktree does not stage another |
| `HEAD` | Yes | No | Each worktree may point at a different branch |
| Local branches and tags | No | Yes | Ref rewrites and deletion affect every agent |
| Object database | No | Yes | New commits become visible repository-wide |
| Stash refs | No | Yes | Do not use stashes as unnamed agent storage |
| Config and hooks | Usually no | Usually yes | Avoid uncoordinated config or hook changes |
| Rerere cache | No | Yes | Reuse only after reviewing the recorded resolution |
| Worktree registry | No | Yes | Create, lock, remove, and prune deliberately |

## Task record

Use this minimal record for each assignment:

```text
task: <stable name>
owner: <agent>
base: <ref>@<full oid>
branch: <unique branch>
worktree: <absolute path>
owns: <paths/subsystem>
excludes: <paths/subsystem>
depends-on: <task names or none>
checks: <commands>
publication: private | published | shared
```

If an agent must touch an excluded path, pause and renegotiate ownership before editing.

## Handoff record

Use this record when an agent completes work:

```text
task: <stable name>
branch-tip: <full oid>
base: <full oid>
commits: <oldest-to-newest oid and intent>
paths: <changed paths>
checks: <command and result>
generated: <files and generator command or none>
migrations: <ordering/rollback notes or none>
risks: <known risks or none>
depends-on: <task tips or none>
worktree-clean: yes | no, with explanation
```

Resolve handoff OIDs immediately. Branch names can move; OIDs make the accepted artifact stable.

## Integration policy

Choose a history policy before starting:

- Rebase private agent branches before handoff when the project wants a linear history.
- Merge shared or review-visible branches when preserving the published history shape matters.
- Cherry-pick cohesive commits when only part of a task is accepted; use `-x` when provenance matters.
- Squash only when intermediate commits have no review or diagnostic value.

Integrate dependency providers before consumers. After every integration, run the provider's checks plus tests for interfaces touched by both branches. Run the full required suite at the end.

## Failure containment

- Create `backup/<branch>/<timestamp>` before a risky rewrite.
- Preserve rejected integration attempts on a named branch when the diagnosis matters.
- Abort one operation before starting another; never stack a merge on a rebase or a cherry-pick on a conflicted merge.
- If ownership becomes ambiguous, stop writes, inventory worktrees and refs, and reconstruct each tip from OIDs and reflogs.
- If an agent disappears, do not delete its worktree until its dirty state, untracked files, and branch reachability are inspected.
