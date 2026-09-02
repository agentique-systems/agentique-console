import { ARTIFACT_CONTENT_MAX_BYTES, ARTIFACT_DOWNLOAD_MAX_BYTES, artifactContentQuerySchema, artifactPresentationOf, decisionResolveBodySchema, pageOf, type ArtifactResponse, type DecisionResolveResponse, type PublicationAdvanceResponse, type TaskView } from "@agentique-console/core";
import { attemptResponse, decisionView, invocationResponse, planNodeResponse, publicationView, taskLedger } from "../../operator/projections.ts";
import { ApiError } from "../errors.ts";
import { admit, id, notify, page, parse, type RouteHandlers, type RouteRequest } from "./support.ts";
import type { AppContext } from "../../context.ts";

/** A media type that a browser would execute is never served inline; text and JSON are served as text with an explicit charset. */
function inlineMediaType(mediaType: string): string {
  const presentation = artifactPresentationOf(mediaType);
  if (presentation === "json") return "application/json; charset=utf-8";
  if (presentation === "text") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function sendBytes(request: RouteRequest, ctx: AppContext, artifactId: string, mode: "content" | "download"): unknown {
  const { stores } = ctx.app.runtime;
  const artifact = stores.artifacts.get(id("artifact", artifactId));
  const query = parse(artifactContentQuerySchema, request.query, "query");
  if (mode === "download") {
    if (artifact.byteSize > ARTIFACT_DOWNLOAD_MAX_BYTES) throw new ApiError("payload_too_large", `Artifact ${artifact.id} exceeds the download bound`, { artifactId: artifact.id });
    const { bytes } = stores.artifacts.read(artifact.id);
    const name = `${artifact.id}${artifactPresentationOf(artifact.mediaType) === "json" ? ".json" : artifactPresentationOf(artifact.mediaType) === "text" ? ".txt" : ".bin"}`;
    void request.reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("x-content-type-options", "nosniff")
      .header("content-length", String(bytes.byteLength));
    return request.reply.send(Buffer.from(bytes));
  }
  if (artifactPresentationOf(artifact.mediaType) === "binary") throw new ApiError("unsupported", `Artifact ${artifact.id} (${artifact.mediaType}) is served through the download route only`, { artifactId: artifact.id });
  const offset = query.offset ?? 0;
  const maxBytes = query.maxBytes ?? ARTIFACT_CONTENT_MAX_BYTES;
  if (offset > artifact.byteSize) throw new ApiError("bad_request", "offset is beyond the end of the Artifact", { artifactId: artifact.id });
  const { bytes } = stores.artifacts.read(artifact.id);
  const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + maxBytes));
  void request.reply
    .header("content-type", inlineMediaType(artifact.mediaType))
    .header("x-content-type-options", "nosniff")
    .header("content-disposition", "inline")
    .header("x-artifact-byte-size", String(artifact.byteSize))
    .header("x-artifact-offset", String(offset))
    .header("x-artifact-truncated", String(offset + slice.byteLength < artifact.byteSize));
  return request.reply.send(Buffer.from(slice));
}

export const recordRoutes: Pick<
  RouteHandlers,
  | "getPlanNode"
  | "getInvocation"
  | "listInvocationAttempts"
  | "getAttempt"
  | "getAttemptTranscript"
  | "getTask"
  | "getHandoff"
  | "getDecision"
  | "resolveDecision"
  | "supersedeDecision"
  | "getEvaluation"
  | "getGate"
  | "getSnapshot"
  | "getChangeset"
  | "getArtifact"
  | "getArtifactContent"
  | "downloadArtifact"
  | "getPublication"
  | "advancePublication"
