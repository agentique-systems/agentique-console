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
resumes from the durable record. Claude Agent SDK, OpenAI Codex SDK, and
Vercel AI SDK 7 are peer execution providers behind the same adapter contract.
Select the provider and its model in [Settings](docs/settings.md); see
[provider configuration and capabilities](docs/providers.md).

The architecture is defined under [`docs/architecture/`](docs/README.md);
those architecture documents are authoritative over this README.

## Running

Requirements: Node 22.22 or later, git and ripgrep (`rg`) on `PATH`, and
credentials for the selected provider. Claude remains the default.

```
npm install
npm start          # builds the web application and serves it with the API on one port
npm run dev        # the API (tsx watch) and the vite dev server side by side
```

The server prints the address it listens on. State lives under
`CONSOLE_DATA_DIR` (default `~/.agentique-console`): `console.sqlite`, the
blob store, provider continuation state, and per-Workspace worktrees.

Startup validates the configuration, opens the database (a database the
current schema lineage did not create is refused with instructions to reset
the data directory; version-1 orchestration databases migrate forward without
rewriting runs, manifests, or events),
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

### Settings

Open **Settings** from the navigation or workspace gate. Configure providers,
models, MCP tools, conversation preferences, workspace defaults and execution
limits there. Saved credentials require separately provisioned encrypted
storage. See the [Settings guide](docs/settings.md) for precedence, setup,
backup/recovery, administration and restart behavior.

### Configuration

Application variables are optional and prefixed `CONSOLE_`; SDK credential
variables use their standard names. An invalid value fails
startup with exit code 1 naming the variable. Unknown `CONSOLE_*` names are
ignored.

| Variable | Default | Meaning |
|---|---|---|
| `SETTINGS_KEY` | unset | Separately protected 32-byte base64 AES-GCM key; required for saving credentials. |
| `ADMIN_TOKEN`, `PUBLIC_ORIGIN` | unset | Remote Settings requires a bearer token (at least 32 characters) and exact HTTPS origin. |
| `TRUSTED_ENDPOINT_ORIGINS` | unset | Comma-separated exact origins allowed for custom providers and HTTP MCP, including explicit local endpoints. |
| `DATA_DIR` | `~/.agentique-console` | State directory. |
| `PORT`, `HOST` | `4400`, `127.0.0.1` | The listener. `0` picks a free port. |
| `FS_ROOTS` | home and its filesystem root | Directories the Workspace browser may list, separated by the platform path delimiter. Every Workspace root must lie under one. |
| `PROVIDER` | `claude` | Default backend: `claude`, `codex`, or `ai-sdk`. |
| `MODEL`, `EFFORT` | selected provider default, `medium` | Default model override and reasoning effort. |
| `CLAUDE_MODEL`, `CODEX_MODEL`, `AI_SDK_MODEL` | `claude-fable-5-1`, `gpt-5.6-terra`, `openai/gpt-5.6-sol` | Each provider's default model. |
| `CLAUDE_MODELS`, `CODEX_MODELS`, `AI_SDK_MODELS` | bundled catalog | Comma-separated model allowlists. The corresponding default must be present. |
| `MODEL_CATALOG` | unset | JSON model metadata, reasoning efforts, context windows, and optional USD/million-token prices; [schema and examples](docs/providers.md). |
| `AI_SDK_HARNESS` | unset | `pi` enables experimental `HarnessAgent` models in addition to normal `ToolLoopAgent` models. |
| `CONTINUATION`, `CONTINUATION_TTL_MS` | `1`, unset | Provider session continuation across Attempts and its retention. |
| `MCP_DISABLED` | unset | Comma-separated names of approved MCP servers (`browser`) to drop from the catalog an Attempt may receive. Not a flag: an entry that names no approved server fails startup. |
| `BROWSER_MCP` | unset | The `browser` MCP server command, whitespace separated. |
| `MCP_SERVERS` | unset | JSON named catalog of stdio (`command`, `args`, optional `env`) or Streamable HTTP (`url`, optional `headers`) MCP servers. All providers enforce the effective capability policy. |
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
npm run verify     # typecheck, lint, and the test suites of every workspace
npm run lint       # ESLint, with the existing legacy findings baselined
npm test           # the test suites alone
npm run build      # core, server, and the web bundle
```

`npm run test:browser` builds the web application and drives it in a real
Chromium (Playwright) against a real server process over a disposable
repository: the normal operator path through publication, pagination,
pause and resume, provider/model switching and persisted invocation identity,
a reconnect, deep links, and a narrow viewport. It needs
Playwright's browser once: `npx playwright install chromium`.

`npm run verify:coding-run --workspace server` runs one real coding Run
against Claude over a disposable repository. Live smoke tests are opt-in:
`AGENTIQUE_LIVE_SMOKE=1` for Claude, `AGENTIQUE_LIVE_CODEX=1`,
`AGENTIQUE_LIVE_AI_SDK=1`, or `AGENTIQUE_LIVE_PI=1` for the new adapters.
The latter also require their credential environment variables. Default
tests make no billable model calls. See [live verification](docs/providers.md#verification).

## What an operator does

1. Choose or add a Workspace, then type in the conversation composer. Send is
   the entry point for questions, clarification and requests for work.
2. Talk to the Orchestrator. It answers before work starts, asks clarifying
   questions, and creates or steers execution internally when needed. Greetings
   and discussion do not start work Runs.
3. Review proposed Requirements and resolve required Decisions inline. Budget
   increases and side-effect approvals keep their explicit controls.
4. Follow progress and read the final report and Artifacts in the same thread.
   Stop, resume and cancel controls are beside the work. Execution plans,
   Invocations, audit records and detailed usage remain available through
   optional inspection.
5. Accept the verified result using the signoff confirmation. Request and
   confirm publication separately; acceptance alone never changes the Target.
6. Continue after completion. History spans multiple work Runs and survives
   reloads. Pending messages retry with the same durable request id.

Conversation history and **New conversation** live in the sidebar. Workspace
selection, model settings, Agents and System remain accessible. The model is
pinned on the first Send; a new conversation can select another model.
Enter sends, Shift+Enter adds a line, and Ctrl/Command K opens the palette.

Conversation-only turns use the existing engine with no filesystem or execution
tools, so chatting needs no worktree or completion configuration. Their usage
counts against a durable Budget. New work uses configured Budget, completion
check and evaluator defaults. The model sees a bounded recent history window;
older messages remain available in the thread. Default tests use deterministic
provider fixtures and make no billable model calls.

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

Domain control mutations are idempotent operator operations; message posts use
a client `requestId` for transport retry identity: an identical replay
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
  provider/       provider registry, Claude/Codex/AI SDK adapters, tools and fixtures
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
