# Agent handoffs

Agentique Console uses one handoff protocol for assignments, updates, milestones,
decisions, failures, final results, context rotation, and recovery. Plain-text
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

Ordinary records have a 6 KiB soft target; reports and rotation checkpoints a
12 KiB soft target. Targets never truncate storage. The full core and evidence manifest are
delivered; high-risk, needs-verification, or explicitly requested context also
gets its profile extension immediately. Other extensions remain available via
`read_handoff`, whose cursor pages default to 8 KiB and cannot exceed 32 KiB.

Missing or escaping file references are retained as warnings and elevate a
low-risk record to medium risk. They are never silently removed.

## Rotation

Console-side rotation is opt-in (`CONSOLE_CONTEXT_ROTATION=1`). By default a
lane keeps one provider session for life and the CLI's native compaction
carries continuity — the same thread an interactive session has, and none of
the re-priming a rotation pays. Everything below describes rotation when it is
on.

A seat nearing its budget (80% of the token limit, or of the turn limit when
one is set) checkpoints proactively: a tool-free pass over the still-healthy
provider session using the same model and effort, stored for the rotation to
consume. At the limit itself the seat rotates unconditionally: the pending
proactive checkpoint if there is one, else a deathbed checkpoint query, else the
Console's own reconstruction.

The token limit is the configured cap, lowered — never raised — by a per-model
context catalog whose windows are deliberate under-estimates: an unknown model
rotates earlier rather than risking hard overflow.

A checkpoint draft that parses must also pass a deterministic quality gate:
non-blank summary, a next action and at least one resolving evidence ref for
non-completed work, and a resolving task ref when one is claimed. A failing
draft is retried once with the specific failures appended to the prompt; the
attempt is journaled (`handoff.checkpoint.retried`). If both drafts fail the
gate, the rotation accepts the better draft and records its remaining
failures. Checks are structural only — an honest empty-work checkpoint passes,
and length is never scored.

A failed checkpoint rotates with a degraded, high-risk recovery handoff
assembled from the latest valid envelope and durable authorities. Recent
transcript slicing is never used.

## Observability and evaluation

The event spine records creation, consumption, retrieval, discrepancies,
checkpoint failures, and enriched rotation metadata. Usage separates uncached,
cache-creation, and cache-read input tokens.

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
