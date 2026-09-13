# Execution providers

Claude (`claude`), Codex (`codex`), and AI SDK (`ai-sdk`) execute the same
`AttemptExecutionRequest` and return the same `AttemptExecutionOutcome`.
Only `server/src/provider/` imports SDKs. The registry supplies identity,
model metadata, credential readiness, and an explicit capability catalog.
Orchestration resolves that contract; it does not branch on backend names.

## Selection and persistence

[Settings ? Providers & models](settings.md) is the browser configuration
editor. Saved defaults and supported workspace overrides select the model for
new conversations; deployment values enforce their mapped defaults. Existing
conversations preserve their selected provider and model. The composer links
to Settings and displays its selection without another configuration editor.
The existing API accepts optional provider/model selection when admitting a new
conversation context. Unknown providers, unsupported model IDs and missing
credential configuration are refused before recording a partial message.

The chosen pair is an immutable `run.execution` value and overrides model
identity on **every invocation in that Run**, including workers, reviewers,
and final synthesis. It is copied into each immutable Context Manifest's
`content.modelPolicy`, displayed in invocation detail, and used for capacity
leases and continuation identity. Select a different pair when launching
the next Run; an in-flight Run is never silently switched.

Schema version 2 adds nullable run selection and usage-price provenance.
Version-1 rows/events/manifests remain unchanged. A missing provider on an
old manifest always means Claude, even if deployment defaults change.
Removing credentials cannot prevent recovery or inspection of existing
runs; subsequent execution reports an adapter failure. Model allowlists
apply to new launches, not previously pinned runs. Keep pricing metadata for
models still in use if authoritative dollar accounting is required.

## Configuration

Use Settings for supported instance configuration. See the [Settings guide](settings.md)
for encrypted storage, exact endpoint trust, non-billable verification and
restart requirements. Deployment variables enforce their corresponding
settings. Set environment variables before starting the server; `.env` files are not
automatically loaded. No secret or local credential path is returned by
`GET /api/config`. Readiness means a configured credential source exists,
not that a remote account has been authenticated or has model entitlement.

| Setting | Meaning |
| --- | --- |
| `CONSOLE_PROVIDER` | `claude` (default), `codex`, or `ai-sdk` |
| `CONSOLE_MODEL` | Override the default model of the selected default provider |
| `CONSOLE_CLAUDE_MODEL` | Default `claude-fable-5-1` |
| `CONSOLE_CODEX_MODEL` | Default `gpt-5.6-terra` |
| `CONSOLE_AI_SDK_MODEL` | Default `openai/gpt-5.6-sol` |
| `CONSOLE_CLAUDE_MODELS`, `CONSOLE_CODEX_MODELS`, `CONSOLE_AI_SDK_MODELS` | Comma-separated allowlists; defaults must be included |
| `ANTHROPIC_API_KEY` | Claude API authentication and AI SDK Anthropic models; Claude also retains its SDK's local-login behavior |
| `CODEX_API_KEY` | Codex credential; falls back to `OPENAI_API_KEY` |
| `OPENAI_API_KEY` | AI SDK OpenAI models and optional Pi/OpenAI models |
| `AI_GATEWAY_API_KEY` | AI SDK Gateway models |
| `CONSOLE_CODEX_HOME` | Dedicated Codex credentials/session directory; default `<dataDir>/providers/codex`. Do not point it at an interactive user's general-purpose Codex home. Login there separately if using stored Codex authentication. |
| `CONSOLE_CODEX_BASE_URL`, `CONSOLE_CODEX_PATH` | Optional Codex endpoint or compatible CLI binary override |
| `CONSOLE_OPENAI_BASE_URL`, `CONSOLE_ANTHROPIC_BASE_URL`, `CONSOLE_AI_GATEWAY_BASE_URL` | Optional normal AI SDK model endpoints; URLs cannot embed credentials |
| `CONSOLE_AI_SDK_HARNESS` | `pi` enables `pi/openai/<model>` and `pi/anthropic/<model>`; Pi uses native endpoints, so incompatible endpoint overrides are rejected |
| `CONSOLE_CONTINUATION`, `CONSOLE_CONTINUATION_TTL_MS` | Existing shared continuation enablement and retention policy |
| `CONSOLE_MCP_SERVERS` | Explicit JSON server catalog, below |
| `CONSOLE_MCP_TOOL_TIMEOUT_MS` | Per-call MCP/local-tool timeout for new adapters; default 60 seconds. Claude retains its SDK default when unset. |

