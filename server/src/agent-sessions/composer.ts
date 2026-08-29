/**
 * Prompt composition for agent sessions: every string the Console says to an
 * agent — system-prompt tails, delivery prompts, roster lines, reconstructed
 * checkpoints. Prompt bytes are pinned by prompt-snapshot.e2e; keep every
 * literal byte-identical.
 */
import type { ChangeImpactWire, HandoffDraft, Interaction, InteractionQuestion } from "@agentique-console/shared";
import { profileWritesFiles, type AgentProfile } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import type {
  Repo,
  AgentRow,
  AgentSessionRow,
  MessageRow,
} from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { recoveryAction, rotationAction } from "../lane-runtime/checkpoint.ts";
import { decisionOf, decisionPin, renderDecision, type DecisionLedger } from "../orchestrator/decisions.ts";
import type { AssumptionService } from "../orchestrator/assumptions.ts";
import type { RequirementService } from "../orchestrator/requirements.ts";
import type { ProjectObjectiveService } from "../orchestrator/objective.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import { effectiveNativeTools, type GovernedTool } from "../sdk/native-capability-policy.ts";
import type { SdkUserMessageLike } from "../sdk/types.ts";
import { taskLedgerLine, type TaskService } from "../tasks/service.ts";
import {
  selectDecisionDelta,
  selectDelegatedView,
  selectRosterSeats,
  selectSessionImpacts,
  selectTaskView,
  type DelegatedViewNode,
  type TaskView,
} from "./delivery-view.ts";
import type { RolePrompt } from "./topology-contract.ts";

/**
 * The MCP servers the CONSOLE launches for a seat: the profile's executed
 * declarations (stdio/sse/http), minus what the operator disabled, with the
 * browser server swappable by name. A `ref` declaration is deliberately
 * absent here — its native meaning is "attach an already-configured server",
 * so the workspace's own native MCP config (root `.mcp.json`, SDK-owned)
 * launches it and the console only grants it (`mcpGrantNames`). One launcher
 * per declaration, by construction.
 *
 * Config-declared and console-launched — the Console vendors no capability of
 * its own. `CONSOLE_MCP_DISABLED=browser` turns a server off for a whole
 * install; `CONSOLE_BROWSER_MCP='<command> <args…>'` replaces the browser one
 * without touching a profile. Both are operator-set env, never silent.
 */
