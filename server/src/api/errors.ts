export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "bad_request", message);
}
export function notFound(message: string): ApiError {
  return new ApiError(404, "not_found", message);
}
export function conflict(message: string): ApiError {
  return new ApiError(409, "conflict", message);
}
export function forbidden(message: string): ApiError {
  return new ApiError(403, "forbidden", message);
}
