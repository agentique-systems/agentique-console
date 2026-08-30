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

  it("the scheduler, join settler, and Pattern runners import nothing legacy, poll nothing, and implement only the supported Patterns", () => {
    const files = [...listFiles("server/src/execution/patterns", isCode), path.join(repoRoot, "server/src/execution/scheduler.ts"), path.join(repoRoot, "server/src/execution/join.ts"), path.join(repoRoot, "server/src/execution/readiness.ts"), path.join(repoRoot, "server/src/execution/readiness-facts.ts"), path.join(repoRoot, "server/src/execution/handoff-routing.ts"), path.join(repoRoot, "server/src/execution/integration-service.ts"), path.join(repoRoot, "server/src/execution/task-projection.ts"), path.join(repoRoot, "server/src/execution/task-proposals.ts"), path.join(repoRoot, "server/src/execution/runtime-tools.ts"), path.join(repoRoot, "server/src/execution/acceptance-checks.ts")];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (file.endsWith(".test.ts") && (specifier === "vitest" || specifier.startsWith("node:"))) continue;
        const allowed = specifier === "@agentique-console/core" || specifier === "zod" || resolvesInto(file, specifier, "server/src/execution") || resolvesInto(file, specifier, "server/src/persistence") || resolvesInto(file, specifier, "server/src/provider");
        expect(allowed, `${rel(file)} imports ${specifier}`).toBe(true);
      }
      if (file.endsWith(".test.ts")) continue;
      const text = fs.readFileSync(file, "utf8");
      // Event-driven, never polling: no timer, interval, or sleep anywhere in the runtime.
      expect(text, rel(file)).not.toMatch(/setTimeout|setInterval|setImmediate|sleep\(/);
      // Nothing schedules from a transcript, an Event replay, or a rendered position string.
      expect(text, rel(file)).not.toMatch(/journal\.read\(|renderPatternPosition|TRANSCRIPT_MEDIA_TYPE/);
    }
    // Every one of the six Patterns has a runner file and a runner registration; nothing is deferred.
    const runnerFiles = listFiles("server/src/execution/patterns", (f) => isCode(f) && !f.endsWith(".test.ts")).map((f) => path.basename(f)).sort();
    expect(runnerFiles).toEqual(["chain.ts", "coordinator-worker.ts", "evaluator-optimizer.ts", "index.ts", "parallel.ts", "root.ts", "route.ts", "single.ts", "support.ts"]);
    const registry = fs.readFileSync(path.join(repoRoot, "server/src/execution/patterns/index.ts"), "utf8");
    for (const supported of ["single", "chain", "route", "parallel", "coordinator_worker", "evaluator_optimizer"]) expect(registry).toMatch(new RegExp(`case "${supported}"`));
    expect(`${registry}\n${fs.readFileSync(path.join(repoRoot, "server/src/execution/readiness.ts"), "utf8")}\n${fs.readFileSync(path.join(repoRoot, "server/src/execution/scheduler.ts"), "utf8")}`).not.toMatch(/later_phase|SUPPORTED_PATTERNS|SUPPORTED_EDGE_TYPES/);
    // The readiness evaluator is pure over the graph plus explicit facts: no persistence, provider, Workspace, clock, or id minting; the
    // facts projection is the one reader of rows and reads only route-selection and optimizer-verdict Evaluations (never a transcript,
    // Handoff summary, or Event).
    const readiness = fs.readFileSync(path.join(repoRoot, "server/src/execution/readiness.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(importsOf(path.join(repoRoot, "server/src/execution/readiness.ts"))).toEqual(["@agentique-console/core"]);
    expect(readiness).not.toMatch(/\bstores\b|\bctx\b|clock\(|newId\(|\.ids\(|Date\.|journal|\.execute\(|\.prepare\(|\.apply\(|sourcePath/);
    const facts = fs.readFileSync(path.join(repoRoot, "server/src/execution/readiness-facts.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(facts).toMatch(/stores\.evaluations\.routeSelectionsOf\(/);
    expect(facts).toMatch(/stores\.evaluations\.optimizerVerdictsOf\(/);
    expect(facts).not.toMatch(/stores\.(invocations|handoffs|artifacts|tasks|decisions|runs)\b|journal|transcript|summary|artifacts\.read\(/);
    // The evaluator_optimizer runner decides every round from Evaluation rows: never from a status alone, a summary, a transcript, an Event, or a source path.
    const optimizer = fs.readFileSync(path.join(repoRoot, "server/src/execution/patterns/evaluator-optimizer.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(optimizer).not.toMatch(/journal\.read\(|\.summary\b|TRANSCRIPT_MEDIA_TYPE|artifacts\.read\(|result\.openItems|result\.blocker|sourcePath|setTimeout|setInterval/);
    // The Acceptance Criterion execution port depends on core alone and names no persistence, storage, transcript, or Target write concept.
    const checkPortFile = path.join(repoRoot, "server/src/execution/ports/acceptance-criterion-execution.ts");
    expect(importsOf(checkPortFile)).toEqual(["@agentique-console/core"]);
    const checkPort = fs.readFileSync(checkPortFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(checkPort).not.toMatch(/PersistenceContext|\bStores\b|ArtifactStore|BlobStore|Database|better-sqlite3|drizzle|storageKey|\btx\b|transcript|continuation|artifactId|target/i);
    // The check service records only ids, exit status, digest, size, and truncation outside the output Artifact: no output bytes reach an outcome or an Event.
    const checkService = fs.readFileSync(path.join(repoRoot, "server/src/execution/acceptance-checks.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(checkService).toMatch(/if \(this\.ctx\.tx\.inTransaction\) throw/);
    expect(checkService).not.toMatch(/journal\.read\(|transcript|TextDecoder|toString\(\)|summary/);
    expect(checkService.slice(checkService.indexOf("export type AcceptanceCheckOutcome"), checkService.indexOf("export class AcceptanceCheckService"))).not.toMatch(/output|bytes|Uint8Array/);
    // A join never touches the executor, the governor, or a provider: no Invocation, Attempt, lease, or Usage.
    const join = fs.readFileSync(path.join(repoRoot, "server/src/execution/join.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(join).not.toMatch(/executor|governor|provider|invocations\.create|createAttempt|tryAcquire|usage\.record|preparation/);
    // The Task projection is pure over explicit facts: its one store reader is the projector, which reads Tasks, dependency edges, and Artifact ids only.
    const projection = fs.readFileSync(path.join(repoRoot, "server/src/execution/task-projection.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(projection.slice(projection.indexOf("export function projectTasks"), projection.indexOf("export function projectNodeTasks"))).not.toMatch(/\bstores\b|\bctx\b|clock\(|journal|invocations\.|handoffs\.|changesets\.|transcript/);
    expect(projection.slice(projection.indexOf("export function projectNodeTasks"))).not.toMatch(/stores\.(invocations|handoffs|changesets|decisions|runs)\b|journal|transcript|summary/);
    // The coordinator_worker runner never reads a transcript, a Handoff summary, or an Event to decide anything, and infers no Task state from a Coordinator claim.
    const coordinator = fs.readFileSync(path.join(repoRoot, "server/src/execution/patterns/coordinator-worker.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(coordinator).not.toMatch(/journal\.read\(|\.summary\b|TRANSCRIPT_MEDIA_TYPE|artifacts\.read\(|result\.openItems|setTimeout|setInterval/);
    // The provider boundary never imports the scheduler or the stores; the persistence boundary never imports execution (checked above too).
    for (const file of listFiles("server/src/provider", isCode)) {
      for (const specifier of importsOf(file)) {
        expect(resolvesInto(file, specifier, "server/src/execution"), `${rel(file)} imports ${specifier}`).toBe(false);
      }
    }
  });

  it("no execution code reads a transcript Artifact or blob to make a decision (invariant 6)", () => {
    for (const file of listFiles("server/src/execution", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      const text = fs.readFileSync(file, "utf8");
      // The integration service is the one reader of Artifact content: it delivers a Changeset's verified diff to the
      // Integration Workspace (§9.2) and decides nothing from the bytes; it never touches a transcript.
      if (rel(file) === "server/src/execution/integration-service.ts") {
        expect(text, rel(file)).not.toMatch(/blobs\.get\(|transcript|TRANSCRIPT_MEDIA_TYPE/i);
        continue;
      }
      expect(text, rel(file)).not.toMatch(/artifacts\.read\(|blobs\.get\(|\.transcriptArtifactId\b[^;\n]*\bread|TRANSCRIPT_MEDIA_TYPE[^;\n]*(read|get)\(/);
    }
  });

  it("the runtime-tool port exposes only the effective callable set and one call, and only the execution boundary binds it", () => {
    const adapter = fs.readFileSync(path.join(repoRoot, "server/src/provider/adapter.ts"), "utf8");
    const port = adapter.match(/export interface RuntimeToolCallPort \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(port).toMatch(/readonly tools: readonly RuntimeToolCallTool\[\];/);
    const members = port.replace(/\/\*[\s\S]*?\*\//g, "").match(/^\s*(readonly\s+)?\w+(\(.*\))?:.*;$/gm) ?? [];
    expect(members.map((m) => m.trim())).toEqual(["readonly tools: readonly RuntimeToolCallTool[];", "call(request: RuntimeToolCallRequest): Promise<RuntimeToolCallOutcome>;"]);
    // Provider code never constructs, imports, or reaches the executor, a store, a proposal service, or a transaction; it calls the port only.
    for (const file of listFiles("server/src/provider", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, rel(file)).not.toMatch(/RuntimeToolExecutor|TaskProposalService|runtimeToolCalls\.(record|find)|tx\.write|persistence\/(stores\/(?!continuations)|blob-store|database|client|schema|context|transactions)/);
    }
    // The executor is the one binder: it is constructed in the Attempt executor from the Attempt's canonical rows, nowhere else outside tests and test support.
    const binders = listFiles("server/src", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts")).filter((f) => /new RuntimeToolExecutor\(/.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(binders).toEqual(["server/src/execution/attempt-executor.ts"]);
    const executor = fs.readFileSync(path.join(repoRoot, "server/src/execution/runtime-tools.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // The port's runtime does not authorize provider-native calls and never touches approvals, Decisions, transcripts, or side-effect approval state.
    expect(executor).not.toMatch(/approvedToolCallUses|ToolCallAuthorizer|side_effect_approval|TRANSCRIPT_MEDIA_TYPE|artifacts\.read\(|decisions\.(request|resolve)/);
    // Runtime tools are closed unions in core: no free tool name, no `unknown` input at the boundary.
    const core = fs.readFileSync(path.join(repoRoot, "core/src/runtime-tools.ts"), "utf8");
    expect(core).toMatch(/export type RuntimeToolCallRequest = \{ tool: "propose_tasks"; input: TaskProposalBatch \} \| \{ tool: "update_task"; input: TaskUpdateRequest \};/);
    expect(core).not.toMatch(/input: unknown|tool: string;/);
  });

  it("the integration-workspace port carries verified content bound to one Artifact, and only the integration service binds it", () => {
    const portFile = path.join(repoRoot, "server/src/execution/ports/integration-workspace.ts");
    const port = fs.readFileSync(portFile, "utf8");
    // The port depends on core alone and names no persistence, storage, database, or transaction concept an adapter could reach.
    expect(importsOf(portFile)).toEqual(["@agentique-console/core"]);
    expect(port).not.toMatch(/PersistenceContext|\bStores\b|ArtifactStore|BlobStore|Database|better-sqlite3|drizzle|storageKey|blobKey|\btx\b|transaction\(/);
    // The content source is bound to exactly one Artifact: one parameterless read, no lookup by id, no enumeration.
    const source = port.match(/export interface ArtifactContentSource \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(source).toMatch(/readonly artifactId: ArtifactId;/);
    expect(source).toMatch(/readonly digest: string;/);
    expect(source).toMatch(/readonly byteSize: number;/);
    const methods = source.replace(/\/\*[\s\S]*?\*\//g, "").match(/^\s*\w+\(.*\).*;$/gm) ?? [];
    expect(methods.map((m) => m.trim())).toEqual(["read(): Promise<Uint8Array>;"]);
    // The request carries the content source and no path, key, bare digest, or metadata-only shortcut for the diff.
    const request = port.match(/export interface IntegrationApplyRequest \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(request).toMatch(/diff: ArtifactContentSource;/);
    expect(request).not.toMatch(/diffArtifactId|diffDigest|diffByteSize|diffPath|empty:|blob|key/i);
    // The integration service alone resolves stored content and binds it; the port and every adapter location stay free of persistence.
    const service = fs.readFileSync(path.join(repoRoot, "server/src/execution/integration-service.ts"), "utf8");
    expect(service).toMatch(/implements ArtifactContentSource/);
    expect(service).toMatch(/artifacts\.read\(/);
    for (const file of [...listFiles("server/src/provider", (f) => isCode(f) && !f.endsWith(".test.ts")), ...listFiles("server/src/execution/ports", isCode)]) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, rel(file)).not.toMatch(/artifacts\.read\(|blobs\.get\(|BlobStore|ArtifactStore|persistence\/(stores\/(?!continuations)|blob-store|database|client|schema)|better-sqlite3|drizzle-orm/);
    }
    // The fake Integration Workspace consumes the content source and touches no persistence.
    const support = fs.readFileSync(path.join(repoRoot, "server/src/execution/test-support.ts"), "utf8");
    const fake = support.slice(support.indexOf("export class FakeIntegrationWorkspace"), support.indexOf("export class FakeExecutionWorkspace"));
    expect(fake.length).toBeGreaterThan(100);
    expect(fake).toMatch(/await request\.changeset\.diff\.read\(\)/);
    expect(fake).not.toMatch(/\bstores\b|\bctx\b|\bblobs\b|artifacts\.|sha256Hex|BlobStore|ArtifactStore/);
    // No compatibility path: neither the port nor the service offers a second way to obtain the content.
    expect(`${port}\n${service}`).not.toMatch(/\b(legacy|compat\w*|fallback|shim|deprecated)\b/i);
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
