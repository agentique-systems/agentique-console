/**
 * Server-side directory browsing for Workspace creation: the one route that
 * reads the operator's filesystem on request. The containment rule is
 * realpath first, then check: resolving symlinks before comparing against
 * the configured browse roots collapses `..` traversal and symlink escapes
 * into one check that cannot be walked around by spelling a path
 * differently. Directories only — never files, never contents.
 */
import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export class BrowseError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "BrowseError";
  }
}

export interface BrowseEntry {
  readonly name: string;
  readonly path: string;
  readonly hidden: boolean;
}

export interface BrowseListing {
  /** The canonical (realpath'd) directory actually listed. */
  readonly path: string;
  /** `null` at a root boundary: there is nowhere permitted to go up to. */
  readonly parent: string | null;
  readonly entries: readonly BrowseEntry[];
}

const MAX_ENTRIES = 1_000;
const IGNORED = new Set(["node_modules", ".git", ".cache"]);

/** Realpath'd browse roots; an unreadable or missing root is dropped rather than failing the call. */
export async function resolveRoots(configured: readonly string[]): Promise<readonly string[]> {
  const resolved: string[] = [];
  for (const root of configured) {
    if (!isAbsolute(root)) continue;
    const real = await realpath(resolve(root)).catch(() => null);
    if (real !== null && !resolved.includes(real)) resolved.push(real);
  }
  return resolved;
}

/** The roots as the picker shows them: each surviving root under its configured label. */
export async function rootsView(configured: readonly { path: string; label: string }[]): Promise<{ roots: { path: string; label: string }[] }> {
  const roots = await resolveRoots(configured.map((root) => root.path));
  return { roots: roots.map((path) => ({ path, label: configured.find((root) => resolve(root.path) === path || root.path === path)?.label ?? path })) };
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Canonicalizes `input` and proves it lies inside `roots`; throws `BrowseError` with the status the API returns; never returns an unverified path. */
export async function resolveBrowsePath(input: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(input) || input.includes("\0")) throw new BrowseError(400, "an absolute path is required");
  let real: string;
  try {
    real = await realpath(resolve(input));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new BrowseError(403, "not readable");
    throw new BrowseError(404, "no such directory");
  }
  if (!roots.some((root) => isUnder(real, root))) throw new BrowseError(403, "the path is outside the allowed roots");
  const info = await stat(real).catch(() => null);
  if (info === null || !info.isDirectory()) throw new BrowseError(400, "not a directory");
  return real;
}

/** A path that may not exist yet but whose parent does and is allowed: the canonical parent joined with the unresolved leaf. */
export async function resolveNewPath(input: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(input) || input.includes("\0")) throw new BrowseError(400, "an absolute path is required");
  if (existsSync(input)) return resolveBrowsePath(input, roots);
  const parent = await resolveBrowsePath(dirname(resolve(input)), roots);
  return join(parent, basename(resolve(input)));
}

export async function listDirectories(path: string, options: { readonly showHidden?: boolean; readonly roots: readonly string[] }): Promise<BrowseListing> {
  const real = await resolveBrowsePath(path, options.roots);
  const dirents = await readdir(real, { withFileTypes: true }).catch(() => {
    throw new BrowseError(403, "not readable");
  });
  const entries: BrowseEntry[] = [];
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES) break;
    const hidden = dirent.name.startsWith(".");
    if (hidden && options.showHidden !== true) continue;
    if (IGNORED.has(dirent.name)) continue;
    const child = join(real, dirent.name);
    if (dirent.isSymbolicLink()) {
      // Follow only far enough to decide whether it stays inside the roots.
      const target = await realpath(child).catch(() => null);
      if (target === null || !options.roots.some((root) => isUnder(target, root))) continue;
      const info = await stat(target).catch(() => null);
      if (info === null || !info.isDirectory()) continue;
    } else if (!dirent.isDirectory()) {
      continue;
    }
    entries.push({ name: dirent.name, path: child, hidden });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const up = dirname(real);
  const parent = up !== real && options.roots.some((root) => isUnder(up, root)) ? up : null;
  return { path: real, parent, entries };
}

/** One-call browse for the API: resolve the allow-list, then list under it. */
export async function browseDirectories(configured: readonly string[], path: string, showHidden: boolean): Promise<BrowseListing> {
  const roots = await resolveRoots(configured);
  return listDirectories(path, { roots, showHidden });
}
