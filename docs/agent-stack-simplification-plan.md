# Agentique Console — Agent Stack Simplification: Implementation Plan (rev 5)

Repo: `/home/user/agentique-console` (npm workspaces `server/`/`shared/`/`web/`,
SQLite/drizzle, `@anthropic-ai/claude-agent-sdk` **0.3.226** pinned). Migrations
0000–0015 present; this plan adds 0016–0017.

**Core rule, applied mechanically:** Agentique may RESTRICT native Claude
behavior; it never incompletely parses, silently widens, reinterprets, or
trusts native configuration in a way that changes its meaning. Three
independent states: **Claude-valid** (native-format-valid: parses as a
legitimate native definition), **Agentique-compatible** (instantiable with
every execution-affecting native field's semantics preserved),
**Agentique-trusted** (operator approved that exact source revision). Only
valid ∧ compatible ∧ trusted definitions are runnable; a valid-but-
incompatible definition is never labeled "invalid".

## 1. Target architecture and ownership boundary

**Claude owns** (native location AND meaning): agent definitions
(`.claude/agents/*.md`, plugin `agents/`), skills (`.claude/skills/`, plugin
`skills/`; `skills:"all"` + `Skill` tool), hooks (`.claude/settings*.json`,
plugin `hooks/`), CLAUDE.md/`.claude/`, workspace-root `.mcp.json`, plugin
loading, permission primitives, context lifetime (native auto-compaction),
session persistence + `resume`, structured output, worktree tools.

**Three agent concepts:** project-native Claude agents; plugin-native Claude
agents; **Agentique AgentSessions** — durable orchestration participants the
console instantiates FROM a native definition (native `Agent` tool stays
denied; the console is the execution engine).

**Four governance layers — separately computed, separately testable, never
mixed into one list:**
1. **Native-definition tool ceiling** — what the author granted
   (`tools`/`disallowedTools`, including the omitted-`tools` inherit case).
2. **Agentique product-policy ceiling** — `native-capability-policy.ts`.
3. **Console tool grants** — orchestration topology/role via
   `agent-sessions/grants.ts` (`mcp__console_agent__*`), a separate grant
   surface from native tools.
4. **Runtime containment** — worktree/filesystem isolation. **Containment is
   never authorization**: a worktree changes what a seat can touch, never
   what it is granted.

**Agentique owns** (settled; each because the native counterpart keys durable
state to provider sessions or lacks the product semantics): `send_handoff`
transport + mailroom + route law; task ledger + scheduled assignments;
deadlines; `ask_operator` + interactions/decision ledger; requirement graph +
verification tiers + delegation + completion gate; ownership disjointness;
worktree land-on-report; commission budgets; events spine; trust/revision
governance; capacity/watchdogs/crash recovery; in-process console MCP
servers; no SDK sandbox; native in-process subagents denied (litigated:
`options.test.ts` "declares no sandbox"; `grants.test.ts`
browser_/process_/http_probe regression).

**Human-interaction paths:** seats — exactly one, `ask_operator`. Main — two,
deliberate: native `AskUserQuestion`/`ExitPlanMode` intercepted by
`canUseTool` into operator cards, plus `ask_operator` for requirement-id
traceability.

## 2. Source-of-truth matrix

| Concern | Authored in (owner of meaning) | Execution owner | Persisted state |
|---|---|---|---|
| Built-in profiles | code (`registry.ts BUILTINS`) — tool lists re-authored explicitly in Stage 2 | console | seat snapshot |
| Workspace profiles | `.claude/agents/*.md` — native file, native fields, native identity | console instantiates | trust rows (source-identity revision, §Trust) + `agents.profile_snapshot` |
| Agentique governance metadata | `agentique:` frontmatter map (fallback: `.agentique/agents/<name>.overlay.json`, governance keys only) | console | inside resolved profile/snapshot |
| Skills — generic / workspace | `server/skills` plugin / `.claude/skills/` | SDK | none |
| Hooks | `.claude/settings*.json`, plugin `hooks/` | SDK | none |
| MCP — workspace root `.mcp.json`/settings | operator, native | **SDK** (native permissions; console neither reads nor approves) | none |
| MCP — agent frontmatter `mcpServers` | native file (full `AgentMcpServerSpec` surface) | **console** for command forms (trust-gated); **SDK** for name refs (console grants only) | hash-covered by trust revision |
| MCP — console tool servers | code | console | journal |
| Native tool availability | `sdk/native-capability-policy.ts` | console → `allowedTools`/`disallowedTools` | none |
| Requirements/intent, decisions, handoffs, tasks, events, budgets, trust | console tools/UI | console | SQLite (authoritative) |
| Provider transcripts | SDK (`~/.claude/projects`) | SDK | + `provider_entries` mirror (keep) |

**Trust object.** A trust row covers the semantic definition SOURCE, not just
its text: revision =
`sha256("agentique-profile-rev2\0" + canonicalRelPath + "\0" + nativeName +
"\0" + sha256(definitionBytes) + "\0" + (sha256(overlayBytes) | "-"))` with
`canonicalRelPath` workspace-relative, POSIX separators. **Moving or renaming
a trusted definition produces a new revision requiring re-trust, even with
identical content and `name`** — location can affect native precedence, so it
is part of what the operator approved. Trust does NOT cover CLAUDE.md,
`.claude/settings*.json`, `.claude/skills/`, or workspace `.mcp.json`
(inherited natively, `settingSources` parity law — deliberately not
extended). Trust never mutates files. Legacy bundle revisions (all-files
hash) remain valid during dual-read; the `rev2` prefix prevents collision.

**Definition source identity vs native name.** Native `name` is Claude's
identity. The **Agentique definition source** is the concrete file selected
for that name by mirrored native precedence (§Stage 3a). Trust binds to the
source revision; a higher-precedence same-name file is a different source and
never inherits trust.

## 3. Global rules (every stage)

- Each stage lands as one reviewable unit: typecheck + full `vitest` green.
  Snapshot discipline: Stages 1, 3–6 zero diff in
  `prompt-snapshot.e2e.test.ts.snap`; Stage 2's diff limited to
  capability-brief lines (reviewed line-by-line); Stage 7 re-baselines
  deliberately. Structural evals (`server/evals/orchestration`) before/after
  Stages 2, 5, 6, 7 — no scenario regression.
- Migrations transactional, tested on a 0015 fixture; retired env names →
  `RETIRED_ENV_NAMES` (boot-fatal).
- Every **[verify]** is an executable check (scripts under
  `server/scripts/verify-sdk/`, or a test) written BEFORE the dependent
  implementation, with a named fallback; no fallback changes the
  architecture's shape. No semantic question is left to the implementation
  agent.
- No model identifiers in committed artifacts.

---

## Stage 1 — Dead machinery removal (frozen from rev 4)

Delete `sdk/hooks.ts` (`mergeHooks`); `SdkHooksFragment`/`SdkHookMatcher` +
unused hook re-exports (`sdk/types.ts`); fake hook simulation
(`sdk/fake.ts`); never-populated `OrchestratorOptionsInput.hooks`
(`orchestrator/options.ts`); `AgentSessionRuntime.#readScope`;
`AgentProfileRegistry.untrust`/`profileRoot`; fix the stale `permissions.ts`
middleware comment; README env fixes (RAM-sized resident default;
`…_PER_TREE` → `…_PER_SESSION`). **Acceptance:**
`rg 'mergeHooks|SdkHooksFragment|profileRoot|readScope'` empty; suite green;
zero snapshot diff.

---

## Stage 2 — Native capability policy + exact tool-ceiling computation

**Outcome.** One machine-checked policy for the full native surface; the
effective native tool set is a pure intersection preserving omitted-vs-
explicit semantics across the WHOLE surface (meta tools included); console
tools stay a separate grant surface; no automatic additions anywhere.

### 2a. Policy module `server/src/sdk/native-capability-policy.ts`

Categories (rev 4): `WORKSPACE_TOOLS` (Bash, Edit, Write, NotebookEdit,
Read, Glob, Grep, WebFetch, WebSearch), `DISCOVERY_TOOLS` (Skill, ToolSearch,
ListMcpResources, ReadMcpResource, ReadMcpResourceDir, RefreshMcpTools, Mcp,
SlashCommand), `BACKGROUND_WAIT_TOOLS` (Monitor, TaskOutput, TaskStop),
`WORKTREE_TOOLS` (EnterWorktree, ExitWorktree), `DENIED_COORDINATION`
(Agent, Task, SendMessage, ListAgents, Workflow), `DENIED_TASK_STATE`
(TaskCreate/Update/Get/List, TodoWrite), `DENIED_SCHEDULING` (ScheduleWakeup,
Cron*, RemoteTrigger), `DENIED_HUMAN_SURFACE` (AskUserQuestion,
EnterPlanMode, ExitPlanMode), `DENIED_HOST_SURFACE` (Artifact,
PushNotification, SendFeedback, ClaudeDesign, Projects,
ShowOnboardingRolePicker, ProposeSkills, ReportFindings, REPL). Exports:

```ts
export const NATIVE_TOOL_SURFACE: ReadonlySet<string>;   // union of all categories
export function policyAllowedNativeTools(lane: "seat" | "main"): ReadonlySet<string>;
//   seat: SURFACE minus every DENIED_*;  main: same, plus AskUserQuestion & ExitPlanMode
//   (canUseTool-intercepted) allowed, minus Monitor/TaskStop (existing main-only denial)
export function nativeToolCeiling(p: { tools?: string[]; disallowedTools: string[] }): ReadonlySet<string> | "inherit";
//   tools omitted → "inherit" (native inheritance preserved); else set(tools) \ disallowedTools
export function effectiveNativeTools(p, lane): ReadonlySet<string>;
//   ceiling === "inherit" ? policyAllowed(lane) \ p.disallowedTools
//                         : ceiling ∩ policyAllowed(lane)
```

**No automatic additions.** `Skill`, `ToolSearch`, `Monitor`/`TaskOutput`/
`TaskStop`, `EnterWorktree`/`ExitWorktree` are inside `tools` semantics
**[verify with fixtures: the pinned SDK's own `AgentDefinition.tools` doc
says omitted = "inherits all tools" and flags `'Skill'` in `tools` as the
(deprecated) way to grant Skill — confirm with scripts/verify-sdk/tools-
semantics.ts running probe subagents via `query({agents})` for: omitted
tools; `tools:[Read]`; `disallowedTools:[Grep]`; comma-string form]**. An
explicit `tools:` list that omits them means the seat does not get them; the
console adapts (conditional prompt lines, below) rather than widening. Any
tool the verification proves to be OUTSIDE `tools` semantics gets its own
documented exemption constant — nothing is exempted without proof.

**Seat option assembly** (`runtime.ts`, replacing today's `:260-287` block —
sources stay separately visible in code):

```ts
const native  = effectiveNativeTools(profile, "seat");
const console_ = runtimeToolNames(grantedTools(role, profile, deps));  // grants.ts — unchanged surface
const mcp     = mcpGrants(profile);                                    // Stage 4: mcp__<name> prefixes
allowedTools    = [...native, ...mcp, ...console_];
disallowedTools = [...NATIVE_TOOL_SURFACE].filter(t => !native.has(t));
//  one formula: covers DENIED_* + author's disallowedTools + everything an
//  explicit tools: list did not grant — uniformly, worktree or not.
```

Main: same shape via `policyAllowedNativeTools("main")`; delete
`MAIN_WORK_TOOLS` (byte-identical to `WORKSPACE_TOOLS`; keep its
operator-directive comment at the import) and `MAIN_DENIED_TOOLS`; move
`CONSOLE_TOOL_NAMES` → `MAIN_TOOL_NAMES` in new `orchestrator/grants.ts`
with a registration-equality test.

**Internal type change (this stage, so helpers are exact):**
`ProfileSchema.tools` becomes `z.array(z.string()).optional()` — `undefined`
means "author omitted; native inheritance"; add
`disallowedTools: z.array(z.string()).default([])`. Legacy loaders (JSON
manifest, BUILTINS) keep supplying explicit arrays — behavior unchanged for
them. `profileWritesFiles`: `undefined` tools counts as writing (existing
conservative rule, now exact: omitted = full surface ⊇ Edit/Write). Minting:
a mint materializes `tools = [...effectiveNativeTools(base,"seat")].sort()`
at mint time — an **Agentique-derived execution set**, documented as such
(mint rows are console artifacts, not native files); narrowing checks subset
against that set.

**Built-in regrants** (mechanical, behavior-preserving): each `BUILTINS`
entry's `tools` := current list + `Skill` + `ToolSearch` + (`Monitor`,
`TaskOutput`, `TaskStop` where Bash) + (`EnterWorktree`, `ExitWorktree`
where Edit/Write) — the formerly auto-added names become author-declared
grants in the one place Agentique IS the author. Separately, audit each
archetype for tools the deleted worktree-widening actually provided (e.g.
`explorer` needing Bash) and grant them explicitly in a reviewed commit.

