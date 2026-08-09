/**
 * Best-of-N attempt groups: fan-out, capture, reviewer seating, selection and
 * teardown. Free functions over a narrow context — seat spawning, journalling
 * and profile resolution stay host-private and arrive as bound callbacks.
 */
import type { HandoffDraft, Speaker } from "@agentique-console/shared";
import { badRequest, conflict, notFound } from "../api/errors.ts";
import type { AgentProfile } from "../agent-profiles/registry.ts";
import type { AgentSessionRow, AttemptGroupRow, MessageRow, ParticipantRow, Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import type { WorktreeManager } from "../runtime/worktree-manager.ts";
import { newId, nowIso } from "../ids.ts";
import { MAIN_RECIPIENT, ORCHESTRATOR_SEAT } from "./peer-names.ts";
import type { Category } from "./governance.ts";

export const SEAT_NAME_RE = /^[A-Za-z0-9_.:-]+$/;
export const RESERVED_NAMES = new Set([ORCHESTRATOR_SEAT, "operator", "system", MAIN_RECIPIENT, "coordinator"]);

/** The slice of the host's deps the attempt machinery reads. */
export interface AttemptsDeps {
  repo: Repo;
  bus: EventBus;
  getWorkspaceRoot?: (workspaceId: string) => string;
  worktrees?: WorktreeManager;
}

export interface AttemptsContext {
  deps: AttemptsDeps;
  // Host-private operations, bound as closures so nothing becomes public.
  post(input: { agentSessionId: string; speaker: Speaker; to: string; handoff: HandoffDraft; category?: Category; dedupeKey?: string; turnId?: string }): MessageRow & { queuedBehind?: string[] };
  simpleHandoff(action: string, status: HandoffDraft["core"]["status"], summary: string, nextAction: string | null): HandoffDraft;
  profile(id: string, workspaceId?: string): AgentProfile;
  snapshotProfile(profile: AgentProfile): AgentProfile;
  participant(agentSessionId: string, name: string, role: "orchestrator" | "agent", profile: AgentProfile, extra: string, model: string | undefined, ownership: string[], ord: number, createdAt: string): ParticipantRow;
}

export interface StartAttemptsInput {
  agentSessionId: string; assignment: HandoffDraft; profileId?: string; attempts?: number;
  baseSeatName?: string; owns: string[]; instructions?: string; model?: string; turnId?: string;
}
export interface StartAttemptsResult {
  groupId: string; seats: string[]; branches: string[]; baseCommit: string; dirtyWorkspace: boolean;
}

export interface SelectAttemptWinnerInput {
  agentSessionId: string; groupId: string; reviewer: string; winner?: string; rejectAll?: boolean; reason: string;
}
export type SelectAttemptWinnerResult =
  { merged: true; commit: string; winner: string } | { merged: false; conflicts: string[]; detail: string; winner: string } | { rejected: true };

/**
 * Best-of-N fan-out: seats N attempt copies of one profile, each in an
 * isolated worktree, and posts them the same assignment. Seat identity,
 * worktree binding, and group metadata are server-authored; attempts share
 * scope intentionally — the isolation is the worktree, not the scope.
 */
export function startAttempts(ctx: AttemptsContext, input: StartAttemptsInput): StartAttemptsResult {
  const { repo, bus } = ctx.deps;
  const worktrees = ctx.deps.worktrees;
  if (!worktrees) throw new Error("worktree manager unavailable");
  const session = repo.getAgentSession(input.agentSessionId);
  if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
  if (session.status !== "open") throw conflict(`agent session ${input.agentSessionId} is archived`);
  const user = repo.getUserSession(session.userSessionId);
  if (!user || !ctx.deps.getWorkspaceRoot) throw new Error("workspace unavailable");
  const workspaceRoot = ctx.deps.getWorkspaceRoot(user.workspaceId);
  if (!worktrees.isGitRepo(workspaceRoot)) {
    throw badRequest(`best-of-N attempts require the workspace to be a git repository; ${workspaceRoot} is not one (git init it or run the work as a single assignment)`);
  }
  if (repo.findOpenAttemptGroup(session.id)) throw conflict("an attempt group is already active for this session; wait for it to finish");
  const attempts = Math.max(2, Math.min(3, input.attempts ?? 2));
  const base = (input.baseSeatName ?? input.profileId ?? "implementer").trim();
  if (!SEAT_NAME_RE.test(base) || RESERVED_NAMES.has(base.toLowerCase())) throw badRequest(`invalid or reserved attempt base name "${base}"`);
  const existing = new Set(repo.listParticipants(session.id).map((p) => p.name));
  const seatNames = Array.from({ length: attempts }, (_, i) => `${base}.${i + 1}`);
  for (const name of [...seatNames, `${base}.review`]) if (existing.has(name)) throw conflict(`seat name "${name}" is already taken`);
  const profile = ctx.snapshotProfile(ctx.profile(input.profileId ?? "implementer", user.workspaceId));
  const groupId = newId("bon");
  const dirtyWorkspace = worktrees.isDirty(workspaceRoot);
  const now = nowIso();
  const attemptsState: NonNullable<AttemptGroupRow["attemptsState"]> = {};
  const branches: string[] = [];
  let baseCommit = "";
  const attemptInstructions = `${input.instructions ?? ""}\n\nYou are attempt seat of a best-of-N group: work independently in your own isolated worktree (your cwd). Never run git commit — the Console captures your changes when you report. Install dependencies only if you must run validation.`.trim();
  for (let i = 0; i < attempts; i += 1) {
    const ref = worktrees.addWorktree(workspaceRoot, session.id, `${groupId}-${i + 1}`, `attempt/${session.id}/${groupId}/${i + 1}`);
    baseCommit = ref.baseCommit;
    branches.push(ref.branch);
    const row = ctx.participant(session.id, seatNames[i]!, "agent", profile, attemptInstructions, input.model, input.owns, existing.size + i, now);
    repo.insertParticipant({ ...row, worktreePath: ref.path, worktreeBaseCommit: ref.baseCommit, worktreeBranch: ref.branch, attemptGroupId: groupId, attemptRole: "attempt" });
    attemptsState[seatNames[i]!] = { branch: ref.branch, worktreePath: ref.path, commit: null, artifactId: null, status: "running" };
  }
  repo.insertAttemptGroup({ id: groupId, agentSessionId: session.id, userSessionId: session.userSessionId,
    profileId: profile.id, baseSeat: base, attempts, baseCommit, status: "running", reviewerSeat: null,
    winnerSeat: null, mergeCommit: null, dirtyWorkspace, attemptsState, createdAt: now, updatedAt: now });
  bus.append({ type: "agent_session.attempt_group.started", userSessionId: session.userSessionId, agentSessionId: session.id,
    payload: { agentSessionId: session.id, groupId, seats: seatNames, profileId: profile.id, attempts, baseCommit, dirtyWorkspace } });
  for (const name of seatNames) {
    ctx.post({ agentSessionId: session.id, speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT }, to: name,
      handoff: input.assignment, category: "assignment", dedupeKey: `bon:${groupId}:${name}`, ...(input.turnId ? { turnId: input.turnId } : {}) });
  }
  return { groupId, seats: seatNames, branches, baseCommit, dirtyWorkspace };
}

