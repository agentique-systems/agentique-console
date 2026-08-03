/**
 * Routing decides who SPEAKS next — never who sees what (the transcript is
 * shared). Explicit `to` wins, then @mentions (every mention is a recipient),
 * then the default asymmetry that brakes loops: unaddressed specialist speech
 * returns the floor to the orchestrator; unaddressed orchestrator speech goes
 * to the sole specialist when there is exactly one. Port of the env layer's
 * `orchestrator` strategy with the orchestrator seat playing the human role.
 */
import type { Speaker } from "@agentique-console/shared";

export const ORCHESTRATOR_SEAT = "orchestrator";

/**
 * Finds `@name` mentions in order of appearance, case-insensitively, matched
 * on word boundaries against the given names. Returns the canonical names.
 * `.` and `:` are admitted so structured seat names can be addressed; the
 * lookbehind keeps `email@scout` from reading as a mention of scout.
 */
export function parseMentions(
  text: string,
  names: readonly string[],
): string[] {
  const found: string[] = [];
  const byLower = new Map(names.map((name) => [name.toLowerCase(), name]));
  for (const match of text.matchAll(/(?<=^|[^\w@])@([\w.:-]+)/g)) {
    // Trailing punctuation is ambiguous ("@alpha, thoughts?"); trim separators
    // until something resolves — the full token is tried first, so a name that
    // genuinely ends in one still wins.
    let token = match[1] ?? "";
    while (token.length > 0) {
      const canonical = byLower.get(token.toLowerCase());
      if (canonical !== undefined) {
        if (!found.includes(canonical)) found.push(canonical);
        break;
      }
      if (!/[.:-]$/.test(token)) break;
      token = token.slice(0, -1);
    }
  }
  return found;
}

export interface RouteDecision {
  /** A specialist seat name, or ORCHESTRATOR_SEAT. */
  recipient: string;
  reason: "addressed" | "mention" | "default";
}

export function route(
  message: { speaker: Speaker; to?: string; text: string },
  specialists: readonly string[],
): RouteDecision[] {
  const addressable = [...specialists, ORCHESTRATOR_SEAT];

  if (message.to !== undefined && addressable.includes(message.to)) {
    return [{ recipient: message.to, reason: "addressed" }];
  }

  const mentioned = parseMentions(message.text, addressable).filter(
    (name) => name !== message.speaker.name,
  );
  if (mentioned.length > 0) {
    return mentioned.map((name) => ({
      recipient: name,
      reason: "mention" as const,
    }));
  }

  if (message.speaker.kind === "agent") {
    return [{ recipient: ORCHESTRATOR_SEAT, reason: "default" }];
  }
  if (message.speaker.kind === "orchestrator" && specialists.length === 1) {
    return [{ recipient: specialists[0] as string, reason: "default" }];
  }
  // Orchestrator speech in a multi-seat session with no address, or system
  // speech: nobody is seated by default (the host appends a notice).
  return [];
}