For example, in PowerShell, after supplying `OPENAI_API_KEY` securely:

```powershell
$env:CONSOLE_PROVIDER = 'ai-sdk'
$env:CONSOLE_AI_SDK_MODEL = 'openai/gpt-5.6-sol'
$env:CONSOLE_AI_SDK_MODELS = 'openai/gpt-5.6-sol,openai/gpt-5.6-terra'
npm start
```

AI SDK supports `openai/<model>`, `anthropic/<model>`, and
`gateway/<upstream-provider>/<model>` via its official model factories.
Gateway allows additional upstream providers without application code
changes. Programmatic composition may inject any AI SDK `LanguageModel` or
`Agent` through `AiSdkAdapter`'s `resolveModel` / `createAgent` options.
Custom Agents are trusted server configuration: they must use the supplied
guarded tools and honor the Attempt signal and limits. SDK-native tools
that execute remotely are not automatically granted runtime authority.

`CONSOLE_MODEL_CATALOG` replaces the catalog of each supplied provider. It
accepts arrays of `{ id, label?, efforts?, contextWindowTokens?, pricing? }`.
Efforts use Agentique's `low`, `medium`, `high`, `xhigh`, `max` vocabulary;
an empty list means that this integration does not configure model effort.
Unsupported configured efforts fail explicitly. Context windows drive the
runtime's continuation occupancy check. Pricing requires all four
nonnegative fields in USD per million tokens. Supply current prices for
your account rather than treating an example tariff as authoritative:

```json
{
  "ai-sdk": [{
    "id": "openai/gpt-5.6-sol",
    "label": "OpenAI — Sol",
    "efforts": ["low", "medium", "high"],
    "contextWindowTokens": 200000
  }]
}
```

The optional `pricing` shape is
`{ "input": number, "cacheRead": number, "cacheWrite": number, "output": number }`.
Without it, new adapters mark rows `costKnown: false`; Usage displays
partial/unknown cost, not a claim of free execution. Dollar-only spend
enforcement cannot be authoritative without prices. Token, attempt, time,
reservation, and concurrency bounds still apply. SDK token reporting on
aborted requests may also be incomplete; diagnostics expose unavailable
usage. These limits are not a substitute for provider-side spend controls.

MCP example (secrets belong in server-side environment/config, never agents):

```json
{
  "docs": { "command": "node", "args": ["/absolute/path/docs-mcp.mjs"] },
  "catalog": { "url": "https://mcp.example.com/mcp" }
}
```

The existing `CONSOLE_BROWSER_MCP` shorthand remains supported.
`CONSOLE_MCP_DISABLED` removes named approved/configured servers. An agent
must declare both the server and each canonical capability
`mcp__<server>__<tool>`; the Tool Policy and exact-call approval checks still
apply. Configuring a server does not authorize its tools.

## Capabilities and limitations

| Capability | Claude Agent SDK | Codex SDK | AI SDK 7 |
| --- | --- | --- | --- |
| Runtime and structured result tools | Existing behavior preserved | Guarded per-Attempt MCP bridge | Guarded host tools in native `ToolLoopAgent` / `Agent` / `HarnessAgent` |
| Workspace tools and approvals | Existing native tools + PreToolUse | Authorized read/search/write/shell/URL-fetch tools via MCP | Same guarded local tools; Pi builtins filtered/replaced |
| MCP | Existing SDK transports, explicit catalog | stdio and Streamable HTTP, mediated bridge | stdio and Streamable HTTP host tools |
| Streaming | Existing SDK streaming | Native item snapshots converted to text deltas | Native AI SDK stream; harness events normalized by HarnessAgent |
| Abort/deadline | Existing behavior | SDK process signal + tool cancellation | Agent abort signal + tool/harness cancellation |
| Continuation | Native Claude sessions | Native thread resume; invalid/incompatible/missing sessions start fresh before any tool work | Bounded validated message replay; optional Pi native state **and journal bytes** |
| Usage/timing | SDK tokens, cache, cost, provider time | SDK turn-terminal tokens; wall time and optional configured tariff | Per-step tokens/cache; wall time and optional configured tariff |
| Diagnostics | Existing bounded transcript/failure classification | Bounded redacted JSONL and typed failures | Same; experimental lifecycle details remain adapter-owned |