/**
 * The reviewer's single selection call. Merge runs synchronously so the
 * returned outcome is ground truth for the reviewer's closing handoff; a
 * conflict aborts cleanly (workspace untouched) and fails the group.
 */
export function selectAttemptWinner(ctx: AttemptsContext, input: SelectAttemptWinnerInput): SelectAttemptWinnerResult {
  const { repo, bus } = ctx.deps;
  const worktrees = ctx.deps.worktrees;
  if (!worktrees) throw new Error("worktree manager unavailable");
  const session = repo.getAgentSession(input.agentSessionId);
  if (!session) throw notFound(`no agent session ${input.agentSessionId}`);
  const group = repo.getAttemptGroup(input.groupId);
  if (!group || group.agentSessionId !== session.id) throw notFound(`no attempt group ${input.groupId}`);
  if (group.status !== "reviewing") throw conflict(`attempt group ${input.groupId} is ${group.status}; selection is closed`);
  if (group.reviewerSeat !== input.reviewer) throw badRequest(`only ${group.reviewerSeat} may select for group ${input.groupId}`);
  if ((input.winner === undefined) === (input.rejectAll !== true)) throw badRequest("pass exactly one of winner or rejectAll");
  const user = repo.getUserSession(session.userSessionId);
  if (!user || !ctx.deps.getWorkspaceRoot) throw new Error("workspace unavailable");
  const workspaceRoot = ctx.deps.getWorkspaceRoot(user.workspaceId);
  if (input.rejectAll === true) {
    bus.append({ type: "agent_session.attempt_group.selected", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, groupId: group.id, winner: null, rejectedAll: true, reason: input.reason } });
    closeAttemptGroup(ctx, session, group, "rejected");
    return { rejected: true };
  }
  const winner = input.winner!;
  const entry = group.attemptsState[winner];
  if (!entry || entry.status !== "completed") throw badRequest(`"${winner}" is not a completed attempt of group ${input.groupId}`);
  bus.append({ type: "agent_session.attempt_group.selected", userSessionId: session.userSessionId, agentSessionId: session.id,
    payload: { agentSessionId: session.id, groupId: group.id, winner, rejectedAll: false, reason: input.reason } });
  const outcome = worktrees.mergeBranch(workspaceRoot, entry.branch,
    `Merge best-of-N winner ${winner} (group ${group.id})\n\nAttempt-Group: ${group.id}\nAttempt-Seat: ${winner}`);
  if (outcome.merged) {
    repo.patchAttemptGroup(group.id, { winnerSeat: winner, mergeCommit: outcome.commit });
    bus.append({ type: "agent_session.attempt_group.merged", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, groupId: group.id, winner, mergeCommit: outcome.commit } });
    closeAttemptGroup(ctx, session, { ...group, winnerSeat: winner }, "merged");
    return { merged: true, commit: outcome.commit, winner };
  }
  bus.append({ type: "agent_session.attempt_group.merge_failed", userSessionId: session.userSessionId, agentSessionId: session.id,
    payload: { agentSessionId: session.id, groupId: group.id, winner, conflicts: outcome.conflicts, detail: outcome.detail } });
  closeAttemptGroup(ctx, session, group, "failed");
  return { merged: false, conflicts: outcome.conflicts, detail: outcome.detail, winner };
}

