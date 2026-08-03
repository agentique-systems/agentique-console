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
- An **AgentSession** is a conversation between the Orchestrator and 1–4
  specialist agents (presets: explorer / implementer / reviewer / researcher,
  or ad-hoc briefs). Each belongs to exactly one UserSession. Specialists
  address each other with `@mentions` (hop-limited); unaddressed replies return
  the floor to the Orchestrator. You observe these sessions read-only in the
  right pane — the center strip shows their cards, live seat states, and a flow
  indicator pulsing when delegation or results move between panes.
- **Delegation is asynchronous**: the Orchestrator posts into an agent session
  and ends its turn; when the session goes quiet with unseen results, the
  server wakes the Orchestrator with a transcript digest and it reports back to
  you. All human-in-the-loop — questions (AskUserQuestion) and plan approvals —
  surfaces as cards in *your* conversation; there is no separate inbox.
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
  Other knobs: `CONSOLE_PORT`, `CONSOLE_MODEL`, `CONSOLE_EFFORT`,
  `CONSOLE_HOP_LIMIT`, and `CONSOLE_FS_ROOTS` (colon-separated) to narrow where
  workspaces may live — by default the whole filesystem is browsable.
- Agents run with a sanitized environment. If you launch the server from inside
  another Claude Code session, its variables (`CLAUDE_EFFORT`, session ids) are
  stripped so the console's agents behave the same however you started it.
- `npm run dev` — same app with HMR and server watch (UI moves to :5173,
  proxying `/api` back to the server).
- `npm run verify` — typecheck + 123 tests. The whole suite drives a fake SDK,
  so it needs no credentials and spends nothing.
- `npx tsx server/scripts/smoke.ts` — one real end-to-end run against a scratch
  workspace (priced; prints the transcript, agent sessions, and tasks).

## Architecture

```
shared/   the frozen wire contract: domain rows, event catalog, REST shapes
server/   Fastify 5 + better-sqlite3/drizzle + @anthropic-ai/claude-agent-sdk
          (also serves web/dist, so the app is a single process)
  events/bus.ts            global event spine (replay-then-tail SSE, seq = Last-Event-ID)
  orchestrator/runner.ts   one SDK conversation per UserSession; serialized turn queue
                           (operator | wake | answer-revival jobs)
  orchestrator/tools.ts    the console MCP server: create/send/read/list/approve
  orchestrator/interactions.ts  question + plan cards (canUseTool bridge, restart revival)
  agent-sessions/host.ts   the drain loop: route one message → dispatch owed turns →
                           settle-if-quiet → wake the orchestrator (all watermark-derived,
                           crash-recoverable)
  tasks/                   the SDK task-tool mirror via hooks
  sdk/                     mapper (SDKMessage → events), SQLite SessionStore, fake
web/      Vite + React 19 + Tailwind 4 + zustand + TanStack Query
  live/                    one EventSource spine → router (prefix invalidation +
                           stream folds); transient deltas become overlays retired
                           by their persisted message (one chat lane, no double render)
  session/, agents/        the two transcript surfaces + strip + flow indicator
```

Every turn is one `query()` with `resume`; transcripts are mirrored into
SQLite via the SDK's `sessionStore`, so sessions survive restarts. In-flight
turns die with the process; unanswered cards go stale and their late answers
become fresh resumed turns.
