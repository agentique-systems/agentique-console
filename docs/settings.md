# Settings

Settings is the instance-wide configuration area at `/settings/general`. It is
available from the workspace gate and the persistent application navigation,
before a workspace or provider is configured. Every section has a stable URL,
searchable navigation, Save/Cancel, validation, conflict handling, and protection
against leaving with unsaved changes. The header returns to conversations.
There are no user accounts or personal settings in this application.

## First connection

1. Provision credential storage below, or retain your deployment credential or
   SDK login. Start the console and open **Providers & models**.
2. Select a connection and its authentication method. Enter its API credential
   when applicable. Blank preserves a saved credential. For a compatible
   endpoint, authorize its exact origin in deployment configuration first.
3. Choose **Test connection & discover models**. Inspect the reported check,
   timestamp, authentication result, and model visibility. Save commits the
   connection, encrypted credential, and matching verification together.
4. Select the default provider and model, then Save. If the selected model
   changed, test it again: the earlier verification does not prove visibility
   of another model. Discovery offers model identifiers; the manual catalog
   editor supplies model metadata, context limits, supported efforts, and prices.
5. Return to the conversation and send a message. New conversations consume
   the saved defaults. A workspace override may select another configured model.
   Existing conversations keep their recorded provider and model.

No connection check makes a generating request or starts an agent session.
There is no billable test button. A successful ordinary conversation is the
explicit way to exercise actual execution and its normal accounting controls.

## Configuration inventory and runtime effect

The typed public contract lives in `core/src/settings.ts`. The service in
`server/src/settings/` maps it into the existing Config, provider registry,
conversation service, launch service, and runtime composition. It does not
create another runtime. Existing workspace registration and revisioned agent
definitions remain owned by their existing domain services.

Unless stated otherwise, saved values live in the versioned
`application_settings` row of the existing SQLite database. The names of
deployment variables that enforce individual fields are displayed next to
locked controls. `server/src/settings/configuration.ts` contains the exact
field-to-variable mapping; the environment reference remains in the README
and [provider documentation](providers.md).