export function declaredMcpServers(profile: AgentProfile, config: Config): Record<string, Record<string, unknown>> {
  const disabled = new Set(config.infra.mcpDisabled ?? []);
  const out: Record<string, Record<string, unknown>> = {};
  // Per-call wall clock on every EXECUTED server. Without it a wedged
  // browser_evaluate holds a turn open forever — no watchdog counts an
  // in-flight call, and a live run died exactly this way. The console's own
  // in-process server carries no timeout: ask_operator parks legally.
  const timeout = config.policy.mcpToolTimeoutMs > 0 ? { timeout: config.policy.mcpToolTimeoutMs } : {};
  // A profile SNAPSHOT taken before this field existed has no `mcpServers`,
  // and one from before the transport union has bare `{command,args}` values.
  // Snapshots are cast, never re-parsed, so BOTH degrade gracefully here: a
  // command-shaped value launches as stdio whatever its `transport` says.
  for (const [name, spec] of Object.entries(profile.mcpServers ?? {})) {
    if (disabled.has(name)) continue;
    const declaration = spec as { transport?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
    if (declaration.transport === "ref") continue;
    const override = name === "browser" ? config.infra.browserMcp : undefined;
    if (override !== undefined) {
      const [command, ...args] = override;
      if (command === undefined) continue;
      out[name] = { command, args, ...timeout };
      continue;
    }
    if (typeof declaration.command === "string") {
      out[name] = { command: declaration.command, args: declaration.args ?? [], ...(declaration.env === undefined ? {} : { env: declaration.env }), ...timeout };
    } else if (typeof declaration.url === "string" && (declaration.transport === "sse" || declaration.transport === "http")) {
      out[name] = { type: declaration.transport, url: declaration.url, ...(declaration.headers === undefined ? {} : { headers: declaration.headers }), ...timeout };
    }
  }
  return out;
}

/**
 * Every declared server name the seat is GRANTED (`mcp__<name>` prefix) —
 * executed and ref forms alike, minus operator-disabled. The grant surface
 * is broader than the launch surface exactly by the ref declarations.
 */
export function mcpGrantNames(profile: AgentProfile, config: Config): string[] {
  const disabled = new Set(config.infra.mcpDisabled ?? []);
  return Object.keys(profile.mcpServers ?? {}).filter((name) => !disabled.has(name));
}

/**
 * The workspace tools the brief describes — re-exported from the capability
 * policy so the roster and the brief read the same set the runtime enforces.
 * A profile's declared `tools` are its ceiling for EVERY seat; the worktree
 * is containment, never a grant (`sdk/native-capability-policy.ts`).
 *
 * The brief lives next to this set: the two must not drift. A live run lost
 * two of four researchers to exactly that drift — they held WebSearch and
 * WebFetch while the brief told them "read files only", and they dutifully
 * reported the limit instead of using the tools.
 */
export { WORKSPACE_TOOLS as GOVERNED_BUILTIN_TOOLS } from "../sdk/native-capability-policy.ts";

/**
 * How each governed tool is described to the agent holding (or lacking) it.
 * Grouped so the prose reads as sentences rather than as a tool manifest: a
 * group speaks when the seat has ANY of its tools, so an implementer with
 * Edit and Write is not told it cannot edit because it lacks NotebookEdit.
 * `deferred` names the group's tools that are absent from the turn-1 tool
 * list and load only through ToolSearch — one combined sentence covers them.
 */
const CAPABILITY_GROUPS = [
  {
    tools: ["Read", "Glob", "Grep"],
    can: "read files with Read, Glob, and Grep",
    cannot: "read any file",
  },
  {
    tools: ["Edit", "Write", "NotebookEdit"],
    can: "create and edit files",
    cannot: "create or edit any file",
  },
  {
    tools: ["Bash"],
    can: "run shell commands with Bash — background anything expected to exceed ~2 minutes with run_in_background and wait on Monitor or TaskOutput rather than blocking the turn or polling",
    cannot: "run any shell command",
    // Bash-holders also get Monitor/TaskOutput/TaskStop, but those are
    // DEFERRED like the web pair. Without naming them agents hunt for a wait
    // primitive (8 of 19 ToolSearch calls in a live run) or invent polling
    // loops that burn whole model turns on `true`.
    deferred: ["Monitor", "TaskOutput", "TaskStop"],
  },
  {
    tools: ["WebSearch", "WebFetch"],
    can: "search the web with WebSearch and read pages with WebFetch",
    cannot: "reach the web",
    // The web tools are DEFERRED: absent from the turn-1 tool list, loaded on
    // request. Without naming them a seat that reads its tool list concludes
    // it has no web access and says so — which is exactly how a live run
    // produced a sourceless research section.
    deferred: ["WebSearch", "WebFetch"],
  },
] as const satisfies readonly { tools: readonly GovernedTool[]; can: string; cannot: string; deferred?: readonly string[] }[];

/**
 * Every governed tool must be described. Adding one to
 * `GOVERNED_BUILTIN_TOOLS` without giving it a group fails THIS line rather
 * than silently telling every agent it lacks the tool — the failure mode that
 * hid web access from seats that held it.
 */
type Undescribed = Exclude<GovernedTool, (typeof CAPABILITY_GROUPS)[number]["tools"][number]>;
type AssertNone<T extends never> = T;
export type _AllGovernedToolsDescribed = AssertNone<Undescribed>;

/**
 * What the seat holds, said once and positively. The set described is the
 * SAME intersection the runtime enforces (`effectiveNativeTools`): the
 * author's ceiling under console policy, identical with or without a
 * worktree. The "cannot" line renders whenever a whole group is absent.
 */
function capabilityBrief(profile: AgentProfile, hasWorktree: boolean): string {
  const can: string[] = [];
  const cannot: string[] = [];
  const deferred: string[] = [];
  const tools = effectiveNativeTools(profile, "seat");
  // The merge rule stays profile-based (worktree-binding.ts): only a write
  // profile's worktree lands, so an isolated read-only seat must be told.
  const writes = profileWritesFiles(profile.tools);
  for (const group of CAPABILITY_GROUPS) {
    if (group.tools.some((tool) => tools.has(tool))) {
      can.push(group.can);
      // Only the deferred names the seat actually holds — naming an
      // ungranted tool would send it hunting for a denied capability.
      if ("deferred" in group) deferred.push(...group.deferred.filter((tool) => tools.has(tool)));
    } else cannot.push(group.cannot);
  }
  // `?? {}`: a snapshot from before this field existed is cast, not parsed.
  const servers = Object.keys(profile.mcpServers ?? {});
  if (servers.length > 0) can.push(`use your MCP server(s) — ${servers.join(", ")}, tools named mcp__<server>__<tool>`);
  // The deferred-tools lesson, applied to skills: a capability nobody names
  // goes unused. Byte-stable when the list is empty; silent for a profile
  // that grants no Skill/ToolSearch — an instruction to call a denied tool
  // would be worse than saying nothing.
  const skills = profile.skills ?? [];
  const lines = [
    `You can: ${can.join("; ")}.`,
    ...(cannot.length > 0 ? [`You cannot: ${cannot.join("; ")}. If an assignment needs one of those, say so in a handoff rather than working around it — the limit is real for this run.`] : []),
    ...(deferred.length > 0 && tools.has("ToolSearch") ? [`${deferred.join(", ")} may be missing from your tool list at the start of a turn — deferred, not absent: load them once with ToolSearch {"query": "select:${deferred.join(",")}"} and use them normally.`] : []),
    ...(skills.length > 0 && tools.has("Skill") ? [`Recommended skills: ${skills.join(", ")}. Invoke one with the Skill tool before starting work it covers.`] : []),
    ...(hasWorktree ? [writes
      ? "Your cwd is an isolated worktree; teammates cannot see your files until the Console merges them when you report completed. Landing compares your actual changed paths with declared ownership: an edit inside ANOTHER seat's declared scope blocks the merge unless the scope is declared shared — coordinate through your coordinator before writing outside your own scope."
      : "Your cwd is an isolated worktree — a stable snapshot for your review. It is discarded, not merged, when you report: describe defects and fixes in your report rather than applying them."] : []),
  ];
  return `## Your capabilities\n${lines.join("\n")}`;
}

/** Compact capability tag for roster lines — what this agent can be asked to do. */
function capabilityTag(profile: AgentProfile): string {
  const tools = effectiveNativeTools(profile, "seat");
  const caps = [
    ...(profileWritesFiles(profile.tools) ? ["writes files"] : ["read-only"]),
    ...(tools.has("Bash") ? ["runs commands"] : []),
    // Without this a coordinator reads "read-only" off a researcher's roster
    // line and assigns — or reports — as though the seat had no web access.
    ...(tools.has("WebSearch") || tools.has("WebFetch") ? ["reads the web"] : []),
    ...Object.keys(profile.mcpServers ?? {}),
  ];
  return `can: ${caps.join(", ")}`;
}

/** Console-synthesized lane input: neither human nor peer, so no origin. */
export function seatUserMessage(text: string): SdkUserMessageLike {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, shouldQuery: true };
}

/**
 * The agent's messaging documentation. The mechanics (fields, scheduling,
 * long bodies) live in the tool descriptions; this says who is here and how
 * to reach them.
 */
function seatMessagingBrief(roster: string, addressing: string): string {
  return `## Working with the team\nParticipants: ${roster}.\n${addressing}\n` +
    `Everything you transfer — an assignment, progress, findings, a failure, a result — goes through send_handoff; your plain text output reaches no one. The Human Operator is reachable directly with ask_operator.`;
}

/** The question text of an interaction, for prompts and operator-facing lines. */
export function questionTextOf(interaction: Interaction): string {
  const questions = (interaction.payload as { questions?: InteractionQuestion[] }).questions ?? [];
  return questions.map((question) => question.question).join(" | ");
}

