# Proposal: Artifact blob crash recovery (pending-write markers)

**Status: ACCEPTED WITH AMENDMENTS — implemented 2026-09-01.** The
binding statement of the implemented guarantee is
[execution-model.md](../architecture/execution-model.md) §2.1; where a
section below differs from it, §2.1 and the code govern. This document is
kept for the options considered (§2) and for the record of what was
accepted, amended, implemented, and deliberately excluded (the
disposition immediately below). Its remaining sections were written
before implementation and are annotated where the implementation
diverged.

## Disposition

**Accepted and implemented as proposed.**

- Option 1, the targeted pending-write marker protocol under
  `<root>/.pending/` — markers named by the digest alone, temporaries
  moved into the same directory, the marker durable before any byte of a
  new blob, marker removal after `COMMIT` or after compensation, and
  startup reconciliation deciding every surviving marker by the global
  committed-reference check (§2, §4 steps 1–8, §5, §6).
- `Transactor.afterCommit` with the stated semantics: root-owned from any
  depth, once, only after a successful `COMMIT`, after the transactor has
  left the transaction, in registration order, a throwing hook reported
  and never rethrown (§3).
- Reconciliation owned by `ArtifactStore.reconcilePendingBlobs()` and
  invoked by `RecoveryService.recover()` after the canonical transaction
  and the worktree releases, outside any transaction; no second scheduler,
  timer, or loop (§3).
- Every `ArtifactStore.create` participates without opting in; the
  marker is published inside the store's `put` (§3 "Participating
  creation paths").
- Unmarked historical orphans excluded; no scan, no automatic sweep, no
  "if no marker, assume old" path (§2, §7).
- The child-process crash windows of §6, each inspected after death,
  after recovery, and after a repeated recovery.

**Amended.**

