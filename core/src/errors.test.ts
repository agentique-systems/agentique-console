import { describe, expect, it } from "vitest";
import { ConflictError, failureKindOf, NotFoundError } from "./errors.ts";

describe("failureKindOf", () => {
  it("describes a thrown value by class name and token-shaped code only — never its message, stack, or a free-form code", () => {
    expect(failureKindOf(new ConflictError("Invocation inv_1 already committed /var/lib/console/blobs/ab/abcdef"))).toBe("ConflictError:conflict");
    expect(failureKindOf(new NotFoundError("Artifact", "art_000000000000000000000000"))).toBe("NotFoundError:not_found");
    expect(failureKindOf(Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\data\\blobs\\ab\\abcdef'"), { code: "ENOENT" }))).toBe("Error:ENOENT");
    expect(failureKindOf(Object.assign(new Error("database is locked"), { name: "SqliteError", code: "SQLITE_BUSY" }))).toBe("SqliteError:SQLITE_BUSY");
    // A code that is not a plain token (a path, a sentence, a number) is not reported; neither is a name that is not.
    expect(failureKindOf(Object.assign(new Error("x"), { code: "/tmp/secret key" }))).toBe("Error");
    expect(failureKindOf(Object.assign(new Error("x"), { code: 42 }))).toBe("Error");
    expect(failureKindOf(Object.assign(new Error("x"), { name: "bad name with SECRET" }))).toBe("unknown");
    expect(failureKindOf("a string with a path /etc/passwd")).toBe("unknown");
    expect(failureKindOf(null)).toBe("unknown");
    expect(failureKindOf(new TypeError("MARKER-content-bytes"))).toBe("TypeError");
  });
});