/** The one canonical decision rendering — see `orchestrator/decisions.ts`. */
export function summarizeAnswer(interaction: Interaction): string {
  const decision = decisionOf(interaction);
  return decision === null ? "" : renderDecision(decision);
}

export interface PromptComposerDeps {
  repo: Repo;
  bus: EventBus;
  config: Config;
  handoffs: HandoffService;
  decisions: DecisionLedger;
  /** The governing requirements — injected into every seat like decisions are. */
  requirements: RequirementService;
  /** Bounded project-level orientation; delegated scope remains authoritative. */
  objective?: ProjectObjectiveService;
  /** Recorded premises — the delegated block surfaces the ones under a seat's subtrees. */
  assumptions: AssumptionService;
  tasks: TaskService;
  interactions: InteractionService;
  worktrees: WorktreeManager | null;
  /** Live lane facts for the roster work-state line — a host capability, injected. */
  laneState: (agentSessionId: string, agent: string) => { activeTurn: boolean; live: boolean } | null;
  /**
   * `WorkstreamService.promptLines` — this session's declared cross-workstream
   * links with their derived status. Optional: harnesses without the
   * portfolio render no block.
   */
  workstreamLines?: (agentSessionId: string) => string[];
  /**
   * `ChangeImpactService.listOpen` — the durable revision-currency ledger.
   * An open impact naming this session pins a reconciliation block into its
   * deliveries. Optional: harnesses without the ledger render no block.
   */
  openImpacts?: (userSessionId: string) => ChangeImpactWire[];
}

export class PromptComposer {
  readonly #deps: PromptComposerDeps;
  /** Roster work-state diff lines, memoized 15s — see `agentWorkState`. */
  readonly #workStateDiffCache = new Map<string, { at: number; line: string }>();
  /**
   * Delta-cursor staging, keyed `agentSessionId:seat`. The DURABLE cursors
   * (`agents.last_decision_at`, `interactions.flushed_at`) advance only when
   * a delivery is ACKNOWLEDGED — a turn that dies re-renders its delta on
   * redelivery instead of losing it. These in-memory entries stage what the
   * current process already composed, so a steer into an open turn does not
   * duplicate the block; they are deliberately volatile — a restart forgets
   * them and the unacknowledged delta re-renders. At-least-once, never lost.
   */
  readonly #pendingDecisionAt = new Map<string, string>();
  readonly #pendingFlushedIds = new Map<string, Set<string>>();

  constructor(deps: PromptComposerDeps) { this.#deps = deps; }

  static #seatKey(agentSessionId: string, seat: string): string { return `${agentSessionId}:${seat}`; }

  /**
   * A delivery reached acknowledged: the recipient's turn settled cleanly, so
   * everything composed into it is processed. Advance the durable cursors to
   * the delivery's `deliveredAt` — stamped in the same synchronous block as
   * composition (mailroom.deliver), so every decision/answer that existed at
   * composition is at or before it. Idempotent; retried acks re-derive.
   */
  noteDeliveryAcknowledged(session: AgentSessionRow, seatName: string, deliveryId: string): void {
    const row = this.#deps.repo.getDeliveryById(deliveryId);
    const deliveredAt = row?.deliveredAt ?? null;
    if (deliveredAt === null) return;
    const seat = this.#deps.repo.getAgent(session.id, seatName);
    if (!seat) return;
    if (seat.lastDecisionAt === null || seat.lastDecisionAt < deliveredAt) {
      this.#deps.repo.patchAgent(session.id, seatName, { lastDecisionAt: deliveredAt });
    }
    const flushed = this.#deps.interactions.listAnsweredUnflushed(session.id, seatName)
      .filter((answer) => (answer.resolvedAt ?? answer.createdAt) <= deliveredAt);
    if (flushed.length > 0) {
      this.#deps.interactions.markFlushed(flushed.map((answer) => answer.id));
      const pending = this.#pendingFlushedIds.get(PromptComposer.#seatKey(session.id, seatName));
      if (pending) for (const answer of flushed) pending.delete(answer.id);
    }
  }

  /**
   * A delivery went back to queued (failed turn, pause) or was cancelled: the
   * composed prompt may never have been processed. Drop the staged cursors so
   * the next composition renders the unacknowledged delta again.
   */
  noteDeliveryRequeued(agentSessionId: string, seatName: string): void {
    const key = PromptComposer.#seatKey(agentSessionId, seatName);
    this.#pendingDecisionAt.delete(key);
    this.#pendingFlushedIds.delete(key);
  }

  /**
   * The spawn-time system-prompt tail. Order matters for prompt caching: the
   * invariant part (instructions, capabilities, messaging brief) comes first
   * and is byte-identical across generations; the volatile checkpoint goes
   * last.
   */
  systemPromptAppend(session: AgentSessionRow, seat: AgentRow, profile: AgentProfile, rolePrompt: RolePrompt): string {
    const identity = rolePrompt.brief === undefined ? seat.instructions : `${seat.instructions}\n\n${rolePrompt.brief}`;
    return `${identity}\n\n${capabilityBrief(profile, seat.worktreePath !== null)}\n\n${seatMessagingBrief(this.rosterLine(session, seat.name), rolePrompt.addressing)}\n${rolePrompt.protocol}${this.#objectiveContext(session)}${this.#decisionContext(session)}${this.#specContext(session)}${this.#checkpointContext(seat)}`;
  }

  /**
   * One roster agent line. The roster header is advisory: render at most
   * three scopes per agent; the full ownership list stays in the DB and the
   * API. The capability tag is there so a coordinator assigns work an agent
   * can actually do.
   */
  #seatLine(p: AgentRow, workState?: string): string {
    const scopes = p.ownership.slice(0, 3).join(", ") + (p.ownership.length > 3 ? ` +${p.ownership.length - 3} more` : "");
    return `${p.name} (${p.profileId}; ${capabilityTag(p.profileSnapshot as AgentProfile)}; owns: ${scopes || "coordination"}${workState === undefined ? "" : `; ${workState}`})`;
  }

