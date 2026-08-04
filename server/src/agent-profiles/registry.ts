import fs from "node:fs";
import { z } from "zod";

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  purpose: z.string().min(1),
  instructions: z.string().min(1),
  tools: z.array(z.string()).min(1),
  permissionMode: z.enum(["default", "plan", "bypassPermissions"]),
  model: z.string().optional(),
  effort: z.string().optional(),
  maxTurns: z.number().int().min(1).max(100).default(40),
  sandboxRequired: z.boolean().default(true),
  runtime: z.object({
    shell: z.boolean().default(false),
    browser: z.boolean().default(false),
    screenshots: z.boolean().default(false),
  }),
});

export type AgentProfile = z.infer<typeof ProfileSchema>;

const READ_TOOLS = ["Read", "Glob", "Grep"];
const CODE_TOOLS = [...READ_TOOLS, "Edit", "Write", "Bash"];

const BUILTINS: AgentProfile[] = [
  {
    id: "coordinator",
    title: "Coordinator",
    purpose: "Own a bounded workstream, assign each unit once, integrate results, and report milestones.",
    instructions: "You are the sole coordinator for this AgentSession. You own decomposition and integration. Send assignments only to your specialists. Do not implement their work, broadcast status, or repeat unchanged information. Report to main only for a blocking decision, material failure, milestone, or final result.",
    tools: READ_TOOLS,
    permissionMode: "default",
    maxTurns: 35, sandboxRequired: true,
    runtime: { shell: false, browser: false, screenshots: false },
  },
  {
    id: "explorer",
    title: "Explorer",
    purpose: "Trace code and runtime behavior and return concrete evidence without editing.",
    instructions: "Inspect only the assigned scope. Cite concrete files, symbols, commands, and observations. Do not edit files. Return one concise findings report to your coordinator.",
    tools: READ_TOOLS,
    permissionMode: "default",
    maxTurns: 30, sandboxRequired: true,
    runtime: { shell: false, browser: false, screenshots: false },
  },
  {
    id: "implementer",
    title: "Implementer",
    purpose: "Implement and validate a clearly owned code change.",
    instructions: "You exclusively own the assigned files or component. Inspect before editing, preserve unrelated changes, implement the smallest complete change, and run relevant validation. Report changed files, tests, and remaining risks.",
    tools: CODE_TOOLS,
    permissionMode: "bypassPermissions",
    maxTurns: 50, sandboxRequired: true,
    runtime: { shell: true, browser: false, screenshots: false },
  },
  {
    id: "frontend-implementer",
    title: "Frontend implementer",
    purpose: "Implement frontend behavior and validate the rendered application.",
    instructions: "Own the assigned frontend slice. Run the application, inspect browser behavior and screenshots when available, test interactions, and report concrete validation rather than visual guesses.",
    tools: CODE_TOOLS,
    permissionMode: "bypassPermissions",
    maxTurns: 50, sandboxRequired: true,
    runtime: { shell: true, browser: true, screenshots: true },
  },
  {
    id: "reviewer",
    title: "Reviewer",
    purpose: "Review a completed change and report actionable defects with evidence.",
    instructions: "Review only; do not edit. Inspect the diff, run relevant validation, and report defects by severity with file references and reproduction evidence. Say explicitly when no defect is found.",
    tools: [...READ_TOOLS, "Bash"],
    permissionMode: "default",
    maxTurns: 35, sandboxRequired: true,
    runtime: { shell: true, browser: false, screenshots: false },
  },
  {
    id: "visual-reviewer",
    title: "Visual reviewer",
    purpose: "Inspect a rendered UI through browser interaction and screenshots.",
    instructions: "Review only; do not edit. Exercise the assigned user flow in the browser, capture evidence, inspect console/runtime errors, and report concrete visual or interaction defects.",
    tools: [...READ_TOOLS, "Bash"],
    permissionMode: "default",
    maxTurns: 35, sandboxRequired: true,
    runtime: { shell: true, browser: true, screenshots: true },
  },
  {
    id: "researcher",
    title: "Researcher",
    purpose: "Gather focused external or repository evidence for one decision.",
    instructions: "Research only the assigned question. Prefer primary sources, separate facts from inference, and return a concise recommendation with evidence.",
    tools: [...READ_TOOLS, "WebSearch", "WebFetch"],
    permissionMode: "default",
    maxTurns: 30, sandboxRequired: true,
    runtime: { shell: false, browser: false, screenshots: false },
  },
];

export class AgentProfileRegistry {
  readonly #profiles: ReadonlyMap<string, AgentProfile>;

  constructor(profilesFile: string) {
    const profiles = new Map(BUILTINS.map((profile) => [profile.id, Object.freeze(profile)]));
    if (fs.existsSync(profilesFile)) {
      const parsed = z.array(ProfileSchema).parse(JSON.parse(fs.readFileSync(profilesFile, "utf8")));
      for (const profile of parsed) {
        if (profiles.has(profile.id)) {
          throw new Error(`custom agent profile cannot replace built-in \"${profile.id}\"`);
        }
        profiles.set(profile.id, Object.freeze(profile));
      }
    }
    this.#profiles = profiles;
  }

  get(id: string): AgentProfile {
    const profile = this.#profiles.get(id);
    if (!profile) throw new Error(`unknown agent profile \"${id}\"`);
    return profile;
  }

  list(): AgentProfile[] {
    return [...this.#profiles.values()];
  }
}