**Prompt adaptation** (Stage 2's permitted snapshot diff): `capabilityBrief`
renders from `effectiveNativeTools` — one form, no isolated/non-isolated
split; the skill-invocation line renders only when `Skill` ∈ effective; the
background-Bash line only when Bash ∧ Monitor present.

**Catalog honesty:** `requiresTools` validated against
`NATIVE_TOOL_SURFACE ∪ mcp__*` at load; `validateAssignment(skillNames,
effectiveNativeTools(profile,"seat"))` — the stricter-than-reality mismatch
is gone.

**Upgrade tripwire** (rev 4, kept): enumerate the installed surface (prefer a
shipped manifest **[verify `manifest.json` contents]**, else parse
`ToolInputSchemas` type names from `sdk-tools.d.ts` — names only,
version-coupled, explicit failure message "SDK tool surface changed —
classify: <names>"); assert every name classified exactly once.
**[verify once]** `disallowedTools` strips tools under `bypassPermissions`
(fallback: seats route through `permissionMode:"default"` + `canUseTool`
denial). **Env policy:** audit SDK dist for `process.env.CLAUDE*` reads →
`STRIPPED_FEATURE_FLAGS` in `sdk/env.ts` **[verify by grep]**; `env.test.ts`
asserts.

**Semantic-contract tests** (not snapshots — new
`agent-sessions/tool-semantics.e2e.test.ts` + policy unit tests):
- `tools:[Read,Grep]` → seat options: allowed exactly {Read,Grep}+grants,
  everything else in SURFACE denied by name — including Skill, ToolSearch,
  Monitor, EnterWorktree; worktree or not.
- omitted `tools` → allowed = policyAllowed("seat") minus declared
  disallowed; NOT an empty or predefined list.
- `disallowedTools:[WebFetch]` with omitted tools → WebFetch denied although
  policy would allow it.
- worktree seat vs non-worktree seat, same profile → identical
  allowed/disallowed sets (containment ≠ authorization).
- `bypassPermissions` profile → denied names still absent from the seat's
  surface (paired with the [verify] SDK-level check).
- policy tripwire fails on a fixture surface with one added tool.

**Acceptance.** Every runtime decision about native availability derives from
the policy module (tests/fixtures/prompts/docs may name tools directly); the
four layers are separate helpers with separate tests; semantic-contract
tests green; evals no regression; capability-brief diff reviewed, all other
prompt bytes identical.

---

## Stage 3 — Native agent definitions: real parser, identity, compatibility, trust

**Outcome.** Workspace profiles are project-native Claude agents parsed by a
real YAML parser, identified and selected the native way, evaluated through
the valid/compatible/trusted pipeline, trusted by source identity, and
mutated deterministically. `.agentique/agents/` bundles and
`agentique.profile.json` become a legacy dual-read.

### 3a. Parser of record (`server/src/agent-profiles/native-agent-file.ts`)

The pinned SDK exposes no agent-definition parsing API (verified — no such
export in `sdk.d.ts`), so: add dependency **`yaml@^2`** to
`server/package.json` (mature YAML parser; no home-grown YAML subset).

```ts
export type NativeAgentParse =
  | { formatValid: false; error: string }                       // YAML error / no frontmatter / non-map
  | { formatValid: true; fields: Record<string, unknown>; body: string };
export function parseNativeAgentFile(text: string): NativeAgentParse;
```

- Frontmatter/body split: leading `---\n … \n---\n` at byte 0 (tolerate
  CRLF) — a boundary split only, never YAML parsing.
- `YAML.parse` errors, absent frontmatter, or a non-map document →
  `formatValid:false` → **Claude-valid = false** (terminology:
  "native-format-valid" — the console validates format, not full native
  semantics; where an executable SDK check can strengthen this, it is named
  below).
- ALL top-level keys are preserved in `fields` — nested arrays/maps (MCP
  specs included) arrive as parsed YAML values; nothing is dropped before
  compatibility evaluation.
- The `agentique` key is extracted from the same parsed map; it never
  interferes with native keys.
- `capability-catalog.ts`'s hand-rolled `parseFrontmatter` is **deleted**;
  the catalog uses this module for SKILL.md metadata too (one parser).
- Field-shape tolerance mirrors native authoring **[verify with fixtures:
  the native CLI accepts `tools: Read, Grep` as a comma-separated string as
  well as a YAML list — support exactly the verified forms in the shape
  schema]**.

**Pipeline (Claude-valid independent of Agentique's schema):**

```text
read file → parseNativeAgentFile → formatValid?          (Claude-valid)
→ evaluateNativeAgent(fields, body)                       (Agentique-compatible)
→ resolve agentique overlay → map to resolved AgentProfile (execution snapshot)
→ compute source revision                                  (trust identity)
```

`ProfileSchema` (zod) validates only the final execution snapshot; it is
never the authority on whether the Claude file is valid.

### 3b. Compatibility evaluator (`evaluateNativeAgent`)

```ts
type FieldReason = { field: string; reason: string };
type Evaluation =
  | { compatible: true;  resolved: ResolvedNativeConfig; ignored: string[] }
  | { compatible: false; reasons: FieldReason[] };
```

Per-field rules (each checked against the preserved parsed keys):

| Field | Verdict |
|---|---|
| `name`, `description`, body | applied (identity §3c; purpose; system prompt — console appends commission context at delivery, a runtime addition) |
| `tools` (list or verified comma-string), `disallowedTools` | applied — Stage 2 semantics; omission preserved as `undefined` end-to-end |
| `model`, `effort` | applied (`CONSOLE_EFFORT` remains a documented install-wide operator override) |
| `permissionMode` | applied — ALL native values pass through **[verify each value's headless seat behavior with a fixture]**; `bypassPermissions` keeps the `allowDangerouslySkipPermissions` pairing |
| `mcpServers` | applied per Stage 4 (full surface, lossless) |
| `background` | ignored — provably non-semantic (configures native `Agent`-tool invocation, which never occurs); listed in `ignored[]` |
| `skills`, `maxTurns`, `hooks`, `memory`, `observer`, `observerMessage`, `initialPrompt`, `criticalSystemReminder_EXPERIMENTAL` | incompatible-if-present, each with a reason naming the Agentique alternative where one exists (`agentique.recommendedSkills`, `agentique.assignmentTurnBudget`) |
| unknown non-`agentique` key | incompatible — "unrecognized native field — semantic preservation cannot be guaranteed" (conservative; lifted per-field only by executable proof of no effect) |
| `agentique` | overlay: `role`, `handoffExtension`, `exemptFromOwnership`, `assignmentTurnBudget` (1..100, default 40), `recommendedSkills` — Agentique-owned names for Agentique concepts |

**[verify first]** the pinned CLI tolerates the `agentique:` key in
`.claude/agents/*.md` (fixture workspace, `settingSources:["project"]`,
session boots, `supportedAgents()` lists the agent). Fallback: sidecar
`.agentique/agents/<name>.overlay.json` (governance keys only).

### 3c. Discovery, identity, precedence

**[verify natively, one fixture workspace + `supportedAgents()`]:** (i)
identity from frontmatter `name` vs filename, mismatch legality; (ii) nested
discovery under `.claude/agents/`; (iii) duplicate-name precedence. The
loader mirrors each verified behavior exactly and imposes no stricter
authoring rules — the `/^[a-z][a-z0-9-]*$/` id regex is dropped for
workspace profiles (Agentique derives git/path slugs via existing
`branchSafe()`).

Registry exposes one **effective definition source** per native name after
mirrored precedence; shadowed files are listed with reason "shadowed by
<path>" (compatible=false for the shadowed source); undefined native
precedence → all claimants incompatible ("ambiguous identity"). Profile key
= native `name`; trust binds to the **source revision** (path-inclusive, §2
Trust) — precedence changes therefore never transfer trust.

### 3d. Types, API, UI

`shared/src/domain.ts`: `AgentProfileSummary` gains `claudeValid: boolean`,
`agentiqueCompatible: boolean`, `incompatibilityReasons: string[]`;
`ProfileValidationIssue.kind` gains `"incompatibility"`. Trust API rejects
incompatible revisions (`ConflictError` naming reasons). Web
`agents-view.tsx`: three badges (valid / compatible / trusted) + reasons;
markdown body rendered as the prompt section; display name from
`name`/`description` (the `title` concept is removed).

### 3e. Loader/data flow, snapshot, mutation

`#workspaceProfiles()`: discover `.claude/agents/` (per §3c) AND legacy
`.agentique/agents/<id>/` bundles (dual-read, one transition release,
deprecation issue). Resolved mapping into `AgentProfile`: `purpose` ←
description; `instructions` ← body; `tools`/`disallowedTools` preserved
(incl. `undefined`); `maxTurns` ← `agentique.assignmentTurnBudget`;
`skills` ← `agentique.recommendedSkills`; `mcpServers` ← Stage 4 lossless
forms. Snapshots/minting/composer/grants read the resolved shape unchanged
(snapshot back-compat: old snapshots carry explicit tool arrays and the
legacy `mcpServers` record — the snapshot read path transforms the record
into stdio declarations; existing `?? {}` contract documented at
`ProfileSchema`). New-format profiles need no bundle copy and no
`pluginPath` (`snapshotProfile()` no-ops; legacy keeps its copy path). Seat
`plugins:` = `[console skills plugin]` only (legacy bundles keep theirs
during transition).

**Mutation (deterministic):** discovery recomputes revisions each listing;
running AgentSessions keep their frozen `profile_snapshot`; instantiation of
an edited OR moved definition is refused until its new revision is trusted;
native Claude uses the file normally regardless; trust never writes files.
Move/rename → new revision (path in hash). Same-name shadowing → §3c.

**Tests (paired fixtures — semantic-drift guard).** Parser:
multiline/nested YAML (mcpServers maps, arrays), comma-string `tools`,
malformed YAML → `formatValid:false`, unknown top-level keys preserved and
reported, `agentique` overlay non-interference, CRLF. Registry/e2e
(`workspace-profile.e2e.test.ts` + `registry.test.ts`): one fixture per
disposition row (narrow tools; omitted tools; disallowedTools; each
permissionMode; native `skills`/`maxTurns` → valid+incompatible with the
naming reason; unknown field → incompatible; duplicate names → mirrored
precedence + **trust-non-transfer test**: trust A(`reviewer`), add
higher-precedence B(`reviewer`) → B selected and untrusted, A's running
seats frozen on their snapshot; nested file; mutation-after-trust → new
revision untrusted, running seat unaffected; move-after-trust → re-trust
required). Plus the **native-denial e2e**: project agents visible as
workspace config; `Agent` tool cannot invoke them from any lane; the console
instantiates a trusted one via `create_agent_session`.

**Acceptance.** `claudeValid` is decided by real YAML parsing + native-shape
checks, never by Agentique's execution schema; a valid native agent with
unsupported features shows valid + incompatible + untrusted; omitted vs
explicit `tools` survives discovery→validation→hash→snapshot→mint→options;
zero snapshot diff; all fixtures green; legacy bundles still run with
deprecation.

---

## Stage 4 — MCP: lossless native surface, one launcher per declaration

Parsing rides Stage 3's parsed YAML — **no second MCP parser**. Internal
lossless representation (replaces the `{command,args,env}` record in
`ProfileSchema`; snapshot read path transforms legacy records to `stdio`):

```ts
export type ProfileMcpDeclaration =
  | { form: "ref";   name: string }
  | { form: "stdio"; name: string; command: string; args?: string[]; env?: Record<string,string> }
  | { form: "sse";   name: string; url: string; headers?: Record<string,string> }
  | { form: "http";  name: string; url: string; headers?: Record<string,string> };
```

| Native form (`AgentMcpServerSpec`) | Verdict | Execution |
|---|---|---|
| stdio / SSE / HTTP specs | applied | console-executed: `declaredMcpServers()` passes the config through to `Options.mcpServers` verbatim (same config family) + per-server `timeout` stamp |
| `string` name ref | applied | native meaning "attach an already-configured server": console launches nothing, resolves against the workspace's native MCP config **[verify resolution scope with a fixture]**, grants `mcp__<name>`; unresolvable → incompatible ("references an MCP server not configured in this workspace") |
| SDK/in-process form or unrecognized shape | incompatible | reason names the form; malformed YAML never reaches here (fails native-format validity in Stage 3) |

`mcpGrants(profile)` returns the `mcp__<name>` prefixes for BOTH executed
and ref forms — the grant surface Stage 2's assembly consumes. Owner matrix
(rev 4, unchanged): workspace root `.mcp.json`/settings → SDK-owned, native
semantics untouched; frontmatter command forms → console-executed (format
native, execution deliberately Agentique: trust-gated launch, timeout,
`CONSOLE_MCP_DISABLED` removal, `CONSOLE_BROWSER_MCP` substitution —
operator-set, never silent — wholesale auto-approval); frontmatter refs →
SDK-launched, console-granted; console in-process + `ATTACHABLE_MCP_SERVERS`
mint names → console. No double-launch by construction (native runtime only
launches agent-frontmatter servers via the denied `Agent` tool —
**[verify: spawned lane's `mcpServerStatus()` must not list them]**).
`BROWSER_MCP` builtin becomes a `stdio` declaration.

**Tests.** Parsing fixtures per form + env maps + nested YAML + malformed
(fails at format layer) + unsupported (fails at compatibility layer);
`seat-options.e2e.test.ts`: stdio pass-through with timeout; ref grants
without launch; `mcp-timeout.e2e.test.ts` unchanged.
**Acceptance.** Exactly one launcher per server name; every supported form
round-trips losslessly file→resolved→`Options.mcpServers`;
`migrate-profile.ts` preserves each declaration's form.

---

## Stage 5 — Context-rotation removal (frozen from rev 4)

Precondition [verify]: native compaction covers in-session context
management on 0.3.226 with no console involvement; the four concerns
(compaction / resume / Agentique crash recovery / durable orchestration
state) are distinct and deletion touches only the first. Remove seat + main
rotation paths, `"rotating"` lane state, `lane-runtime/rotation.ts`,
`checkpointQuery`, `rotationTokenLimit` (+tests); tombstone the four env
knobs; stop emitting rotation/checkpoint-failure events (unions
`@deprecated historical`); drop the web ceiling display. Keep
`reconstructCheckpoint`, `#checkpointContext`, `recoveryAction`,
`lane-runtime/usage.ts`, historical `trigger` enums. **Migration 0016:**
drop `agents.pending_checkpoint_handoff_id`. **Acceptance:** boot tombstones
fire; crash-recovery e2e green; evals no regression; snapshot untouched.

---

## Stage 6 — Legacy specification-spine retirement (frozen from rev 4)

Add `RequirementService.recordIntentFallback`; reroute the ExitPlanMode
non-outline path (`permissions.ts`); remove `SpecStore`/`SpecService`/legacy
fallbacks (`orchestrator/spec.ts`, `completion/service.ts`,
`requirements.ts` `#legacy`, `orchestrator/tools.ts` branches);
`api/routes/user-sessions.ts` serves `requirement_revisions`.
**Migration 0017:** convert open pre-graph sessions to intent revisions;
archive spec docs to `event_artifacts`; drop `spec_revisions`.
**Acceptance:** `rg 'SpecStore|SpecService|specRevisions'` empty outside
migrations; non-outline plan approval records an intent revision; suite +
evals green.

---

## Stage 7 — Prompt simplification (frozen from rev 4, two local edits)

7a dedup + structure-mirror removal with the keep-rule; 7b progressive
disclosure per-move contract (pattern knowledge → `orchestration-patterns`;
requirements mechanics → `requirements-mechanics`; wrap-up →
`wrap-up-and-landing`; invariants stay in the standing surface; no mandatory
invocation rituals); budgets re-pinned (brief ≤7,000B;
`tools-bytes.test.ts` ≤12,000B); `rubric-leak.test.ts` extended. Local
edits: prompt text about grants speaks in intersection terms sourced from
`effectiveNativeTools`; the "Recommended skills" line sources from
`agentique.recommendedSkills` and renders only when `Skill` is granted.
**Acceptance:** budgets at new pins; evals ≥ baseline both sub-stages; each
doctrine string greps to one authoritative site (+ its skill); three skills
in `list_agent_profiles` catalog output.

---

## Stage 8 — Documentation and final audit (frozen from rev 4)

README + `docs/*`: env knobs regenerated from `config.ts`; the three-state
model; the four governance layers + intersection formula (incl. omitted-
tools semantics); native profile format + overlay + migration script; MCP
owner matrix (format-vs-execution language); rotation removal; the
three-agent-concepts distinction. Full gate: typecheck, vitest, evals, boot
smoke on a 0015 DB copy; audit the deletion inventory per stage.

---

## Migration tool (`scripts/migrate-profile.ts`) — narrow by design

Rules frozen from rev 4: manifest fields → automatic (frontmatter +
`agentique:` overlay + body; legacy `skills`/`maxTurns` WERE the Agentique
concepts → `recommendedSkills`/`assignmentTurnBudget`); bundle MCP →
automatic frontmatter declarations preserving form; bundle `skills/` /
`commands/` → operator choice (workspace-global widening, never silent);
bundle `hooks/` → never automatic; non-profile `agents/` → report;
unrecognized → stop and report. **New:** the report states explicitly that
the migrated definition is a NEW source (path changed) and therefore
requires re-trust; it never preserves trust across a source move.

## Deletion inventory

| Disappears | Stage |
|---|---|
| `sdk/hooks.ts` + hook-fragment types + fake simulation; `#readScope`; `untrust()`/`profileRoot()`; stale comments | 1 |
| Five hand-maintained tool rosters → policy module; worktree tool-widening (`effectiveBuiltinTools` isolated branch); ALL automatic tool additions (Skill/ToolSearch/background/worktree) — replaced by author-declared grants + the single intersection formula; mixed "effective tools" computation → four separate helpers; `CONSOLE_TOOL_NAMES` drift risk; seat access to scheduling/task-state/plan-mode/human-surface/host-surface natives | 2 |
| Hand-rolled frontmatter parser (`capability-catalog.ts:parseFrontmatter`) → `yaml` + `native-agent-file.ts`; `.agentique/agents/` authoring; `agentique.profile.json`; bundle all-files hashing/`snapshotProfile()` copies/`pluginPath`/plugin passing (new profiles); workspace id regex; conflated `valid` flag; content-only trust hashing; `(workspaceId,name)`-only identity; `ProfileSchema.title`/`entryAgent`; native-name overloads (`skills`, `maxTurns`) | 3 |
| stdio-only MCP narrowing → lossless forms; ambiguous MCP ownership; misleading "supported" label on plugin/bundle `agents/` | 3–4 |
| Rotation subsystem (~550–650 LOC, lane state, ceilings, column, 4 env knobs, 2 test files, web display) | 5 |
| `spec_revisions` + `SpecStore` + `SpecService` + legacy fallbacks | 6 |
| Duplicated doctrine (B1–B16), structure-mirroring prose (keep-rule), ~10KB tool-description + ~2KB brief bytes → 3 skills | 7 |

## Deferred cleanup (explicitly NOT this migration)

Legacy dual-read removal (bundle discovery, all-files hashing, copy path)
after one transition release, then `profile-snapshots/` retention by
reference semantics, never age. `crons`→`deadlines` vocabulary; `tasks`
column renames; `user_sessions.purpose` drop. `sdk/fake.ts` slimming beyond
Stage 1. Optional later: author `BUILTINS` as plugin-native `agents/` files.

## Remaining operator decisions

None. Every remaining unknown is a named **[verify]** with an executable
check and a fallback that does not change the architecture's shape.

## Final acceptance standard (all must hold)

1. Native YAML parses via `yaml@^2` — no home-grown YAML subset decides
   validity. 2. Omitted vs explicit `tools` is preserved end-to-end.
3. No native tool is ever added because of a worktree or console
   convenience. 4. Console tools remain a separate orchestration grant
   surface (`grants.ts`). 5. Native `disallowedTools` are authoritative
   restrictions. 6. Trust binds to the semantic source (path + name +
   bytes). 7. A higher-precedence same-name definition never inherits
   trust. 8. Supported native MCP forms round-trip losslessly.
9. Running AgentSessions stay frozen to their resolved snapshot across
   edits/moves. 10. No unresolved semantic decision remains — every
   [verify] has a script/test and a shape-preserving fallback.

## Evidence appendix (orientation — verify at head)

Seat options `agent-sessions/runtime.ts:252-320`; main
`orchestrator/options.ts`+`permissions.ts`; prompts
`agent-sessions/composer.ts` (bytes pinned; optional blocks render `""`;
identity in env vars — preserve both); console grants
`agent-sessions/grants.ts`; profiles/trust/mint
`agent-profiles/registry.ts`; builders `agent-sessions/patterns/catalog.ts`.
SDK 0.3.226 (installed typings): `AgentDefinition.tools` — "If omitted,
inherits all tools from parent"; `'Skill'` in `tools` deprecated in favor of
the `skills` field (evidence that meta tools sit INSIDE `tools` semantics);
`AgentMcpServerSpec = string | Record<name, McpStdio|McpSSE|McpHttp|
McpSdk>`; `Options.mcpServers` accepts the same config family; no exported
agent-definition parser; `plugins:[{type:'local',path}]`; `settingSources`
omitted = all; `skills:'all'|string[]` is an enablement filter (not
preload); `outputFormat json_schema`; native tool surface = 39 input
schemas in `sdk-tools.d.ts` incl. `Workflow`, `REPL`, `TodoWrite`,
`Artifact`, `PushNotification`, `RemoteTrigger`,
`ShowOnboardingRolePicker`. `MAIN_WORK_TOOLS` byte-identical to
`WORKSPACE_TOOLS`. Crash recovery ≠ rotation: `service.ts`
`#escalateFailure` → `reconstructCheckpoint`; `lane-runtime/usage.ts`
watermark runs every turn.
