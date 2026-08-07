import { z } from "zod";
import type { ConsoleSdk, SdkToolResult } from "../sdk/types.ts";
import type { ManagerService } from "./manager.ts";

const ok = (value: unknown): SdkToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
export function buildManagerMcpServer(sdk: ConsoleSdk, manager: ManagerService, sessionId: string): unknown {
  return sdk.createSdkMcpServer({ name: "profile_manager", version: "1.0.0", tools: [
    sdk.tool("read_profile_proposal", "Read the current staged profile diff and validation issues.", {}, async () => ok(manager.proposal(sessionId))),
    sdk.tool("stage_profile_file", "Create or replace one file in the staged profile bundle. This never writes the workspace until the operator approves the plan.", { path: z.string(), content: z.string() }, async (args: { path: string; content: string }) => ok(manager.stageFile(sessionId, args.path, args.content))),
    sdk.tool("delete_profile_file", "Delete one file from the staged profile bundle.", { path: z.string() }, async (args: { path: string }) => ok(manager.deleteFile(sessionId, args.path))),
    sdk.tool("apply_profile", "After plan approval, atomically apply the valid staged bundle to the workspace. The new revision remains untrusted.", {}, async () => ok(manager.apply(sessionId))),
  ] });
}
