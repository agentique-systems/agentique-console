/**
 * Writes gated on agreement, and on declared ownership.
 *
 * Two rules, one hook, because both answer the same question at the same
 * moment: may this seat write this path right now?
 *
 * CONTRACTS make "renderer and page must agree the interface BEFORE either
 * writes code" a mechanism. In db-live-2 that instruction was followed by
 * nobody: `renderer` wrote `src/game.js` 61 seconds after receiving a contract
 * it never confirmed, and nothing in the system could have caught a signature
 * mismatch before both files were on disk.
 *
 * OWNERSHIP was already half-built — `createSession` validates disjoint scopes
 * and `commitAll` scopes commits by them — and then nothing consulted it. So
 * `renderer` created `.renderer-dev/serve.mjs`, a private duplicate of the dev
 * server `page` owned and had already written, and maintained it for sixteen
 * minutes.
 *
 * Fail-open throughout, matching `worktree-hook.ts`: a hook that throws must
 * never be the reason a seat cannot work.
 */
import path from "node:path";
import type { EventBus } from "../events/bus.ts";
import { pathWithin, type ContractService } from "../contracts/service.ts";
import type { SdkHookInput, SdkHookOutput, SdkHooksFragment } from "../sdk/types.ts";

const WRITE_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";

/** The file a write-shaped tool call targets, if it names one. */
export function filePathOf(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const candidate = input as { file_path?: unknown; path?: unknown; notebook_path?: unknown };
  for (const value of [candidate.file_path, candidate.path, candidate.notebook_path]) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** Whether a path falls inside one of the seat's declared ownership scopes. */
export function ownsPath(ownership: readonly string[], absolutePath: string, workspaceRoot: string): boolean {
  return ownership.some((scope) => pathWithin(absolutePath, scope, workspaceRoot));
}

/**
 * A worktree'd seat writes `<dataDir>/worktrees/…/src/game.js`, but contract
 * scopes and ownership are declared in WORKSPACE coordinates — comparing the
 * raw absolute path against them can never match (which silently disabled
 * contract gating for every worktree'd seat, the default for writers). Map the
 * write target back into the workspace before any scope check.
 */
export function toWorkspacePath(absolute: string, seatRoot: string, workspaceRoot: string): string {
  const withinSeat = path.relative(seatRoot, absolute);
  return withinSeat !== "" && !withinSeat.startsWith("..") && !path.isAbsolute(withinSeat)
    ? path.resolve(workspaceRoot, withinSeat)
    : absolute;
}

export function buildContractHooks(deps: {
  contracts: ContractService;
  bus: EventBus;
  userSessionId: string;
  agentSessionId: string;
  seat: string;
  seatRoot: string;
  workspaceRoot: string;
  ownership: readonly string[];
  /** Ownership denial is opt-in for a release; contract denial is not. */
  enforceOwnership: boolean;
}): SdkHooksFragment {
  const deny = (toolName: string, kind: string, reason: string): SdkHookOutput => {
    deps.bus.append({
      type: "governance.tool.denied",
      userSessionId: deps.userSessionId,
      agentSessionId: deps.agentSessionId,
      payload: {
        sessionId: deps.userSessionId, agentSessionId: deps.agentSessionId,
        participant: deps.seat, toolName, kind, reason: reason.slice(0, 500),
      },
    } as never);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  };

  const onWrite = async (input: SdkHookInput): Promise<SdkHookOutput> => {
    try {
      const target = filePathOf(input.tool_input);
      if (target === null) return {};
      const absolute = toWorkspacePath(path.resolve(deps.seatRoot, target), deps.seatRoot, deps.workspaceRoot);
      const toolName = String(input.tool_name ?? "Write");

      // Reads live state on every call — the hook closes over the SERVICE, not
      // a snapshot, so an acceptance mid-turn takes effect immediately.
      const blocking = deps.contracts.blockingFor(deps.agentSessionId, deps.seat, absolute, deps.workspaceRoot);
      if (blocking) {
        const pending = deps.contracts.pendingParties(blocking.id);
        return deny(toolName, "contract_unaccepted",
          `Contract "${blocking.name}" revision ${blocking.revision} governs ${target}, and you have not accepted it. ` +
          `Read it with read_contract("${blocking.id}"), then accept_contract({contractId:"${blocking.id}", revision:${blocking.revision}}) — ` +
          `or propose_contract_amendment if it is wrong. Still pending: ${pending.join(", ") || "nobody"}.`);
      }

      if (deps.enforceOwnership && deps.ownership.length > 0 && !ownsPath(deps.ownership, absolute, deps.workspaceRoot)) {
        return deny(toolName, "outside_ownership",
          `${target} is outside your declared ownership (${deps.ownership.join(", ")}). ` +
          `Another seat owns it, or nobody does. If you need it changed, say so in a handoff to your coordinator ` +
          `rather than writing a private copy — duplicating a teammate's work is the most expensive thing a seat can do.`);
      }
      return {};
    } catch {
      // Fail-open, per worktree-hook.ts and tasks/hooks.ts.
      return {};
    }
  };

  return { PreToolUse: [{ matcher: WRITE_TOOLS, hooks: [onWrite] }] };
}
