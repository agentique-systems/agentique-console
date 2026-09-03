import { describe, expect, it } from "vitest";
import { ConflictError, DomainError, FAILURE_KINDS, failureKindOf, NotFoundError, ValidationError, type FailureKind } from "./errors.ts";

const SENTINEL = "SecretArtifactBytes";
const closed = (value: unknown): value is FailureKind => (FAILURE_KINDS as readonly string[]).includes(value as string);

describe("failureKindOf", () => {
  it("maps recognized domain, storage, SQLite, and filesystem failures to their closed kinds", () => {
    expect(failureKindOf(new ConflictError(`Invocation inv_1 already committed /var/lib/console/blobs/ab/${SENTINEL}`))).toBe("domain:conflict");
    expect(failureKindOf(new NotFoundError("Artifact", "art_000000000000000000000000"))).toBe("domain:not_found");
    expect(failureKindOf(new ValidationError(SENTINEL))).toBe("domain:validation");
    expect(failureKindOf(Object.assign(new Error("missing"), { failureKind: "storage:content_missing" }))).toBe("storage:content_missing");
    expect(failureKindOf(Object.assign(new Error("corrupt"), { failureKind: "storage:content_corrupt" }))).toBe("storage:content_corrupt");
    expect(failureKindOf(Object.assign(new Error("database is locked"), { name: "SqliteError", code: "SQLITE_BUSY" }))).toBe("sqlite:busy");
    expect(failureKindOf(Object.assign(new Error("UNIQUE constraint failed: x"), { name: "SqliteError", code: "SQLITE_CONSTRAINT_UNIQUE" }))).toBe("sqlite:constraint");
    expect(failureKindOf(Object.assign(new Error("disk image malformed"), { name: "SqliteError", code: "SQLITE_CORRUPT_INDEX" }))).toBe("sqlite:corrupt");
    expect(failureKindOf(Object.assign(new Error("i/o"), { name: "SqliteError", code: "SQLITE_IOERR_WRITE" }))).toBe("sqlite:ioerr");
    expect(failureKindOf(Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\data\\blobs\\ab\\abcdef'"), { code: "ENOENT", errno: -4058, syscall: "open" }))).toBe("filesystem:ENOENT");
    expect(failureKindOf(Object.assign(new Error("EROFS"), { code: "EROFS", syscall: "unlink" }))).toBe("filesystem:EROFS");
    expect(failureKindOf(Object.assign(new Error("ENOSPC"), { code: "ENOSPC", errno: -28 }))).toBe("filesystem:ENOSPC");
  });

  it("maps everything else to a fixed fallback: sentinel names and codes, forged known-looking prefixes, unknown subclasses, and non-Error values", () => {
    class SecretArtifactBytes extends Error {}
    const cases: unknown[] = [
      Object.assign(new Error("x"), { name: SENTINEL }),
      Object.assign(new Error("x"), { code: SENTINEL }),
      Object.assign(new Error("x"), { name: SENTINEL, code: SENTINEL }),
      // A name that looks like a known family with a foreign or unlisted code; a code that looks like an errno without an errno error's shape.
      Object.assign(new Error("x"), { name: "SqliteError", code: SENTINEL }),
      Object.assign(new Error("x"), { code: `ENOENT_${SENTINEL}`, syscall: "open" }),
      Object.assign(new Error("x"), { code: "ENOENT" }),
      Object.assign(new Error("x"), { code: "/tmp/secret key", syscall: "open" }),
      Object.assign(new Error("x"), { failureKind: SENTINEL }),
      Object.assign(new Error("x"), { failureKind: `storage:${SENTINEL}` }),
      new SecretArtifactBytes(SENTINEL),
      new TypeError(SENTINEL),
      SENTINEL,
      42,
      null,
      undefined,
      { name: "ConflictError", code: "conflict", message: SENTINEL },
    ];
    const kinds = cases.map(failureKindOf);
    expect(kinds.filter((k) => k === "unknown")).toHaveLength(cases.length - 2);
    // A known-looking forgery lands inside its family's closed fallback (or outside every family), never on its text.
    expect(failureKindOf(cases[3])).toBe("unknown");
    expect(failureKindOf(cases[4])).toBe("filesystem:other");
    expect(failureKindOf(cases[6])).toBe("filesystem:other");
    expect(failureKindOf(Object.assign(new Error("x"), { name: "SqliteError", code: `SQLITE_${SENTINEL}` }))).toBe("sqlite:other");
    for (const kind of kinds) expect(closed(kind)).toBe(true);
    expect(JSON.stringify(kinds)).not.toContain(SENTINEL);
    // A DomainError with a code outside the closed domain set (a forged instance) is unknown, never its code.
    const forged = new ConflictError("x");
    Object.defineProperty(forged, "code", { value: SENTINEL });
    expect(failureKindOf(forged)).toBe("unknown");
    expect(forged instanceof DomainError).toBe(true);
  });

  it("never throws: accessors that throw, proxies, and revoked proxies classify as unknown", () => {
    const throwing = new Error("x");
    Object.defineProperty(throwing, "code", { get: () => { throw new Error(SENTINEL); } });
    Object.defineProperty(throwing, "name", { get: () => { throw new Error(SENTINEL); } });
    expect(failureKindOf(throwing)).toBe("unknown");
    const proxy = new Proxy(new Error("x"), { get: () => { throw new Error(SENTINEL); } });
    expect(failureKindOf(proxy)).toBe("unknown");
    const revocable = Proxy.revocable(new Error("x"), {});
    revocable.revoke();
    expect(failureKindOf(revocable.proxy)).toBe("unknown");
    // Every kind ever produced is a literal of the closed set.
    expect(new Set(FAILURE_KINDS).size).toBe(FAILURE_KINDS.length);
    expect(FAILURE_KINDS).toContain("unknown");
  });
});
