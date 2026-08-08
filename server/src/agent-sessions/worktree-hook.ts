/**
 * Native worktree governance: the WorktreeCreate hook makes the console's
 * WorktreeManager the implementation of EnterWorktree — the CLI asks, the
 * console creates (its naming, its branch scheme, its data-dir bookkeeping)
 * and returns the path in hookSpecificOutput. WorktreeRemove is observed.
 *
 * Deliberately does NOT bind the created worktree as the seat's
 * merge-on-complete worktree: console-initiated isolation (spawn-time
 * #ensureSeatWorktree, best-of-N) keeps that contract; a native EnterWorktree
 * is agent-chosen scratch isolation on console-owned ground. Fail-open: if
 * creation fails the hook stays silent and the CLI creates its own.
 */
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import type { SdkHookInput, SdkHookOutput, SdkHooksFragment } from "../sdk/types.ts";

function pathSafe(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return safe === "" ? "wt" : safe.slice(0, 48);
}

export function buildWorktreeHooks(deps: {
  repo: Repo;
  bus: EventBus;
  worktrees: WorktreeManager;
  workspaceRoot: string;
  userSessionId: string;
  agentSessionId: string;
  seat: string;
}): SdkHooksFragment {
  const onCreate = async (input: SdkHookInput): Promise<SdkHookOutput> => {
    try {
      const requested = typeof (input as { name?: unknown }).name === "string" ? (input as { name: string }).name : "scratch";
      const suffix = newId("turn").slice(-6);
      const dirName = `native-${pathSafe(deps.seat)}-${pathSafe(requested)}-${suffix}`;
      const ref = deps.worktrees.addWorktree(deps.workspaceRoot, deps.agentSessionId, dirName,
        `seat/${deps.agentSessionId}/native-${pathSafe(deps.seat)}-${suffix}`);
      deps.bus.append({ type: "agent_session.worktree.created", userSessionId: deps.userSessionId, agentSessionId: deps.agentSessionId,
        payload: { agentSessionId: deps.agentSessionId, seat: deps.seat, branch: ref.branch, baseCommit: ref.baseCommit } });
      return { hookSpecificOutput: { hookEventName: "WorktreeCreate", worktreePath: ref.path } };
    } catch {
      return {}; // the CLI falls back to its own worktree
    }
  };
  const onRemove = async (input: SdkHookInput): Promise<SdkHookOutput> => {
    const path = typeof (input as { worktree_path?: unknown }).worktree_path === "string" ? (input as { worktree_path: string }).worktree_path : "?";
    deps.bus.append({ type: "agent_session.runtime", userSessionId: deps.userSessionId, agentSessionId: deps.agentSessionId,
      payload: { agentSessionId: deps.agentSessionId, participant: deps.seat, detail: `native worktree removed: ${path}` } });
    return {};
  };
  return { WorktreeCreate: [{ hooks: [onCreate] }], WorktreeRemove: [{ hooks: [onRemove] }] };
}
