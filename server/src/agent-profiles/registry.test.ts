import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileRegistry } from "./registry.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("AgentProfileRegistry", () => {
  it("loads validated custom profiles without allowing built-in replacement", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-profiles-")); dirs.push(dir);
    const file = path.join(dir, "profiles.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "schema-reviewer", title: "Schema reviewer", purpose: "Review schemas", instructions: "Review only.", tools: ["Read"], permissionMode: "default", sandboxRequired: true, runtime: { shell: false, browser: false, screenshots: false } }]));
    const registry = new AgentProfileRegistry(file);
    expect(registry.get("schema-reviewer").purpose).toBe("Review schemas");
    expect(registry.get("frontend-implementer").runtime.browser).toBe(true);

    fs.writeFileSync(file, JSON.stringify([{ ...registry.get("explorer"), title: "replacement" }]));
    expect(() => new AgentProfileRegistry(file)).toThrow(/cannot replace built-in/);
  });
});