| Section / configuration | Scope and source | Validation and persistence | Effect |
| --- | --- | --- | --- |
| General: theme, send shortcut, follow messages, in-app decision notifications | Instance; saved or built-in | Closed enums/booleans; SQLite | Immediately after Save; other open windows synchronize on focus. Shift+Enter keeps a newline. Notifications are in-app toasts, without OS push/email support. |
| Default execution provider and per-adapter default models | Deployment override, workspace override, application, built-in | Registered provider; default must belong to that provider's catalog | New conversations and work; existing execution identity is unchanged |
| Claude, Codex, OpenAI, Anthropic, Gateway connections | Instance, optionally deployment-enforced | Supported auth mode, required HTTP(S) endpoint, enabled state | Adapter reconstruction after Save; unsafe changes with active dependencies are refused |
| API credentials and protected MCP headers/environment | Deployment secret manager or encrypted application storage | Write-only replacement/removal; authenticated ciphertext bound to connection slot | Actual provider/MCP transport; excluded from public DTOs and exports |
| SDK/local-login sources, Claude cloud authentication | SDK or deployment-owned | Safe source metadata; no token extraction into Settings | SDK-native authentication; login/cloud setup remains deployment-owned |
| Model availability, labels, efforts, context windows, optional input/cache/output prices | Deployment catalog or saved catalog | Unique model IDs; adapter prefixes; finite positive limits and nonnegative prices | Registry selection, effort checks, continuation occupancy and usage accounting. Catalog edits affecting active models are refused. Missing prices mean cost is unknown, not zero. |
| Optional Pi harness | Deployment or application | Explicit opt-in; `pi/openai/` or `pi/anthropic/`; native endpoints only | AI SDK's existing Pi adapter; its packaged model catalog must support the selected model |
| MCP connections / browser tools | Deployment catalog or saved instance catalog | Unique stable names; stdio executable/args or HTTP URL; protected JSON environment/headers | Subsequent attempts; changes require dependent work to stop. Browser is an MCP connection using the existing capability boundary. |
| MCP discovery | Explicit operator check | 12-second initialize/listTools; at most 10 pages / 500 tools | Saves timestamped connectivity evidence only. No tool calls or grants. |
| Agent defaults: effort and invocation deadline | Deployment or application; agent files remain revisioned workspace inputs | Supported effort, bounded integer duration | Restart, then new definition/manifest preparation |
| Cost/token/attempt/time/concurrency budgets | Deployment, workspace override, application, built-in | Existing budget schema plus finite administrative bounds; allocations must fund initial and final work | Global defaults require restart; workspace overrides affect subsequent work. Existing allocations and records are preserved. |
| Orchestrator and node allocation; provider/process/worktree/conversation concurrency | Deployment or application | Existing allocation schema; bounded positive capacity | Restart: existing governor, planner, host and definition composition consume the values |
| Continuation enablement / resumability retention | Deployment or application | Boolean and optional positive duration | Restart; provider/model compatibility and existing continuation safeguards remain required. Retention does not promise file deletion. |
| Completion command / expected exit code, evaluator, check timeout | Deployment, supported workspace overrides, application | Nonempty command or explicit none, bounded exit code and timeout | Global changes require restart; workspace defaults affect subsequent work. Commands execute with console OS permissions. Coding admission still requires its deterministic check. |
| Workspace registration and inherited defaults | Existing workspace store plus saved overrides keyed by stable workspace ID | Existing filesystem-root and workspace service validation; model/budget validation | Add Git or directory workspaces through the existing wizard; overrides do not alter old manifests |
| Denied tools, tools requiring approval, denied MCP servers | Instance policy | Bounded exact capability/server names; narrowing only | Restart; existing capability-policy intersection, approval and signoff logic remain authoritative |
| Settings export/import and section reset | Instance administration | Versioned strict JSON, one revision check, deployment locks, active-dependency checks, explicit confirmation | Atomic non-secret settings replacement; section reset removes that saved section and restores inheritance. Credentials and conversation data are preserved. |
| Version, health, recovery diagnostics, effective values, sources and running limits | Read-only live projection | Safe metadata only | Distinguishes saved pending changes from the current process |
| Listener, data/database/blob/continuation/workspace directories, browse roots, web bundle, Codex home/CLI path, diagnostics retention, endpoint trust, administration policy, storage key | Deployment only | Existing config loaders plus administration validation | Environment/service-manager update and restart. Derived storage paths and fixed runtime bounds are not editable controls. |

## Precedence, atomicity, and restart

For the fields Settings manages, highest precedence is explicitly configured
deployment values, then supported workspace overrides, saved application
sections, and built-in defaults. An environment value locks its corresponding
control; a Settings import cannot remove that lock. Deployment credentials
also lock the authentication source and cannot be removed through the UI.
SDK credential files remain under the SDK's ownership.

Settings edits save a whole section. An unsaved section inherits the current
deployment/built-in values; resetting it restores that inheritance. The System
section shows provenance per effective value. Explicit per-conversation API
selection remains supported by the existing launch contract and is validated
against the effective registry; this is not another browser settings editor.

Each update includes the revision the form loaded. SQLite commits the settings,
ciphertext and matching test evidence in one immediate transaction. A stale
writer receives HTTP 409 and must reload before editing again. Validation or
encryption failure writes nothing. Schema migration `0003_settings.sql` adds
the settings table and advances the schema version to 4 without rewriting
conversations, runs, manifests or events. The settings document has its own
version, currently 1; unsupported versions fail closed.

Provider/default/model settings and workspace overrides apply to subsequent
work without a process restart. Agent/execution defaults, policy restrictions
and the tool timeout apply after restart because the runtime captures them at
composition. A banner lists pending categories; System shows both the saved
values and running limits. Restart does not rewrite historical records or the
provider/model and budget already pinned into active work.

