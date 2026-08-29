/**
 * Import-boundary and terminology enforcement for the new source
 * (`core/`, `server/src/persistence/`, `server/src/execution/`,
 * `server/src/provider/`), and the independence of the legacy application
 * from it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NEW_SOURCE_DIRS = ["core/src", "server/src/persistence", "server/src/execution", "server/src/provider"];
const LEGACY_SOURCE_DIRS = ["shared/src", "server/src", "web/src", "server/scripts", "server/evals"];

function listFiles(dir: string, filter: (file: string) => boolean): string[] {
  const absolute = path.join(repoRoot, dir);
  if (!fs.existsSync(absolute)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (filter(full)) {
        out.push(full);
      }
    }
  };
  walk(absolute);
  return out;
}

const isSource = (file: string) => /\.(ts|tsx|mts|cts|sql|json)$/.test(file);
const isCode = (file: string) => /\.(ts|tsx|mts|cts)$/.test(file);
const rel = (file: string) => path.relative(repoRoot, file).replaceAll("\\", "/");

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(match[1]!);
  return specifiers;
}

function resolvesInto(file: string, specifier: string, dir: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = path.resolve(path.dirname(file), specifier);
  return rel(target).startsWith(`${dir}/`) || rel(target) === dir;
}

const newFiles = NEW_SOURCE_DIRS.flatMap((dir) => listFiles(dir, isCode));
const legacyFiles = LEGACY_SOURCE_DIRS.flatMap((dir) => listFiles(dir, isCode)).filter((file) => !NEW_SOURCE_DIRS.some((dir) => rel(file).startsWith(`${dir}/`)));

describe("import boundaries", () => {
  it("scans the new source", () => {
    expect(newFiles.length).toBeGreaterThan(20);
    expect(legacyFiles.length).toBeGreaterThan(50);
  });

  it("core imports no other workspace package, no Node built-in, and nothing outside core", () => {
    for (const file of listFiles("core/src", isCode)) {
      const isTest = file.endsWith(".test.ts");
      for (const specifier of importsOf(file)) {
        expect(specifier, `${rel(file)} imports ${specifier}`).not.toMatch(/^@agentique-console\/(shared|server|web)/);
        expect(specifier, `${rel(file)} imports ${specifier}`).not.toMatch(/^(\.\.\/)+(shared|server|web)\//);
        if (!isTest) {
          expect(specifier, `${rel(file)} imports Node-only ${specifier}`).not.toMatch(/^node:/);
          expect(["zod"].includes(specifier) || specifier.startsWith("./"), `${rel(file)} imports ${specifier}`).toBe(true);
        }
      }
    }
  });

  it("persistence, execution, and provider import neither the legacy shared package, server/src/db, nor legacy runtime modules", () => {
    const forbiddenPackages = /^@agentique-console\/shared/;
    const forbiddenLegacyDirs = [
      "server/src/db",
      "server/src/agent-sessions",
      "server/src/agent-profiles",
      "server/src/sessions",
      "server/src/orchestrator",
      "server/src/lane-runtime",
      "server/src/continuation",
      "server/src/completion",
      "server/src/compose",
      "server/src/portfolio",
      "server/src/timeline",
      "server/src/system",
      "server/src/sdk",
      "server/src/events",
      "server/src/handoffs",
      "server/src/tasks",
      "server/src/capacity",
      "server/src/workspaces",
      "server/src/runtime",
      "server/src/api",
      "shared/src",
    ];
    const forbiddenLegacyFiles = ["server/src/app.ts", "server/src/boot.ts", "server/src/main.ts", "server/src/context.ts", "server/src/recovery.ts", "server/src/test-helpers.ts", "server/src/ids.ts", "server/src/errors.ts", "server/src/paging.ts"];
    for (const file of [...listFiles("server/src/persistence", isCode), ...listFiles("server/src/execution", isCode), ...listFiles("server/src/provider", isCode)]) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${rel(file)} imports ${specifier}`).not.toMatch(forbiddenPackages);
        for (const dir of forbiddenLegacyDirs) expect(resolvesInto(file, specifier, dir), `${rel(file)} imports ${specifier} (${dir})`).toBe(false);
        for (const legacy of forbiddenLegacyFiles) {
          const target = specifier.startsWith(".") ? rel(path.resolve(path.dirname(file), specifier)) : specifier;
          expect(target, `${rel(file)} imports ${specifier}`).not.toBe(legacy);
        }
      }
    }
  });

  it("the execution boundary depends only on core, the persistence boundary, the provider contract, and itself", () => {
    const files = listFiles("server/src/execution", isCode);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const isTest = file.endsWith(".test.ts");
      for (const specifier of importsOf(file)) {
        if (isTest && (specifier === "vitest" || specifier.startsWith("node:"))) continue;
        const allowed =
          specifier === "@agentique-console/core" ||
          specifier === "zod" ||
          resolvesInto(file, specifier, "server/src/execution") ||
          resolvesInto(file, specifier, "server/src/persistence") ||
          resolvesInto(file, specifier, "server/src/provider");
        expect(allowed, `${rel(file)} imports ${specifier}`).toBe(true);
      }
    }
    // Nothing legacy reaches the execution boundary, and neither the persistence nor the provider boundary depends on it.
    for (const file of [...legacyFiles, ...listFiles("server/src/persistence", isCode), ...listFiles("server/src/provider", isCode)]) {
      for (const specifier of importsOf(file)) {
        expect(resolvesInto(file, specifier, "server/src/execution"), `${rel(file)} imports ${specifier}`).toBe(false);
      }
    }
  });

  it("the provider boundary depends only on core, the continuation index, Node built-ins, and itself, and makes no semantic decision", () => {
    const files = listFiles("server/src/provider", isCode);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const isTest = file.endsWith(".test.ts");
      for (const specifier of importsOf(file)) {
        if (isTest && (specifier === "vitest" || resolvesInto(file, specifier, "server/src/persistence") || resolvesInto(file, specifier, "server/src/execution"))) continue;
        const allowed =
          specifier === "@agentique-console/core" ||
          specifier === "zod" ||
          specifier.startsWith("node:") ||
          resolvesInto(file, specifier, "server/src/provider") ||
          // The continuation index is the one canonical row the adapter owns (execution-model §6.6).
          rel(path.resolve(path.dirname(file), specifier)) === "server/src/persistence/stores/continuations.ts";
        expect(allowed, `${rel(file)} imports ${specifier}`).toBe(true);
      }
      if (!isTest) {
        const text = fs.readFileSync(file, "utf8");
        // No Run, Plan, Pattern, Invocation, Task, Requirement, Decision, Budget, or retry decision is made by an adapter.
        expect(text, rel(file)).not.toMatch(/\.transition\(|createAttempt|reserveOrdinary|reserveFinalInvocation|retryDecision|RETRY_|PATTERNS|planNodes|stores\.(runs|plans|invocations|tasks|requirements|decisions|reservations)/);
      }
    }
    // The persistence boundary never depends on the provider boundary (its tests may drive the fakes).
    for (const file of listFiles("server/src/persistence", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      for (const specifier of importsOf(file)) {
        expect(resolvesInto(file, specifier, "server/src/provider"), `${rel(file)} imports ${specifier}`).toBe(false);
      }
    }
  });

  it("no execution code reads a transcript Artifact or blob to make a decision (invariant 6)", () => {
    for (const file of listFiles("server/src/execution", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, rel(file)).not.toMatch(/artifacts\.read\(|blobs\.get\(|\.transcriptArtifactId\b[^;\n]*\bread|TRANSCRIPT_MEDIA_TYPE[^;\n]*(read|get)\(/);
    }
  });

  it("legacy code imports neither core nor the new persistence boundary", () => {
    for (const file of legacyFiles) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${rel(file)} imports ${specifier}`).not.toMatch(/^@agentique-console\/core/);
        expect(resolvesInto(file, specifier, "server/src/persistence"), `${rel(file)} imports ${specifier}`).toBe(false);
        expect(resolvesInto(file, specifier, "server/src/execution"), `${rel(file)} imports ${specifier}`).toBe(false);
        expect(resolvesInto(file, specifier, "server/src/provider"), `${rel(file)} imports ${specifier}`).toBe(false);
        expect(resolvesInto(file, specifier, "core/src"), `${rel(file)} imports ${specifier}`).toBe(false);
      }
    }
    const legacyPackages = [JSON.parse(fs.readFileSync(path.join(repoRoot, "shared/package.json"), "utf8")), JSON.parse(fs.readFileSync(path.join(repoRoot, "web/package.json"), "utf8"))] as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }[];
    for (const pkg of legacyPackages) {
      expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain("@agentique-console/core");
    }
  });

  it("no runtime path selects between the legacy and the new persistence", () => {
    for (const file of [...newFiles, ...legacyFiles]) {
      if (rel(file) === "server/src/persistence/boundaries.test.ts") continue;
      const text = fs.readFileSync(file, "utf8");
      expect(text, rel(file)).not.toMatch(/legacyMode|CONSOLE_USE_|X-Console-Compat|useLegacy|usePersistence|CONSOLE_PERSISTENCE/);
    }
  });

  it("the legacy migrations never create a new-schema table, so the legacy application never writes it", () => {
    const legacySql = listFiles("server/src/db/migrations", (f) => f.endsWith(".sql")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(legacySql.length).toBeGreaterThan(0);
    for (const table of ["schema_info", "runs", "plan_nodes", "plan_edges", "plan_node_requirements", "invocations", "attempts", "provider_continuations", "context_manifests", "budget_reservations", "capacity_leases", "usage", "conversations", "conversation_messages"]) {
      expect(legacySql, table).not.toMatch(new RegExp(`CREATE TABLE \`?${table}\`? `));
    }
    const newSql = fs.readFileSync(path.join(repoRoot, "server/src/persistence/migrations/0000_orchestration_core.sql"), "utf8");
    for (const table of ["user_sessions", "agent_sessions", "agents", "mailbox_deliveries", "handoff_records", "usage_samples", "provider_entries"]) {
      expect(newSql, table).not.toMatch(new RegExp(`CREATE TABLE \`?${table}\`? `));
    }
  });

  it("core exports nothing under a legacy or compatibility name", () => {
    const index = fs.readFileSync(path.join(repoRoot, "core/src/index.ts"), "utf8");
    expect(index).not.toMatch(/\bas\s+\w+/);
    for (const file of newFiles) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, rel(file)).not.toMatch(/export\s*\{[^}]*\bas\s+(Old|Legacy|Compat)\w*/);
      expect(rel(file), rel(file)).not.toMatch(/(^|\/)(v2|next|new|legacy|old|compat)[-_/.]/i);
    }
  });
});

