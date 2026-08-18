/**
 * Route law for agent sessions: the compiled-contract index and every
 * derivation from it — roles, completion/escalation targets, edge legality,
 * relay collectors. Pure reads over the repo plus one memo; the relay
 * DECISION (whether to carry a silent agent's report) stays in the service's
 * settle-hook path.
 */
import { InvalidInputError } from "../errors.ts";
import type { Repo, AgentRow, AgentSessionRow } from "../db/repo.ts";
import type { EdgeSpec } from "./topology-contract.ts";
import { compileContract, contractOfSession, roleOfAgent, type CompiledContract } from "./topology.ts";
import { CHILD_SENDER_PREFIX, CONSOLE_SENDER, MAIN_RECIPIENT, COORDINATOR_AGENT } from "./names.ts";
import type { Category } from "./final-gate.ts";

export interface SessionRoutingDeps {
  repo: Pick<Repo, "getAgent" | "listAgents" | "getAgentSession">;
}

export class SessionRouting {
  readonly #deps: SessionRoutingDeps;
  /** Compiled per session and memoized — contracts are frozen at creation. */
  readonly #contracts = new Map<string, CompiledContract>();

  constructor(deps: SessionRoutingDeps) { this.#deps = deps; }

  contractOf(session: AgentSessionRow): CompiledContract {
    let compiled = this.#contracts.get(session.id);
    if (!compiled) { compiled = compileContract(contractOfSession(session)); this.#contracts.set(session.id, compiled); }
    return compiled;
  }

  /** Memo cleanup on archive — the lifecycle's `#forget` calls this. */
  forget(agentSessionId: string): void {
    this.#contracts.delete(agentSessionId);
  }

  /** A participant's contract role; "main" is the user-session lane's pseudo-role. */
  roleOf(agentSessionId: string, name: string): string {
    if (name === MAIN_RECIPIENT) return "main";
    const seat = this.#deps.repo.getAgent(agentSessionId, name);
    return seat ? roleOfAgent(seat) : "";
  }

  agentsOfRole(agentSessionId: string, role: string): AgentRow[] {
    return this.#deps.repo.listAgents(agentSessionId)
      .filter((row) => roleOfAgent(row) === role)
      .sort((a, b) => a.ord - b.ord);
  }

  /**
   * The agent named by a completion-spec role. Builders guarantee `finalFrom`
   * and `voice` are single-agent roles, so first-by-ord IS the agent.
   */
  completionAgent(session: AgentSessionRow, which: "finalFrom" | "voice"): string {
    const role = this.contractOf(session).contract.completion[which];
    return this.agentsOfRole(session.id, role)[0]?.name ?? COORDINATOR_AGENT;
  }

  /**
   * Whether a seat's role reviews someone else's output. Its worktree is a
   * SNAPSHOT OF THE THING UNDER REVIEW, so it must be cut from the branch the
   * work is on, not from the workspace baseline.
   */
  isReviewRole(session: AgentSessionRow, seatName: string): boolean {
    const seat = this.#deps.repo.getAgent(session.id, seatName);
    return seat !== undefined && this.contractOf(session).role(roleOfAgent(seat))?.extensionKind === "review";
  }

  /** Where an agent's console-synthesized failures go (RoleSpec.escalateTo). */
  escalationTarget(session: AgentSessionRow, seatName: string): string {
    const seat = this.#deps.repo.getAgent(session.id, seatName);
    const spec = seat ? this.contractOf(session).role(roleOfAgent(seat)) : undefined;
    const target = spec?.escalateTo ?? "main";
    if (target === "main") return MAIN_RECIPIENT;
    return this.agentsOfRole(session.id, target).filter((row) => row.name !== seatName)[0]?.name ?? MAIN_RECIPIENT;
  }

  /**
   * Where a silent agent's relayed report goes: its role's outbound edge,
   * preferring the escalation target, then any non-main edge, then main
   * itself (a final pipeline stage's only outlet).
   */
  relayCollector(session: AgentSessionRow, role: string, seatName: string): string | null {
    const compiled = this.contractOf(session);
    const candidates = compiled.contract.edges.filter((edge) => edge.from === role && edge.to !== role);
    if (candidates.length === 0) return null;
    const escalate = compiled.role(role)?.escalateTo;
    const pick = candidates.find((edge) => edge.to === escalate && edge.to !== "main")
      ?? candidates.find((edge) => edge.to !== "main")
      ?? candidates[0]!;
    if (pick.to === "main") return MAIN_RECIPIENT;
    return this.agentsOfRole(session.id, pick.to).filter((row) => row.name !== seatName)[0]?.name ?? null;
  }

  assertRoute(session: AgentSessionRow, sender: string, recipient: string, category: Category): EdgeSpec {
    // Console-authored deliveries (operator answers, close-out asks, release
    // notices) are legal toward any agent — the console is the transport, not
    // a participant, so it needs no edge of its own.
    if (sender === CONSOLE_SENDER) return { from: "console", to: this.roleOf(session.id, recipient), advance: "immediate" };
    // Boundary hops: a child session's report enters its parent under the
    // reserved `child:<id>` sender, valid only toward that child's controller.
    if (sender.startsWith(CHILD_SENDER_PREFIX)) {
      const child = this.#deps.repo.getAgentSession(sender.slice(CHILD_SENDER_PREFIX.length));
      if (child && child.parentAgentSessionId === session.id && recipient === child.parentControllerAgent) {
        return { from: "child", to: "controller", advance: "immediate" };
      }
      throw new InvalidInputError(`route ${sender} → ${recipient} is not allowed; a child session reports only to its own controller`);
    }
    const contract = this.contractOf(session);
    const from = this.roleOf(session.id, sender);
    const to = this.roleOf(session.id, recipient);
    const edge = from === "" || to === "" || sender === recipient ? undefined : contract.edge(from, to);
    if (!edge) throw new InvalidInputError(`route ${sender} → ${recipient} is not allowed; communication is ${contract.contract.routeSummary}`);
    if (edge.categories && !edge.categories.includes(category)) {
      throw new InvalidInputError(`route ${sender} → ${recipient} does not carry "${category}" handoffs; communication is ${contract.contract.routeSummary}`);
    }
    return edge;
  }
}
