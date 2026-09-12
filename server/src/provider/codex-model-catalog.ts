import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const run = promisify(execFile);
const catalogSchema = z.object({ models: z.array(z.looseObject({ slug: z.string() })) });

/**
 * Model metadata can override CLI feature flags (notably apply_patch, tool mode,
 * and multi-agent mode). Use the installed CLI's own offline catalog, retaining
 * model prompts/tuning but removing unmediated execution surfaces. This file is
 * deliberately isolated alongside the pinned SDK's offline wire contract.
 */
export async function guardedCodexCatalog(directory: string, model: string, env: Record<string, string>, signal: AbortSignal, binary?: string): Promise<{ filename: string; close(): Promise<void> }> {
  const require = createRequire(import.meta.url);
  const launcher = binary ?? process.execPath;
  const args = binary ? [] : [path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js")];
  const { stdout } = await run(launcher, [...args, "debug", "models", "--bundled"], { env, signal, windowsHide: true, timeout: 15_000, maxBuffer: 8_388_608 });
  const catalog = catalogSchema.parse(JSON.parse(stdout));
  const selected = catalog.models.find((entry) => entry.slug === model);
  if (!selected) throw new Error("invalid request: selected Codex model is absent from the installed CLI catalog; update the pinned SDK before enabling this model");
  const guarded = {
    ...selected, apply_patch_tool_type: null, shell_type: "disabled", tool_mode: "direct", multi_agent_version: "disabled",
    supports_search_tool: false, experimental_supported_tools: [],
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
  };
  const filename = path.join(directory, `agentique-model-${randomUUID()}.json`);
  await fs.writeFile(filename, JSON.stringify({ models: [guarded] }), { mode: 0o600, flag: "wx", signal });
  return { filename, close: () => fs.unlink(filename) };
}
