/**
 * The single composition root, shared by production (`main.ts`) and the test
 * harness (`test-helpers.ts`). Every service is built here, every dependency
 * is required, and every cross-service callback is registered exactly once
 * (their setters throw on a second registration).
 *
 * Boot side effects live in `boot.ts`; the HTTP server and process signals in
 * `main.ts`. This module only builds and connects the object graph.
 */
import Database from "better-sqlite3";
import { AgentSessionService } from "./agent-sessions/service.ts";
import { AgentProfileRegistry } from "./agent-profiles/registry.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import { Repo } from "./db/repo.ts";
import { createStores } from "./db/stores/index.ts";
import { NotFoundError } from "./errors.ts";
import type { ArtifactStore } from "./events/artifact-store.ts";
import { EventBus } from "./events/bus.ts";
import { late } from "./late.ts";
import { computeCoverageReport } from "./completion/coverage.ts";
import { RunCompletionService } from "./completion/service.ts";
import { ContinuationCheckpointService } from "./continuation/service.ts";
import { DecisionIssueService } from "./orchestrator/decision-issues.ts";
import { DecisionLedger } from "./orchestrator/decisions.ts";
import { InteractionService } from "./orchestrator/interactions.ts";
import { OrchestratorRunner } from "./orchestrator/runner.ts";
import { buildConsoleMcpServer } from "./orchestrator/tools.ts";
import { AssumptionService } from "./orchestrator/assumptions.ts";
import { ChangeImpactService } from "./orchestrator/change-impact.ts";
import { RequirementService } from "./orchestrator/requirements.ts";
import { OrchestrationStateService } from "./orchestrator/state.ts";
import { ProjectObjectiveService } from "./orchestrator/objective.ts";
import { WorkstreamService } from "./portfolio/workstreams.ts";
import type { ConsoleSdk } from "./sdk/types.ts";
import type { SqliteSessionStore } from "./sdk/session-store.ts";
import { WorktreeManager } from "./runtime/worktree-manager.ts";
import { UserSessionService } from "./sessions/service.ts";
import { AssignmentScheduler } from "./tasks/scheduler.ts";
import { TaskService } from "./tasks/service.ts";
import { TimelineService } from "./timeline/service.ts";
import { CapacityService } from "./capacity/service.ts";
import { SystemPauseService } from "./system/pause.ts";
import { CapabilityCatalog } from "./agent-profiles/capability-catalog.ts";
import path from "node:path";
import { HandoffService } from "./handoffs/service.ts";
import { LandingLedger } from "./workspaces/landings.ts";
import { WorkspaceService } from "./workspaces/service.ts";

export interface CreateAppOptions {
  config: Config;
  db: Db;
  sqlite: Database.Database;
  sdk: () => Promise<ConsoleSdk>;
  /**
   * OS-resource managers. Omitted members are constructed for real; `null`
   * states — at the construction site, visibly — that a capability is absent
   * (tests that never touch git say so here instead of relying on a forgotten
   * optional).
   */
  runtime?: {
    worktrees?: WorktreeManager | null;
  };
}

export interface App {
  config: Config;
  db: Db;
  sqlite: Database.Database;
  bus: EventBus;
  artifacts: ArtifactStore;
  repo: Repo;
  sdk: () => Promise<ConsoleSdk>;
  getWorkspaceRoot: (workspaceId: string) => string;
  workspaces: WorkspaceService;
  timeline: TimelineService;
  profiles: AgentProfileRegistry;
  worktrees: WorktreeManager | null;
  decisions: DecisionLedger;
  decisionIssues: DecisionIssueService;
  interactions: InteractionService;
  tasks: TaskService;
  scheduler: AssignmentScheduler;
  handoffs: HandoffService;
  sessionStore: SqliteSessionStore;
  host: AgentSessionService;
  runner: OrchestratorRunner;
  requirements: RequirementService;
  objective: ProjectObjectiveService;
  assumptions: AssumptionService;
  changeImpacts: ChangeImpactService;
  workstreams: WorkstreamService;
  orchestrationState: OrchestrationStateService;
  continuation: ContinuationCheckpointService;
  completion: RunCompletionService;
  /** Canonical-landing truth: records merges by immutable commit id, verifies reachability at boundaries. */
  landings: LandingLedger;
  userSessions: UserSessionService;
  capacity: CapacityService;
  /** The operator's whole-system Pause/Resume over `capacity`. */
  system: SystemPauseService;
}

