/**
 * Native cron governance: a PostToolUse mirror of CronCreate/CronDelete into
 * the console's crons table, plus a minimal 5-field matcher for the fallback
 * scheduler. The CLI's own scheduler fires while the lane process lives; a
 * parked or recycled lane loses its in-memory jobs, so the runner's fallback
 * re-fires due crons from the mirror whenever the lane is closed.
 */
import type { Repo } from "../db/repo.ts";
import type { EventBus } from "../events/bus.ts";
import { newId, nowIso } from "../ids.ts";
import type { SdkHookInput, SdkHookOutput, SdkHooksFragment } from "../sdk/types.ts";

export function buildCronHooks(deps: { repo: Repo; bus: EventBus; userSessionId: string }): SdkHooksFragment {
  const mirror = async (input: SdkHookInput): Promise<SdkHookOutput> => {
    try {
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const response = (input.tool_response ?? {}) as Record<string, unknown>;
      if (input.tool_name === "CronCreate") {
        const sdkCronId = typeof response.id === "string" ? response.id : JSON.stringify(response).match(/"id":"([^"]+)"/)?.[1];
        const schedule = typeof toolInput.cron === "string" ? toolInput.cron : "";
        const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";
        if (!sdkCronId || schedule === "" || prompt === "") return {};
        deps.repo.insertCron({ id: newId("cron"), userSessionId: deps.userSessionId, sdkCronId, schedule, prompt,
          oneShot: toolInput.recurring === false, dueAt: null, status: "active", createdAt: nowIso(), updatedAt: nowIso() });
        deps.bus.append({ type: "user_session.runtime", userSessionId: deps.userSessionId,
          payload: { sessionId: deps.userSessionId, detail: `cron mirrored: ${schedule} (${sdkCronId})` } });
      } else if (input.tool_name === "CronDelete") {
        const sdkCronId = typeof toolInput.id === "string" ? toolInput.id : "";
        for (const row of deps.repo.listCrons(deps.userSessionId)) {
          if (row.sdkCronId === sdkCronId) deps.repo.patchCron(row.id, { status: "deleted" });
        }
      }
    } catch (error) {
      console.error("cron mirror failed:", error);
    }
    return {};
  };
  return { PostToolUse: [{ matcher: "CronCreate|CronDelete", hooks: [mirror] }] };
}

/**
 * Minimal 5-field cron matcher (minute hour dom month dow, local time).
 * Supports "*", "*\/n", exact numbers, and comma lists — the shapes models
 * actually write. Unknown syntax never matches (fail-quiet).
 */
export function cronDue(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return fields.every((field, index) => fieldMatches(field as string, values[index] as number));
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) { const n = Number(step[1]); return n > 0 && value % n === 0; }
  return field.split(",").some((part) => {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return /^\d+$/.test(part) && Number(part) === value;
  });
}