> = {
  getPlanNode: (request, ctx) => planNodeResponse(ctx.app.runtime, ctx.app.runtime.stores.plans.getNode(id("planNode", request.params.planNodeId))),
  getInvocation: (request, ctx) => invocationResponse(ctx.app.runtime, id("invocation", request.params.invocationId)),
  listInvocationAttempts: (request, ctx) => {
    const invocationId = id("invocation", request.params.invocationId);
    ctx.app.runtime.stores.invocations.get(invocationId);
    return pageOf(ctx.app.runtime.stores.invocations.listAttempts(invocationId), (a) => String(a.number).padStart(9, "0"), page(request.query));
  },
  getAttempt: (request, ctx) => attemptResponse(ctx.app.runtime, id("attempt", request.params.attemptId)),
  getAttemptTranscript: (request, ctx) => {
    // Diagnostic only: the transcript Artifact's bytes, bounded and paged; nothing in the runtime coordinates work from it.
    const attempt = ctx.app.runtime.stores.invocations.getAttempt(id("attempt", request.params.attemptId));
    if (attempt.transcriptArtifactId === null) throw new ApiError("not_found", `Attempt ${attempt.id} recorded no transcript`, { attemptId: attempt.id });
    return sendBytes(request, ctx, attempt.transcriptArtifactId, "content");
  },
  getTask: (request, ctx): TaskView => {
    const task = ctx.app.runtime.stores.tasks.get(id("task", request.params.taskId));
    const view = taskLedger(ctx.app.runtime, task.runId).tasks.find((t) => t.task.id === task.id);
    if (view === undefined) throw new ApiError("not_found", `Task ${task.id} not found`, { taskId: task.id });
    return view;
  },
  getHandoff: (request, ctx) => ctx.app.runtime.stores.handoffs.get(id("handoff", request.params.handoffId)),
  getDecision: (request, ctx) => decisionView(ctx.app.runtime.stores.decisions.get(id("decision", request.params.decisionId))),
  resolveDecision: (request, ctx): DecisionResolveResponse => {
    admit(ctx);
    const decisionId = id("decision", request.params.decisionId);
    const body = parse(decisionResolveBodySchema, request.body, "body");
    const { runtime } = ctx.app;
    const decision = runtime.stores.decisions.get(decisionId);
    // Kinds with a dedicated operator operation are never resolved here; the message names the operation.
    if (decision.kind === "budget_increase" || decision.kind === "signoff" || decision.kind === "publish") {
      throw new ApiError("refused", `a ${decision.kind} Decision is resolved through its own operation (${decision.kind === "budget_increase" ? "the Run's budget-increases" : decision.kind === "signoff" ? "the Run's signoff" : "the Run's publications"}), never generically`, { decisionId, kind: decision.kind, refusal: "dedicated_operation" });
    }
    if (decision.kind === "orchestrator_choice") throw new ApiError("refused", "an orchestrator_choice is the Orchestrator's own record; the operator does not resolve it", { decisionId, kind: decision.kind, refusal: "not_operator_resolvable" });
    const outcome = runtime.decisionRequests.resolve({ decisionId, optionId: body.optionId, rationale: body.rationale ?? null, artifactIds: body.artifactIds ?? [] });
    if (decision.runId !== null) notify(ctx, decision.runId);
    return outcome.kind === "resolved"
      ? { kind: "resolved", decisionId, chosenOptionId: outcome.chosenOptionId, resolvedBy: outcome.resolvedBy, supersedingDecisionId: null, replayed: outcome.replayed }
      : { kind: "superseded", decisionId, chosenOptionId: null, resolvedBy: null, supersedingDecisionId: null, replayed: outcome.replayed };
  },
  supersedeDecision: (request, ctx): DecisionResolveResponse => {
    admit(ctx);
    const decisionId = id("decision", request.params.decisionId);
    const body = parse(decisionResolveBodySchema, request.body, "body");
    const { runtime } = ctx.app;
    const decision = runtime.stores.decisions.get(decisionId);
    const outcome = runtime.decisionRequests.supersede({ decisionId, optionId: body.optionId, rationale: body.rationale ?? null, artifactIds: body.artifactIds ?? [] });
    if (decision.runId !== null) notify(ctx, decision.runId);
    return { kind: "superseded", decisionId, chosenOptionId: outcome.chosenOptionId, resolvedBy: "operator", supersedingDecisionId: outcome.supersedingDecisionId, replayed: outcome.replayed };
  },
  getEvaluation: (request, ctx) => ctx.app.runtime.stores.evaluations.get(id("evaluation", request.params.evaluationId)),
  getGate: (request, ctx) => ctx.app.runtime.stores.gates.get(id("gate", request.params.gateId)),
  getSnapshot: (request, ctx) => ctx.app.runtime.stores.snapshots.get(id("snapshot", request.params.snapshotId)),
  getChangeset: (request, ctx) => ctx.app.runtime.stores.changesets.get(id("changeset", request.params.changesetId)),
  getArtifact: (request, ctx): ArtifactResponse => {
    const artifact = ctx.app.runtime.stores.artifacts.get(id("artifact", request.params.artifactId));
    return { artifact, presentation: artifactPresentationOf(artifact.mediaType) };
  },
  getArtifactContent: (request, ctx) => sendBytes(request, ctx, request.params.artifactId ?? "", "content"),
  downloadArtifact: (request, ctx) => sendBytes(request, ctx, request.params.artifactId ?? "", "download"),
  getPublication: (request, ctx) => publicationView(ctx.app.runtime, id("publication", request.params.publicationId)),
  advancePublication: async (request, ctx): Promise<PublicationAdvanceResponse> => {
    admit(ctx);
    const publicationId = id("publication", request.params.publicationId);
    ctx.app.runtime.stores.publications.get(publicationId);
    // The operator's explicit retry after an infrastructure failure: the host drives the same idempotent boundaries.
    await ctx.app.host.notifyPublication(publicationId);
    return { outcome: {}, publication: ctx.app.runtime.stores.publications.get(publicationId) };
  },
};
