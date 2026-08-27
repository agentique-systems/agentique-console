/**
 * The console tool-description byte budget. Every description and parameter
 * describe here rides main's context on every turn, competing with the
 * native system prompt and the brief for attention — the standing surface
 * holds contracts and one-line invariants; procedure lives in the skills
 * (orchestration-patterns, requirements-mechanics, wrap-up-and-landing).
 * Measured as registered: tool descriptions plus every schema description
 * the provider serializes, nested describes included.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildConsoleMcpServer, type ConsoleToolsInput } from "./tools.ts";

interface CapturedTool {
  name: string;
  description: string;
  schema: Record<string, z.ZodType>;
}

/** Only the construction path runs — handlers never execute, so the stub sdk needs no deps. */
function captureTools(): CapturedTool[] {
  const tools: CapturedTool[] = [];
  const sdk = {
    tool(name: string, description: string, schema: Record<string, z.ZodType>, handler: unknown) {
      const compiled = { name, description, schema, handler };
      tools.push(compiled);
      return compiled;
    },
    createSdkMcpServer(config: unknown) { return config; },
  };
  buildConsoleMcpServer({ sdk } as unknown as ConsoleToolsInput);
  return tools;
}

function describeBytes(schema: z.ZodType): number {
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  let bytes = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "description" && typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
      else walk(value);
    }
  };
  walk(json);
  return bytes;
}

describe("console tool byte budget", () => {
  // Bumped 12000 → 12600 with reconcile_change_impact — a new tool surface
  // (the change-impact ledger's judgment recorder), not creep on existing ones.
  // Bumped 12600 → 14200 with link_workstreams/unlink_workstreams and the
  // portfolio fields on create_agent_session/add_agent — the workstream
  // dependency layer's authoring surface, not creep on existing ones.
  // Bumped 14200 → 15300 with list_decision_issues/resolve_decision_issue/
  // merge_decision_issues and ask_operator's issueKey — the decision-issue
  // layer's binding surface, not creep on existing ones.
  // Bumped 15300 → 15900 with read_continuation — the project continuation
  // checkpoint's read surface, not creep on existing ones.
  // Bumped 15900 → 16200 to state the auto-coordination contract AT the
  // commission affordance (create_agent_session/add_agent): a live run read
  // "hub_and_spoke" as "supply a coordinator too", renamed the coordinator
  // profile past the reserved-name check, and paid for two management layers
  // per session — the one-line invariant belongs where the mistake happens.
  it("keeps total description + parameter-describe bytes within the budget", () => {
    const tools = captureTools();
    expect(tools.length).toBeGreaterThan(20);
    const total = tools.reduce((sum, tool) =>
      sum
      + Buffer.byteLength(tool.description, "utf8")
      + Object.values(tool.schema).reduce((inner, schema) => inner + describeBytes(schema), 0),
    0);
    expect(total).toBeLessThanOrEqual(16_200);
  });
});
