/**
 * Prompt composition for agent sessions: every string the Console says to an
 * agent — system-prompt tails, delivery prompts, roster lines, reconstructed
 * checkpoints. Prompt bytes are pinned by prompt-snapshot.e2e; keep every
 * literal byte-identical.
 */
import type { HandoffDraft, Interaction, InteractionQuestion } from "@agentique-console/shared";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { Config } from "../config.ts";
import type {
  Repo,
  AgentRow,
  AgentSessionRow,
  MessageRow,
} from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import type { HandoffService } from "../handoffs/service.ts";
import { recoveryAction } from "../lane-runtime/checkpoint.ts";
import { decisionOf, renderDecision, type DecisionLedger } from "../orchestrator/decisions.ts";
import type { InteractionService } from "../orchestrator/interactions.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { SdkUserMessageLike } from "../sdk/types.ts";
import type { TaskService } from "../tasks/service.ts";
import type { RolePrompt } from "./topology-contract.ts";

/**
 * The MCP servers a seat actually gets: what its profile declared, minus what
 * the operator disabled, with the browser server swappable by name.
 *
 * Config-declared and console-launched — the Console vendors no capability of
 * its own. `CONSOLE_MCP_DISABLED=browser` turns a server off for a whole
 * install; `CONSOLE_BROWSER_MCP='<command> <args…>'` replaces the browser one
 * without touching a profile.
 */
export function declaredMcpServers(profile: AgentProfile, config: Config): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const disabled = new Set(config.infra.mcpDisabled ?? []);
  const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  // A profile SNAPSHOT taken before this field existed has no `mcpServers`.
  // Snapshots are cast, never re-parsed, so the default never applies to them:
  // a session open across the upgrade must degrade to "no servers", not crash.
  for (const [name, spec] of Object.entries(profile.mcpServers ?? {})) {
    if (disabled.has(name)) continue;
    const override = name === "browser" ? config.infra.browserMcp : undefined;
    if (override !== undefined) {
      const [command, ...args] = override;
      if (command === undefined) continue;
      out[name] = { command, args };
      continue;
    }
    out[name] = spec;
  }
  return out;
}

function capabilityBrief(profile: AgentProfile, hasWorktree: boolean): string {
  const can: string[] = [];
  const cannot: string[] = [];
  // `?? {}`: a snapshot from before this field existed is cast, not parsed.
  const servers = Object.keys(profile.mcpServers ?? {});
  if (profile.tools.includes("Bash")) {
    can.push("run shell commands with Bash, including long-running ones in the background — background a server and read its output back rather than blocking a turn");
  } else cannot.push("run any shell command");
  if (servers.length > 0) {
    can.push(`use the tools your MCP server(s) provide — ${servers.join(", ")}, named mcp__<server>__<tool>`);
  } else cannot.push("reach any MCP server (your profile declares none)");
  cannot.push("write outside your own working copy — teammates own theirs");
  return `## Your capabilities\nYou can: ${can.join("; ") || "read files only"}.\nYou cannot: ${cannot.join("; ")}.\n` +
    `${hasWorktree ? "Your cwd is an isolated worktree; teammates and the coordinator cannot see your files until the Console merges them when you report completed.\n" : ""}` +
    `If an assignment needs something in the "cannot" list, say so immediately in a handoff rather than working around it — the limit is real and will not change mid-run.`;
}

/** Compact capability tag for roster lines — what this agent can be asked to do. */
function capabilityTag(profile: AgentProfile): string {
  const caps = [
    ...(profile.tools.includes("Edit") || profile.tools.includes("Write") ? ["writes files"] : ["read-only"]),
    ...(profile.tools.includes("Bash") ? ["runs commands"] : []),
    ...Object.keys(profile.mcpServers ?? {}),
  ];
  return `can: ${caps.join(", ")}`;
}

/** Console-synthesized lane input: neither human nor peer, so no origin. */
export function seatUserMessage(text: string): SdkUserMessageLike {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, shouldQuery: true };
}