Changing connection credentials/endpoints/enabled state, modifying an active
model's metadata, or removing its model is refused while dependent nonterminal
conversations/work exist. MCP changes require all dependent work to stop.
An idle but resumable conversation is still a dependency. Finish or explicitly
stop its execution before changing the connection. Changing a default remains
available and affects the next conversation.

## Credential storage and recovery

Saved secrets use AES-256-GCM with a random 12-byte nonce and an authentication
tag. Associated data binds the ciphertext to its connection slot. The key is
exactly 32 random bytes encoded as canonical base64, supplied through
`CONSOLE_SETTINGS_KEY`. It is never stored beside the ciphertext. Without a
key, non-secret Settings and deployment/SDK credentials remain usable; storing
a new credential is refused. There is no plaintext fallback.

Provision one key through the service manager's protected secret facility.
Allow only the console service identity and administrators to read it. On
Windows, use an ACL-protected service secret/environment source; on Linux,
use the service's secret manager or a service-account-only credential source.
Protect the data directory with the same OS access boundary. Do not commit
the key, put it in the database/data directory, or print it in deployment logs.

For an isolated PowerShell development session, this creates a key without
printing it (it lasts only for that process tree):

```powershell
$env:CONSOLE_SETTINGS_KEY = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
npm start
```

Production must preserve that key securely across restarts. Back up the
database and the key separately and record which key belongs to each database
backup. Restore the matching pair while the service is stopped. A missing,
wrong, or damaged key makes encrypted credentials unreadable and prevents
startup; the application never ignores or converts them to plaintext. Losing
the key requires restoring a matching backup or rebuilding credential storage
and re-entering upstream credentials. Non-secret JSON export is not a full
database backup and cannot recover secrets.

For planned rotation, explicitly remove saved credentials while the old key is
available, stop the service, provision the new key, restart, and re-enter the
credentials. Keep the old key for the retention period of old encrypted
backups. Removal only deletes the console's local credential; revoke a key
through its upstream provider separately. Backups may retain removed
ciphertext until those backups are expired.

Public API responses contain presence, source and update time, never saved
values or key suffixes. Empty credential input preserves the existing value;
removal is a separate confirmed action applied on Save. Test error bodies are
discarded. Known credentials are redacted across provider output chunks,
transcripts, diagnostics and results; tool calls containing those values are
refused before durable or approval-audit writes. Credential-bearing opaque
continuations are discarded rather than stored. Settings public values are
checked against known credentials to prevent accidental export via other
fields. Operators must still use protected fields for new secrets, not command
arguments, model labels, endpoints or conversation text.

## Administration and network trust

The default deployment is the existing local-operator model: Settings accepts
only a loopback peer and a localhost/loopback Host. All Settings and connection
test routes enforce this boundary. Writes also require the application-specific
`X-Console-Settings: 1` header. Supplied Origin must match, and cross-origin
Fetch Metadata is rejected. Administrative responses are `Cache-Control:
no-store`; cross-origin credentialed access is not enabled.

For remote access, configure a random `CONSOLE_ADMIN_TOKEN` of at least 32
characters and `CONSOLE_PUBLIC_ORIGIN`, an exact HTTPS origin. Preserve the
public Host at the authenticated reverse proxy and use TLS. The Settings UI
asks for the token and holds it only in memory; requests use an Authorization
bearer header. Reload requires re-entry. The server does not trust forwarded
peer/protocol headers. This protects administration; the console's other
operator APIs still require the deployment's existing private-network or
authenticated-proxy boundary. It does not turn the application into a public
multi-user service.

`CONSOLE_TRUSTED_ENDPOINT_ORIGINS` is a comma-separated list of exact origins,
including scheme and port. Every custom provider or HTTP MCP origin must be
explicitly allowed by deployment and requires restart. For example,
`http://127.0.0.1:11434` permits an operator-managed local compatible provider.
No-auth mode is limited to explicitly allowed OpenAI-compatible endpoints.
The administrator is authorizing outbound access to these origins, including
private addresses; do not add broad or untrusted destinations.

