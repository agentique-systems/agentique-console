/**
 * Per-turn specialist prompts, composed from UNSEEN messages only (the seat's
 * lastSeenSeq watermark; resume handles memory of everything earlier). Session
 * behavior lives here, not in agent briefs — port of the env layer's
 * composeTurnPrompt, simplified.
 */
import type { MessageRow } from "../db/repo.ts";

export interface SeatDescription {
  name: string;
  role: "orchestrator" | "agent";
  description: string;
}

/** One labeled transcript line: `[speaker]` or `[speaker → recipient]`. */
export function formatMessageLine(row: MessageRow): string {
  const label =
    row.toName === null
      ? `[${row.speakerName}]`
      : `[${row.speakerName} → ${row.toName}]`;
  const prefix = row.kind === "plan" ? "PLAN:\n" : "";
  return `${label}: ${prefix}${row.text}`;
}

export function composeSpecialistPrompt(options: {
  seatName: string;
  sessionTitle: string;
  seats: SeatDescription[];
  /** Unseen messages, oldest first, own speech already filtered. */
  messages: MessageRow[];
  hopRemaining: number;
  /** Seats whose turns are in flight right now (excluding this one). */
  speaking: string[];
}): string {
  const roster = options.seats
    .map((seat) => {
      const role = seat.role === "orchestrator" ? " (the orchestrator)" : "";
      return seat.description === ""
        ? `- ${seat.name}${role}`
        : `- ${seat.name}${role}: ${seat.description}`;
    })
    .join("\n");

  const header = [
    `You are **${options.seatName}** in the agent session "${options.sessionTitle}".`,
    "",
    "Participants:",
    roster,
    "",
    `Agent-to-agent hop budget remaining before the floor is forced back to the orchestrator: ${options.hopRemaining}.`,
    ...(options.speaking.length > 0
      ? [
          `Also speaking right now (their turns are in flight): ${options.speaking.join(", ")}.`,
        ]
      : []),
  ].join("\n");

  const body =
    options.messages.length === 0
      ? "(No new messages — you were asked to take a turn.)"
      : `New messages:\n${options.messages.map(formatMessageLine).join("\n")}`;

  const closing =
    "Do the work, then reply with your closing message in the structured " +
    "output (`message`, optionally `to` for a specific participant). Your " +
    "structured `message` is your only speech others will see — put your " +
    "actual findings or answer in it, not a summary of what you did. Set " +
    "`message` to null only if you truly have nothing to deliver.";

  return `${header}\n\n${body}\n\n${closing}`;
}
