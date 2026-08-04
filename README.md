# Agentique Console v2

A deliberately narrow console for observable, coordinated agent work. It is a
single npm-workspaces application backed by SQLite and the Claude Agent SDK.

## Execution model

- A **Workspace** is a local directory.
- A **UserSession** is the Human Operator's conversation with the main
  Orchestrator.
- An **AgentSession** is one Console-managed coordinator plus 1–4 named
  specialists. Every participant has its own resumable provider session and a
  snapshotted agent profile.
- Communication follows one enforced star: `main ↔ coordinator ↔ specialist`.
  Specialists cannot message main or one another. Messages are committed to a
  durable mailbox before a participant is scheduled.
- Native SDK `Agent`, `SendMessage`, and task tools are denied. They would
  bypass persistence and make the UI incomplete. One Console task ledger is
  shared by the main agent and coordinators.
- Main wakes only for a decision, failure, milestone, or final result. Repeated
  pending reports from one AgentSession coalesce; ordinary updates never wake
  it. Runtime state is rendered as trace data instead of chat narration.

SQLite is the authoritative event and mailbox store. It records messages,
delivery transitions, tool calls/results, runtime notices, retries, process
output, failures, turns, context rotations, and termination. Large tool
payloads and screenshots become durable artifacts referenced by bounded event
rows. The SDK's eager `SessionStore` mirror is also SQLite-backed, so provider
history is available for recovery even when a participant crashes before it
can send a closing message.

## Agent profiles

Immutable built-ins are `coordinator`, `explorer`, `implementer`,
`frontend-implementer`, `reviewer`, `visual-reviewer`, and `researcher`.
Profiles define purpose, instructions, exact tools, permission mode, model and
effort overrides, turn limit, sandbox requirement, and runtime capabilities.

Add local profiles in `~/.agentique-console/profiles.json` (override with
`CONSOLE_PROFILES_FILE`). Built-in ids cannot be replaced. Example:

```json
[
  {
    "id": "database-reviewer",
    "title": "Database reviewer",
    "purpose": "Review SQLite schema and migrations",
    "instructions": "Review only. Run focused tests and report concrete defects.",
    "tools": ["Read", "Glob", "Grep", "Bash"],
    "permissionMode": "default",
    "maxTurns": 30,
    "sandboxRequired": true,
    "runtime": { "shell": true, "browser": false, "screenshots": false }
  }
]
```

Shell-capable profiles receive Console-owned start/read/stop process tools;
`process_read` can wait for a state change so agents do not poll. Frontend and
visual profiles also receive managed local-Chrome navigation, interaction,
console, snapshot, and screenshot tools. Process execution and SDK Bash are
fail-closed when the Linux sandbox is unavailable.

## Context and decisions

Provider sessions rotate before the next turn at 120,000 context tokens or 30
model turns by default. Rotation keeps at most 4,000 characters of structured
recent memory and starts a new provider generation; the full prior journal
remains durable. Tune with `CONSOLE_CONTEXT_TOKEN_LIMIT` and
`CONSOLE_CONTEXT_TURN_LIMIT`.

Coordinators have a typed `request_decision` tool. Blocking operator decisions
surface immediately as cards. Nonblocking decisions travel as coalesced
milestones. Product scope, fidelity, licensing, budget, security, and
irreversible choices belong to the operator; routine technical sequencing and
local integration do not.

## Running

```bash
npm install
npm start                    # http://localhost:4400
npm run dev                  # Vite HMR + watched server
npm run verify               # credential-free fake-SDK tests
```

Data defaults to `~/.agentique-console/console.db`. Other useful settings are
`CONSOLE_PORT`, `CONSOLE_MODEL`, `CONSOLE_EFFORT`, `CONSOLE_FS_ROOTS`,
`CONSOLE_GLOBAL_AGENT_TURNS` (default 4), and
`CONSOLE_PER_SESSION_AGENT_TURNS` (default 2).

Historical SDK JSONL can be copied into the authoritative provider journal:

```bash
npm run import-legacy --workspace server -- /path/to/session.jsonl [session-id] [subpath]
```

## Minimal architecture

```text
shared/  domain, REST, and event contracts
server/
  orchestrator/runner.ts       serialized main turns + coalesced material wakes
  agent-sessions/host.ts       managed participants, strict routing, scheduler
  agent-profiles/registry.ts   immutable built-ins + validated JSON profiles
  events/bus.ts                replayable event journal + artifacts
  sdk/session-store.ts         eager provider-entry journal
  runtime/                     sandboxed processes + local-Chrome inspection
web/
  live/                        one replay-then-tail EventSource
  session/, agents/            conversation and complete execution inspector
```

The intended vertical slice is intentionally small: orchestration, managed
agent sessions, reliable events, bounded context, profiles, and enough runtime
tooling for agents to validate their work.