export function createApp(options: CreateAppOptions): App {
  const { config, db, sqlite, sdk } = options;
  // One store per table (see db/stores/index.ts for the ownership rule);
  // services get their store, and the Repo façade composes the same instances.
  const stores = createStores(db, sqlite);
  const artifacts = stores.artifacts;
  const bus = new EventBus(db, artifacts);
  const repo = new Repo(db, sqlite, stores);
  const workspaces = new WorkspaceService(stores.workspaces, bus, config.infra.fsRoots.map((root) => root.path));
  const getWorkspaceRoot = (workspaceId: string): string => workspaces.get(workspaceId).rootPath;
  const timeline = new TimelineService(repo, bus);
  const profiles = new AgentProfileRegistry({ getWorkspaceRoot, db, bus });
  const worktrees = options.runtime?.worktrees === undefined ? new WorktreeManager({ dataDir: config.infra.dataDir }) : options.runtime.worktrees;

  // The session→project resolution every project-scoped aggregate shares:
  // requirement graph, decision ledger. One closure, wired once.
  const resolveProject = (userSessionId: string): string => {
    const row = repo.getUserSession(userSessionId);
    if (!row) throw new NotFoundError(`no user session ${userSessionId}`);
    return row.projectId;
  };
  // The decision-issue registry: the project-level unresolved human choices
  // that asks (interaction rows) attach to. The ledger reads the issue store
  // too, for SUPERSEDING resolutions that have no interaction row.
  const decisionIssues = new DecisionIssueService(stores.decisionIssues, stores.interactions, bus, resolveProject);
  decisionIssues.setDeps({
    isAgentSessionOpen: (agentSessionId) => repo.getAgentSession(agentSessionId)?.lifecycle === "open",
  });
  const decisions = new DecisionLedger(stores.interactions, resolveProject, stores.decisionIssues);
  const interactions = new InteractionService(stores.interactions, bus, decisionIssues);
  const tasks = new TaskService(stores.tasks, stores.assignments, bus, (workspaceId) => void workspaces.get(workspaceId));
  const handoffs = new HandoffService({ repo, bus, getWorkspaceRoot });
  const requirements = new RequirementService(stores.requirements, stores.projects, stores.assumptions, bus, resolveProject);
  const objective = new ProjectObjectiveService(stores.projects, resolveProject);
  const assumptions = new AssumptionService(stores.assumptions, requirements, bus, resolveProject);
  // The project-portfolio workstream layer: durable cross-session dependency
  // links with console-derived status; ownership claims live on seat rows and
  // are checked by portfolio/ownership.ts inside the lifecycle paths.
  const workstreams = new WorkstreamService(stores.workstreams, bus, resolveProject);
  // The change-impact ledger: the graph computes each change's transitive
  // closure; this persists it durably and derives reconciliation state.
  const changeImpacts = new ChangeImpactService(stores.changeImpacts, bus, resolveProject);
  changeImpacts.setDeps({
    openAgentSessionIds: (userSessionId) =>
      new Set(repo.listAgentSessions(userSessionId).filter((row) => row.lifecycle === "open").map((row) => row.id)),
    sessionTitle: (agentSessionId) => repo.getAgentSession(agentSessionId)?.title ?? null,
    listTasks: (userSessionId) => tasks.listForUserSession(userSessionId),
    latestChanges: (userSessionId) => stores.requirements.latestChanges(resolveProject(userSessionId)),
    liveWorkstreamEdges: (userSessionId) => workstreams.liveEdges(userSessionId),
  });
  requirements.setImpactRecorder((input) => changeImpacts.record(input));
  // One requirements proposal at a time: with sequential continuation this is
  // what makes a stale base revision impossible rather than merely detected.
  requirements.setPendingProposalCheck((userSessionId) =>
    interactions.listPending(userSessionId).some((row) =>
      row.kind === "plan_approval" && typeof row.payload === "object" && row.payload !== null && "requirements" in row.payload));
  // The frontier annotates open requirements from other aggregates' facts —
  // narrow read closures, wired once here like every other crossing.
  requirements.setFrontierDeps({
    openAgentSessionIds: (userSessionId) =>
      new Set(repo.listAgentSessions(userSessionId).filter((row) => row.lifecycle === "open").map((row) => row.id)),
    blockedRequirementIds: (userSessionId) => {
      const blocked = new Set<string>();
      for (const task of tasks.listForUserSession(userSessionId)) {
        if (task.requirementId === null || task.status === "completed" || task.status === "deleted") continue;
        if ((task.status === "pending" && !task.ready) || task.scheduledAssignment !== null) blocked.add(task.requirementId);
      }
      return blocked;
    },
    awaitingOperatorAgentSessionIds: (userSessionId) =>
      new Set(interactions.listPending(userSessionId)
        .map((row) => row.agentSessionId)
        .filter((id): id is string => id !== null)),
  });
  const orchestrationState = new OrchestrationStateService(stores.orchestrationState, bus, objective);
  orchestrationState.setDeps({
    resolveProject,
    listUserSessionIdsForProject: (projectId) => repo.listUserSessionsForProject(projectId).map((row) => row.id),
    materialHeadSeq: (userSessionIds) => bus.objectiveMaterialHeadSeq(userSessionIds),
    openDecisionIssueIds: (userSessionId) => decisionIssues.listOpenForProject(userSessionId).map((issue) => issue.id),
  });
  // Continuation checkpoints: the run-boundary handoff a later session on the
  // same project inherits. Constructed here (the runner injects its digest);
  // deps wire below once host and completion exist.
  const continuation = new ContinuationCheckpointService(stores.continuation, bus);
  const sessionStore = stores.providerEntries;

  // The landing ledger: the durable line between "committed in a worktree"
  // and "canonically landed". The worktree binding records each merge through
  // it; verification re-runs at every subsequent landing and every coverage
  // evaluation, so a reset that drops landed commits becomes a visible,
  // salvageable invalidation instead of a stale "landed" claim.
  const landings = new LandingLedger({
    store: stores.landings, bus, worktrees, getWorkspaceRoot,
    getUserSession: (userSessionId) => repo.getUserSession(userSessionId),
  });
  const capacity = new CapacityService({ repo, bus });
  const catalog = new CapabilityCatalog(path.join(config.infra.skillsPluginDir, "skills"));
  // A typo'd requires.tools would silently block a skill's assignment forever.
  for (const issue of catalog.issues) console.warn(`capability catalog: ${issue}`);
  const lateRunner = late<OrchestratorRunner>("runner");
  const lateScheduler = late<AssignmentScheduler>("scheduler");
  const host = new AgentSessionService({
    repo, bus, artifacts, config, profiles, sdk, sessionStore, getWorkspaceRoot, requirements, objective, assumptions,
    worktrees, landings, capacity,
    interactions, decisions, decisionIssues, tasks, handoffs,
    workstreams: {
      promptLines: (agentSessionId) => workstreams.promptLines(agentSessionId),
      finalCaveats: (agentSessionId) => workstreams.finalCaveats(agentSessionId),
      noteSessionArchived: (session) => workstreams.noteSessionArchived(session),
    },
    changeImpacts: {
      listOpen: (userSessionId) => changeImpacts.listOpen(userSessionId),
    },
    scheduler: () => lateScheduler.get(),
    wake: (userSessionId, agentSessionId, category, text) =>
      lateRunner.get().enqueueAgentMilestone(userSessionId, agentSessionId, category, text),
  });
  // The link layer reads session facts through the host's ONE predicates.
  workstreams.setDeps({
    getAgentSession: (agentSessionId) => repo.getAgentSession(agentSessionId),
    reportedFinal: (session) => host.reportedFinal(session),
    userSessionOpen: (userSessionId) => repo.getUserSession(userSessionId)?.lifecycle === "open",
  });
  // The completion coverage evaluator: ONE closure, consumed by the
  // completion service (proposal snapshot + accept-time guard) and by main's
  // record_completion tool result (so main sees the outstanding exceptions
  // structurally instead of reconstructing them from memory).
  const coverage = (userSessionId: string) => {
    // Landing reachability is re-verified against git BEFORE the rows-only
    // computation, so a coverage read always reflects the workspace as it is
    // now — the accept-time guard recomputes through this same closure.
    try { landings.verify(userSessionId); } catch { /* a git hiccup must not block coverage */ }
    return computeCoverageReport({
      governingRevision: (id) => requirements.latestApproved(id)?.revision ?? null,
      obligations: (id) => requirements.completionObligations(id),
      liveRequirementIds: (id) => new Set(requirements.derive(id).map((node) => node.id)),
      listTasks: (id) => tasks.listForUserSession(id),
      listOpenDecisionIssues: (id) => decisionIssues.listOpenForProject(id),
      listOpenChangeImpacts: (id) => changeImpacts.listOpen(id),
      brokenWorkstreamLinks: (id) => workstreams.brokenOpen(id),
      invalidatedLandings: (id) => landings.invalidated(id),
      isAgentSessionOpen: (agentSessionId) => repo.getAgentSession(agentSessionId)?.lifecycle === "open",
      policy: config.policy.completionPolicy,
    }, userSessionId);
  };
  const objectiveFacts = (userSessionId: string): import("@agentique-console/shared").ObjectiveProgressFacts => {
    const nodes = requirements.derive(userSessionId);
    const taskRows = tasks.listForUserSession(userSessionId).filter((task) => task.status !== "deleted");
    const issues = decisionIssues.listOpenForProject(userSessionId);
    const impacts = changeImpacts.listOpen(userSessionId);
    const sessions = repo.listAgentSessions(userSessionId);
    const invalidated = landings.invalidated(userSessionId);
    const report = coverage(userSessionId);
    return {
      requirements: {
        revision: requirements.governingRevision(userSessionId),
        open: requirements.frontier(userSessionId).length,
        unsatisfied: nodes.filter((node) => node.derivedStatus !== "satisfied" && node.derivedStatus !== "retired").length,
        verificationGaps: requirements.verificationGaps(userSessionId).length,
      },
      tasks: {
        pending: taskRows.filter((task) => task.status === "pending").length,
        inProgress: taskRows.filter((task) => task.status === "in_progress").length,
        blocked: taskRows.filter((task) => task.status === "pending" && !task.ready).length,
      },
      decisionIssues: { open: issues.length, ids: issues.map((issue) => issue.id) },
      changeImpacts: { open: impacts.length, ids: impacts.map((impact) => impact.id) },
      workstreams: {
        active: sessions.filter((session) => session.lifecycle === "open").length,
        archived: sessions.filter((session) => session.lifecycle === "archived").length,
        brokenDependencies: workstreams.brokenOpen(userSessionId).length,
      },
      landings: { invalidated: invalidated.length, ids: invalidated.map((landing) => landing.id) },
      completionExceptions: { count: report?.exceptions.length ?? 0, refs: (report?.exceptions ?? []).map((entry) => entry.ref) },
    };
  };
  const scheduler = new AssignmentScheduler({
    store: stores.assignments, tasks, sessions: stores.sessions, messages: stores.messages, bus,
    post: (input) => host.post(input),
    paused: () => capacity.paused,
  });
  lateScheduler.set(scheduler);
  const runner = new OrchestratorRunner({
    repo, bus, config, sdk, interactions, decisions, handoffs, sessionStore, getWorkspaceRoot,
    requirements, objective, orchestrationState, continuation,
    host: () => host,
    tasks, capacity,
    buildMcpServer: (userSessionId, sdkInstance) =>
      buildConsoleMcpServer({ sdk: sdkInstance, host, repo, bus, userSessionId, tasks, scheduler, handoffs, artifacts, interactions, decisionIssues, requirements, assumptions, changeImpacts, workstreams, state: orchestrationState, continuation, catalog, registry: profiles, coverage, objectiveFacts }),
  });
  lateRunner.set(runner);
  workstreams.setWakeNote((userSessionId, text) => lateRunner.get().postConsoleNote(userSessionId, text));
  // Console-established facts (a falsified assumption, a dependency that
  // moved under satisfied work) wake main with a note — record-and-display,
  // never a status rewrite.
  requirements.setWakeNote((userSessionId, text) => lateRunner.get().postConsoleNote(userSessionId, text));
  assumptions.setWakeNote((userSessionId, text) => lateRunner.get().postConsoleNote(userSessionId, text));
  landings.setWakeNote((userSessionId, text) => lateRunner.get().postConsoleNote(userSessionId, text));
  const completion = new RunCompletionService({
    db, repo, bus, interactions, scheduler, getWorkspaceRoot, orchestrationState, requirements, changeImpacts, workstreams, coverage,
    host: () => host,
    runner: () => runner,
    quietWindowMs: config.policy.completionQuietWindowMs,
    paused: () => capacity.paused,
  });
  // The checkpoint builder reads other aggregates' durable facts — narrow
  // closures, wired once here like every other crossing. Wired AFTER host and
  // completion exist; the service itself was constructed before the runner.
  continuation.setDeps({
    getUserSession: (userSessionId) => repo.getUserSession(userSessionId),
    listUserSessionsForProject: (projectId) => repo.listUserSessionsForProject(projectId),
    listAgentSessions: (userSessionId) => repo.listAgentSessions(userSessionId),
    listAgents: (agentSessionId) => repo.listAgents(agentSessionId),
    reportedFinal: (session) => host.reportedFinal(session),
    listTasks: (userSessionId) => tasks.listForUserSession(userSessionId),
    governingRevision: (userSessionId) => requirements.latestApproved(userSessionId)?.revision ?? 0,
    decisionCount: (userSessionId) => decisions.list(userSessionId).length,
    listOpenChangeImpacts: (userSessionId) => changeImpacts.listOpen(userSessionId),
    listOpenDecisionIssues: (userSessionId) => decisionIssues.listOpenForProject(userSessionId),
    listWorkstreamLinks: (userSessionId) => workstreams.list(userSessionId),
    latestState: (userSessionId) => orchestrationState.current(userSessionId),
    latestObjectiveAssessment: (userSessionId) => orchestrationState.latestObjectiveAssessment(userSessionId),
    latestCompletion: (userSessionId) => orchestrationState.latestCompletion(userSessionId),
    latestSummaryFacts: (userSessionId) => completion.latestSummaryFacts(userSessionId),
  });
  const system = new SystemPauseService({ capacity, runner, host });
  const userSessions = new UserSessionService({
    repo, projects: stores.projects, bus, runner, interactions, decisionIssues, workspaces,
    archiveAgentSessions: (userSessionId) => host.archiveForUserSession(userSessionId),
    completion,
    continuation,
    wireAgentSessions: (userSessionId) => host.wireSessionsForUserSession(userSessionId),
    pauseSnapshot: () => capacity.snapshot(),
    openRequirementCount: (userSessionId) => requirements.frontier(userSessionId).length,
  });

  // Every cross-service callback, registered once. The completion predicate
  // re-evaluates on every settle, status change and answered card; a withheld
  // final must not become a silence. The task hook is the scheduler's release
  // path: every ledger transition flows through it, and dispatch rides it.
  tasks.onChange(scheduler.onTaskChanged);
  // Capacity resume re-kicks both lane engines: queued orchestrator jobs
  // drain and queued seat deliveries redeliver — nothing was cancelled.
  // Capacity resume re-kicks every engine the pause held: queued orchestrator
  // jobs drain, queued seat deliveries redeliver, ready scheduled assignments
  // dispatch, and every open run's completion predicate is re-armed —
  // nothing was cancelled.
  capacity.onResume(() => {
    runner.resumeQueued();
    host.resumeQueuedDeliveries();
    scheduler.redriveReady();
    for (const session of repo.listOpenWorkSessions()) completion.schedule(session.id);
  });
  runner.onSettled((userSessionId) => completion.schedule(userSessionId));
  runner.onOperatorMessage((userSessionId) => completion.noteOperatorMessage(userSessionId));
  host.onStatusChanged((userSessionId) => completion.schedule(userSessionId));
  interactions.onResolved((userSessionId) => completion.schedule(userSessionId));
  interactions.onBlockingCleared((userSessionId, agentSessionId) =>
    host.onBlockingQuestionsCleared(userSessionId, agentSessionId));
  interactions.onStaleAnswerRouting({
    deliverToAgent: (interaction) => host.deliverOperatorAnswer(interaction),
    reviveMain: (userSessionId, prompt) => runner.enqueueRevival(userSessionId, prompt),
    beginExecuting: (userSessionId) => userSessions.beginExecuting(userSessionId),
    deliverIssueUpdate: (interaction, text, dedupeKey) => host.deliverIssueUpdate(interaction, text, dedupeKey),
  });

  return {
    config, db, sqlite, bus, artifacts, repo, sdk, getWorkspaceRoot, requirements, objective, assumptions, changeImpacts, workstreams, orchestrationState, continuation, landings,
    workspaces, timeline, profiles, worktrees, capacity,
    decisions, decisionIssues, interactions, tasks, scheduler, handoffs, sessionStore,
    host, runner, completion, userSessions, system,
  };
}