/** The agent's messaging documentation. */
function seatMessagingBrief(roster: string, addressing: string): string {
  return `Communication: your plain text output reaches no one. To transfer anything — an assignment, progress, findings, a failure, a final result — call send_handoff. Its fields are typed; there is no JSON to write or escape. Participants: ${roster}. ` +
    `${addressing} ` +
    `The Human Operator is reachable separately and directly with ask_operator — that path does not go through anyone. ` +
    `Put the substance in stateSummary — the findings themselves, not a description of having found them — and say what you could not verify in uncertainty. ` +
    `Size is not a constraint on truth: if the substance is long, put it in write_note and reference the artifact. Never shorten a finding to fit. ` +
    `If send_handoff ever rejects your input as unparseable, do NOT retry the same payload — move the body into write_note and re-send with the reference. ` +
    `Never use the Agent or SendMessage tools.`;
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
  tasks: TaskService;
  interactions: InteractionService;
  worktrees: WorktreeManager | null;
  /** Live lane facts for the roster work-state line — a host capability, injected. */
  laneState: (agentSessionId: string, agent: string) => { activeTurn: boolean; live: boolean } | null;
}

export class PromptComposer {
  readonly #deps: PromptComposerDeps;
  /** Roster work-state diff lines, memoized 15s — see `agentWorkState`. */
  readonly #workStateDiffCache = new Map<string, { at: number; line: string }>();

  constructor(deps: PromptComposerDeps) { this.#deps = deps; }

  /**
   * The spawn-time system-prompt tail. Order matters for prompt caching: the
   * invariant part (instructions, capabilities, messaging brief) comes first
   * and is byte-identical across generations; the volatile checkpoint goes
   * last.
   */
  systemPromptAppend(session: AgentSessionRow, seat: AgentRow, profile: AgentProfile, rolePrompt: RolePrompt): string {
    return `${seat.instructions}\n\n${capabilityBrief(profile, seat.worktreePath !== null)}${seat.worktreePath ? "\nNever run git commit — the Console lands your work when you report completed. Install dependencies only if you must run validation." : ""}\n\n${seatMessagingBrief(this.rosterLine(session), rolePrompt.addressing)}\n${rolePrompt.protocol}${this.#decisionContext(session)}${this.#checkpointContext(seat)}`;
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

  rosterLine(session: AgentSessionRow): string {
    return this.#deps.repo.listAgents(session.id).map((p) => this.#seatLine(p)).join("; ");
  }

  /**
   * The delivery prompt for a batch of queued journal rows. Call once per
   * delivery — it MUTATES as it renders: answered interactions are marked
   * flushed and the agent's decision watermark (`lastDecisionAt`) advances.
   */
  deliveryPrompt(session: AgentSessionRow, seat: AgentRow, rows: MessageRow[]): string {
    // Agent worktree state on every line: the coordinator otherwise has no
    // way to see in-progress work.
    const roster = this.#deps.repo.listAgents(session.id).map((p) => this.#seatLine(p, this.agentWorkState(p))).join("; ");
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
      return `[${row.speakerName} → ${row.toName} | ${row.createdAt}] Handoff ${id}\n${JSON.stringify({ handoff: { core: handoff.core, extension: expanded ? handoff.extension : undefined } }, null, 2)}${expanded ? "" : `\nExtension ${handoff.extension.kind} is available with read_handoff.`}`;
    }).join("\n\n");
    // The operator's answers to THIS agent's own questions. Rendered before
    // the handoffs because it outranks them — an operator decision is not a
    // claim to be verified.
    const answered = this.#deps.interactions.listAnsweredUnflushed(session.id, seat.name);
    const decisions = answered.map((row) => summarizeAnswer(row)).filter((line) => line !== "");
    if (decisions.length > 0) this.#deps.interactions.markFlushed(answered.map((row) => row.id));
    const answersBlock = decisions.length === 0 ? ""
      : `## The operator answered your question(s)\nAuthoritative — act on these and do not ask again.\n${decisions.map((line) => `- ${line}`).join("\n")}\n\n`;
    // Decisions made since this agent's last delivery — including ones it
    // never asked for; a LIVE agent may not respawn for hours, so the system
    // prompt's spawn-time digest is stale for exactly the agents that are
    // busy. The DELTA only, never the whole list, and omitted entirely when
    // empty: a block that renders empty would change every prompt and destroy
    // prompt caching (asserted in decision-ledger.e2e.test.ts).
    const fresh = this.#deps.decisions.since(session.userSessionId, seat.lastDecisionAt);
    const unseen = fresh.filter((row) => row.askedBy !== seat.name);
    if (fresh.length > 0) {
      this.#deps.repo.patchAgent(session.id, seat.name, { lastDecisionAt: fresh[fresh.length - 1]!.createdAt });
    }
    const freshBlock = unseen.length === 0 ? ""
      : `## New operator decisions since your last delivery\nAuthoritative — these were decided for this whole session, not just for the seat that asked.\n${unseen.map((row) => `- ${renderDecision(row)}`).join("\n")}\n\n`;
    return `AgentSession ${session.id}: ${session.title}\nYou are ${seat.name}. Participants: ${roster}.\n\n${answersBlock}${freshBlock}Only the following addressed handoffs are new:\n${messages}\n\nTreat handoff claims as historical context; verify risky claims against repository/task/journal evidence during normal work. Act without restating the envelope.`;
  }

