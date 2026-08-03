# Agentique Console v2

A self-contained console for orchestrated agent work, built on the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) and
nothing else on the AI side. One npm-workspaces monorepo, one SQLite file, one
process per side — clone, install, run.

## The interaction model

- A **Workspace** is a directory on your machine. You point the console at a
  parent folder, name a new directory, and that directory *is* the workspace.
- A **UserSession** is a conversation between you (the Human Operator) and the
  **Orchestrator** — the only agent you ever talk to. The left sidebar lists
  them; each keeps its own Claude session (resume id) across restarts.
- An **AgentSession** is a group of 1–4 specialist agents (presets: explorer /
  implementer / reviewer / researcher, or ad-hoc briefs) plus a coordinator,
  working a coherent stream of work. Each belongs to exactly one UserSession.
  Agents address each other by name over the SDK's native SendMessage. You
  observe these sessions read-only in the right pane — the center strip shows
  their cards, live seat states, and a flow indicator pulsing when delegation
  or results move between panes.
- **Every agent is a native SDK subagent.** The Orchestrator runs as one
  persistent streaming SDK session per UserSession (the CLI's own
  architecture); creating an agent session returns a SPAWN PLAN the
  Orchestrator executes verbatim — each specialist and a **session
  coordinator** spawned as flat, named, background subagents that talk to each
  other (and to the Orchestrator) via the SDK's native SendMessage. The
  console does not run agents at all anymore: it OBSERVES the stream —
  SendMessage calls become the session transcript, spawn/stop bookends become
  turn and status events — and persists only its own domain rows. Specialist
  chatter stays out of your conversation; the coordinator reports conclusions
  up. Plans work the SDK's own way: planning-variant seats (read-only) send
  their plan up, and approval = respawning the seats as execute variants with
  the approved plan in their prompts. All human-in-the-loop — questions
  (AskUserQuestion) and the Orchestrator's own plan-mode approvals — surfaces
  as cards in *your* conversation; there is no separate inbox.
- **Modes**: every session is `execute` or `plan_execute`. For your session
  it's a toggle (plan_execute puts the Orchestrator in SDK plan mode: survey
  read-only, draft tasks, present the plan via ExitPlanMode for your approval).
  For agent sessions the Orchestrator chooses; a planning-phase specialist's
  plan is captured and routed to the Orchestrator for approval.
- **Tasks are first-class**, built on the SDK's TaskCreate/TaskUpdate tools:
  hooks mirror every session's task list (state, owner, blocked-by
  dependencies) into one per-UserSession view rendered in the center strip.

## Layout

```
sidebar          conversation            strip                inspector
UserSessions  │  you ⇄ Orchestrator  │  AgentSession cards │  selected AgentSession
              │  question/plan cards │  flow indicator     │  (read-only transcript)
              │                      │  tasks              │
```

## Running

```bash
npm install
npm start          # → http://localhost:4400
```

That's the whole thing: one command, one process, one port. It builds the UI
and the API server serves it alongside `/api` and the event stream. Agents run
through the real Claude Agent SDK using your local Claude Code credentials.

- Data lives in `~/.agentique-console/console.db` (override: `CONSOLE_DATA_DIR`).
  Other knobs: `CONSOLE_PORT`, `CONSOLE_MODEL`, `CONSOLE_EFFORT`, and
  `CONSOLE_FS_ROOTS` (colon-separated) to narrow where workspaces may live —
  by default the whole filesystem is browsable.
- Agents run with a sanitized environment. If you launch the server from inside
  another Claude Code session, its variables (`CLAUDE_EFFORT`, session ids) are
  stripped so the console's agents behave the same however you started it.
- `npm run dev` — same app with HMR and server watch (UI moves to :5173,
  proxying `/api` back to the server).
- `npm run verify` — typecheck + the full test suite. It drives a fake SDK,
  so it needs no credentials and spends nothing.
- `npx tsx server/scripts/smoke.ts` — one real end-to-end run against a scratch
  workspace (priced; prints the transcript, agent sessions, and tasks).

## Architecture

```
shared/   the frozen wire contract: domain rows, event catalog, REST shapes
server/   Fastify 5 + better-sqlite3/drizzle + @anthropic-ai/claude-agent-sdk
          (also serves web/dist, so the app is a single process)
  events/bus.ts            global event spine (replay-then-tail SSE, seq = Last-Event-ID)
  orchestrator/runner.ts   one PERSISTENT streaming SDK session per UserSession: jobs
                           push user messages into the live lane, turns are detected
                           from the stream (result + session_state_changed backstop),
                           interrupt keeps the lane, mid-turn messages steer, agent
                           reports (peer messages) mint their own turns
  orchestrator/options.ts  lane options + ALL AgentDefinitions (presets, planning
                           variants, the session coordinator) + forwardSubagentText
  orchestrator/tools.ts    the console MCP server: create_agent_session (the
                           spawn-plan factory), read/list, the coordinator's task board
  orchestrator/interactions.ts  question + plan cards (canUseTool bridge, restart revival)
  agent-sessions/host.ts   the OBSERVER: SeatRegistry (Agent spawns → seats),
                           derived transcript rows from SendMessage, derived
                           turn/status/phase events, console-domain CRUD
  tasks/                   the SDK task-tool mirror via hooks
  sdk/                     mapper (SDKMessage → events, subagent traffic tagged by
                           parent_tool_use_id, peer messages), fake
web/      Vite + React 19 + Tailwind 4 + zustand + TanStack Query
  live/                    one EventSource spine → router (prefix invalidation +
                           stream folds); transient deltas become overlays retired
                           by their persisted message (one chat lane, no double render)
  session/, agents/        the two transcript surfaces + strip + flow indicator
```

The Orchestrator's lane is one long-lived streaming `query()` reopened with
`resume` after restarts or mode changes; every other agent lives inside it as
a native subagent. Transcripts persist the CLI's way — JSONL files under
`~/.claude/projects/…` (main session + per-subagent files), written by the SDK
itself. The console's SQLite holds only its own domain: sessions, derived
messages, events, tasks, cards. In-flight agents die with the process; the
Orchestrator re-runs a session's spawn plan to restart them, and unanswered
cards go stale, their late answers becoming fresh turns.
