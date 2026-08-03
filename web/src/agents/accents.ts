/**
 * Seat accents, ported from v1's session-parts (buildAccents/accentOf):
 * seating-order accent assignment, status-token vocabulary only — no new
 * hues. Deterministic because seating order is server data (participants[]).
 */
import type { Speaker } from "@agentique-console/shared";

const ACCENTS = [
  "text-status-running",
  "text-status-completed",
  "text-status-waiting",
  "text-status-pending",
  "text-status-cancelled",
  "text-attention",
] as const;

export type AccentMap = ReadonlyMap<string, string>;

/** Seating order = accent order; wraps past six seats. */
export function buildAccents(names: readonly string[]): AccentMap {
  return new Map(
    names.map((name, index) => [
      name,
      ACCENTS[index % ACCENTS.length] as string,
    ]),
  );
}

/**
 * By-name lookup for surfaces that only carry a speaker name (overlays,
 * tool participants). The orchestrator gets a distinct neutral accent —
 * it runs the table, it doesn't sit at it; system stays muted.
 */
export function accentOfName(accents: AccentMap, name: string): string {
  if (name === "orchestrator") return "text-foreground";
  if (name === "system") return "text-muted-foreground";
  return accents.get(name) ?? "text-muted-foreground";
}

export function accentOf(accents: AccentMap, speaker: Speaker): string {
  if (speaker.kind === "operator") return "text-foreground";
  if (speaker.kind === "orchestrator") return "text-foreground";
  if (speaker.kind === "system") return "text-muted-foreground";
  return accents.get(speaker.name) ?? "text-muted-foreground";
}