- *Marker ownership on reuse.* The proposal published a marker before
  every `put` (§4 step 2), so a reuse of an already present blob carried
  a marker whose recovery action would have been decided by the reference
  check — and a crashed reuse of a pre-existing *unmarked, unreferenced*
  blob would have authorized its deletion. The implementation publishes
  the marker only when the store finds no blob for the digest: a reuse
  publishes none, a crashed reuse marks nothing, and a pre-existing
  unmarked blob is never deleted on the authority of a failed new
  transaction. `BlobWrite` gained `pending` (this call published a
  marker) beside `written` (this call wrote the blob); a `written: false`
  result can still carry a marker obligation (the concurrent-writer
  fallback that verified another writer's content), which is why the
  Artifact Store settles the marker from `pending`, not from `written`.
- *Hook registration order.* Compensation and completion are registered
  before the marker or the blob can exist, so the failure-prone steps
  (marker, temporary write, rename, Event, insert, `COMMIT`) run covered;
  the proposal registered them after `put` (§4 step 5).
- *`afterCommit` signature.* No `{ seq }` argument: the existing
  abstraction does not need one.
- *Marker content.* Empty; the name is the whole meaning. The proposal's
  `{ digest, pid, createdAt }` content was informational only and was
  dropped.
- *Report shape.* `RecoveryReport.blobs` is
  `{ resolvedMarkers, removedBlobs, removedTemporaries, failures[], failureCount, complete }`
  with failures typed by a closed kind (`enumeration_failed`,
  `reference_query_failed`, `blob_removal_failed`,
  `temporary_removal_failed`, `marker_removal_failed`, `unsafe_entry`,
  `unrecognized_entry`), the digest or a bounded sanitized entry
  identifier, and the closed failure kind; the list is capped at 64 and
  the count is complete. `complete` is the success statement. The
  proposal's `pendingBlobDigests` and `malformedMarkers` were replaced
  by that shape.
- *Diagnostics.* `commit_hook_failed`, `blob_marker_cleanup_failed`, and
  `blob_reconciliation_failed` (closed kinds, digests, safe identifiers).
  The `blob_marker_malformed` kind was folded into the reconciliation
  report's `unrecognized_entry` and `unsafe_entry`.
- *Safety checks.* Beyond the proposal's leaf `lstat`, the implementation
  refuses a symlink or foreign entry at the pending directory and at the
  shard directory, creates markers exclusively (`wx`), recognises
  temporaries by the full protocol name rather than a `.tmp` suffix, and
  reads exactly one directory. `storage:unsafe_entry` was added to the
  closed failure kinds for these refusals.
- *Startup boundary.* The proposal stated that production `main.ts`
  orders `recover()` before the scheduler starts. It does not: the
  replacement runtime is not wired into the legacy application, and no
  production code calls the clean-break `RecoveryService` (the boundary
  test pins this). The test harnesses model the boundary — recovery
  first, work refused while `blobs.complete` is false — and the
  production wiring is the application cutover's (roadmap Phase 9).

**Deliberately excluded.**

- The `durableBarriers` option and every `fsync` (§4 "Operating-system or
  machine failure"): the accepted guarantee covers process termination
  only, and the boundary test forbids the option in the new source. A
  power-loss guarantee, if ever wanted, is a separate decision.
- Any change to SQLite durability settings.
- The one-time operator-invoked reconciliation of historical orphans
  (§2 "Tradeoff"): not authorized; unmarked orphans stay.
- Any lock service or multi-process claim.

**Evidence.** `server/src/persistence/transactions.test.ts`,
`blob-store.test.ts`, `stores/artifacts.test.ts`,
`server/src/execution/recovery-service.test.ts`,
`data-access-crash.test.ts`, and the protocol case of
`persistence/boundaries.test.ts`.

## 1. The gap

Phase 2G-A requires that a `write_artifact` crash "leave no orphan after
recovery" without sacrificing committed or deduplicated content. The
Artifact Store guarantees, today and verified:

- no invalid request writes a blob; metadata never commits before its blob
  exists; every synchronous failure (exception, failed COMMIT) is
  compensated by `afterRollback`, which removes a newly written blob unless
  a committed Artifact anywhere references its digest;
- after an abrupt death before COMMIT (verified with a real child process,
  `SIGKILL` inside the call, a real SQLite file and `FileBlobStore`): the
  uncommitted rows are gone, the blob file remains, unreferenced;
- after startup recovery: the blob still remains — recovery repairs
  Attempts, leases, and worktree obligations and touches no blob; a later
  identical write reuses the file (`written: false`);
- a committed write whose response was lost replays the same Artifact id;
  a blob referenced by committed metadata survives a crashing duplicate.

No component knows, after a restart, which blob files were written by
transactions that never committed. That knowledge must come from either a
record written *before* the blob (a marker) or a comparison of the whole
blob tree against every committed reference (a scan).

## 2. Options

### Option 1 — targeted pending-write marker protocol (recommended)

Before a blob is written, the writer publishes a small **pending marker**
for the digest inside the owned blob root; the marker is removed after the
transaction commits (or after rollback compensation). At startup, recovery
resolves every marker that survived: a referenced digest keeps its blob,
an unreferenced one loses it, and the marker is removed. Cost is
proportional to the number of in-flight writes at the time of death,
never to the size of the store.

### Option 2 — startup blob/reference reconciliation scan

At startup, walk the entire blob tree, and remove every file whose digest
no committed Artifact references. This finds every orphan, including those
left before the protocol existed, but it is a garbage collector: a full
directory walk plus one reference query per file (or one bulk query) on
every start, growing with the store; a bug in the reference check deletes
committed content; and a single process start becomes proportional to the
whole history of the console. execution-model §2.1 excludes a garbage
collector from Phase 1 by name.

### Tradeoff and recommendation

The marker protocol is recommended **for writes performed under it**. It
is bounded (O(markers)), it never touches a file it did not mark, and it
cannot delete committed content because the reference check is the same
global check the rollback hook already applies. Its limitation is exactly
that it covers only marked writes: an orphan left by a death *before* the
protocol shipped carries no marker and stays invisible. The scan is the
only mechanism that can find such pre-existing orphans; it is not proposed
here. If the operator wants the historical orphans removed, a **one-time,
operator-invoked, dry-run-first reconciliation command** is the smallest
safe shape — a separate decision, not part of this proposal, and never an
automatic sweep on start.

The marker protocol is *not* correct merely because it avoids the scan; it
is correct because (a) the marker is durable before the blob exists, so no
blob written under the protocol can exist without its marker having
existed, (b) marker removal happens only after COMMIT, so every surviving
marker names a digest whose transaction either did not commit or committed
without completing its cleanup, and (c) the recovery action for a
surviving marker is decided by the global reference check, which is
correct in both cases.

## 3. Ownership and integration

- **Marker owner.** `ArtifactStore` (`server/src/persistence/stores/artifacts.ts`)
  publishes and clears markers; it is already the only writer of blobs
  and the only registrar of blob compensation. Markers are a storage
  concern of the persistence boundary: they are not rows, not Events,
  not orchestration state, and the scheduler never sees them.
- **Storage.** The `BlobStore` interface gains marker primitives
  implemented by `FileBlobStore` as files under `<root>/.pending/` and by
  `MemoryBlobStore` as an in-memory set (tests). No SQLite table.
- **Cleanup owner.** `ArtifactStore.reconcilePendingBlobs()` — invoked by
  `RecoveryService.recover()` after its canonical reconciliation
  transaction and after the outstanding worktree releases, outside any
  transaction, exactly where recovery already performs external
  compensation. Recovery is the one startup owner of external state; no
  second scheduler, timer, or loop is added.
- **Exclusive ownership.** Assumed, as today: one runtime process opens
  the database file and its blob store (migration-contract §4). Recovery
  runs once at process start before any provider or scheduler work is
  admitted. *Amended:* the test harnesses (`withProcess`, `openProcess`,
  the crash child) model that order and refuse work after an incomplete
  reconciliation; no production entrypoint invokes the clean-break
  `RecoveryService` yet — that wiring is the application cutover's. The
  proposal establishes no lock; it inherits the contract and states it.
- **When recovery is complete enough.** New work is admitted only after
  `recover()` returns. `reconcilePendingBlobs()` runs inside `recover()`,
  so no `write_artifact` can race a marker that a dead process left.
  Markers created by *this* process afterwards belong to live
  transactions and are never touched by recovery of this process.
- **Participating creation paths.** Every `ArtifactStore.create` — the
  runtime tool `write_artifact`, transcripts, captured tool calls,
  Changeset diffs, join and parallel indexes, command outputs, final
  reports, publication reports — participates without change, because the
  marker is published inside `create`. No caller opts in or out.
- **Nested writes.** `create` runs inside the caller's root transaction
  (`tx.write` re-entrancy). The marker is published inside the callback
  before `blobs.put`, exactly where `afterRollback` is registered today;
  `afterCommit` (below) is registered on the root from any depth, like
  `afterRollback`.
- **Transactor addition.** One method:
  `afterCommit(hook: (commit: { seq: number }) => void)`. Hooks run
  exactly once, only after a successful COMMIT, after the transactor has
  left the transaction, in registration order, and are cleared when the
  root ends; a hook that throws is reported through the existing
  diagnostics sink (`commit_hook_failed`, index and closed failure kind
  only) and never affects the committed result or the caller's return
  value. `afterRollback` is unchanged.
- **Post-COMMIT cleanup failure.** The committed Artifact, Event, and call
  row are the result; a marker that could not be removed stays on disk,
  is reported (`blob_marker_cleanup_failed`, digest and closed kind), and
  is resolved by the next recovery, which finds the digest referenced and
  simply removes the marker. Nothing is retried in-process; no state is
  kept in memory.

## 4. Ordering and durability

Per `create`, in the root transaction, on the calling thread:

1. Validate the request, ownership, and the final metadata (as today).
2. **Publish the marker** `<root>/.pending/<digest>`: create-or-overwrite
   a regular file holding `{ digest, pid, createdAt }` (≈ 100 bytes; never
   Artifact bytes, credentials, or call payloads). If a marker already
   exists (a concurrent same-digest write in this process, or a leftover
   this recovery already handled), it is left as is.
3. **Create the temporary blob** inside `<root>/.pending/` as
   `<digest>.<pid>.<counter>.<uuid>.tmp` (moved there from the final
   directory, so every in-flight file lives under the one reconciled
   directory), write the bytes.
4. **Publish the final blob**: `rename` the temporary file to
   `<root>/<2 hex>/<digest>` (same filesystem; atomic replace-or-create).
   An existing verified blob is reused instead (`written: false`).
5. Register `afterRollback` (remove the new blob unless referenced, then
   remove the marker) and `afterCommit` (remove the marker).
6. Append the Event and insert the row (as today); the caller continues
   its transaction (the `runtime_tool_calls` row, other stores).
7. **COMMIT** (owned by the root `write`).
8. **Remove the marker** (`afterCommit`).

Rollback at any point after 2 runs the compensation: remove the blob if
step 4 wrote it and no committed Artifact references the digest, then
remove the marker.

Distinguish three failure classes:

- **Abrupt process termination** (`SIGKILL`, `process.exit`, crash of the
  Node process): every file operation that returned has been handed to the
  kernel; the page cache survives the process. All ordering above holds as
  written. This is what the child-process suite tests, and it is all that
  suite proves.
- **Operating-system or machine failure** (kernel panic, power loss): a
  file operation that returned may not be on stable storage. Without
  barriers, the marker may vanish while the blob survives (the protocol
  then misses that orphan) or the rename may survive while the marker
  does not. *Excluded:* the `durableBarriers` option and its `fsync`s
  proposed here were not authorized and are not implemented; the
  accepted guarantee is for process termination only and makes no
  power-loss claim.
- **Storage durability assumptions.** `.pending/` and the blob tree are on
  one local filesystem with POSIX `rename` atomicity (Windows NTFS
  `MoveFileEx` with replace is equivalent); directory entries are
  durable after the directory `fsync`; the database file is on the same
  or a separately durable filesystem, with SQLite's own commit durability
  (`journal_mode=WAL`; the connection's `synchronous` setting governs
  whether a COMMIT is durable at power loss — the proposal does not change
  it). A SIGKILL test proves none of this and the documentation must not
  say otherwise.

## 5. Safety and deduplication

- **Marker identity.** The marker's name is the SHA-256 hex digest and
  nothing else; the store validates it against `^[0-9a-f]{64}$` before
  any use, and the blob path is always computed by `pathFor(digest)` from
  that validated name — never read from the marker's content, never
  joined from user data. A marker cannot name a path, traverse, or point
  outside the owned root, because it names no path at all.
- **Collisions.** Two markers for one digest are one marker (same name);
  two writers of one digest in one process share the blob and the marker,
  and the last transaction to end removes the marker (a removal of an
  absent marker is not an error). With single ownership there is no
  cross-process collision.
- **Repeated writes of the same digest in one transaction.** The first
  `put` writes and registers both hooks; later ones reuse (`written:
  false`) and register nothing; one `afterCommit` removes the marker once.
- **Distinct Artifact records sharing a digest.** Reference checks are
  by digest over the whole `artifacts` table (all Runs, all Conversations,
  `artifacts_digest` index), exactly as `discardUnreferencedBlob` checks
  today. Any committed reference anywhere protects the blob.
- **Pre-existing committed blob.** `put` reuses it (`written: false`); a
  marker is still published (step 2 precedes `put`) and later resolved to
  "referenced → keep"; the blob is never removed.
- **Restoring a missing blob referenced by committed metadata.** The
  reference exists before the write; the marker resolves to "referenced →
  keep". The rollback path keeps it likewise (as today).
- **An existing unreferenced blob written before the protocol.** Not
  marked, not visible, not touched. Stated as a limitation in §7.
- **Temporary files left by death inside `put`.** They live under
  `.pending/`, are named with the digest and a `.tmp` suffix, and are
  removed by reconciliation unconditionally: a `.tmp` file is never
  referenced by any row (rows name digests, and the final path is not a
  `.tmp`). The blob store's own failure path already removes its
  temporary file on a thrown write.
- **Malformed or partially written markers.** A marker whose name is not
  a digest, or whose content does not parse, is left in place and reported
  (`blob_marker_malformed`, file name only); reconciliation never deletes a
  file it did not name by digest. The content is informational (pid,
  time); the name alone drives the action, so a truncated content file is
  still resolvable.
- **Cleanup interrupted by another crash.** Every action is idempotent:
  removing an absent blob or marker succeeds; the next recovery repeats
  the remaining markers. Order within one marker: blob removal first, then
  marker removal, so a death between them leaves the marker and the next
  recovery finds no blob and removes the marker.
- **Cleanup failure (`EPERM`, `EROFS`, `EIO`) and the next attempt.** The
  marker (and possibly the blob) stays; recovery reports the digest under
  `pendingBlobDigests` with the closed failure kind; the next recovery
  retries. No in-process retry loop, timer, or background task.
- **Symlinks and foreign files.** Before removing, the store `lstat`s the
  computed path and removes only a regular file; a symlink, directory, or
  anything else under a marker's computed path is reported and left.
  Removal uses the computed path (`rmSync` on a symlink would remove the
  link, not its target, but the check excludes it anyway).
- **Contents of markers and diagnostics.** Digest, pid, timestamp, counts,
  and closed failure kinds only. No Artifact bytes, credentials, tool-call
  payloads, or paths outside the digest-derived name.

## 6. Crash-window proof

| Window (death at) | State immediately after death | Recovery action | State after successful recovery | Invariant protecting committed content |
|---|---|---|---|---|
| Marker published, before the temporary file | marker; no blob; no rows | digest unreferenced → nothing to remove; remove marker | clean | nothing committed; nothing removed but the marker |
| Partial temporary write (inside `put`) | marker; `.pending/<digest>.….tmp` partial; no final blob; no rows | remove every `.tmp` under `.pending/`; digest unreferenced → remove marker | clean | a `.tmp` is never referenced; final blob absent |
| Final blob published, before the row (today's window 1) | marker; blob; no rows | digest unreferenced → remove blob; remove marker | clean | reference check is global; an unreferenced digest is by definition uncommitted |
| Rows and Event in the open transaction, before COMMIT (window 2) | marker; blob; SQLite discards the uncommitted frames on open | as above | clean | uncommitted rows never become references |
| After COMMIT, before marker removal (window 3 plus a marker) | marker; blob; committed rows | digest referenced → keep blob; remove marker | committed Artifact readable; no marker | keep-if-referenced decides before any removal |
| Death during cleanup (after blob removal, before marker removal) | marker; no blob; no rows | digest unreferenced, blob absent → remove marker | clean | idempotent, ordered blob-then-marker |
| Same digest already committed by another Artifact (window 4) | marker; blob (reused, `written: false`); rows of the new Artifact uncommitted | digest referenced by the earlier Artifact → keep; remove marker | earlier Artifact readable | global reference check |
| Rollback path (any synchronous failure) | compensation ran: blob removed unless referenced; marker removed | nothing pending | clean | unchanged from today |

"Clean" means: no marker for the digest, no `.tmp` file, and no blob file
unless a committed Artifact references it.

## 7. Scope of the guarantee

**Covered** (after a successful recovery, conditional on §4's barriers
for machine failure and unconditional for process death):

- writes performed under the protocol — every `ArtifactStore.create` of a
  process running this proposal;
- final digest files those writes created;
- temporary files those writes left under `.pending/`.

**Not covered:**

- unreferenced blob files that exist before the protocol ships (unmarked
  orphans) — invisible to it; only a scan (not proposed) or an
  operator-invoked reconciliation could find them;
- a marker that fails to resolve — its digest is reported and the
  guarantee is explicitly *not* met for it until a later recovery
  succeeds;
- any cross-process scenario — the single-owner contract stands.

**Definition of successful recovery.** `RecoveryReport` gains
`blobs: { resolvedMarkers: number; removedBlobs: number; removedTemporaries: number; pendingBlobDigests: string[]; malformedMarkers: number }`.
Recovery is *successful with respect to blobs* if and only if
`pendingBlobDigests` is empty and `malformedMarkers` is zero. A recovery
that removed nothing because nothing was pending is successful; a
recovery that could not remove an orphan is not, whatever else it did,
and no report may describe it as having met the no-orphan guarantee.

**No retroactive coverage and no compatibility fallback.** The proposal
adds no "if no marker, assume old" path, no automatic destructive sweep,
and no read-time fallback. Unmarked orphans stay until a separately
authorized mechanism removes them.

## 8. Proposed implementation plan

Components and files:

- `server/src/persistence/blob-store.ts` — `BlobStore` gains
  `markPending(digest): void`, `clearPending(digest): void`,
  `pendingDigests(): string[]`, `removeTemporaries(): number`, and
  `removeIfPresent(digest): boolean` (the `lstat`-guarded regular-file
  removal); `FileBlobStore` keeps temporaries and markers under
  `<root>/.pending/` and accepts `{ durableBarriers }`; `MemoryBlobStore`
  mirrors the set.
- `server/src/persistence/transactions.ts` — `afterCommit(hook)`, run
  exactly once after a successful COMMIT, failures reported as
  `commit_hook_failed` (index, closed kind) and never rethrown.
- `server/src/persistence/context.ts` — diagnostic kinds
  `commit_hook_failed`, `blob_marker_cleanup_failed`,
  `blob_marker_malformed`, `blob_reconciliation_failed` (digest or file
  name plus closed kind only).
- `server/src/persistence/stores/artifacts.ts` — marker publication in
  `create` (step 2), `afterCommit` registration, marker removal in the
  rollback hook, and `reconcilePendingBlobs(): BlobReconciliationReport`.
- `server/src/execution/recovery-service.ts` — call
  `reconcilePendingBlobs()` after the worktree releases; extend
  `RecoveryReport` with `blobs`.
- `server/src/main.ts` / boot — unchanged ordering (recover before
  scheduling); confirm by test.
- Documentation — execution-model §2.1 and the glossary Artifact entry
  updated *only when implemented*, replacing the "recovery removes no
  blob" statement with the exact guarantee of §7.

Schema implications: **none**. Markers are files; no table, column,
Event, or migration changes. `schema_info` unchanged.

Tests (new or extended):

- `transactions.test.ts`: `afterCommit` runs once after COMMIT, never on
  rollback, from any depth, in order; a throwing hook is reported and the
  committed result returned.
- `blob-store.test.ts`: marker primitives, `.pending/` temporaries,
  `lstat` guard (symlink, directory, foreign file untouched), malformed
  names ignored, idempotent removal.
- `stores/artifacts.test.ts`: marker lifecycle on success and on every
  existing rollback case; a same-digest pair in one transaction; a
  restored referenced blob keeps its file.
- `data-access-crash.test.ts` (child process, real file, `FileBlobStore`):
  the six windows of §6 — marker-before-temp, partial temp, blob-before-
  row, rows-before-COMMIT, COMMIT-before-marker-removal (hook injected to
  die after COMMIT), death during cleanup (recovery child dies between
  blob and marker removal) — each asserting the exact files after death,
  after recovery, and after a second recovery (repeatable), and that
  committed and deduplicated content reads afterwards.
- `recovery-service.test.ts`: the report fields; a failing removal
  (`EPERM` injected) yields `pendingBlobDigests` and no success claim;
  the next recovery resolves it.
- Boundary test: markers and reconciliation appear only in the
  persistence boundary and the recovery service; no scheduler, runner, or
  provider file names them; no timer or loop.

Performance bounds: per write, two extra file operations (marker create,
marker unlink) plus two `fsync`s when barriers are on; per startup,
`O(number of markers + number of temporaries)` file operations and one
indexed reference query per marker — independent of store size.

Remaining assumptions: single runtime owner of the database and blob
root; `.pending/` on the same filesystem as the blob tree; no external
process writes the blob root; the reference check's index
(`artifacts_digest`) is present (it is).

**Authorization outcome (2026-09-01):** (1) the marker protocol and the
`.pending/` layout — authorized and implemented, with the reuse amendment
above; (2) `Transactor.afterCommit` — authorized and implemented without
the `{ seq }` argument; (3) the recovery-service integration and the
report — authorized and implemented with the amended report shape; (4)
`durableBarriers` — not authorized, not implemented; (5) pre-existing
orphans — left in place, no reconciliation command. Execution-model §2.1
now states the implemented guarantee.