describe("terminology", () => {
  const RETIRED = [
    /\bUserSession\b/,
    /\bAgentSession\b/,
    /\buser_session\b/,
    /\bagent_session\b/,
    /\bseat\b/i,
    /\blane\b/i,
    /\bgeneration\b/i,
    /\battention\b/i,
    /\bwake\b/i,
    /\bmailbox\b/i,
    /\bmailroom\b/i,
    /\broster\b/i,
    /\bcommission\b/i,
    /\btopology\b/i,
    /\bworkstream\b/i,
    /\bspecialist\b/i,
    /\bcheckpoint\b/i,
    /\bdelegation edge\b/i,
    /\bhandoff (core|extension)\b/i,
    /\bmap_reduce\b/,
    /\bhub_and_spoke\b/,
    /\bpeer_to_peer\b/,
    /\bplan_execute\b/,
    /\bdebate\b/i,
    /\bpipeline\b/i,
    /\blanding\b/i,
    /\brotation\b/i,
    /\bdeferrable\b/i,
    /\bin_progress\b/,
    /\btrusted\b/i,
  ];
  /** Lines that name a retired term only to forbid or test it. */
  const ALLOWED_CONTEXT = /(retired|forbid|prohib|never|not |reject|toThrow|expect\(|CHECK|no \w+ table|legacy|\/\/ )/i;

  it("is absent from the new source, schema, migration, and tests except where a term is explicitly prohibited", () => {
    const files = NEW_SOURCE_DIRS.flatMap((dir) => listFiles(dir, isSource));
    const offences: string[] = [];
    for (const file of files) {
      if (rel(file) === "server/src/persistence/boundaries.test.ts") continue;
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const term of RETIRED) {
          if (term.test(line) && !ALLOWED_CONTEXT.test(line)) offences.push(`${rel(file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offences).toEqual([]);
  });

  it("does not model a domain Session type", () => {
    const index = fs.readFileSync(path.join(repoRoot, "core/src/index.ts"), "utf8");
    const exported = listFiles("core/src", (f) => isCode(f) && !f.endsWith(".test.ts")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(index).not.toMatch(/session/i);
    expect(exported).not.toMatch(/export (interface|type|class) \w*Session\w*/);
  });
});