  /**
   * The successor's inheritance when the model could not produce a checkpoint.
   * Built from facts the console owns — the task ledger, the agent's declared
   * ownership, its worktree branch and diff, the assignment it is working, and
   * its own last report — so it always exists and is always true. A failed
   * model checkpoint costs fidelity, not truth.
   */
  reconstructCheckpoint(session: AgentSessionRow, seat: AgentRow): HandoffDraft {
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
    const taskLines = this.#deps.tasks?.linesForAgentSession(session.id) ?? [];
    if (taskLines.length > 0) facts.push(`Task ledger:\n${taskLines.join("\n")}`);
    if (seat.worktreePath && this.#deps.worktrees && seat.worktreeBranch && seat.worktreeBaseCommit) {
      try {
        const diff = this.#deps.worktrees.captureDiffStats(seat.worktreePath, seat.worktreeBaseCommit, seat.worktreeBranch);
        const stat = diff.filesChanged === 0 ? "no changes yet" : `${diff.filesChanged} file(s) +${diff.insertions}/-${diff.deletions}`;
        facts.push(`Isolated worktree ${seat.worktreeBranch}: ${stat}. Not visible in the shared workspace until you report completed.`);
      } catch { facts.push(`Isolated worktree ${seat.worktreeBranch} (diff unavailable).`); }
    }
    if (assignment) {
      facts.push(`Current assignment from ${assignment.sender}: ${assignment.core.action}${assignment.core.nextAction ? ` — next: ${assignment.core.nextAction}` : ""}`);
      evidence.push({ kind: "journal", ref: assignment.id, label: `assignment from ${assignment.sender}` });
    }
    if (own) {
      facts.push(`Your last report (${own.core.status}): ${own.core.state.summary.slice(0, 600)}`);
      evidence.push({ kind: "journal", ref: own.id, label: "your last report" });
    }

    return {
      core: {
        schemaVersion: 1,
        taskId: own?.core.taskId ?? assignment?.core.taskId ?? null,
        status: "needs_verification",
        risk: "high",
        action: recoveryAction(assignment?.core.action ?? own?.core.action ?? "Resume interrupted work"),
        state: {
          summary: `Context was rotated before ${seat.name} could write a checkpoint, so this was reconstructed by the Console from authoritative state — not from the previous context's memory. Treat it as a starting point and re-derive anything not listed.\n\n${facts.join("\n")}`,
          evidence,
        },
        result: { summary: null, artifacts: [] },
        uncertainty: ["Reconstructed checkpoint: the prior context's reasoning and any unreported findings were lost. Re-verify before reporting completion."],
        nextAction: assignment?.core.nextAction ?? own?.core.nextAction ?? "Re-read the assignment and continue.",
        requestExpandedContext: true,
      },
      extension: { kind: (seat.profileSnapshot as AgentProfile).handoffExtension ?? "generic", data: { source: "reconstructed" } },
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
    const digest = this.#deps.decisions.digest(session.userSessionId);
    if (digest === "") return "";
    return `\n\n## Operator decisions (authoritative)\nThe operator made these. Do not re-litigate them, do not contradict them, and do not ask again.\n${digest}`;
  }

  #checkpointContext(seat: AgentRow): string {
    if (seat.latestHandoffId && this.#deps.handoffs) {
      const handoff = this.#deps.handoffs.get(seat.latestHandoffId);
      return `\n\n## Rotation checkpoint ${handoff.metadata.id}\n${JSON.stringify({ core: handoff.core, extension: handoff.extension }, null, 2)}`;
    }
    return "";
  }
}
