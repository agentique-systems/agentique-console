/** Shared text helpers for the reading tracker. */

/** Collapse whitespace and trim — titles come from shell arguments. */
export function fooBar(text) {
  return String(text).trim().replace(/\s+/g, " ");
}

/** One line per entry for `list` output. */
export function formatEntry(entry) {
  const status = entry.finishedAt ? "done " : "open ";
  return `${status} ${entry.id}  ${entry.title}`;
}
