# Agentique Console v2

A deliberately narrow console for observable, coordinated agent work. It is a
single npm-workspaces application backed by SQLite and the Claude Agent SDK.

## Execution model

- A **Workspace** is a local directory.
- A **UserSession** is the Human Operator's conversation with the main
  Orchestrator.
- **The requirement graph is the committed specification.** Main proposes an
  outline of declarative requirement statements (`propose_requirements`); the
  operator edits it in place and approves; the Console mints stable ids
  (`r1`, `r2`, …) and derives every parent's status mechanically from its
  children (`all`/`any` composition). Statuses are semantic — open,
  satisfied, violated, infeasible, retired — never numeric; a terminal status
  is a journaled claim carrying evidence and a verification tier (self /
  independent / operator) the Console DERIVES from who stood behind the
  claim — never chosen by the reporting model. A committed node may declare
  the verification its satisfaction deserves (`(verify: independent)`), and
  the Console derives the gaps (satisfied below the declared tier) and the
  reversals (terminal claims the run later withdrew) — displayed everywhere,
  never a gate. Commissions name the requirement ids they serve
  and seats report or decompose only within those delegated subtrees; the
  run verdict can be `infeasible`, with evidence. Amendments supersede
  revisions while unchanged statements keep their status; refinement below a
  committed node needs no approval, changed meaning does.
  `docs/requirements.md` has the full model.
- An **AgentSession** is a Console-managed team of named agents running an
  **orchestration pattern**. Each agent has its own resumable provider session
  and a snapshotted agent profile. Idle agents park (process closed, resume
  handle kept) and wake on the next delivery.
- **Patterns are topology contracts.** At creation the chosen pattern's builder
  compiles a per-session contract — roles with tool grants, a route table,
  fan-in joins, a composite termination policy, a completion spec, and per-role
  prompts — snapshotted onto the session row. The Console executes contracts
  and never branches on pattern names. The catalog: `hub_and_spoke` (the default:
  one coordinator + 1–20 specialists), `pipeline` (the agents are the stages,
  in order), `evaluator_optimizer` (generate → judge cycles with a round cap),
  `map_reduce` (a reducer fans out runtime-minted mappers with
  `dispatch_work_items`; the join delivers all reports in one turn), `debate`
  (independent positions, console-seated judge), `peer_to_peer` (a bounded
  mesh: hard handoff cap, oscillation detection, a designated closer), and
  `plan_execute` (a planner over the task DAG the Console dispatches on).
- **One level of nesting.** A controller agent (hub coordinator, planner) may
  spawn a child AgentSession running any pattern with
  `create_child_session`. The child's `main` resolves to that controller — its
  final crosses the boundary as a milestone — and a parent's own final is
  withheld until every child has reported (or is abandoned). Child agents never
  receive the spawn tools, so the depth cap is the granting itself.
- Agents transfer work with one console-owned tool, `send_handoff`. Its
  parameters *are* the handoff core, so the provider validates the shape and
  nothing is serialized by hand. Every transfer is route-checked against the
  session's contract (hub sessions keep the familiar
  `main ↔ coordinator ↔ specialist` star) and journaled to SQLite
  before it is carried, then pushed into the recipient's live lane — waking a
  parked agent or steering a running turn. One transport, every direction.
  A coordinator can pass a specialist's report upward verbatim with
  `forward_message` — the operator reads the specialist's words, not a
  paraphrase.
- **Native for capability, console for coordination**, with no exceptions. The
  SDK supplies `Bash` (including backgrounded work read back with
  `TaskOutput`/`Monitor`), git worktrees behind `EnterWorktree`, and model
  invocation; anything beyond that — a browser, a database client — is an MCP
  server a profile declares and the Console launches. The Console builds no
  capability tools of its own. It used to: browser automation, process
  management and an HTTP probe. They were deleted after a live run in which
  `browser_evaluate` failed on every call behind a green test suite, every
  screenshot cost a second round trip to look at, and one keypress per call
  made real verification unaffordable. Addressing, delivery, the task ledger,
  context lifetime and the operator obligation stay console-owned, because the
  console holds invariants the native versions do not know about: a fixed
  roster, an agent that outlives many provider sessions, journal-as-truth, and
  a human who is owed a report. The native cross-session `SendMessage` mesh and the native
  `Task*` ledger were tried for those jobs and removed; both keyed durable
  state to the provider session, which dies at every context rotation.
