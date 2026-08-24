---
name: orchestration-patterns
description: Choosing and commissioning AgentSession patterns — sizing the crew, writing briefings that carry a success contract, and the failure mode each pattern is prone to.
version: 1.0.0
provenance: moved from the standing orchestrator surfaces (agent-stack simplification, Stage 7b)
status: validated
requires:
  tools: []
whenToUse: Before create_agent_session when the pattern or crew size is not obvious, and when a running session's shape stops fitting the work.
costNote: ~70 lines when invoked.
---

# Orchestration patterns

The tool description carries the one-line "when" for each pattern; this
skill carries the judgment. Choose the shape the WORK has — never the
smallest crew out of thrift, never an inflated one for show.

## Sizing the crew

- Ask of every seat: what does THIS agent add beyond the others — new
  information, independent evidence, real capacity? A seat that adds none is
  coordination cost.
- One coherent stream per session. Two independent streams are two sessions
  run in parallel, not one big roster; pass results between them as artifact
  and handoff ids.
- Prefer close-and-create over deforming a running session past its
  briefing. add_agent covers an emergent need in an open role; a changed
  DECOMPOSITION wants a fresh session.
- Nest (allowChildSessions) only for a workstream with its OWN internal
  decomposition, so you arbitrate across workstreams instead of within them.

## Briefing craft

The briefing is the session's contract, not a greeting:

- `why` — why this session, this pattern, now. The run review reads it.
- `expecting` — what evidence would count as success, or change your plan.
  The session reads this as its success contract; a vague expecting gets
  you a vague final.
- `requirements` — the delegated sub-scope, named by id. A session
  commissioned without ids renders as unscoped, and its seats hold no
  scoped reporting tools.
- `tasks` — the initial ledger units, created WITH the session so the
  briefing's taskId resolves and the entry assignment starts its unit.
- Make the assignment self-contained: the seat sees the briefing and the
  workspace, not your context.

## Per-pattern failure modes

- hub_and_spoke — the default when decomposition is unknown or evolving. A
  coordinator that relays without sequencing adds a lossy hop: brief it on
  what to integrate, not just what to distribute.
- pipeline — the agents ARE the stages; a relay stage that adds nothing
  loses quality. Steer a specific stage with send_to_coordinator `to`
  (update-only); assignments still enter through stage 1.
- evaluator_optimizer — pass patternConfig.rubric or the evaluator invents
  its own bar. Same-model loops collude; the builder enforces distinct
  models unless you opt out. The loop is round-bounded — make each round
  carry the FULL work product.
- map_reduce — seat only the reducer; width is decided at dispatch time,
  one self-contained item per mapper. Items that share state do not map —
  use a pipeline or hub instead.
- debate — one BLIND round: each debater argues once and never sees the
  others, so instructions must not promise rebuttals. Disagreement is the
  signal; brief debaters to commit to a position, not to hedge.
- peer_to_peer — rarely; only when the crew must hand work directly to
  each other. The Console caps handoffs and stops ping-pong; a mesh that
  needs sequencing wanted a hub.
- plan_execute — when the units deserve an explicit task DAG the Console
  dispatches on. The planner's DAG is live state: a stale ledger stalls
  dispatch, so re-planning means updating the ledger, not narrating.
