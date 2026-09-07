# Agentique Console

A local console for durable, inspectable agent work on a codebase. An
operator states a goal for a Workspace; an Orchestrator turns it into
Requirements and an Execution Plan; Workers carry out bounded Tasks in
isolated worktrees; the runtime integrates their changes, runs the
deterministic completion check and the Gate Evaluator, and asks the
operator to sign the result off. Publication to the Target branch is a
separate, atomic, receipted step that the operator requests explicitly.

Everything the runtime knows is in one SQLite database plus a
content-addressed blob store; the process can be killed at any point and
resumes from the durable record. The Claude Agent SDK is the only provider.

The architecture is defined under [`docs/architecture/`](docs/README.md);
those four documents are authoritative over this README.

## Running

Requirements: Node 22.22 or later, git on `PATH`, and the Claude Agent SDK
credentials the provider needs in the environment.

```
npm install
npm start          # builds the web application and serves it with the API on one port
npm run dev        # the API (tsx watch) and the vite dev server side by side
```

The server prints the address it listens on. State lives under
`CONSOLE_DATA_DIR` (default `~/.agentique-console`): `console.sqlite`, the
blob store, provider continuation state, and per-Workspace worktrees.

Startup validates the configuration, opens the database (a database the
current schema did not create is refused with instructions to reset the
data directory; there is no migration path from any earlier version),
recovers durable state (interrupted Attempts, pending blob writes,
outstanding publications), and only then admits work and serves requests.
While the blob reconciliation is incomplete, mutating requests are refused
with `503 unavailable`; reads keep working. The process assumes it is the
exclusive owner of its data directory.

Shutdown (SIGINT/SIGTERM) stops admission, lets the scheduler drain,
interrupts running Attempts through the provider's interruption path (they
are recorded as interrupted with cause `shutdown`, never as failed work),
waits a bounded time for them to settle, and closes the database. A Run is
never cancelled and an operator pause is never erased by a shutdown; the
next start reconstructs every runnable Run and every outstanding
publication from the rows.

### Configuration

All variables are optional and prefixed `CONSOLE_`. An invalid value fails
startup with exit code 1 naming the variable. Unknown `CONSOLE_*` names are
ignored.

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `~/.agentique-console` | State directory. |
| `PORT`, `HOST` | `4400`, `127.0.0.1` | The listener. `0` picks a free port. |
| `FS_ROOTS` | home and its filesystem root | Directories the Workspace browser may list, separated by the platform path delimiter. Every Workspace root must lie under one. |
| `MODEL`, `EFFORT` | `claude-fable-5-1`, `medium` | The provider model and reasoning effort. |
| `CONTINUATION`, `CONTINUATION_TTL_MS` | `1`, unset | Provider session continuation across Attempts and its retention. |
| `MCP_DISABLED` | unset | Comma-separated names of approved MCP servers (`browser`) to drop from the catalog an Attempt may receive. Not a flag: an entry that names no approved server fails startup. |
| `BROWSER_MCP` | unset | The `browser` MCP server command, whitespace separated. |
| `MCP_TOOL_TIMEOUT_MS` | unset | The bound on one MCP tool call of an Attempt, in milliseconds (at least 1000), applied through the SDK's own per-call limit; unset uses the SDK's default. |
| `PROVIDER_MAX_CONCURRENCY`, `PROCESS_MAX_ATTEMPTS`, `MAX_WORKTREES` | `4`, `6`, unset | Resource governor limits. |
| `MAX_CONCURRENT_RUNS`, `DIAGNOSTICS_RETAINED` | `4`, `500` | Host driver limits: Runs advanced concurrently; diagnostics kept in memory. |
| `DEFAULT_MAX_COST_USD`, `DEFAULT_MAX_TOKENS`, `DEFAULT_MAX_ATTEMPTS`, `DEFAULT_MAX_CONCURRENCY`, `DEFAULT_MAX_WALL_CLOCK_MS` | `50`, `5000000`, `60`, `3`, unset | The Budget a Run gets when the operator does not state one. |
| `ORCHESTRATOR_COST_USD`, `ORCHESTRATOR_TOKENS`, `ORCHESTRATOR_ATTEMPTS` | `5`, `500000`, `8` | The Orchestrator's allocation; the final reserve is at least one such allocation, by the canonical allocation rules. |
| `NODE_COST_USD`, `NODE_TOKENS`, `NODE_ATTEMPTS` | `4`, `400000`, `4` | The default allocation of a plan node. |
| `ATTEMPT_MAX_WALL_CLOCK_MS`, `CHECK_TIMEOUT_MS` | `600000`, `600000` | Bounds on one Attempt and on one deterministic check. |
| `DEFAULT_COMPLETION_CHECK` | `npm test` | The completion check of a coding Run when the operator states none; empty declares none. |
| `DEFAULT_EVALUATOR` | `reviewer` | The Gate Evaluator: the built-in reviewer or `none`. |

### Verification

```
npm run verify     # typecheck and the test suites of every workspace
npm test           # the test suites alone
npm run build      # core, server, and the web bundle
```

`npm run test:browser` builds the web application and drives it in a real
Chromium (Playwright) against a real server process over a disposable
repository: the normal operator path through publication, pagination,
pause and resume, a reconnect, deep links, and a narrow viewport. It needs
Playwright's browser once: `npx playwright install chromium`.

`npm run verify:coding-run --workspace server` runs one real coding Run
against the live provider over a disposable repository; it is the only
step that needs credentials. The live smoke test in the server suite is
skipped unless `AGENTIQUE_LIVE_SMOKE=1`.

## What an operator does