- The task ledger is console-owned (`task_list`/`task_create`/`task_update`),
  keyed to the AgentSession so it survives rotation and every agent reads the
  same list; a task may name the requirement it discharges.
  An assignment whose task still has incomplete dependencies is
  scheduled rather than delivered, and dispatches the moment its last blocker
  completes. Main wakes itself later with the console-owned `set_deadline`
  (the native cron and wakeup tools are denied). In-process subagents
  (`Agent`/`Task`) are denied everywhere — they would fork ungoverned context.
  Main holds Read, Bash, Write and Edit for unblocking, verifying and operator
  deliverables; commissioned implementation goes through seats.
- Main wakes only for a decision, failure, milestone, or final result. Repeated
  pending reports from one AgentSession coalesce; ordinary updates never wake
  it. Runtime state is rendered as trace data instead of chat narration.

SQLite is the authoritative event and mailbox store. It records messages,
delivery transitions, tool calls/results, runtime notices, retries, failures,
turns, context rotations, and termination. Large tool payloads and screenshots
become durable artifacts referenced by bounded event rows. The SDK's eager `SessionStore` mirror is also SQLite-backed, so provider
history is available for recovery even when a participant crashes before it
can send a closing message.

## Agent profiles

Immutable built-ins are `coordinator`, `explorer`, `planner`, `implementer`,
`frontend-implementer`, `reviewer`, `visual-reviewer`, and `researcher`.
Profiles define purpose, instructions, exact tools, permission mode, model and
effort overrides, turn limit, and any MCP servers its agents get. Every
profile declares a **role archetype** — `orchestrator`, `explorer`,
`planner`, `implementer`, or `reviewer` — naming the kind of progress the
seat produces (main is the run-level orchestrator); minted variants inherit
their base's role, and a write-isolated reviewer-archetype seat is the ONE
kind whose requirement claims the Console records as `independent` — the
tier follows the snapshotted facts, not the model's say-so, so reviewer
seats hold `report_requirement` wherever they sit in a topology.

Every lane sees the workspace as an interactive Claude Code session would: the
CLI's user, project and local settings load (CLAUDE.md, permissions, skills,
hooks), and every discovered skill is visible to every agent — a profile's
`skills` list is the set its brief recommends, not a filter. The console's own
skills plugin (`server/skills`) loads for main and every seat alike; it ships
the six `git-gud-*` skills (commits, conflicts, coordinate, recover, sync,
worktrees), which govern every git operation an agent runs itself and take
precedence over the older `worktree-etiquette` note. Only the rotation
checkpoint and the composer's rewrite pass run hermetically.

Add custom profiles as workspace plugin bundles: a directory per profile under
`.agentique/agents/<id>/`, holding an `agentique.profile.json` manifest (the id
must match the directory) plus any Claude plugin components — `skills/`,
`hooks/`, `agents/`, `commands/`, `.mcp.json`. The bundle's files hash to a
revision the operator must trust before an agent runs on it; an edit
invalidates the trust until re-approved. Built-in profiles are immutable —
clone to a new id. Example manifest:

```json
{
  "id": "database-reviewer",
  "title": "Database reviewer",
  "purpose": "Review SQLite schema and migrations",
  "instructions": "Review only. Run focused tests and report concrete defects.",
  "tools": ["Read", "Glob", "Grep", "Bash"],
  "permissionMode": "default",
  "maxTurns": 30,
  "mcpServers": {}
}
```

Capability is native or declared, never console-built. `Bash` in the profile's
`tools` gives an agent a shell — long-running work is backgrounded and read
back with the native `TaskOutput`/`TaskStop`/`Monitor`, so nothing polls and
nothing blocks a turn. Anything more comes from `mcpServers`: a
`{command, args}` per server, launched by the Console and auto-approved whole,
so its tool names never have to be mirrored in a console-side list. The
built-in `frontend-implementer` and `visual-reviewer` declare a browser server
this way. `CONSOLE_MCP_DISABLED` drops servers by name and
`CONSOLE_BROWSER_MCP` replaces the browser one install-wide. Any agent can
dereference an artifact it or a teammate produced with `read_artifact`.

**The Console runs no sandbox.** The SDK's gave every Bash call its own network
and PID namespace, so a dev server died with the call that started it and was
unreachable from the browser sent to verify it — the two things a coding agent
most needs. Containment is the worktree: every non-coordinator agent in a git
workspace works in its own tree, and only a write profile's tree merges when its
session reports. An isolated agent holds every built-in tool — Read through
Bash, Write and the web — and its profile's instructions govern use; a
read-only profile's tree is a snapshot that is discarded, and the agent is told
so. Only an agent WITHOUT a worktree (the coordinator, or any agent in a
non-git workspace) keeps its profile's `tools` list binding: there, every
built-in the profile does not grant is denied by name. Each agent is told its
own capabilities at spawn, so a limit is a stated fact rather than something to
discover by failing.

