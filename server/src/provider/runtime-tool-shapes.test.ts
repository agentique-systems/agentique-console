/**
 * The runtime-tool shapes through the real SDK MCP layer: every executable
 * runtime tool and `return_result` register on an in-process server built by
 * the pinned SDK, list as JSON Schema a Claude tool definition accepts (an
 * object schema, no type arrays, every field described), carry the
 * always-load marker, and validate a well-formed call while refusing a
 * malformed one before any handler runs. This is the regression for the
 * failure the first live smoke found: a schema the MCP layer cannot render
 * makes the whole server list no tools.
 */
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXECUTABLE_RUNTIME_TOOLS } from "@agentique-console/core";
import { describe, expect, it } from "vitest";
import { RETURN_RESULT_SHAPE, RUNTIME_TOOL_INPUT_SHAPES } from "./runtime-tool-shapes.ts";

async function listed() {
  const calls: { name: string; args: unknown }[] = [];
  const handler = async (args: unknown) => {
    calls.push({ name: "handler", args });
    return { content: [{ type: "text" as const, text: "ok" }] };
  };
  const tools = [...EXECUTABLE_RUNTIME_TOOLS.map((name) => ({ name, description: `runtime tool ${name}`, inputSchema: RUNTIME_TOOL_INPUT_SHAPES[name], handler })), { name: "return_result", description: "the result", inputSchema: RETURN_RESULT_SHAPE, handler }];
  const server = createSdkMcpServer({ name: "agentique", version: "1.0.0", alwaysLoad: true, tools: tools as never });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "probe", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, calls, tools: (await client.listTools()).tools };
}

describe("runtime tool shapes on the real SDK MCP layer", () => {
  it("lists every runtime tool and return_result as an object JSON Schema with described fields and the always-load marker", async () => {
    const { client, tools } = await listed();
    try {
      expect(tools.map((t) => t.name).sort()).toEqual([...EXECUTABLE_RUNTIME_TOOLS, "return_result"].sort());
      for (const tool of tools) {
        const schema = tool.inputSchema as { type?: unknown; properties?: Record<string, unknown> };
        expect(schema.type, tool.name).toBe("object");
        expect(JSON.stringify(schema), tool.name).not.toMatch(/"type":\[/);
        expect(tool._meta, tool.name).toEqual({ "anthropic/alwaysLoad": true });
        if (tool.name !== "request_completion") expect(Object.keys(schema.properties ?? {}).length, tool.name).toBeGreaterThan(0);
      }
      const result = tools.find((t) => t.name === "return_result")!.inputSchema as { required?: string[]; properties: Record<string, { description?: string }> };
      expect(result.required?.sort()).toEqual(["artifactIds", "blocker", "evaluation", "evidence", "finalReport", "openItems", "routeSelection", "runOutcome", "status", "summary", "tasks"]);
      for (const [field, property] of Object.entries(result.properties)) expect(property.description, field).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it("validates a call against the shape before the handler: a well-formed result reaches it, a malformed one is refused with the MCP validation error", async () => {
    const { client, calls } = await listed();
    try {
      const ok = await client.callTool({ name: "return_result", arguments: { status: "completed", artifactIds: [], tasks: [], evidence: [], summary: "done", openItems: [], blocker: null, runOutcome: null, routeSelection: null, evaluation: null, finalReport: null } });
      expect(ok.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      const malformed = await client.callTool({ name: "return_result", arguments: { status: "completed" } });
      expect(malformed.isError).toBe(true);
      expect(JSON.stringify(malformed.content)).toMatch(/Invalid arguments|validation/i);
      expect(calls).toHaveLength(1);
      const badLimit = await client.callTool({ name: "read_tasks", arguments: { limit: "five" } });
      expect(badLimit.isError).toBe(true);
      const decision = await client.callTool({ name: "request_decision", arguments: { kind: "operator_choice", question: "Which?", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }], resolutionPolicy: { kind: "operator_required" }, affects: { requirementIds: [], taskIds: [], planNodeIds: [] } } });
      expect(decision.isError).toBeFalsy();
      expect(calls).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
