/**
 * Domain errors. Core code states WHAT went wrong; the HTTP layer alone
 * (api/errors.ts, applied in api/server.ts's error handler) decides what
 * status that maps to. Nothing outside api/ knows an HTTP code.
 */
export class InvalidInputError extends Error {}

export class NotFoundError extends Error {}

export class ConflictError extends Error {}
