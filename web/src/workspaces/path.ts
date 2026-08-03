/** Pure path helpers for the directory picker. Kept out of the component so they can be tested. */

export interface Crumb {
  readonly label: string;
  readonly path: string;
}

/**
 * Breadcrumbs for an absolute POSIX path, root first.
 * `/home/dev/git` → [{/, /}, {home, /home}, {dev, /home/dev}, {git, /home/dev/git}]
 */
export function breadcrumbs(path: string): readonly Crumb[] {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const crumbs: Crumb[] = [{ label: "/", path: "/" }];
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

/** The last segment — what a workspace gets named after by default. */
export function basename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? "";
}

/** Join a directory and a child name without doubling the root slash. */
export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}
