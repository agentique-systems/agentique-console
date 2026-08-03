/**
 * Specialist turn options. Specialists do the real work: full tool surface,
 * bypassPermissions scoped by cwd (D6 — local trust; no additionalDirectories),
 * structured output {message, to} so a turn can never end silently (D3). In a
 * planning-phase session the seat runs SDK plan mode instead, and ExitPlanMode
 * is captured by the host's per-seat canUseTool (M8).
 */
import type { SessionPhase } from "@agentique-console/shared";
import type { SdkOptions } from "../sdk/types.ts";
import { SESSION_PROTOCOL } from "./presets.ts";

export const TURN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: ["string", "null"],
      description:
        "Your closing message to the session — your findings or answer, verbatim. Null only if you have nothing to deliver.",
    },
    to: {
      type: ["string", "null"],
      description:
        "Seat name to address (or null to return the floor to the orchestrator).",
    },
  },
  required: ["message", "to"],
  additionalProperties: false,
} as const;

export interface TurnOutput {
  message: string | null;
  to: string | null;
}

/** Best-effort parse of the structured turn output. */
export function parseTurnOutput(output: unknown): TurnOutput {
  if (typeof output === "object" && output !== null) {
    const record = output as Record<string, unknown>;
    return {
      message:
        typeof record.message === "string" && record.message.trim() !== ""
          ? record.message
          : null,
      to: typeof record.to === "string" && record.to !== "" ? record.to : null,
    };
  }
  return { message: null, to: null };
}

export interface SpecialistOptionsInput {
  workspaceRoot: string;
  instructions: string;
  resume: string | null;
  phase: SessionPhase;
  model: string | undefined;
  abortController: AbortController;
  sessionStore: unknown;
  hooks?: SdkOptions["hooks"];
  canUseTool?: SdkOptions["canUseTool"];
}

export function buildSpecialistOptions(
  input: SpecialistOptionsInput,
): SdkOptions {
  const planning = input.phase === "planning";
  return {
    cwd: input.workspaceRoot,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: `${input.instructions}\n${SESSION_PROTOCOL}`,
    },
    settingSources: [],
    includePartialMessages: true,
    ...(planning
      ? { permissionMode: "plan" as const }
      : {
          permissionMode: "bypassPermissions" as const,
          allowDangerouslySkipPermissions: true,
        }),
    outputFormat: { type: "json_schema", schema: TURN_OUTPUT_SCHEMA },
    maxTurns: 50,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.resume === null ? {} : { resume: input.resume }),
    persistSession: true,
    sessionStore: input.sessionStore as SdkOptions["sessionStore"],
    sessionStoreFlush: "eager",
    abortController: input.abortController,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    ...(input.canUseTool === undefined
      ? {}
      : { canUseTool: input.canUseTool }),
  };
}
