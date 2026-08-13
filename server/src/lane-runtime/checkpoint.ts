/** The checkpoint query shared by both lane engines' rotation paths. */
import type { HandoffDraft } from "@agentique-console/shared";
import { HANDOFF_DRAFT_JSON_SCHEMA, HandoffDraftSchema } from "../handoffs/schema.ts";
import { sdkEnv } from "../sdk/env.ts";
import { mapSdkMessage, type TurnEvent } from "../sdk/mapping.ts";
import type { ConsoleSdk, SdkOptions } from "../sdk/types.ts";

/**
 * A checkpoint is a read-only self-description; every tool that could act on
 * the world (or fork context) is denied.
 */
export const CHECKPOINT_DENIED_TOOLS = [
  "Agent", "SendMessage", "Task", "Bash", "Edit", "Write", "WebSearch", "WebFetch",
];

/** What differs between the two engines' checkpoint queries. */
export interface CheckpointQueryParams {
  prompt: string;
  systemPromptAppend: string;
  cwd: string;
  /** Sandbox read scope; the write scope is always empty — a checkpoint acts on nothing. */
  readPaths: string[];
  /** The provider session being checkpointed. */
  resume: string;
  model: string | null;
  effort: string | null | undefined;
  /** Present = persist through it with eager flush; absent = CLI default. */
  sessionStore?: SdkOptions["sessionStore"];
  /**
   * null = no deadline. The host arms its rotation gate's timeout; the runner
   * passes null deliberately — unified code, unchanged behavior.
   */
  timeoutMs: number | null;
  /** Result-frame hook (the host records checkpoint usage through it). */
  onResult?: (event: Extract<TurnEvent, { kind: "result" }>) => void;
}

/** One tool-free checkpoint query against the lane's current context. */
export async function checkpointQuery(sdk: ConsoleSdk, params: CheckpointQueryParams): Promise<{ draft: HandoffDraft | null; failure: string | null }> {
  let draft: HandoffDraft | null = null;
  let failure: string | null = null;
  const abort = new AbortController();
  // The abort controller is useless unarmed: a provider-side outage makes the
  // CLI retry for minutes while the caller's rotation gate blocks senders.
  const deadline = params.timeoutMs === null ? null : setTimeout(() => abort.abort(), params.timeoutMs);
  deadline?.unref?.();
  const query = sdk.query({ prompt: params.prompt, options: {
    cwd: params.cwd, systemPrompt: { type: "preset", preset: "claude_code", append: params.systemPromptAppend },
    settingSources: [], includePartialMessages: false, permissionMode: "plan", allowedTools: [],
    disallowedTools: CHECKPOINT_DENIED_TOOLS,
    // MUST be object-rooted: the CLI turns this into a synthetic
    // `StructuredOutput` tool and ships it verbatim as input_schema, and the
    // API rejects anything whose root `type` is not the string "object".
    outputFormat: { type: "json_schema", schema: HANDOFF_DRAFT_JSON_SCHEMA }, maxTurns: 2,
    env: sdkEnv(), abortController: abort, persistSession: true,
    ...(params.sessionStore === undefined ? {} : { sessionStore: params.sessionStore, sessionStoreFlush: "eager" as const }),
    resume: params.resume, ...(params.model ? { model: params.model } : {}),
    ...(params.effort ? { effort: params.effort as SdkOptions["effort"] } : {}),
  } });
  try {
    for await (const raw of query) for (const event of mapSdkMessage(raw)) {
      if (event.kind === "result") {
        const parsed = HandoffDraftSchema.safeParse(event.output);
        if (parsed.success) draft = parsed.data;
        params.onResult?.(event);
      } else if (event.kind === "error") failure = event.message;
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally { if (deadline) clearTimeout(deadline); query.close?.(); }
  return { draft, failure };
}

/**
 * Marks a checkpoint rebuilt from the last real handoff after a failed
 * checkpoint query. The prefix is a `startsWith` idempotence guard: a draft
 * recovered from an already-recovered draft must not stack prefixes.
 */
export const RECOVERY_PREFIX = "Recovery checkpoint: ";

export function recoveryAction(action: string): string {
  return action.startsWith(RECOVERY_PREFIX) ? action : `${RECOVERY_PREFIX}${action}`;
}