/**
 * An attempt seat reported terminal status: commit its worktree, capture the
 * diff as a durable artifact, and when the whole group is settled either
 * seat the reviewer or fail the group. Fail-open — a git error marks the
 * attempt failed but never blocks the mailbox append that already happened.
 */
export function onAttemptPost(ctx: AttemptsContext, session: AgentSessionRow, seat: ParticipantRow, status: "completed" | "failed"): void {
  const { repo, bus } = ctx.deps;
  const worktrees = ctx.deps.worktrees;
  const group = seat.attemptGroupId ? repo.getAttemptGroup(seat.attemptGroupId) : undefined;
  if (!group || group.status !== "running" || !worktrees || !seat.worktreePath || !ctx.deps.getWorkspaceRoot) return;
  const user = repo.getUserSession(session.userSessionId);
  if (!user) return;
  const workspaceRoot = ctx.deps.getWorkspaceRoot(user.workspaceId);
  const state = { ...group.attemptsState };
  const entry = state[seat.name];
  if (!entry || entry.status !== "running") return;
  let commit: string | null = null;
  let artifactId: string | null = null;
  let diffBytes = 0;
  let filesChanged = 0;
  let attemptStatus: "completed" | "failed" = status;
  try {
    commit = worktrees.commitAll(seat.worktreePath, `attempt ${seat.name}: ${group.profileId} work`, seat.ownership);
    const diff = worktrees.captureDiff(workspaceRoot, group.baseCommit, entry.branch);
    filesChanged = diff.filesChanged;
    const content = diff.patch.length > 4 * 1024 * 1024
      ? `${diff.stat}\n\n[patch truncated at 4MiB — full history retained on archived branch]\n${diff.patch.slice(0, 4 * 1024 * 1024)}`
      : `${diff.stat}\n\n${diff.patch}`;
    const stored = bus.storeArtifact(content, "text/x-patch", { userSessionId: session.userSessionId, agentSessionId: session.id });
    artifactId = stored.artifactId;
    diffBytes = stored.bytes;
  } catch (error) {
    attemptStatus = "failed";
    bus.append({ type: "agent_session.runtime", userSessionId: session.userSessionId, agentSessionId: session.id,
      payload: { agentSessionId: session.id, participant: seat.name, detail: `attempt capture failed: ${error instanceof Error ? error.message : String(error)}` } });
  }
  state[seat.name] = { ...entry, commit, artifactId, status: attemptStatus };
  repo.patchAttemptGroup(group.id, { attemptsState: state });
  bus.append({ type: "agent_session.attempt.completed", userSessionId: session.userSessionId, agentSessionId: session.id,
    payload: { agentSessionId: session.id, groupId: group.id, seat: seat.name, status: attemptStatus,
      branch: entry.branch, commit, artifactId, diffBytes, filesChanged } });
  const settled = Object.values(state);
  if (settled.some((attempt) => attempt.status === "running")) return;
  if (settled.every((attempt) => attempt.status === "failed")) {
    closeAttemptGroup(ctx, session, { ...group, attemptsState: state }, "failed");
    ctx.post({ agentSessionId: session.id, speaker: { kind: "agent", name: seat.name }, to: ORCHESTRATOR_SEAT,
      handoff: ctx.simpleHandoff(`All ${group.attempts} attempts failed`, "failed",
        `Every attempt in best-of-N group ${group.id} failed. Diffs (if any) are retained as artifacts.`,
        "Decide whether to retry with a fresh attempt group or rework the assignment."), category: "failure" });
    return;
  }
  seatReviewer(ctx, session, { ...group, attemptsState: state });
}