1. Add a **Workspace**: a directory under a browse root, usually a git
   repository. A git Workspace publishes to a branch; a plain directory
   can run everything but cannot be published atomically, and the console
   says so before anything is attempted.
2. Open a **Conversation** and start a **Run** from a goal. The goal and
   the completion check become the operator's Requirement; the Budget, the
   Orchestrator allocation, and the final reserve have validated defaults.
3. Answer what the Orchestrator asks: approve or edit its **Requirement
   proposal**, resolve **Decisions**, approve **Budget Increases**, steer
   it with messages. Every operator input is a durable record the next
   Orchestrator turn receives; nothing is a chat transcript.
4. Watch the **Execution Plan** (a compiled graph of pattern and join
   nodes), the **Task ledger**, the Invocations and Attempts, usage and
   Budget, Gates and Evaluations, and the live output of running Attempts.
5. When the completion check and the Gate Evaluator pass, review the
   **final report** and accept the **signoff** or request changes.
   Accepting records the final Changeset and completes the Run; it does
   not touch the Target.
6. Request **publication** and confirm it. The runtime prepares a
   candidate, verifies the accepted result on it, and updates the Target
   branch and a receipt ref in one atomic git transaction; a Target that
   moved meanwhile refuses the update and nothing is applied. A checkout
   of the Target branch is brought forward only when that is safe; local
   changes are never discarded.

Pause (soft: no new Attempts; hard: interrupt running ones), resume, and
cancel are available at every point. A cancelled Run stays inspectable.

### The console

The web application is scoped to one Workspace (switch from the sidebar or
the palette). Its pages: **Runs** (home: every Run of the Workspace, the
ones that need you marked and counted on the navigation), **Conversations**
(the thread beside the list; a Run starts from the launcher under the
thread), **Agents**, and **System**. A Run opens on its **Overview** (what
to do next, what needs you, progress, budget, live output) with its other
sections beside it: Requirements, Plan (the graph with a node and Invocation
inspector), Tasks, Decisions, Verification, Signoff & publish, Budget &
usage, Agents. Consequential actions (cancel, accept the signoff, publish)
confirm before they act. Keyboard: `Ctrl`/`⌘` `K` opens the palette (pages,
sections, recent Runs and Conversations, Workspaces, theme); `[` and `]`
step through a Run's sections; `Ctrl`/`⌘` `Enter` sends a message or starts
a Run from its form.

## HTTP API

`core/src/api.ts` is the one route contract: every route, its method and
path, its request schema, its response type, the pagination and body
bounds, and the error codes. The server registers exactly those routes and
the web application calls them by name. Highlights:

- `GET /api/health`, `/api/config`, `/api/system/capacity`
- `/api/workspaces`, `/api/fs/roots`, `/api/fs/dirs` (browse roots only)
- `/api/conversations`, messages, Requirements and Acceptance Criteria,
  Decisions, Runs
- `/api/runs/:runId` — the overview with the derived phase; `/plan`,
  `/invocations`, `/tasks`, `/decisions`, `/budget`, `/evaluations`,
  `/gates`, `/snapshots`, `/changesets`, `/artifacts`, `/usage`,
  `/signoff`, `/publications`; `start`, `cancel`, `pause`, `resume`,
  Budget Increases, signoff accept / request changes, publication request
  / resolve
- Records by id: plan nodes, Invocations, Attempts and their transcripts,
  Tasks, Handoffs, Decisions (resolve, supersede), Evaluations, Gates,
  Snapshots, Changesets, Artifacts (metadata, bounded content, download),
  Publications (advance)
- `GET /api/events` — the committed-event stream (server-sent events) with
  sequence replay from `Last-Event-ID`, filters by Workspace, Conversation,
  or Run, and the transient output of running Attempts.

Every list pages by keyset: `limit` (at most 200), `order` (`asc` by
default, `desc` for newest first), and an opaque `cursor` that names its
collection and order (`nextCursor` continues, `reverseCursor` turns
around); a page is also bounded to 1 MiB of serialized records and ends
before the record that would cross it, and any JSON response above 4 MiB
is refused as `413 payload_too_large` rather than truncated.

Every mutation is an idempotent operator operation: an identical replay
returns the recorded outcome; a request the domain refuses (a different
resolution of a resolved Decision, an action on a terminal Run) is
`409 refused` with the typed reason; a stale state transition is
`409 conflict`. Nothing
in a request names the actor; the server is the authority on identity,
state, and storage. Responses carry no credentials, provider payloads, or
storage paths.

## Layout

```
core/       @agentique-console/core — domain types, schemas, transitions, the API contract
server/src/
  persistence/    SQLite schema and baseline migration, stores, transactions, journal, blob store
  execution/      scheduler, Invocation and Attempt execution, runtime tools, Gates, completion,
                  signoff, publication, Budget growth, run control, recovery
  provider/       Claude Agent SDK adapter and fixture
  workspace-state/ git and directory providers behind the six Workspace ports
  agents/         Agent Definitions (built-in and Workspace files)
  composition/    the one runtime composition; the live verification entrypoint
  host/ events/ operator/ api/ workspaces/   process host, event stream, operator services, routes
  main.ts app.ts boot.ts config.ts           entrypoint, application, startup order, configuration
web/src/    the operator web application
docs/       the architecture documents and the delivery roadmap
```

`server/src/persistence/boundaries.test.ts` enforces the import rules
between these boundaries, the retired vocabulary across the tree, the
single scheduler, and the startup order. The test suites run real git,
real subprocesses, and real process death where the guarantee needs it;
no guarantee is claimed for power loss.
