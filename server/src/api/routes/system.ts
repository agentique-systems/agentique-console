import { API_BODY_MAX_BYTES, ARTIFACT_CONTENT_MAX_BYTES, fsDirsQuerySchema, OPERATOR_MESSAGE_MAX_BYTES, PAGE_LIMIT_MAX, WORKSPACE_KINDS, type CapacityResponse, type ConfigResponse, type FsDirsResponse, type FsRootsResponse, type HealthResponse } from "@agentique-console/core";
import { defaultFinalReserve } from "../../operator/run-launch.ts";
import { capabilitiesOf } from "../../operator/workspaces.ts";
import { browseDirectories, rootsView } from "../../workspaces/fs-browse.ts";
import { parse, type RouteHandlers } from "./support.ts";

export const systemRoutes: Pick<RouteHandlers, "health" | "config" | "capacity" | "fsRoots" | "fsDirs"> = {
  health: (_request, ctx): HealthResponse => {
    const { app } = ctx;
    const report = app.boot;
    return {
      ok: app.admission.ready,
      admission: app.admission.state,
      database: { disposition: app.runtime.database.disposition, schemaVersion: app.runtime.database.schemaInfo.version },
      recovery:
        report === null
          ? null
          : {
              interruptedAttempts: report.recovery.interruptedAttemptIds.length,
              cancelledAttempts: report.recovery.cancelledAttemptIds.length,
              releasedLeases: report.recovery.releasedLeaseIds.length,
              failedInvocations: report.recovery.failedInvocationIds.length,
              retryEligible: report.recovery.retryEligible.length,
              workspaceReleased: report.recovery.workspaceReleasedInvocationIds.length,
              workspaceReleaseFailed: report.recovery.workspaceReleaseFailedInvocationIds.length,
              blobsComplete: report.recovery.blobs.complete,
              blobFailures: report.recovery.blobs.failureCount,
              outstandingPublications: report.reconstructed.publications,
            },
      startedAt: app.startedAt,
    };
  },
  config: (_request, ctx): ConfigResponse => {
    const { config, runtime } = ctx.app;
    return {
      defaults: {
        model: config.provider.model,
        effort: config.provider.effort,
        runKind: config.defaults.runKind,
        budget: config.defaults.budget,
        finalReserve: defaultFinalReserve(runtime, config.defaults.evaluator),
        orchestratorAllocation: config.defaults.orchestratorAllocation,
        nodeAllocation: config.defaults.nodeAllocation,
        completionCheck: config.defaults.completionCheck,
        evaluator: config.defaults.evaluator,
      },
      limits: { operatorMessageMaxBytes: OPERATOR_MESSAGE_MAX_BYTES, bodyMaxBytes: API_BODY_MAX_BYTES, pageLimitMax: PAGE_LIMIT_MAX, artifactContentMaxBytes: ARTIFACT_CONTENT_MAX_BYTES },
      provider: { name: runtime.provider.provider, continuation: runtime.provider.supportsContinuation },
      workspaceKinds: WORKSPACE_KINDS.map((kind) => capabilitiesOf(kind)),
    };
  },
  capacity: (_request, ctx): CapacityResponse => {
    const status = ctx.app.runtime.governor.status();
    return {
      providers: status.providers,
      process: status.process,
      worktrees: status.worktrees,
      activeLeases: status.activeLeases.map((lease) => ({ leaseId: lease.id, runId: lease.runId, attemptId: lease.attemptId, grantedAt: lease.grantedAt })),
    };
  },
  fsRoots: (_request, ctx): Promise<FsRootsResponse> => rootsView(ctx.app.config.fsRoots),
  fsDirs: async (request, ctx): Promise<FsDirsResponse> => {
    const query = parse(fsDirsQuerySchema, request.query, "query");
    const listing = await browseDirectories(
      ctx.app.config.fsRoots.map((root) => root.path),
      query.path,
      query.showHidden === "1",
    );
    return { path: listing.path, parent: listing.parent, entries: [...listing.entries] };
  },
};