function seatReviewer(ctx: AttemptsContext, session: AgentSessionRow, group: AttemptGroupRow): void {
  const { repo, bus } = ctx.deps;
  const user = repo.getUserSession(session.userSessionId);
  if (!user) return;
  const reviewerName = `${group.baseSeat}.review`;
  const profile = ctx.snapshotProfile(ctx.profile("reviewer", user.workspaceId));
  const now = nowIso();
  const instructions = "You are selecting the winning attempt of a best-of-N group. Compare the attempts' diffs and reports with evidence, run read-only validation where useful, and you MUST call select_attempt_winner exactly once before your closing handoff. Reject all attempts only when none is sound.";
  const existing = repo.listParticipants(session.id);
  if (!existing.some((p) => p.name === reviewerName)) {
    const row = ctx.participant(session.id, reviewerName, "agent", profile, instructions, undefined, [], existing.length, now);
    repo.insertParticipant({ ...row, attemptGroupId: group.id, attemptRole: "reviewer" });
  }
  repo.patchAttemptGroup(group.id, { status: "reviewing", reviewerSeat: reviewerName });
  bus.append({ type: "agent_session.attempt_group.review_started", userSessionId: session.userSessionId, agentSessionId: session.id,
    payload: { agentSessionId: session.id, groupId: group.id, reviewer: reviewerName } });
  const completed = Object.entries(group.attemptsState).filter(([, attempt]) => attempt.status === "completed");
  const evidence = completed.map(([seatName, attempt]) => ({ kind: "artifact" as const, ref: attempt.artifactId ?? "", label: `diff ${seatName}` })).filter((ref) => ref.ref !== "");
  ctx.post({ agentSessionId: session.id, speaker: { kind: "orchestrator", name: ORCHESTRATOR_SEAT }, to: reviewerName,
    handoff: { core: { schemaVersion: 1, taskId: null, status: "pending", risk: "medium",
      action: `Select the winning attempt for best-of-N group ${group.id}`,
      state: { summary: `${completed.length} of ${group.attempts} attempts completed (base ${group.baseCommit.slice(0, 12)}; branches: ${completed.map(([, attempt]) => attempt.branch).join(", ")}). Compare their diffs with read_attempt_diff or git, then select.`, evidence },
      result: { summary: null, artifacts: [] }, uncertainty: [],
      nextAction: "Call select_attempt_winner with the winning seat, or rejectAll.", requestExpandedContext: false },
      extension: { kind: "coordination", data: { attempts: Object.fromEntries(completed.map(([seatName, attempt]) => [seatName, { branch: attempt.branch, commit: attempt.commit }])) } } },
    category: "assignment", dedupeKey: `bon:${group.id}:review` });
}

/** Terminal transition: clean up worktrees (diffs are already durable) and journal. */
export function closeAttemptGroup(ctx: AttemptsContext, session: AgentSessionRow, group: AttemptGroupRow, status: "merged" | "rejected" | "failed" | "abandoned"): void {
  const { repo, bus } = ctx.deps;
  const worktrees = ctx.deps.worktrees;
  const user = repo.getUserSession(session.userSessionId);
  const workspaceRoot = user && ctx.deps.getWorkspaceRoot ? ctx.deps.getWorkspaceRoot(user.workspaceId) : null;
  if (worktrees && workspaceRoot) {
    for (const [seatName, attempt] of Object.entries(group.attemptsState)) {
      const oversized = attempt.artifactId === null && attempt.status === "completed";
      try { worktrees.remove(workspaceRoot, attempt.worktreePath, attempt.branch, { archiveBranch: oversized }); } catch { /* best effort */ }
      repo.patchParticipant(session.id, seatName, { worktreePath: null });
    }
  }
  repo.patchAttemptGroup(group.id, { status });
  bus.append({ type: "agent_session.attempt_group.closed", userSessionId: session.userSessionId, agentSessionId: session.id,
    payload: { agentSessionId: session.id, groupId: group.id, status } });
}