## Context and decisions

A lane — main or any agent — keeps one provider session for its whole life,
and the CLI's native auto-compaction manages its context exactly as it does for
an interactive session. Console-side context rotation is opt-in
(`CONSOLE_CONTEXT_ROTATION=1`): on, a lane is rotated onto a fresh provider
session the moment it reaches `CONSOLE_CONTEXT_TOKEN_LIMIT` (default 120,000)
tokens of measured occupancy or `CONSOLE_CONTEXT_TURN_LIMIT` model turns
(default 0 = no turn limit). Occupancy is the largest single request's prompt —
never the turn's summed input, which counts every cache read again per round
trip and would rotate a healthy agent after one turn. Rotation asks the agent
for a checkpoint; if that fails, the Console deterministically reconstructs one
from state it owns (task ledger, ownership, worktree branch and diff, the
agent's own last report), so a successor always inherits something true. The
full prior journal remains durable either way. The occupancy figure the UI
shows is a per-process high-water mark; after a native compaction it stays at
the peak.

An AgentSession owes the operator a reply. If it goes idle without its
coordinator reporting, the Console closes the loop itself from the journal —
labelled as Console-assembled, never as a coordinator result.

Every agent — not just coordinators — has the typed `ask_operator` tool.
Blocking operator decisions surface immediately as cards. Nonblocking
decisions travel as coalesced milestones. Product scope, fidelity, licensing,
budget, security, and irreversible choices belong to the operator; routine
technical sequencing and local integration do not.

## Running

```bash
npm install
npm start                    # http://localhost:4400
npm run dev                  # Vite HMR + watched server
npm run verify               # credential-free tests (fake SDK; worktree suites use real git)
```

Data defaults to `~/.agentique-console/console.db`; point `CONSOLE_DATA_DIR`
somewhere fresh to make a run's database a self-contained artifact, then
summarize it afterwards with
`npx tsx server/scripts/report-run.ts [path/to/console.db]`.

The orchestrator runs on `claude-opus-5` by default. `CONSOLE_MODEL` moves that
default, and the composer's model chip overrides it per session (opus-5,
fable-5, sonnet-5) — a change recycles the lane, so it takes effect on the next
turn rather than mid-turn. Agent models come from profiles and are unaffected;
every builtin profile runs on `claude-opus-5`. Effort: main and the write and
review profiles run at `xhigh`, coordination and evidence-gathering at `high`;
`CONSOLE_EFFORT` (one of low, medium, high, xhigh, max) overrides every lane.

Settings: `CONSOLE_PORT`, `CONSOLE_HOST`, `CONSOLE_MODEL`,
`CONSOLE_IMPROVE_MODEL`, `CONSOLE_EFFORT`, `CONSOLE_FS_ROOTS`,
`CONSOLE_MCP_DISABLED`, `CONSOLE_BROWSER_MCP`.
Agent-residency knobs: `CONSOLE_MAX_RESIDENT_AGENTS` (default 8),
`CONSOLE_MAX_RESIDENT_AGENTS_PER_TREE` (default 4; a parent session and its
children share the budget), `CONSOLE_AGENT_IDLE_REAP_MS` (default 300000),
`CONSOLE_AGENT_SPAWN_TIMEOUT_MS` (default 30000),
`CONSOLE_PEER_NAME_PREFIX` (default `console-`, the session-registry
namespace), and `CONSOLE_AGENT_WORKTREES=0` to disable agent worktree
isolation.

Historical SDK JSONL can be copied into the authoritative provider journal:

```bash
npm run import-legacy --workspace server -- /path/to/session.jsonl [session-id] [subpath]
```

## Minimal architecture

```text
shared/  domain, REST, and event contracts
server/
  orchestrator/runner.ts       serialized main turns + coalesced material wakes
  orchestrator/requirements.ts the requirement graph: revisions, statuses, delegations
  agent-sessions/service.ts    managed participants, strict routing, mailbox
  agent-profiles/registry.ts   immutable built-ins + trusted workspace bundles
  events/bus.ts                replayable event journal + artifacts
  sdk/session-store.ts         eager provider-entry journal
  runtime/worktree-manager.ts  console-owned git worktrees per seat
web/
  live/                        one replay-then-tail EventSource
  session/, agents/            conversation and complete execution inspector
```

The intended vertical slice is intentionally small: orchestration, managed
agent sessions, reliable events, bounded context, profiles, and enough runtime
tooling for agents to validate their work.
