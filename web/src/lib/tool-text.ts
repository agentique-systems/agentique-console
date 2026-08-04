/**
 * Turning a raw tool call into something an operator can read at a glance.
 * Shared by both transcripts — the orchestrator's chain-of-thought steps and
 * the inspector's per-seat tool runs want exactly the same treatment.
 */

/**
 * The file or pattern a call is about, for the label chip. Covers the argument
 * names the SDK's own tools use; anything else gets no chip rather than a
 * wrong one.
 */
export function subjectOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path", "pattern", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** Paths are long and the left of one is never the interesting part. */
export function shortenPath(value: string, keep = 2): string {
  const segments = value.split("/").filter((segment) => segment !== "");
  if (segments.length <= keep) return value;
  return `…/${segments.slice(-keep).join("/")}`;
}
