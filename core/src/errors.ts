/**
 * Typed domain errors. Core code states what went wrong; a transport layer
 * alone decides how that is presented. Nothing here knows an HTTP status.
 */

export type DomainErrorCode =
  | "validation"
  | "illegal_transition"
  | "not_found"
  | "conflict"
  | "invariant_violation"
  | "allocation_exhausted"
  | "insufficient_capacity"
  | "immutable";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** A value failed runtime validation at a persistence or external boundary. */
export class ValidationError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("validation", message, details);
  }
}

/** A requested state transition is not in the object's transition table. */
export class IllegalTransitionError extends DomainError {
  readonly subject: string;
  readonly from: string;
  readonly to: string;

  constructor(subject: string, from: string, to: string, details: Record<string, unknown> = {}) {
    super("illegal_transition", `${subject} cannot transition from ${from} to ${to}`, {
      subject,
      from,
      to,
      ...details,
    });
    this.subject = subject;
    this.from = from;
    this.to = to;
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, id: string, details: Record<string, unknown> = {}) {
    super("not_found", `${what} ${id} not found`, { what, id, ...details });
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("conflict", message, details);
  }
}

/** A structural rule of the domain would be broken by the requested write. */
export class InvariantViolationError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("invariant_violation", message, details);
  }
}

/** An Invocation has no Attempt, cost, or token allocation left. */
export class AllocationExhaustedError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("allocation_exhausted", message, details);
  }
}

/** A reservation would exceed the parent's unreserved, unconsumed capacity. */
export class InsufficientCapacityError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("insufficient_capacity", message, details);
  }
}

/** An append-only or revisioned record was asked to change in place. */
export class ImmutableRecordError extends DomainError {
  constructor(what: string, id: string, details: Record<string, unknown> = {}) {
    super("immutable", `${what} ${id} is immutable`, { what, id, ...details });
  }
}
