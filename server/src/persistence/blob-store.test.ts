import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobCorruptedError, BlobMissingError, BlobUnsafeEntryError, FileBlobStore, MemoryBlobStore, sha256Hex } from "./blob-store.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-blobs-"));
  dirs.push(dir);
  return dir;
}

/** Every entry under the root as `<relative path>`, symlinks listed by their link name and never followed. */
function allFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out.sort();
}

const bytes = (text: string) => new TextEncoder().encode(text);
const blobPath = (digest: string) => `${digest.slice(0, 2)}/${digest}`;
const markerPath = (digest: string) => `.pending/${digest}`;
const temporaryName = (digest: string, counter = 1) => `${digest}.${process.pid}.${counter}.0f0e0d0c-0b0a-4908-8706-050403020100.tmp`;

describe("FileBlobStore", () => {
  it("stores content under its digest, deduplicates verified content, verifies on read, and publishes a pending marker only for a new blob", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    const content = bytes("hello");
    const digest = sha256Hex(content);
    expect(store.put(content)).toEqual({ digest, byteSize: 5, written: true, pending: true });
    // The marker exists beside the published blob until the owning transaction clears it; it is an empty regular file.
    expect(allFiles(root)).toEqual([markerPath(digest), blobPath(digest)]);
    expect(fs.readFileSync(path.join(root, markerPath(digest)))).toHaveLength(0);
    expect(store.listPending()).toEqual([{ kind: "marker", digest }]);
    // A reuse of an already present blob publishes no marker and carries no obligation.
    expect(store.put(content)).toEqual({ digest, byteSize: 5, written: false, pending: false });
    expect(allFiles(root)).toEqual([markerPath(digest), blobPath(digest)]);
    expect(store.clearPending(digest)).toBe(true);
    expect(store.clearPending(digest)).toBe(false);
    expect(allFiles(root)).toEqual([blobPath(digest)]);
    expect(store.listPending()).toEqual([]);
    expect(Uint8Array.from(store.get(digest))).toEqual(content);
    expect(store.has(digest)).toBe(true);
    expect(() => store.get("0".repeat(64))).toThrow(BlobMissingError);
  });

  it("rejects an existing target whose bytes do not match the digest instead of reusing it, and publishes no marker for it", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    const content = bytes("payload");
    const digest = sha256Hex(content);
    const target = path.join(root, digest.slice(0, 2), digest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes("payloadX"));
    expect(() => store.put(content)).toThrow(BlobCorruptedError);
    expect(() => store.get(digest)).toThrow(BlobCorruptedError);
    // A same-size corruption is caught by the digest, not the size.
    fs.writeFileSync(target, bytes("PAYLOAD"));
    expect(() => store.put(content)).toThrow(BlobCorruptedError);
    expect(store.listPending()).toEqual([]);
  });

  it("removes its temporary file and withdraws its marker when the write fails, leaving no target behind", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const digest = sha256Hex(bytes("unlucky"));
    expect(() => store.put(bytes("unlucky"))).toThrow("disk full");
    expect(allFiles(root)).toEqual([]);
    expect(store.has(digest)).toBe(false);
    expect(store.listPending()).toEqual([]);
  });

  it("an early marker failure publishes nothing: an unsafe pending directory refuses the write before any byte is written", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    fs.writeFileSync(path.join(root, ".pending"), "not a directory");
    const content = bytes("never published");
    expect(() => store.put(content)).toThrow(BlobUnsafeEntryError);
    expect(store.has(sha256Hex(content))).toBe(false);
    expect(allFiles(root)).toEqual([".pending"]);
    expect(() => store.listPending()).toThrow(BlobUnsafeEntryError);
  });

  it("tolerates a concurrent writer of the same digest only when the winner's content verifies; the marker stays with the caller in the reused case and is withdrawn otherwise", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    const content = bytes("shared");
    const digest = sha256Hex(content);
    const target = path.join(root, digest.slice(0, 2), digest);
    vi.spyOn(fs, "renameSync").mockImplementationOnce((_from, to) => {
      // The other process lands the same content first; our rename then fails.
      fs.writeFileSync(String(to), content);
      const error = new Error("EEXIST") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });
    // `written: false` with a marker obligation: this call prepared to publish, so its transaction owns the marker.
    expect(store.put(content)).toEqual({ digest, byteSize: 6, written: false, pending: true });
    expect(allFiles(root)).toEqual([markerPath(digest), blobPath(digest)]);
    expect(fs.readFileSync(target)).toEqual(Buffer.from(content));

    vi.spyOn(fs, "renameSync").mockImplementationOnce((_from, to) => {
      fs.writeFileSync(String(to), bytes("garbage"));
      throw new Error("EEXIST");
    });
    const other = bytes("other content");
    expect(() => store.put(other)).toThrow(BlobCorruptedError);
    // No temporary file and no marker for the failed write; the first call's marker is untouched.
    expect(allFiles(root)).toEqual([markerPath(digest), blobPath(digest), blobPath(sha256Hex(other))].sort());
    expect(store.listPending()).toEqual([{ kind: "marker", digest }]);
  });

  it("uses a distinct protocol-named temporary file per write, inside the pending area", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    const names: string[] = [];
    vi.spyOn(fs, "writeFileSync").mockImplementation((file) => {
      names.push(String(file));
      throw new Error("captured");
    });
    expect(() => store.put(bytes("a"))).toThrow("captured");
    expect(() => store.put(bytes("a"))).toThrow("captured");
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    const digest = sha256Hex(bytes("a"));
    for (const name of names) {
      expect(path.dirname(name)).toBe(path.join(root, ".pending"));
      expect(path.basename(name)).toMatch(new RegExp(`^${digest}\\.${process.pid}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`));
    }
    // Both failed writes withdrew their marker.
    expect(store.listPending()).toEqual([]);
  });

  it("removes a blob for compensation only when it is a regular file in a regular shard directory, and reports whether one existed", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    const { digest } = store.put(bytes("remove me"));
    expect(store.remove(digest)).toBe(true);
    expect(store.remove(digest)).toBe(false);
    expect(store.has(digest)).toBe(false);
    expect(() => store.remove("nope")).toThrow(TypeError);
    // A symlink at the blob's path is neither followed nor removed; its target survives.
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "precious");
    const linked = sha256Hex(bytes("linked"));
    fs.mkdirSync(path.join(root, linked.slice(0, 2)), { recursive: true });
    fs.symlinkSync(victim, path.join(root, blobPath(linked)), "file");
    expect(() => store.remove(linked)).toThrow(BlobUnsafeEntryError);
    expect(fs.readFileSync(victim, "utf8")).toBe("precious");
    expect(fs.lstatSync(path.join(root, blobPath(linked))).isSymbolicLink()).toBe(true);
    // A directory at the blob's path is not removed either.
    const nested = sha256Hex(bytes("nested"));
    fs.mkdirSync(path.join(root, blobPath(nested)), { recursive: true });
    expect(() => store.remove(nested)).toThrow(BlobUnsafeEntryError);
    expect(fs.existsSync(path.join(root, blobPath(nested)))).toBe(true);
    // A junction where the shard directory should be is refused before the leaf is examined; a missing shard is simply "absent".
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-elsewhere-"));
    dirs.push(elsewhere);
    const away = sha256Hex(bytes("away"));
    fs.writeFileSync(path.join(elsewhere, away), "not ours");
    fs.symlinkSync(elsewhere, path.join(root, away.slice(0, 2)), "junction");
    expect(() => store.remove(away)).toThrow(BlobUnsafeEntryError);
    expect(fs.existsSync(path.join(elsewhere, away))).toBe(true);
    expect(store.remove(sha256Hex(bytes("no shard yet")))).toBe(false);
    // The error names the role and the digest only, never a path.
    let caught: unknown;
    try {
      store.remove(linked);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).not.toContain(root);
    expect((caught as { failureKind?: string }).failureKind).toBe("storage:unsafe_entry");
  });

  it("publishes markers idempotently as empty regular files, refuses a non-regular entry at the marker path, and never writes through one", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    const digest = sha256Hex(bytes("marked"));
    store.markPending(digest);
    store.markPending(digest);
    expect(allFiles(root)).toEqual([markerPath(digest)]);
    expect(fs.lstatSync(path.join(root, markerPath(digest))).isFile()).toBe(true);
    expect(() => store.markPending("not-a-digest")).toThrow(TypeError);
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "precious");
    const linked = sha256Hex(bytes("linked marker"));
    fs.symlinkSync(victim, path.join(root, markerPath(linked)), "file");
    expect(() => store.markPending(linked)).toThrow(BlobUnsafeEntryError);
    expect(() => store.clearPending(linked)).toThrow(BlobUnsafeEntryError);
    expect(fs.readFileSync(victim, "utf8")).toBe("precious");
    expect(fs.lstatSync(path.join(root, markerPath(linked))).isSymbolicLink()).toBe(true);
    const dirMarker = sha256Hex(bytes("directory marker"));
    fs.mkdirSync(path.join(root, markerPath(dirMarker)));
    expect(() => store.markPending(dirMarker)).toThrow(BlobUnsafeEntryError);
    expect(() => store.clearPending(dirMarker)).toThrow(BlobUnsafeEntryError);
    // A `put` of the linked digest fails before any byte is written.
    expect(() => store.put(bytes("linked marker"))).toThrow(BlobUnsafeEntryError);
    expect(store.has(linked)).toBe(false);
  });

  it("enumerates the pending area deterministically: markers, protocol temporaries, unsafe entries, and unrecognized entries with sanitized identifiers", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    expect(store.listPending()).toEqual([]);
    const a = sha256Hex(bytes("a"));
    const b = sha256Hex(bytes("b"));
    store.markPending(b);
    store.markPending(a);
    const pending = path.join(root, ".pending");
    fs.writeFileSync(path.join(pending, temporaryName(a)), "partial");
    fs.writeFileSync(path.join(pending, temporaryName(b, 7)), "");
    // Foreign or malformed entries: never removed, reported by a bounded, character-restricted identifier.
    fs.writeFileSync(path.join(pending, "notes.txt"), "?");
    fs.writeFileSync(path.join(pending, `${a}.tmp`), "?");
    fs.writeFileSync(path.join(pending, "x".repeat(200)), "?");
    fs.writeFileSync(path.join(pending, "we ird$name"), "?");
    // Protocol-named entries that are not regular files are unsafe.
    const c = sha256Hex(bytes("c"));
    fs.mkdirSync(path.join(pending, c));
    const d = sha256Hex(bytes("d"));
    fs.symlinkSync(path.join(root, "nowhere"), path.join(pending, d), "file");
    fs.mkdirSync(path.join(pending, temporaryName(c, 2)));
    const listed = store.listPending();
    // Entries in directory order (by raw name); foreign names are reported sanitized and bounded, never as found.
    const byRawName: Record<string, unknown> = {
      [a]: { kind: "marker", digest: a },
      [temporaryName(a)]: { kind: "temporary", digest: a, name: temporaryName(a) },
      [`${a}.tmp`]: { kind: "unrecognized", entry: `${a}.tmp` },
      [b]: { kind: "marker", digest: b },
      [temporaryName(b, 7)]: { kind: "temporary", digest: b, name: temporaryName(b, 7) },
      [c]: { kind: "unsafe", entry: c },
      [temporaryName(c, 2)]: { kind: "unsafe", entry: temporaryName(c, 2) },
      [d]: { kind: "unsafe", entry: d },
      "notes.txt": { kind: "unrecognized", entry: "notes.txt" },
      "we ird$name": { kind: "unrecognized", entry: "we_ird_name" },
      ["x".repeat(200)]: { kind: "unrecognized", entry: "x".repeat(96) },
    };
    expect(listed).toEqual(
      Object.keys(byRawName)
        .sort()
        .map((name) => byRawName[name]),
    );
    expect(store.listPending()).toEqual(listed);
    // Removal of a recognized temporary is lstat-guarded and idempotent; a malformed name is refused before any filesystem access.
    expect(store.removeTemporary(temporaryName(a))).toBe(true);
    expect(store.removeTemporary(temporaryName(a))).toBe(false);
    expect(() => store.removeTemporary(temporaryName(c, 2))).toThrow(BlobUnsafeEntryError);
    expect(() => store.removeTemporary("notes.txt")).toThrow(TypeError);
    expect(() => store.removeTemporary(`${a}.tmp`)).toThrow(TypeError);
    expect(() => store.removeTemporary("../" + temporaryName(a))).toThrow(TypeError);
    expect(fs.existsSync(path.join(pending, "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(pending, temporaryName(c, 2)))).toBe(true);
    // The pending area itself must be a regular directory: a junction is refused, never followed.
    const other = tempRoot();
    const linkedRoot = tempRoot();
    fs.symlinkSync(other, path.join(linkedRoot, ".pending"), "junction");
    const linkedStore = new FileBlobStore(linkedRoot);
    expect(() => linkedStore.listPending()).toThrow(BlobUnsafeEntryError);
    expect(() => linkedStore.markPending(a)).toThrow(BlobUnsafeEntryError);
    expect(() => linkedStore.clearPending(a)).toThrow(BlobUnsafeEntryError);
    expect(() => linkedStore.removeTemporary(temporaryName(a))).toThrow(BlobUnsafeEntryError);
    expect(fs.readdirSync(other)).toEqual([]);
  });
});

describe("MemoryBlobStore", () => {
  it("verifies existing content on put and get, removes for compensation, and mirrors the marker protocol", () => {
    const store = new MemoryBlobStore();
    const content = bytes("mem");
    const written = store.put(content);
    expect(written).toMatchObject({ written: true, pending: true });
    const { digest } = written;
    expect(store.pendingDigests()).toEqual([digest]);
    expect(store.listPending()).toEqual([{ kind: "marker", digest }]);
    expect(store.put(content)).toMatchObject({ written: false, pending: false });
    expect(store.clearPending(digest)).toBe(true);
    expect(store.clearPending(digest)).toBe(false);
    expect(store.pendingDigests()).toEqual([]);
    store.corrupt(digest, bytes("MEM"));
    expect(() => store.put(content)).toThrow(BlobCorruptedError);
    expect(() => store.get(digest)).toThrow(BlobCorruptedError);
    expect(store.remove(digest)).toBe(true);
    expect(store.remove(digest)).toBe(false);
    expect(() => store.get(digest)).toThrow(BlobMissingError);
    expect(store.size).toBe(0);
    expect(() => store.removeTemporary("x")).toThrow(TypeError);
    expect(store.removeTemporary(temporaryName(digest))).toBe(false);
  });
});