Codex's TypeScript SDK does not expose per-call native approval callbacks.
The adapter therefore disables native shell/patch/subagent/browser execution
and exposes the authorized tool set through a random-token loopback MCP
endpoint. A private model catalog derived **offline from the installed CLI**
also removes model-level tool overrides; feature flags alone are insufficient.
The CLI still runs with read-only sandbox configuration and approval `never`,
but those settings are not relied upon as the authorization boundary. The
catalog and bridge are attempt-scoped and cleaned up. Unknown native model
metadata fails closed: upgrade the pinned SDK and rerun its offline wire
contract before enabling a model absent from the installed CLI catalog.
Disabling Agentique continuation stops reuse; the Codex CLI can still write
its own session files inside the dedicated private home.

For AI SDK, normal models run the SDK's own `ToolLoopAgent`; Agentique does
not implement a replacement model/tool loop. Optional Pi integration uses
`HarnessAgent` and the official Pi adapter for native sessions and compaction.
Its virtual sandbox is private scratch storage, not a second canonical
worktree. Authorized host tools operate on the assigned Agentique directory.
Pi uses its own packaged model registry; the bundled harness choice is
`pi/openai/gpt-5.5`. Newer model IDs may work in normal AI SDK mode before
they become available in Pi. Only the selected upstream credential is passed
to Pi, preventing its automatic Gateway preference from changing routing.
Harness continuation persists its private journal; an aborted in-flight tail
can be recomputed, not losslessly reattached. Framework pending host-tool
queues are not replayed across an Agentique authorization boundary.
All experimental imports and lifecycle adaptation live in
`server/src/provider/ai-sdk-harness.ts`.

New file tools resolve symlinks and reject paths outside the assigned
directory and repository/provider control directories. `shell` is an
explicitly authorized host-shell capability, **not an OS security sandbox**;
as with existing Claude shell authorization, approving a command grants that
command its host permissions. Web capability fetches URLs; web search
requires a configured MCP tool. Tool outputs, transcripts, continuations,
process output, and tool/agent call counts are bounded. Runs without an
assigned directory receive invocation-scoped provider scratch, not the
database directory.

## Verification

```text
npm run verify
npm run test:browser
```

Contract tests exercise both new adapters using the actual MCP transport and
AI SDK ToolLoopAgent, all authorization outcomes, decisions, cancellation,
usage, results and continuation. Harness tests drive the real HarnessAgent
and virtual sandbox against a scripted harness runtime. The pinned real Codex
CLI also talks to an offline Responses WebSocket fixture that verifies its
model-visible tool surface, without credentials or model work. API restart
tests and Chromium check provider/model selection and immutable manifests.
Existing Claude suites remain part of the default verification.

ESLint's checked-in suppression file baselines 36 findings in pre-existing
code; it does not exempt new provider files. New findings still fail lint.

Live tests are bounded, credential-gated, and excluded unless explicitly
enabled. They read a disposable file, call a runtime read tool, return a typed
result and check usage/transcripts; they never modify a real workspace:

```powershell
$env:AGENTIQUE_LIVE_CODEX = '1'      # CODEX_API_KEY or OPENAI_API_KEY
$env:AGENTIQUE_LIVE_AI_SDK = '1'     # OPENAI_API_KEY
$env:AGENTIQUE_LIVE_PI = '1'         # OPENAI_API_KEY, optional harness smoke
npm test --workspace server -- --run src/provider/multi-provider-live.test.ts
```

Optional model overrides are `AGENTIQUE_LIVE_CODEX_MODEL`,
`AGENTIQUE_LIVE_AI_SDK_MODEL`, and `AGENTIQUE_LIVE_PI_MODEL`.
Claude's existing `AGENTIQUE_LIVE_SMOKE` / `AGENTIQUE_LIVE_MODEL` gates are
unchanged. A skipped live suite is not evidence of account/model entitlement.

## SDK references

Implementation targets the pinned official SDK surfaces: Codex SDK
`0.154.0`, AI SDK `7.0.99`, Harness `1.0.109`, and Pi adapter `1.0.111`.
See the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk),
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[AI SDK agents](https://ai-sdk.dev/docs/agents/overview), and
[official harness adapters](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters).
Installed package declarations and SDK source are the executable API
baseline; run adapter contracts when updating these pins.
