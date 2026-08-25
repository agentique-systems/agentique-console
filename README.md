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
- **Depth-capped nesting.** A controller agent (hub coordinator, planner —
  or the entry agent of a session commissioned with `allowChildSessions`) may
  spawn a child AgentSession running any pattern with
  `create_child_session`. The child's `main` resolves to that controller — its
  final crosses the boundary as a milestone — and a parent's own final is
  withheld until every child has reported (or is abandoned).
  `CONSOLE_MAX_SESSION_DEPTH` bounds ancestry depth (0 = top-level): only
  seats in sessions BELOW the cap receive the spawn tools, so the cap is the
  granting itself — a controller in a child session below the cap can nest
  again. Lifecycle follows the tree: closing or abandoning a session archives
  its whole subtree, and inspection (timeline, portfolio, UI) renders every
  depth the runtime permits.
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
  state to the provider session — an identity the Console deliberately never
  treats as durable.
- The task ledger is console-owned (`task_list`/`task_create`/`task_update`),
  keyed to the AgentSession — never a provider session — so every agent reads
  the same list; a task may name the requirement it discharges.
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
turns, and termination. Large tool payloads and screenshots
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
worktrees), which govern every git operation an agent runs itself, and the
three orchestration-doctrine skills main reaches for at decision points
(`orchestration-patterns`, `requirements-mechanics`, `wrap-up-and-landing` —
the standing prompts keep the invariants; these carry the procedure). Only
the composer's rewrite pass runs hermetically.

**Three agent concepts, deliberately distinct.** *Project-native Claude
agents* (`.claude/agents/*.md`) and *plugin-native agents* are workspace
configuration Claude owns; *Agentique AgentSessions* are the durable
orchestration participants the Console instantiates FROM a native definition
(the native `Agent` tool stays denied — the Console is the execution engine).

