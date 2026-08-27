# Agent handoffs

Agentique Console uses one handoff protocol for assignments, updates, milestones,
decisions, failures, final results, and crash recovery. Plain-text
managed transfers are not produced by the v2 tools; old transcript rows remain
readable.

## Transport and delivery timing

One transport, every direction. Agents call the console-owned `send_handoff`
tool, whose parameters *are* the handoff core — `to`, `category`, `status`,
`risk`, `action`, `stateSummary`, `evidence[]`, `resultSummary`, `artifacts[]`,
`uncertainty[]`, `nextAction`. The provider validates that shape before the
call is emitted, so there is no envelope to hand-serialize and no parse step
that can reject a finished report.

The console route-checks the star topology, journals the handoff and its
delivery row, then pushes into the recipient's lane: waking a parked seat,
or steering a running turn so the message drains at its next tool round with a
`steered mid-turn` runtime notice. Journal states are the delivery contract:
`queued` (journaled, not yet carried) → `delivered` → `acknowledged` (consumed
by a settled turn). Capacity is not a delivery outcome — a row simply waits for
a lane and is carried when one frees, with nothing for the sender to interpret.

A route violation is the only thing that fails a send, because a message with
no legal destination has nowhere to go. Everything else about a transfer is
either valid by construction or repaired by the console.

> Earlier revisions carried handoffs over the harness's native cross-session
> `SendMessage` mesh, with a JSON envelope in the `message` string, ref
> confirmation on first contact, and queued receipts. It was removed: the
> envelope had to be escaped by hand (in one live run 59% of sends were
> rejected, and a completed review reached nobody), and peer pins lived in
> provider-process memory that every context rotation destroyed. Native
> primitives now cover capability — sandbox, processes, browser, worktrees —
> while addressing and delivery stay console-owned.

## Contract and authority

Every handoff has a versioned core containing task/status/risk, the requested
action, evidence-backed state, result artifacts, uncertainty, and an exact next
action. The server adds identity, sender/recipient, generation, trigger, and
root/parent lineage. Agents cannot author that metadata.

Profile extensions are selected by the server: coordination for main and
coordinators, implementation for implementers, investigation for explorers and
researchers, review for reviewers, and generic for custom profiles unless their
profile selects an existing extension kind.

Handoff statements are historical claims. Repository state, Console tasks,
provider journal entries, and artifacts are authoritative. Receivers verify
claims during normal work in proportion to risk and report contradictions with
`report_handoff_discrepancy`.

## Size and retrieval

Ordinary records have a 6 KiB soft target; reports and recovery checkpoints a
12 KiB soft target. Targets never truncate storage. The full core and evidence manifest are
delivered; high-risk, needs-verification, or explicitly requested context also
gets its profile extension immediately. Other extensions remain available via
`read_handoff`, whose cursor pages default to 8 KiB and cannot exceed 32 KiB.

Missing or escaping file references are retained as warnings and elevate a
low-risk record to medium risk. They are never silently removed.

## Context lifetime, generation retirement, and crash recovery

Within a generation a lane keeps one provider session, and the CLI's native
compaction carries continuity — the same thread an interactive session has.
Native compaction manages the context WINDOW, but a resumed provider session
still replays its whole retained history on every later API call, so a
long-lived seat's per-turn input otherwise grows with its lifetime (a live
run's seats retained up to ~551K tokens; 94% of its 279M input tokens was
cache replay). Retained history is therefore bounded at the WAKE boundary:
when a parked seat's provider session has carried context occupancy at or
above `CONSOLE_AGENT_CONTEXT_RETIRE_TOKENS` (default 150K; 0 disables), the
Console does not resume it. It journals a deterministic continuation
checkpoint (trigger `rotation`, checkpoint-flagged, recipient self), bumps
the seat's generation, and the next spawn starts a fresh provider session
whose system-prompt tail carries the checkpoint. The seat identity —
assignment, task truth, ownership, worktree — is untouched; only the
provider conversation changes. The retired transcript stays journaled under
its session id and the `agent_session.context.rotated` event records the
provenance (retired session id, peak occupancy, checkpoint id). A planned
rotation is not a failure: nothing escalates and main is not woken.

CRASH recovery shares the same reconstruction: when a lane dies before it can
report, the Console deterministically rebuilds a high-risk recovery
checkpoint from state it owns — operator decisions, the governing
requirements pointer, the task ledger, declared ownership, the worktree
branch and diff (uncommitted work is committed first), the standing
assignment, and the agent's own last report. A rotation checkpoint is built
from the same facts but flagged as planned (in-progress, medium risk) — its
facts were captured at a healthy boundary. Either way the successor is told
the snapshot is Console-assembled, not the prior context's memory, and that
authoritative state outranks its prose. Recent transcript slicing is never
used.

## Observability and evaluation

The event spine records creation, consumption, retrieval, and discrepancies.
Usage separates uncached, cache-creation, and cache-read input tokens.

Credential-free tests cover schema normalization, reference warnings, lineage,
lossless overflow, bounded retrieval, persistence, routing, and UI folding. The
priced live suite is deliberately opt-in:

```sh
AGENTIQUE_LIVE_HANDOFF_EVAL=1 npm run eval:handoffs
```

It runs 12 scenarios three times and reports schema validity, fact recall,
forbidden claims, evidence recall, serialized bytes, and token usage. The
committed baseline is a deterministic contract baseline, not a fabricated live
model score.
