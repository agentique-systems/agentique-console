import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobCorruptedError, BlobMissingError, FileBlobStore, MemoryBlobStore, sha256Hex } from "./blob-store.ts";

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

describe("FileBlobStore", () => {
  it("stores content under its digest, deduplicates verified content, and verifies on read", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    const content = bytes("hello");
    const digest = sha256Hex(content);
    expect(store.put(content)).toEqual({ digest, byteSize: 5, written: true });
    expect(store.put(content)).toEqual({ digest, byteSize: 5, written: false });
    expect(allFiles(root)).toEqual([`${digest.slice(0, 2)}/${digest}`]);
    expect(Uint8Array.from(store.get(digest))).toEqual(content);
    expect(store.has(digest)).toBe(true);
    expect(() => store.get("0".repeat(64))).toThrow(BlobMissingError);
  });

  it("rejects an existing target whose bytes do not match the digest instead of reusing it", () => {
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
  });

  it("removes its temporary file when the write fails and leaves no target behind", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => store.put(bytes("unlucky"))).toThrow("disk full");
    expect(allFiles(root).filter((f) => !f.endsWith(".tmp"))).toEqual([]);
    expect(allFiles(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(store.has(sha256Hex(bytes("unlucky")))).toBe(false);
  });

  it("tolerates a concurrent writer of the same digest only when the winner's content verifies", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    const content = bytes("shared");
    const digest = sha256Hex(content);
    const target = path.join(root, digest.slice(0, 2), digest);
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      // The other process lands the same content first; our rename then fails.
      fs.writeFileSync(String(to), content);
      const error = new Error("EEXIST") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });
    expect(store.put(content)).toEqual({ digest, byteSize: 6, written: false });
    expect(allFiles(root)).toEqual([`${digest.slice(0, 2)}/${digest}`]);
    expect(fs.readFileSync(target)).toEqual(Buffer.from(content));

    vi.spyOn(fs, "renameSync").mockImplementationOnce((from, to) => {
      fs.writeFileSync(String(to), bytes("garbage"));
      throw new Error("EEXIST");
    });
    const other = bytes("other content");
    expect(() => store.put(other)).toThrow(BlobCorruptedError);
    expect(allFiles(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(realRename).toBeTypeOf("function");
  });

  it("uses a distinct temporary name per write within the process", () => {
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
    expect(names.every((n) => n.endsWith(".tmp") && n.includes(`.${process.pid}.`))).toBe(true);
  });

  it("removes a blob for compensation and reports whether one existed", () => {
    const root = tempRoot();
    const store = new FileBlobStore(root);
    const { digest } = store.put(bytes("remove me"));
    expect(store.remove(digest)).toBe(true);
    expect(store.remove(digest)).toBe(false);
    expect(store.has(digest)).toBe(false);
    expect(() => store.remove("nope")).toThrow(TypeError);
  });
});

describe("MemoryBlobStore", () => {
  it("verifies existing content on put and get, and removes for compensation", () => {
    const store = new MemoryBlobStore();
    const content = bytes("mem");
    const { digest } = store.put(content);
    expect(store.put(content).written).toBe(false);
    store.corrupt(digest, bytes("MEM"));
    expect(() => store.put(content)).toThrow(BlobCorruptedError);
    expect(() => store.get(digest)).toThrow(BlobCorruptedError);
    expect(store.remove(digest)).toBe(true);
    expect(store.remove(digest)).toBe(false);
    expect(() => store.get(digest)).toThrow(BlobMissingError);
    expect(store.size).toBe(0);
  });
});
