/**
 * PreToolUse on Agent: put the spawn plan's `name` back on the tool call.
 *
 * `create_agent_session` returns a spawn plan whose `name` the Orchestrator is
 * told to copy verbatim — without it the SDK registers no address and
 * SendMessage({to: "<seat>-<suffix>"}) resolves to nothing, so seats cannot
 * reach their coordinator or each other. Asking the model to carry a field
 * from a nested tool result into a later tool call is a compliance bet, and
 * the first real multi-seat run lost it 11 times out of 11: three seats gave
 * up on their coordinator and dumped their plans to "main".
 *
 * The name is fully derivable from the prompt the spawn plan wrote, so derive
 * it instead of asking. The hook only fills a gap — an explicit `name` is
 * always left alone.
 */
import type { SdkOptions } from "../sdk/types.ts";
import { AGENT_SESSION_ID_RE, spawnNameFrom } from "./spawn-names.ts";

type HookResult = Record<string, unknown>;

export function buildSpawnNameHook(): NonNullable<SdkOptions["hooks"]> {
  const onAgentSpawn = async (input: unknown): Promise<HookResult> => {
    try {
      const toolInput = ((input ?? {}) as { tool_input?: unknown })
        .tool_input as Record<string, unknown> | undefined;
      if (!toolInput) return {};
      if (typeof toolInput.name === "string" && toolInput.name !== "") return {};
      // Only console seats get a name — an ad-hoc Agent call the Orchestrator
      // makes for itself has no session to belong to and stays anonymous.
      const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";
      if (!AGENT_SESSION_ID_RE.test(prompt)) return {};
      const name = spawnNameFrom(toolInput);
      if (name === null) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { ...toolInput, name },
        },
      };
    } catch (error) {
      console.error("spawn-name hook failed:", error);
      return {};
    }
  };

  return {
    PreToolUse: [{ matcher: "Agent|Task", hooks: [onAgentSpawn] }],
  } as NonNullable<SdkOptions["hooks"]>;
}