  /**
   * The roster's bounded seat selection: all of them within the cap
   * (byte-identical rendering), the relevant ones plus a counted remainder
   * over it — the full roster stays one roster_status call away.
   */
  #rosterSeats(session: AgentSessionRow, self: string | null): { agents: AgentRow[]; suffix: string } {
    const agents = this.#deps.repo.listAgents(session.id);
    const selection = selectRosterSeats(agents.map((p) => {
      const lane = this.#deps.laneState(session.id, p.name);
      return { name: p.name, live: lane !== null && (lane.live || lane.activeTurn), lastActiveAt: p.lastActiveAt };
    }), self);
    if (selection === null) return { agents, suffix: "" };
    return {
      agents: agents.filter((p) => selection.names.has(p.name)),
      suffix: `; …and ${selection.omitted} more seat(s) — roster_status lists them all`,
    };
  }

  rosterLine(session: AgentSessionRow, self: string | null = null): string {
    const { agents, suffix } = this.#rosterSeats(session, self);
    return agents.map((p) => this.#seatLine(p)).join("; ") + suffix;
  }

  /**
   * The delivery prompt for a batch of queued journal rows. Selection is the
   * delivery-view layer's (bounded, deterministic); rendering here stays
   * byte-identical to the unbounded form whenever everything fits. Durable
   * cursors advance at ACKNOWLEDGEMENT (`noteDeliveryAcknowledged`), not
   * here — composition only stages what it rendered.
   */
  deliveryPrompt(session: AgentSessionRow, seat: AgentRow, rows: MessageRow[]): string {
    const seatKey = PromptComposer.#seatKey(session.id, seat.name);
    // Agent worktree state on every line: the coordinator otherwise has no
    // way to see in-progress work. Work states (git diffs included) are
    // computed for the SELECTED seats only.
    const rosterView = this.#rosterSeats(session, seat.name);
    const roster = rosterView.agents.map((p) => this.#seatLine(p, this.agentWorkState(p))).join("; ") + rosterView.suffix;
    const messages = rows.map((row) => {
      const id = (row.payload?.handoff as { id?: string } | undefined)?.id;
      if (!id || !this.#deps.handoffs) return `[${row.speakerName} → ${row.toName} | ${row.createdAt}] ${row.text}`;
      const handoff = this.#deps.handoffs.get(id);
      const expanded = handoff.core.risk === "high" || handoff.core.status === "needs_verification" || handoff.core.requestExpandedContext;
      this.#deps.bus.append({ type: "handoff.consumed", userSessionId: session.userSessionId, agentSessionId: session.id,
        payload: { handoffId: id, agent: seat.name, mode: expanded ? "expanded" : "compact" } });
      // Rendered in SEND shape, not as a top-level `CORE:` blob — the flat
      // rendering is the agent's only worked example of a handoff, and it must
      // not teach a shape `send_handoff` rejects.
      // The sender's rationale rides even the COMPACT form: `expecting` is the
      // recipient's success contract, and a contract buried behind
      // read_handoff is one nobody reads. Bounded fields (≤280 chars each).
      const data = handoff.extension.data as { why?: unknown; expecting?: unknown };
      const rationale =
        (typeof data.why === "string" && data.why !== "" ? `\nWhy: ${data.why}` : "") +
        (typeof data.expecting === "string" && data.expecting !== "" ? `\nExpected evidence: ${data.expecting}` : "");
      return `[${row.speakerName} → ${row.toName} | ${row.createdAt}] Handoff ${id}\n${JSON.stringify({ handoff: { core: handoff.core, extension: expanded ? handoff.extension : undefined } }, null, 2)}${rationale}${expanded ? "" : `\nExtension ${handoff.extension.kind} is available with read_handoff.`}`;
    }).join("\n\n");
    // The operator's answers to THIS agent's own questions. Rendered before
    // the handoffs because it outranks them — an operator decision is not a
    // claim to be verified. Flushed durably at ACK; the staged ids only stop
    // a steered same-process recomposition from repeating the block.
    const stagedFlush = this.#pendingFlushedIds.get(seatKey) ?? new Set<string>();
    const answered = this.#deps.interactions.listAnsweredUnflushed(session.id, seat.name)
      .filter((row) => !stagedFlush.has(row.id));
    const decisions = answered.map((row) => summarizeAnswer(row)).filter((line) => line !== "");
    if (decisions.length > 0) {
      for (const row of answered) stagedFlush.add(row.id);
      this.#pendingFlushedIds.set(seatKey, stagedFlush);
    }
    const answersBlock = decisions.length === 0 ? ""
      : `## The operator answered your question(s)\nAuthoritative — act on these and do not ask again.\n${decisions.map((line) => `- ${line}`).join("\n")}\n\n`;
    // Decisions made since this agent's last delivery — including ones it
    // never asked for; a LIVE agent may not respawn for hours, so the system
    // prompt's spawn-time digest is stale for exactly the agents that are
    // busy. The DELTA only, never the whole list, and omitted entirely when
    // empty: a block that renders empty would change every prompt and destroy
    // prompt caching (asserted in decision-ledger.e2e.test.ts). Bounded: over
    // the caps, decisions pinned to this seat's live requirement scope render
    // ahead of recency, and the remainder is counted with its read path.
    const staged = this.#pendingDecisionAt.get(seatKey);
    const watermark = staged !== undefined && (seat.lastDecisionAt === null || staged > seat.lastDecisionAt) ? staged : seat.lastDecisionAt;
    const fresh = this.#deps.decisions.since(session.userSessionId, watermark);
    const unseen = fresh.filter((row) => row.askedBy !== seat.name);
    if (fresh.length > 0) this.#pendingDecisionAt.set(seatKey, fresh[fresh.length - 1]!.createdAt);
    let freshBlock = "";
    if (unseen.length > 0) {
      const pin = decisionPin(this.#deps.requirements.derive(session.userSessionId), this.#seatDecisionScope(session));
      const delta = selectDecisionDelta(unseen.map((row) => ({ line: `- ${renderDecision(row)}`, pinned: row.requirementIds.length > 0 && pin(row.requirementIds) })));
      const omittedLine = delta.omitted === 0 ? ""
        : `\n- (${delta.omitted} more decision(s) since your last delivery — they still stand; list_decisions returns the full ledger)`;
      freshBlock = `## New operator decisions since your last delivery\nAuthoritative — these were decided for this whole session, not just for the seat that asked.\n${delta.lines.join("\n")}${omittedLine}\n\n`;
    }
    // The shared ledger, in every delivery: a live run's units sat pending
    // forever because agents only ever saw the ledger at spawn. Omitted
    // entirely when empty (byte-stability for ledger-less sessions). Bounded:
    // a large ledger keeps this seat's active units and their blockers and
    // counts the rest — the full ledger stays one task_list call away.
    const taskView = this.#taskView(session.id, seat.name);
    const taskLines = [...taskView.lines, ...(taskView.omittedLine === null ? [] : [taskView.omittedLine])];
    const ledgerBlock = taskLines.length === 0 ? ""
      : `## Task ledger (console-owned, authoritative)\n${taskLines.join("\n")}\nEach line starts with the unit's taskId — the one id send_handoff and task_update take. Keep your unit's status honest: in_progress when you start; completed only when the promised output exists and your report states it; report blocked/failed plainly — the unit stays open for the remaining work.\n\n`;
    // The governing revision on EVERY delivery: the decision delta announces
    // an amendment once, but a long-lived seat's context can scroll it away —
    // the pointer re-anchors each time work arrives. Omitted entirely when no
    // spec exists (byte-stability for spec-less sessions).
    const specPointer = this.#deps.requirements.pointer(session.userSessionId);
    const specBlock = specPointer === null ? ""
      : `Governing requirements: ${specPointer}. If your system prompt shows an older revision, read_requirements before continuing.\n\n`;
    // Revision currency, pinned: an open change impact that names this
    // session as affected-and-unreconciled renders on EVERY delivery until it
    // clears — a meaning change must not be buried by whatever else arrived.
    // Derived from the durable ledger (change-impact.ts), so it survives
    // restart and clears mechanically when the session acts or is reconciled.
    // Omitted entirely when none (byte-stability).
    const impactBlock = this.#impactBlock(session);
    // Declared cross-workstream links on EVERY delivery: what this session
    // awaits from other workstreams (with the console-derived status) and
    // which workstreams consume its output — the interface is a contract, not
    // an implementation detail. Omitted entirely when none (byte-stability).
    const workstreamLines = this.#deps.workstreamLines?.(session.id) ?? [];
    const workstreamBlock = workstreamLines.length === 0 ? ""
      : `## Workstream links (declared by main, console-derived status)\n${workstreamLines.map((line) => `- ${line}`).join("\n")}\nA pending or broken dependency is a fact to plan around and report, not to assume away.\n\n`;
    // The session's delegated sub-scope on EVERY delivery, statements and
    // statuses included — the sub-scope IS this session's success condition,
    // and a contract buried in the briefing is one a long-lived seat forgets.
    // Omitted entirely when the session holds no delegation (byte-stability).
    const delegatedBlock = this.#delegatedRequirements(session);
    return `AgentSession ${session.id}: ${session.title}\nYou are ${seat.name}. Participants: ${roster}.\n\n${answersBlock}${freshBlock}${ledgerBlock}${specBlock}${impactBlock}${workstreamBlock}${delegatedBlock}Only the following addressed handoffs are new:\n${messages}\n\nTreat handoff claims as historical context; verify risky claims against repository/task/journal evidence during normal work. Act without restating the envelope.`;
  }

  /** The bounded ledger view for one seat, over the canonical wire tasks. */
  #taskView(agentSessionId: string, seat: string): TaskView {
    return selectTaskView(this.#deps.tasks.listForAgentSession(agentSessionId).map((task) => ({
      id: task.id, status: task.status, owner: task.owner, dependencyIds: task.dependencyIds, ready: task.ready,
      line: taskLedgerLine(task),
    })), seat);
  }

  /** The pinned reconciliation block — see the call site in `deliveryPrompt`. */
  #impactBlock(session: AgentSessionRow): string {
    if (this.#deps.openImpacts === undefined) return "";
    const impacts = selectSessionImpacts(this.#deps.openImpacts(session.userSessionId), session.id);
    if (impacts.shown.length === 0) return "";
    const lines = impacts.shown.map((impact) => {
      const seeds = impact.affected.seedIds.slice(0, 8).join(", ")
        + (impact.affected.seedIds.length > 8 ? ` +${impact.affected.seedIds.length - 8} more` : "");
      const note = impact.note === null ? "" : ` — ${[...impact.note].length > 160 ? `${[...impact.note].slice(0, 160).join("")}…` : impact.note}`;
      return `- ${impact.id} (rev ${impact.atRevision}, ${impact.sourceKind}): ${seeds} changed${note}`;
    });
    if (impacts.omitted > 0) lines.push(`- (+${impacts.omitted} more open impact(s) affecting this session)`);
    return `## Requirement changes pending reconciliation (console-derived)\n${lines.join("\n")}\n` +
      `The Console lists this session as affected and not yet reconciled: re-check active work against the current revision (read_requirements) before relying on earlier conclusions, and report what you re-verified — or the conflict — to your coordinator.\n\n`;
  }

  /**
   * The successor's inheritance, built from facts the console owns — the task
   * ledger, the agent's declared ownership, its worktree branch and diff, the
   * assignment it is working, and its own last report — so it always exists
   * and is always true. Two sources share it, differing only in framing and
   * quality flags: "recovery" (the lane died before it could report — facts
   * may trail unreported work, so the successor re-verifies) and "rotation"
   * (a planned generation boundary retired the provider session — the seat's
   * own last report was written healthy at a natural boundary, so the facts
   * are current). The seat's last report IS the model-authored share of the
   * checkpoint; nothing here interrogates a dying or absent process.
   */
  reconstructCheckpoint(session: AgentSessionRow, seat: AgentRow, source: "recovery" | "rotation" = "recovery"): HandoffDraft {
    const { repo } = this.#deps;
    const evidence: HandoffDraft["core"]["state"]["evidence"] = [];
    const facts: string[] = [];

    const assignment = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, recipient: seat.name, excludeCheckpoints: true });
    const own = repo.latestHandoff({ userSessionId: session.userSessionId, agentSessionId: session.id, sender: seat.name, excludeCheckpoints: true });

    if (seat.ownership.length > 0) facts.push(`Owns: ${seat.ownership.join(", ")}.`);
    // Before the task ledger, deliberately: an operator decision outranks
    // model-maintained state.
    const decisions = this.#deps.decisions.lines(session.userSessionId, { max: 12 });
    if (decisions.length > 0) facts.push(`Operator decisions (Console-recorded, authoritative — do not contradict):\n${decisions.map((line) => `- ${line}`).join("\n")}`);
    // The checkpoint must be self-sufficiently true: the successor re-reads
    // the spec digest at spawn, but the reconstruction is what it TRUSTS.
    const specPointer = this.#deps.requirements.pointer(session.userSessionId);
    if (specPointer !== null) facts.push(`Governing requirements: ${specPointer}.`);
    const delegated = this.#deps.requirements.delegationSet(session.id);
    if (delegated.length > 0) facts.push(`Delegated requirements: ${delegated.join(", ")} (report_requirement with evidence; read_requirements for statements).`);
    // The seat-scoped BOUNDED view, not the whole ledger: a reconstruction
    // over hundreds of units must still fit in a checkpoint the successor can
    // read; the remainder is counted and stays one task_list call away.
    const taskView = this.#taskView(session.id, seat.name);
    const taskLines = [...taskView.lines, ...(taskView.omittedLine === null ? [] : [taskView.omittedLine])];
    if (taskLines.length > 0) facts.push(`Task ledger:\n${taskLines.join("\n")}`);
    if (seat.worktreePath && this.#deps.worktrees && seat.worktreeBranch && seat.worktreeBaseCommit) {
      try {
        // Commit whatever the dead turn left uncommitted FIRST: a checkpoint
        // that says "no changes yet" over a tree full of unstaged work is a
        // lie a successor acts on (a live run's reconstruction claimed exactly
        // that over 35 minutes of edits).
        try { this.#deps.worktrees.commitAll(seat.worktreePath, "console: reconstruction snapshot", seat.ownership); } catch { /* best effort */ }
        const diff = this.#deps.worktrees.captureDiffStats(seat.worktreePath, seat.worktreeBaseCommit, seat.worktreeBranch);
        const stat = diff.filesChanged === 0 ? "no changes yet" : `${diff.filesChanged} file(s) +${diff.insertions}/-${diff.deletions}`;
        facts.push(`Isolated worktree ${seat.worktreeBranch}: ${stat}. Not visible in the shared workspace until you report completed.`);
      } catch { facts.push(`Isolated worktree ${seat.worktreeBranch} (diff unavailable).`); }
    }
    if (!seat.worktreePath && seat.salvageBranch) {
      facts.push(`Previous work is preserved on archived branch ${seat.salvageBranch}${seat.salvageArtifactId ? ` and as diff artifact ${seat.salvageArtifactId} (read_artifact)` : ""} — recover from it rather than assuming the work is gone.`);
      if (seat.salvageArtifactId) evidence.push({ kind: "artifact", ref: seat.salvageArtifactId, label: "archived diff of the previous attempt" });
    }
    if (assignment) {
      facts.push(`Current assignment from ${assignment.sender}: ${assignment.core.action}${assignment.core.nextAction ? ` — next: ${assignment.core.nextAction}` : ""}`);
      evidence.push({ kind: "journal", ref: assignment.id, label: `assignment from ${assignment.sender}` });
    }
    if (own) {
      facts.push(`Your last report (${own.core.status}): ${own.core.state.summary.slice(0, 600)}`);
      evidence.push({ kind: "journal", ref: own.id, label: "your last report" });
    }

    const rotation = source === "rotation";
    const baseAction = assignment?.core.action ?? own?.core.action ?? "Resume interrupted work";
    const preamble = rotation
      ? `${seat.name}'s provider session was retired at a planned context boundary, so this continuation snapshot was assembled by the Console from authoritative state — not from that context's memory. You are the same seat continuing the same assignment, worktree and task truth; do not redo work listed as done.`
      : `${seat.name}'s previous context ended before it could write a checkpoint, so this was reconstructed by the Console from authoritative state — not from that context's memory. Treat it as a starting point and re-derive anything not listed.`;
    return {
      core: {
        schemaVersion: 1,
        taskId: own?.core.taskId ?? assignment?.core.taskId ?? null,
        // A planned rotation is not a failure and its facts were captured at a
        // healthy boundary; only a crash reconstruction is suspect enough to
        // demand re-verification of everything.
        status: rotation ? "in_progress" : "needs_verification",
        risk: rotation ? "medium" : "high",
        action: rotation ? rotationAction(baseAction) : recoveryAction(baseAction),
        state: {
          summary: `${preamble}\n\n${facts.join("\n")}`,
          evidence,
        },
        result: { summary: null, artifacts: [] },
        uncertainty: [rotation
          ? "Planned context rotation: the retired context's unreported local reasoning was not carried over. Read historical detail through read_handoff/read_artifact and the repository instead of re-deriving what is listed."
          : "Reconstructed checkpoint: the prior context's reasoning and any unreported findings were lost. Re-verify before reporting completion."],
        nextAction: assignment?.core.nextAction ?? own?.core.nextAction ?? "Re-read the assignment and continue.",
        requestExpandedContext: true,
      },
      extension: { kind: (seat.profileSnapshot as AgentProfile).handoffExtension ?? "generic",
        data: rotation ? { source: "rotation", consoleSynthesized: true } : { source: "reconstructed" } },
    };
  }

  /**
   * What this agent is doing right now, in one clause, from facts the console
   * owns. Rendered for EVERY agent — the worktree diff is the richest variant,
   * not the only one.
   */
  agentWorkState(seat: AgentRow): string {
    const facts: string[] = [];
    const lane = this.#deps.laneState(seat.agentSessionId, seat.name);
    if (lane?.activeTurn) facts.push("working now");
    else if (lane?.live) facts.push("live, between turns");
    else if (seat.turnCount > 0) facts.push(`parked after ${seat.turnCount} turn(s)`);
    else facts.push("not started");
    if (seat.latestHandoffId && this.#deps.handoffs) {
      try {
        const last = this.#deps.handoffs.get(seat.latestHandoffId);
        facts.push(`last reported ${last.core.status}: ${last.core.action}`);
      } catch { /* a handoff we cannot read tells the roster nothing */ }
    }
    if (seat.worktreePath && seat.worktreeBranch && seat.worktreeBaseCommit && this.#deps.worktrees) {
      // Memoized: `deliveryPrompt` renders this for EVERY agent on EVERY
      // delivery — at the agent cap that is one git subprocess per agent per
      // message. A 15s-stale count in a prompt hint is invisible.
      const key = `${seat.worktreePath}:${seat.worktreeBranch}`;
      const cached = this.#workStateDiffCache.get(key);
      if (cached && Date.now() - cached.at < 15_000) {
        facts.push(cached.line);
      } else {
        let line: string;
        try {
          const diff = this.#deps.worktrees.captureDiffStats(seat.worktreePath, seat.worktreeBaseCommit, seat.worktreeBranch);
          line = diff.filesChanged === 0
            ? "unmerged worktree, nothing written yet"
            : `unmerged worktree: ${diff.filesChanged} file(s) +${diff.insertions}/-${diff.deletions}, not visible in the workspace until they report completed`;
        } catch { line = "unmerged worktree (state unavailable)"; }
        this.#workStateDiffCache.set(key, { at: Date.now(), line });
        // Evict on write: entries outlive their worktrees otherwise.
        for (const [k, v] of this.#workStateDiffCache) if (Date.now() - v.at >= 15_000) this.#workStateDiffCache.delete(k);
        facts.push(line);
      }
    }
    return facts.join("; ");
  }

  /**
   * Everything the operator has decided, injected into the VOLATILE TAIL of an
   * agent's system prompt. Placement is load-bearing: AFTER the cache-invariant
   * head (instructions, capabilities, messaging brief — byte-identical across
   * generations) so it cannot break prompt caching, and BEFORE the checkpoint,
   * because an operator decision outranks a model-authored summary of state.
   * Cache-safe because the system prompt is assembled only at spawn, never per
   * turn.
   */
  #decisionContext(session: AgentSessionRow): string {
    const digest = this.#deps.decisions.digest(session.userSessionId, {
      pinned: decisionPin(this.#deps.requirements.derive(session.userSessionId), this.#seatDecisionScope(session)),
    });
    if (digest === "") return "";
    return `\n\n## Operator decisions (authoritative)\nAlready decided for this run — act on them as given.\n${digest}`;
  }

  #objectiveContext(session: AgentSessionRow): string {
    return this.#deps.objective?.seatDigest(session.userSessionId) ?? "";
  }

  /**
   * The requirement ids a seat's decisions pin against: its delegated
   * subtrees PLUS their ancestors — a decision on the parent obligation
   * governs the child's work. Undelegated sessions pin nothing extra.
   */
  #seatDecisionScope(session: AgentSessionRow): Set<string> {
    const roots = this.#deps.requirements.delegationSet(session.id);
    if (roots.length === 0) return new Set();
    const nodes = this.#deps.requirements.derive(session.userSessionId);
    const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
    const scope = new Set<string>();
    for (const node of nodes) {
      for (let cursor: string | null = node.id; cursor !== null; cursor = parentOf.get(cursor) ?? null) {
        if (roots.includes(cursor)) { scope.add(node.id); break; }
      }
    }
    for (const root of roots) {
      for (let cursor: string | null = root; cursor !== null; cursor = parentOf.get(cursor) ?? null) scope.add(cursor);
    }
    return scope;
  }

  /**
   * The approved spec, after decisions (both authoritative) and before the
   * checkpoint (the spec outranks a model-authored summary of state). Renders
   * empty when no spec is approved — the byte-stability rule.
   *
   * A seat gets current milestone context plus the top-level shape, not the whole outline:
   * its delegated subtree arrives in full with every delivery, and detail
   * outside it is one read_requirements away — injecting the entire graph
   * into every seat is exactly what stops scaling.
   */
  #specContext(session: AgentSessionRow): string {
    const approved = this.#deps.requirements.latestApproved(session.userSessionId);
    if (approved === undefined) return "";
    const intent = this.#deps.requirements.intentDocument(session.userSessionId);
    const nodes = this.#deps.requirements.derive(session.userSessionId);
    const subtreeCounts = (rootId: string): { satisfied: number; total: number } => {
      const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
      let satisfied = 0;
      let total = 0;
      for (const node of nodes) {
        if (node.id === rootId) continue;
        for (let cursor: string | null = node.parentId; cursor !== null; cursor = parentOf.get(cursor) ?? null) {
          if (cursor === rootId) {
            total += 1;
            if (node.derivedStatus === "satisfied") satisfied += 1;
            break;
          }
        }
      }
      return { satisfied, total };
    };
    const glyph: Record<string, string> = { open: "·", satisfied: "✓", violated: "✗", infeasible: "⊘", retired: "†" };
    const top = nodes.filter((node) => node.parentId === null).map((node) => {
      const counts = subtreeCounts(node.id);
      const suffix = counts.total === 0 ? "" : ` (subtree: ${counts.satisfied}/${counts.total} satisfied)`;
      return `- [${glyph[node.derivedStatus] ?? "·"}] ${node.id}${node.composition === "any" ? " (any of)" : ""}: ${node.statement}${suffix}`;
    });
    return `\n\n## Requirements (rev ${approved.revision}, authoritative — statuses are console-derived)\n` +
      `${intent === null ? "" : `${intent}\n\n`}` +
      `Top-level requirements:\n${top.join("\n")}\n` +
      `Your work is checked against this. Your delegated subtree arrives in full with each delivery; read_requirements (scopeId) returns any subtree with statuses.`;
  }

  /**
   * The delegated-requirements delivery block: the statements this session
   * answers for, with live statuses, scoped to its delegated subtrees.
   * Renders "" when the session holds no delegation — byte-stability.
   */
  #delegatedRequirements(session: AgentSessionRow): string {
    const roots = this.#deps.requirements.delegationSet(session.id);
    if (roots.length === 0) return "";
    // Vision continuity at depth: each delegated root carries its chain from
    // the top of the graph, so a seat three levels down still sees WHICH
    // larger obligation its subtree serves.
    const ancestors = roots
      .map((root) => ({ root, path: this.#deps.requirements.ancestorPath(session.userSessionId, root) }))
      .filter((entry) => entry.path.length > 0)
      .map((entry) => `Under: ${entry.path.map((step) => `${step.id} ${step.statement}`).join(" › ")} › ${entry.root}`);
    const nodes = this.#deps.requirements.derive(session.userSessionId);
    const inSubtree = new Set<string>();
    const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
    for (const node of nodes) {
      for (let cursor: string | null = node.id; cursor !== null; cursor = parentOf.get(cursor) ?? null) {
        if (roots.includes(cursor)) { inSubtree.add(node.id); break; }
      }
    }
    const subtreeNodes = nodes.filter((node) => inSubtree.has(node.id));
    const viewNodes: DelegatedViewNode[] = subtreeNodes.map((node) => {
      const depth = (() => { let d = 0; for (let cursor = node.parentId; cursor !== null && inSubtree.has(cursor); cursor = parentOf.get(cursor) ?? null) d += 1; return d; })();
      const status = node.derivedStatus === node.status ? node.status : `${node.status}, derives ${node.derivedStatus}`;
      // The console-derived invalidation marks ride the line: a seat holding a
      // flagged terminal claim must see its evidence is suspect, not a clean
      // [satisfied]. Byte-stable when nothing is flagged.
      const flagged = node.flags.length === 0 ? "" : ` ⚠ ${node.flags.join(", ")}`;
      return {
        id: node.id,
        parentId: node.parentId !== null && inSubtree.has(node.parentId) ? node.parentId : null,
        line: `${"  ".repeat(depth)}- ${node.id} [${status}${flagged}]${node.composition === "any" ? " (any of)" : ""}: ${node.statement}`,
        derivedStatus: node.derivedStatus,
        flagged: node.flags.length > 0,
      };
    });
    // Bounded: within budget the full subtree renders byte-identically; over
    // it, satisfied stable subtrees collapse first, then the view falls back
    // to the flagged/open skeleton with its governing boundary — a suspect
    // claim survives every rung (delivery-view.ts).
    const view = selectDelegatedView(viewNodes);
    const lines = view.omittedLine === null ? view.lines : [...view.lines, view.omittedLine];
    const flagLegend = subtreeNodes.some((node) => node.flags.length > 0)
      ? "⚠ marks a terminal claim whose dependency or premise changed AFTER it was recorded (console-derived): re-verify or reopen before relying on it; report_requirement with a fresh claim clears the mark.\n"
      : "";
    const ancestorBlock = ancestors.length === 0 ? "" : `${ancestors.join("\n")}\n`;
    // Link-driven context selection: what this subtree DEPENDS ON outside
    // itself (read-only — its statements and statuses, not its work), and the
    // recorded premises it rests on. Both empty-render to "" (byte stability).
    const byNodeId = new Map(nodes.map((node) => [node.id, node]));
    const outsideDeps = [...new Set(nodes.filter((node) => inSubtree.has(node.id))
      .flatMap((node) => node.dependsOn)
      .filter((target) => !inSubtree.has(target)))];
    const contextBlock = outsideDeps.length === 0 ? "" :
      `Context requirements (outside your scope, read-only — your subtree depends on them):\n${
        outsideDeps.map((id) => {
          const node = byNodeId.get(id);
          return node === undefined ? `- ${id}` : `- ${id} [${node.derivedStatus}]: ${node.statement}`;
        }).join("\n")}\n`;
    const assumptionLines = this.#deps.assumptions.openLines(session.userSessionId, inSubtree);
    const assumptionBlock = assumptionLines.length === 0 ? "" :
      `Standing assumptions (recorded, not operator-approved — your subtree rests on them; report contradictions with resolve_assumption or to main):\n${assumptionLines.join("\n")}\n`;
    return `## Your delegated requirements (this session's success condition)\n${ancestorBlock}${lines.join("\n")}\n${flagLegend}${contextBlock}${assumptionBlock}Statuses are semantic and evidence-required: report_requirement (leaves only — the Console records who stood behind each claim), decompose_requirement to refine below these nodes. Anything outside this sub-scope routes to main.\n\n`;
  }

  /**
   * Where the previous generation left off (recovery, or a historical
   * checkpoint row), as prose the
   * successor can act on. The lossless record stays one read_handoff away.
   */
  #checkpointContext(seat: AgentRow): string {
    if (seat.latestHandoffId && this.#deps.handoffs) {
      const handoff = this.#deps.handoffs.get(seat.latestHandoffId);
      // `latestHandoffId` is the seat's inbound pointer: for a seat that has
      // not recovered it names its briefing or last assignment, which the lane
      // already delivered — only a real checkpoint is worth a tail.
      if (!handoff.metadata.checkpoint) return "";
      const { core } = handoff;
      const evidence = core.state.evidence.map((ref) => `${ref.kind}:${ref.ref}${ref.label ? ` (${ref.label})` : ""}`);
      const lines = [
        `Action: ${core.action} — ${core.status}, risk ${core.risk}.`,
        `State: ${core.state.summary}`,
        ...(core.result.summary ? [`Result: ${core.result.summary}`] : []),
        ...(core.uncertainty.length > 0 ? [`Uncertain: ${core.uncertainty.join(" | ")}`] : []),
        ...(core.nextAction ? [`Next: ${core.nextAction}`] : []),
        ...(evidence.length > 0 ? [`Evidence: ${evidence.join("; ")}`] : []),
      ];
      return `\n\n## Where you left off (checkpoint ${handoff.metadata.id})\nA bounded continuation snapshot recorded when your previous provider context ended — you are the same seat continuing the same work; read_handoff returns the full record. Authoritative repository/task/requirement state outranks its prose. Treat it as a starting point, verify anything risky, and do not redo investigation it records as done.\n${lines.join("\n")}`;
    }
    return "";
  }
}
