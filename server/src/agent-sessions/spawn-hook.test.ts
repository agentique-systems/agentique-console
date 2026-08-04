/**
 * The Agent-tool `name` injection. Losing `name` is invisible in the console —
 * the runner recovers it from the prompt for its own attribution, so the panes
 * look right while the SDK holds no address and every SendMessage between
 * seats silently misses.
 */
import { describe, expect, it } from "vitest";
import { buildSpawnNameHook } from "./spawn-hook.ts";
import { spawnNameOf } from "./spawn-names.ts";

const AS_ID = "as_e3f78fb84c614c9dabe4";

type PreToolUseHook = (input: unknown) => Promise<Record<string, unknown>>;

function hook(): PreToolUseHook {
  const hooks = buildSpawnNameHook() as {
    PreToolUse: { hooks: PreToolUseHook[] }[];
  };
  return hooks.PreToolUse[0]?.hooks[0] as PreToolUseHook;
}

const run = (toolInput: Record<string, unknown>) =>
  hook()({ tool_name: "Agent", tool_input: toolInput });

function injectedName(result: Record<string, unknown>): string | undefined {
  const specific = result.hookSpecificOutput as
    | { updatedInput?: Record<string, unknown> }
    | undefined;
  return specific?.updatedInput?.name as string | undefined;
}

describe("spawn-name hook", () => {
  it("names a seat spawn from the prompt the spawn plan wrote", async () => {
    const seat = spawnNameOf(AS_ID, "collision");
    const result = await run({
      description: "S1 collision seat",
      subagent_type: "implementer-planning",
      run_in_background: true,
      prompt: `You are seat "collision" (spawn name ${seat}) in Agent session ${AS_ID} "S1 · Core Sim". Coordinator: ${spawnNameOf(AS_ID, "coordinator")}.`,
    });
    expect(injectedName(result)).toBe(seat);
  });

  it("names the coordinator, whose prompt carries no (spawn name …)", async () => {
    const coordinator = spawnNameOf(AS_ID, "coordinator");
    const result = await run({
      description: "S1 coordinator",
      subagent_type: "session-orchestrator",
      prompt: `You coordinate Agent session ${AS_ID} "S1 · Core Sim". Coordinator: ${coordinator}. Seats: ${spawnNameOf(AS_ID, "pmove")}.`,
    });
    expect(injectedName(result)).toBe(coordinator);
  });

  it("leaves an explicit name alone", async () => {
    const result = await run({
      name: "chosen-by-the-model",
      subagent_type: "implementer",
      prompt: `seat (spawn name ${spawnNameOf(AS_ID, "pmove")}) in ${AS_ID}`,
    });
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it("ignores an Agent call that belongs to no console session", async () => {
    const result = await run({
      description: "ad-hoc helper",
      subagent_type: "general-purpose",
      prompt: "Go read the docs and report back.",
    });
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it("ignores a session spawn whose prompt names no seat", async () => {
    const result = await run({
      subagent_type: "implementer",
      prompt: `Something about Agent session ${AS_ID} with no seat marker.`,
    });
    expect(result.hookSpecificOutput).toBeUndefined();
  });
});
