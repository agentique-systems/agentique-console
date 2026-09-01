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

/**
 * The closed set of failure kinds a diagnostic or a provider-facing failure
 * may name (execution-model §6.4, §13, §14). Every value is a literal of
 * this tuple; nothing a thrown value carries — its class name, constructor,
 * `code`, message, stack, cause, or details — is ever forwarded as text.
 * Recognized families keep a useful distinction: the domain error codes,
 * the Artifact Store's two content failures, SQLite's primary result codes
 * that a runtime can act on, and the filesystem errno names an Artifact
 * blob store can raise. Everything else is `unknown`.
 */
export const FAILURE_KINDS = [
  "domain:validation",
  "domain:illegal_transition",
  "domain:not_found",
  "domain:conflict",
  "domain:invariant_violation",
  "domain:allocation_exhausted",
  "domain:insufficient_capacity",
  "domain:immutable",
  "storage:content_missing",
  "storage:content_corrupt",
  "sqlite:busy",
  "sqlite:locked",
  "sqlite:constraint",
  "sqlite:corrupt",
  "sqlite:full",
  "sqlite:ioerr",
  "sqlite:readonly",
  "sqlite:cantopen",
  "sqlite:other",
  "filesystem:ENOENT",
  "filesystem:EACCES",
  "filesystem:EPERM",
  "filesystem:EEXIST",
  "filesystem:ENOSPC",
  "filesystem:EROFS",
  "filesystem:EBUSY",
  "filesystem:EIO",
  "filesystem:EMFILE",
  "filesystem:ENFILE",
  "filesystem:ENOTDIR",
  "filesystem:EISDIR",
  "filesystem:ENOTEMPTY",
  "filesystem:EINVAL",
  "filesystem:EAGAIN",
  "filesystem:ENAMETOOLONG",
  "filesystem:ELOOP",
  "filesystem:other",
  "unknown",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

const FAILURE_KIND_SET: ReadonlySet<string> = new Set(FAILURE_KINDS);

/** The property a boundary error may carry to declare its own kind; only a value of `FAILURE_KINDS` is honoured. */
export const FAILURE_KIND_PROPERTY = "failureKind";

/** SQLite primary result codes the runtime distinguishes, by the primary code an extended code (`SQLITE_CONSTRAINT_UNIQUE`) begins with. */
const SQLITE_PRIMARY_KINDS: Readonly<Record<string, FailureKind>> = {
  SQLITE_BUSY: "sqlite:busy",
  SQLITE_LOCKED: "sqlite:locked",
  SQLITE_CONSTRAINT: "sqlite:constraint",
  SQLITE_CORRUPT: "sqlite:corrupt",
  SQLITE_FULL: "sqlite:full",
  SQLITE_IOERR: "sqlite:ioerr",
  SQLITE_READONLY: "sqlite:readonly",
  SQLITE_CANTOPEN: "sqlite:cantopen",
};

/** Reads one property of a thrown value without trusting it: a throwing accessor, a proxy, or a non-object yields `undefined`. */
function property(value: unknown, name: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return (value as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * The closed failure kind of a thrown value, for a diagnostic or a
 * provider-facing failure. The classification is a finite policy, never a
 * content channel: a `DomainError` maps to its own closed code; a boundary
 * error that declares a `failureKind` of `FAILURE_KINDS` maps to exactly
 * that; a SQLite error (a `SqliteError` carrying a `SQLITE_*` code) maps to
 * its primary result code's kind or `sqlite:other`; a Node filesystem error
 * (a `code` together with the `errno` or `syscall` an errno error carries)
 * maps to its errno name when listed or `filesystem:other`; anything else —
 * an unknown class, a forged or unlisted code, a non-Error value — is
 * `unknown`. Names, codes, messages, stacks, causes, and details are never
 * echoed, and classification never throws.
 */
export function failureKindOf(error: unknown): FailureKind {
  try {
    if (error instanceof DomainError) return (FAILURE_KIND_SET.has(`domain:${error.code}`) ? `domain:${error.code}` : "unknown") as FailureKind;
    if (!(error instanceof Error)) return "unknown";
    const declared = property(error, FAILURE_KIND_PROPERTY);
    if (typeof declared === "string" && FAILURE_KIND_SET.has(declared)) return declared as FailureKind;
    const code = property(error, "code");
    if (property(error, "name") === "SqliteError" && typeof code === "string" && code.startsWith("SQLITE_")) {
      const primary = code.split("_").slice(0, 2).join("_");
      return SQLITE_PRIMARY_KINDS[primary] ?? "sqlite:other";
    }
    const errno = property(error, "errno");
    const syscall = property(error, "syscall");
    if (typeof code === "string" && (typeof errno === "number" || typeof syscall === "string")) {
      return (FAILURE_KIND_SET.has(`filesystem:${code}`) ? `filesystem:${code}` : "filesystem:other") as FailureKind;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

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
