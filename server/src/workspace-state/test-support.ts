/**
 * Real-filesystem fixtures for the Workspace provider suites: disposable
 * temporary repositories and directories, canonical ids, a verified content
 * source over bytes, and readers over a directory tree. Every fixture lives
 * under a temporary directory the test removes; no test touches a
 * repository it did not create.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SnapshotIdentity } from "@agentique-console/core";
import type { ArtifactContentSource } from "../execution/ports/integration-workspace.ts";
import { gitSync, text } from "./git.ts";
import type { WorkspaceStateLayout } from "./paths.ts";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentique-${prefix}-`));
}

export function canonicalId<P extends string>(prefix: P): `${P}_${string}` {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/** Writes `files` (relative path → content; `null` deletes) under `dir`. */
export function writeFiles(dir: string, files: Record<string, string | Uint8Array | null>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    if (content === null) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** A fresh repository with `files` committed on `branch`. */
export function initRepository(dir: string, files: Record<string, string | Uint8Array>, branch = "main"): { headCommit: string } {
  gitSync(["init", "--quiet", `--initial-branch=${branch}`, dir], { cwd: path.dirname(dir) });
  gitSync(["config", "core.autocrlf", "false"], { cwd: dir });
  writeFiles(dir, files);
  return { headCommit: commitAll(dir, "initial") };
}

export function commitAll(dir: string, message: string): string {
  gitSync(["add", "-A", "--", "."], { cwd: dir });
  gitSync(["commit", "--quiet", "--allow-empty", "--no-verify", "-m", message], { cwd: dir, identity: true });
  return text(gitSync(["rev-parse", "HEAD"], { cwd: dir }));
}

export function headOf(dir: string, ref = "HEAD"): string {
  return text(gitSync(["rev-parse", ref], { cwd: dir }));
}

export function gitIdentityOf(dir: string, commit: string): SnapshotIdentity {
  return { kind: "git", commitId: text(gitSync(["rev-parse", `${commit}^{commit}`], { cwd: dir })), treeId: text(gitSync(["rev-parse", `${commit}^{tree}`], { cwd: dir })) };
}

/** Every regular file under `dir` (excluding `.git`), relative path → UTF-8 content, sorted. */
export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full).replaceAll("\\", "/")] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A content source over exact bytes, verified on every read like the runtime's. */
export function contentSource(bytes: Uint8Array, artifactId = canonicalId("art")): ArtifactContentSource & { reads: number } {
  const source = {
    artifactId: artifactId as never,
    mediaType: "text/x-diff",
    digest: sha256(bytes),
    byteSize: bytes.byteLength,
    reads: 0,
    async read() {
      source.reads += 1;
      return Uint8Array.from(bytes);
    },
  };
  return source;
}

export function layoutIn(dir: string): WorkspaceStateLayout {
  return { stateRoot: path.join(dir, "state") };
}

export function statusOf(dir: string): string {
  return text(gitSync(["status", "--porcelain", "--untracked-files=all"], { cwd: dir }));
}

export function listRefs(dir: string, prefix: string): string[] {
  return text(gitSync(["for-each-ref", "--format=%(refname)", prefix], { cwd: dir }))
    .split(/\r?\n/)
    .filter((line) => line !== "");
}