Add custom profiles as **native Claude agent files** in
`.claude/agents/<name>.md` — real YAML frontmatter (parsed with a real YAML
parser, never a home-grown subset) over a markdown body that becomes the
agent's instructions. Native fields keep their native meaning: `name`,
`description`, `tools` (list or comma string; **omitted means "inherits all
tools"**, bounded by console policy — never normalized into a list),
`disallowedTools`, `model`, `permissionMode`, and `mcpServers` (the full
native surface: stdio, SSE, HTTP, and name refs). Agentique-owned governance
rides a namespaced `agentique:` map — `role`, `recommendedSkills`,
`assignmentTurnBudget`, `handoffExtension`, `exemptFromOwnership` — or an
equivalent `.agentique/agents/<name>.overlay.json` sidecar. Example:

```markdown
---
name: database-reviewer
description: Review SQLite schema and migrations
tools: Read, Glob, Grep, Bash
agentique:
  role: reviewer
  recommendedSkills: [handoff-discipline]
  assignmentTurnBudget: 30
---
Review only. Run focused tests and report concrete defects.
```

Every definition carries three independent states: **Claude-valid** (parses
as a legitimate native definition), **Agentique-compatible** (instantiable
with every execution-affecting field's semantics preserved — a valid file
using a native feature the Console cannot execute faithfully, such as
`skills:` preloading or `maxTurns`, shows valid + incompatible with the
reason and the `agentique:` alternative), and **Agentique-trusted** (the
operator approved that exact source revision). Only all three run. Trust
binds to the definition SOURCE — path, native name, file bytes, overlay
bytes — so moving, renaming, or editing a trusted definition requires
re-trust, and a higher-precedence same-name file never inherits a shadowed
file's trust. Running AgentSessions stay frozen to their resolved snapshot
across edits. Built-in profiles are immutable — clone to a new id.
`npx tsx server/scripts/migrate-profile.ts` converts a legacy
`.agentique/agents/<id>/` bundle (still dual-read for one transition
release) into a native file; the migrated definition is a new source and
requires re-trust.

**Four governance layers, separately computed, never mixed into one list:**
(1) the **native-definition tool ceiling** — what the author granted
(`tools`/`disallowedTools`, omission = native inheritance); (2) the
**Agentique product-policy ceiling** (`sdk/native-capability-policy.ts`),
which classifies the SDK's ENTIRE native tool surface and denies seats the
coordination, task-state, scheduling, human-surface, and host-surface
natives; (3) **console tool grants** (`agent-sessions/grants.ts`) — the
orchestration tools (`mcp__console_agent__*`) a seat's role earns, a
separate grant surface from native tools; and (4) **worktree containment**,
which is never authorization. A seat's effective native tools are a pure
intersection — `ceiling ∩ policy` (or `policy \ disallowedTools` when
`tools` is omitted) — identical with or without a worktree, and everything
in the surface outside that set is denied by name. Nothing is ever added
because of a worktree or a console convenience; a policy tripwire test
parses the installed SDK's tool schemas and fails CI when an unclassified
tool appears.

Capability is native or declared, never console-built. `Bash` gives an agent
a shell — long-running work is backgrounded and read back with the native
`TaskOutput`/`TaskStop`/`Monitor` (author-declared in `tools` like any
native tool). Anything more comes from `mcpServers`, with **one launcher per
declaration**: the workspace root `.mcp.json` and settings-configured
servers stay SDK-owned with native semantics untouched; a profile's
stdio/SSE/HTTP declarations are console-executed (trust-gated, per-call
timeout, auto-approved whole); a bare name ref keeps its native meaning —
"attach an already-configured server" — so the workspace's own config
launches it and the Console only grants `mcp__<name>` (an unresolvable ref
is a compatibility finding). The built-in `frontend-implementer` and
`visual-reviewer` declare a browser server. `CONSOLE_MCP_DISABLED` drops
servers by name and `CONSOLE_BROWSER_MCP` replaces the browser one
install-wide. Any agent can dereference an artifact it or a teammate
produced with `read_artifact`.

**The Console runs no sandbox.** The SDK's gave every Bash call its own network
and PID namespace, so a dev server died with the call that started it and was
unreachable from the browser sent to verify it — the two things a coding agent
most needs. Containment is the worktree: every non-coordinator agent in a git
workspace works in its own tree, and only a write profile's tree merges when
its session reports; a read-only profile's tree is a snapshot that is
discarded, and the agent is told so. The worktree changes what a seat can
TOUCH, never what it is granted. Each agent is told its own capabilities at
spawn — the same intersection the runtime enforces — so a limit is a stated
fact rather than something to discover by failing.

## Context and decisions

A lane — main or any agent — keeps one provider session for its whole life,
and the CLI's native auto-compaction manages its context exactly as it does
for an interactive session; the Console never rotates a lane for context
reasons (the earlier console-side rotation subsystem and its four
`CONSOLE_CONTEXT_*`/`CONSOLE_CHECKPOINT_*` knobs were removed — setting one
is now a boot error, and historical journals keep their `*.context.rotated`
rows). What remains is CRASH recovery: when a lane dies before it can
report, the Console deterministically reconstructs a checkpoint from state
it owns (operator decisions, the governing requirements, the task ledger,
ownership, the worktree branch and diff, the agent's own last report), so a
successor always inherits something true. The occupancy figure the UI shows
is a per-process high-water mark; after a native compaction it stays at the
peak.

An AgentSession owes the operator a reply. If it goes idle without its
coordinator reporting, the Console closes the loop itself from the journal —
labelled as Console-assembled, never as a coordinator result.

Every agent — not just coordinators — has the typed `ask_operator` tool.
Blocking operator decisions surface immediately as cards. Nonblocking
decisions travel as coalesced milestones. Product scope, fidelity, licensing,
budget, security, and irreversible choices belong to the operator; routine
technical sequencing and local integration do not.

Each ask participates in a project-level **decision issue** — the durable
human choice it refers to. Asks from different agents or sessions sharing an
explicit `issueKey` become one issue: the operator sees one question, and one
answer resolves every attached ask. A chat reply binds automatically only
while a single issue is open; with several open, the orchestrator binds the
operator's words to the named issue explicitly, so one message can never
resolve unrelated questions. Issues outlive their askers and their session,
carry every asker's recommendation, and keep superseded answers as history.

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

Settings (`server/src/config.ts` is authoritative): `CONSOLE_DATA_DIR`,
`CONSOLE_PORT`, `CONSOLE_HOST`, `CONSOLE_SKILLS_DIR`, `CONSOLE_FS_ROOTS`,
`CONSOLE_MODEL`, `CONSOLE_IMPROVE_MODEL`, `CONSOLE_EFFORT`,
`CONSOLE_AUTO_INIT_GIT=0`, `CONSOLE_MCP_DISABLED`, `CONSOLE_BROWSER_MCP`.
Agent-residency knobs — these bound RESIDENT LANES (live provider
processes), never durable seats: a parked seat still exists, and an
AgentSession's roster may exceed what is resident.
`CONSOLE_MAX_RESIDENT_AGENTS` (the machine-wide lane cap, default sized to
host RAM: `min(12, max(4, totalmem/1.5GiB))`),
`CONSOLE_MAX_RESIDENT_AGENTS_PER_SESSION` (the per-AgentSession lane cap,
default 4 — per session, deliberately NOT shared across a parent and its
children: each child session brings its own residency under the global cap,
so nesting adds parallel capacity), `CONSOLE_AGENT_IDLE_REAP_MS` (default 300000),
`CONSOLE_AGENT_SPAWN_TIMEOUT_MS` (default 30000),
`CONSOLE_PEER_NAME_PREFIX` (default `console-`, the session-registry
namespace), and `CONSOLE_AGENT_WORKTREES=0` to disable agent worktree
isolation.
Supervision and governance knobs: `CONSOLE_MCP_TOOL_TIMEOUT_MS` (default
300000, per-call wall clock on every console-executed MCP server),
`CONSOLE_TOOL_ALARM_MS` (600000), `CONSOLE_TURN_QUIET_ALARM_MS` (300000),
`CONSOLE_WATCHDOG_IDENTICAL_CALLS` (5), `CONSOLE_WATCHDOG_ERROR_STREAK`
(10), `CONSOLE_MAX_REDELIVERY_ATTEMPTS` (2), `CONSOLE_GOVERNANCE_SWEEP_MS`
(30000), `CONSOLE_OPERATOR_ASK_DETACH_MS` (300000),
`CONSOLE_DEFERRED_AUTO_PROCEED_MS` (900000),
`CONSOLE_BLOCKING_ASK_ESCALATE_MS` (900000), `CONSOLE_COMPLETION_QUIET_MS`
(2000), `CONSOLE_PATTERN_HANDOFF_CAP` (120), `CONSOLE_PATTERN_STALL_MS`
(600000), `CONSOLE_CHILD_SESSIONS=0`, `CONSOLE_MAX_CHILD_SESSIONS` (5),
`CONSOLE_MAX_SESSION_DEPTH` (2).
Retired names fail the boot with the replacement named — among them the four
rotation knobs (`CONSOLE_CONTEXT_ROTATION`, `CONSOLE_CONTEXT_TOKEN_LIMIT`,
`CONSOLE_CONTEXT_TURN_LIMIT`, `CONSOLE_CHECKPOINT_TIMEOUT_MS`; native
compaction manages context) and the old `*_SEAT_*`/`*_PER_TREE` spellings.

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
  agent-profiles/registry.ts   immutable built-ins + trusted native .claude/agents
  sdk/native-capability-policy.ts  the whole native tool surface, classified
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
