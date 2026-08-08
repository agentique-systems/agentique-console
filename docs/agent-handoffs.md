# Agent handoffs

Agentique Console uses one handoff protocol for assignments, updates, milestones,
decisions, failures, final results, context rotation, and recovery. Plain-text
managed transfers are not produced by the v2 tools; old transcript rows remain
readable.

## Transport and delivery timing

Agents carry handoffs over the harness's native cross-session `SendMessage`
mesh: every console session registers a peer name, and the `message` field MUST
be the JSON envelope `{"handoff": <HandoffDraft>, "category": …,
"dedupeKey"?: …, "checkpointReadiness"?: "stable"|"defer"}`. A PreToolUse
middleware resolves the address, enforces the star topology, zod-validates the
envelope (denying with the exact failures so the sender self-corrects),
journals the handoff and its delivery row, and rewrites the tool input to the
canonical peer name and a `[handoff … delivery …]`-tagged normalized body.

Journal states are the delivery contract: `queued` (journaled, not yet
carried) → `delivered` (native carry succeeded — the sender's tool result
returned `success:true` with a `msg_id` — or a console input push landed) →
`acknowledged` (consumed by a settled turn; for main, the carry receipt).
A send to an unreachable seat is denied with a *queued receipt* ("queued as
delivery … do not resend"); the console re-carries the row when the seat
wakes. First cross-session contact demands ref confirmation (`name [ref]`) —
the middleware treats the identical retry as the same delivery, never a
duplicate.

Delivery into a running seat is native steering: messages enqueue and drain at
the receiver's next tool round, mid-turn. Console-path pushes (briefings,
redeliveries) steer the live turn the same way, with a
`steered mid-turn` runtime notice.

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

Ordinary records have a 4 KiB soft target and rotation checkpoints a 12 KiB soft
target. Targets never truncate storage. The full core and evidence manifest are
delivered; high-risk, needs-verification, or explicitly requested context also
gets its profile extension immediately. Other extensions remain available via
`read_handoff`, whose cursor pages default to 8 KiB and cannot exceed 32 KiB.

Missing or escaping file references are retained as warnings and elevate a
low-risk record to medium risk. They are never silently removed.

## Rotation

Soft rotation begins at 75% of the token limit or 80% of the turn limit. A seat
may defer while state is unstable. At a stable boundary the old provider context
runs a tool-free checkpoint pass using the same model and effort. A failed soft
checkpoint leaves the old context resumable and retries later.

The token limit is the configured cap, lowered — never raised — by a per-model
context catalog whose windows are deliberate under-estimates: an unknown model
rotates earlier rather than risking hard overflow.

A checkpoint draft that parses must also pass a deterministic quality gate:
non-blank summary, a next action and at least one resolving evidence ref for
non-completed work, and a resolving task ref when one is claimed. A failing
draft is retried once with the specific failures appended to the prompt; the
attempt is journaled (`handoff.checkpoint.retried`). If both drafts fail the
gate, a soft rotation defers exactly like a failed soft checkpoint, and a hard
rotation accepts the better draft and records its remaining failures. Checks
are structural only — an honest empty-work checkpoint passes, and length is
never scored.

Hard limits remain the configured token/turn caps. A failed hard checkpoint
rotates with a degraded, high-risk recovery handoff assembled from the latest
valid envelope and durable authorities. Recent transcript slicing is never used.

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
