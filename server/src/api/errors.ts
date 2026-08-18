import { ConflictError, InvalidInputError, NotFoundError } from "../errors.ts";
import { BrowseError } from "../workspaces/fs-browse.ts";

/** A transport-level error that already knows its status (fs browse). */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** The one domain→HTTP mapping, consumed by api/server.ts's error handler. */
export function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof InvalidInputError) return new ApiError(400, "bad_request", error.message);
  if (error instanceof NotFoundError) return new ApiError(404, "not_found", error.message);
  if (error instanceof ConflictError) return new ApiError(409, "conflict", error.message);
  if (error instanceof BrowseError) return new ApiError(error.status, "browse_error", error.message);
  return null;
}