Endpoints cannot contain userinfo, a query credential, or a fragment. Server
HTTP checks pin a validated DNS address into the socket, refuse private and
link-local destinations without explicit trust, bound lookup/request time,
and refuse redirects. Changing origin requires re-entering the credential.
Changing an MCP connection requires re-entering its protected values.
API-key Claude/Codex execution uses a per-attempt authenticated loopback bridge:
the SDK receives a temporary token, and only the guarded bridge holds and
sends the saved upstream key. AI SDK HTTP requests and HTTP MCP traffic use
the same guarded network transport. Native SDK local/cloud authentication
remains SDK/deployment-owned and cannot be redirected through a UI endpoint
override. HTTP bridge traffic does not support WebSocket upgrades.

An executable MCP configuration is privileged code execution. Saving a changed
stdio server and explicitly testing it require separate confirmations. Enter
an absolute path to already installed software; discovery never installs a
package. A server can run startup code during discovery. Listing its tools
does not authorize them: agent declarations, role restrictions, instance
restrictions, exact-call approvals, mandatory signoff and publication controls
continue to apply.

## What verification means

Checks are server-side, one at a time, rate-limited to one per second, and
bounded to 12 seconds. Provider catalogs have a 1 MiB response bound and return
at most 500 safe identifiers. Unsupported discovery leaves manual
configuration available. Save accepts a matching staged result for five
minutes; evidence is bound to the connection, credential and selected model
by a server HMAC. Changing those values invalidates it. A stable storage key
also keeps the verification fingerprint stable across restarts; without one,
deployment-only verification is deliberately invalidated at process restart.

| Connection | Available non-billable check | Explicit limitation |
| --- | --- | --- |
| Claude API key / AI SDK Anthropic | Authenticated model catalog | Visibility is not proof of successful message execution or tool support |
| Codex API key / AI SDK OpenAI | Authenticated model catalog | Codex also needs support in its installed CLI's offline catalog |
| Custom API-key endpoint | Model catalog plus anonymous comparison | A public catalog cannot authenticate a key; refusal of anonymous access is required to report authentication evidence |
| Local no-auth compatible endpoint | Model catalog | Authentication is not required; tool/schema compatibility remains provider-specific |
| AI Gateway | Public model catalog, without sending the credential | Gateway key/account access remains unverified |
| Claude/Codex local login | Credential-source presence only | No session starts. Expiration and model entitlement remain unverified; OS-keychain logins may not expose a detectable file. |
| Claude deployment/cloud authentication | Selected source metadata | SDK owns the flow; no universal safe account/model probe is available |
| MCP | Initialize and listTools | Connectivity only; no tools are called or permissions granted |

The UI distinguishes not configured, configured but unverified, verified for
the displayed check, and a failed check with an actionable explanation.
Neither stored credential presence nor a successful catalog response is
presented as successful billable execution.

## Design and verification

The organization adapts [Primer settings navigation](https://primer.style/product/ui-patterns/navigation/)
and [forms](https://primer.style/product/ui-patterns/forms/), the connection-first
configuration in [Open WebUI](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/)
and its [settings scope](https://docs.openwebui.com/getting-started/quick-start/settings/),
and explicit credential/model/integration configuration patterns in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It uses
Agentique's existing controls, themes, service graph and runtime safeguards.

`npm run verify`, `npm run build`, and `npm run test:browser` are the delivery
checks. Settings server tests cover encryption, atomic persistence, restart,
precedence, credential lifecycle, checks, runtime consumption, conflict and
network boundaries. Chromium covers setup through a reply, navigation and
unsaved changes, preferences, export, restart, all seven section deep links,
axe accessibility rules, both themes and 390-pixel viewports. Browser artifacts
are written to `web/test-artifacts/` and excluded from Git. All automated
Settings checks use deterministic local fixtures. Existing live-provider
verification remains an explicit opt-in described in the provider document.
