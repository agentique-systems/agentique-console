/**
 * The one domain-to-HTTP mapping (core `ApiErrorBody`): every typed refusal
 * of the canonical services reaches the operator as a closed code with
 * bounded details — ids, closed codes, statuses — never a stack, a path, or
 * content. Anything unrecognized is `internal` and logged server-side.
 */
import { API_ERROR_STATUS, DomainError, IllegalTransitionError, NotFoundError, ValidationError, type ApiErrorBody, type ApiErrorCode } from "@agentique-console/core";
import { AdmissionRefusedError } from "../host/admission.ts";
import { WorkspaceStateError } from "../workspace-state/paths.ts";
import { BrowseError } from "../workspaces/fs-browse.ts";

export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> | null = null,
    status?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status ?? API_ERROR_STATUS[code];
  }

  body(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

const SAFE_DETAIL = /^(?:[a-zA-Z]+Id|id|refusal|code|status|kind|chosen|requested|partition|admission|reason|defects|path|field|from|to|subject)$/;

/** Only closed facts survive into the envelope; a detail named like content, a path, or a payload is dropped. */
function boundedDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL.test(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) out[key] = typeof value === "string" ? value.slice(0, 500) : value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) out[key] = value.slice(0, 50).map((v) => (v as string).slice(0, 200));
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Maps a thrown value to the API error it is; `null` for an unrecognized error (an internal failure). */
export function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof AdmissionRefusedError) return new ApiError("unavailable", error.message, { admission: error.admission });
  if (error instanceof BrowseError) return new ApiError(error.status === 404 ? "not_found" : error.status === 403 ? "forbidden" : "bad_request", error.message);
  if (error instanceof WorkspaceStateError) return new ApiError(error.code === "workspace_missing" ? "not_found" : error.code === "unsupported" ? "unsupported" : "bad_request", error.message, { code: error.code });
  if (error instanceof ValidationError) return new ApiError("bad_request", error.message, boundedDetails(error.details));
  if (error instanceof NotFoundError) return new ApiError("not_found", error.message, boundedDetails(error.details));
  if (error instanceof IllegalTransitionError) return new ApiError("conflict", error.message, boundedDetails(error.details));
  if (error instanceof DomainError) {
    // A service's typed refusal carries its closed `refusal` code; every other conflict is a canonical conflict.
    const refusal = (error as { refusal?: unknown }).refusal;
    if (typeof refusal === "string") return new ApiError("refused", error.message, { refusal, ...(boundedDetails(error.details) ?? {}) });
    if (error.code === "conflict" || error.code === "immutable" || error.code === "insufficient_capacity" || error.code === "allocation_exhausted") return new ApiError("conflict", error.message, boundedDetails(error.details));
    if (error.code === "validation") return new ApiError("bad_request", error.message, boundedDetails(error.details));
    if (error.code === "not_found") return new ApiError("not_found", error.message, boundedDetails(error.details));
    return null;
  }
  return null;
}
