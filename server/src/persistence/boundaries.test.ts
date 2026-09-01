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
const NEW_SOURCE_DIRS = ["core/src", "server/src/persistence", "server/src/execution", "server/src/provider", "server/src/workspace-state", "server/src/agents"];
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
      // Test files and test fixtures (`*test-support.ts`, including the crash suite's child process) may use vitest and Node built-ins.
      const isTest = file.endsWith(".test.ts") || file.endsWith("test-support.ts");
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
        // Tests may drive the persistence and execution fixtures, and the shape regression lists tools through the MCP client the SDK itself depends on.
        if (isTest && (specifier === "vitest" || specifier.startsWith("@modelcontextprotocol/sdk/") || resolvesInto(file, specifier, "server/src/persistence") || resolvesInto(file, specifier, "server/src/execution"))) continue;
        const allowed =
          specifier === "@agentique-console/core" ||
          specifier === "zod" ||
          specifier.startsWith("node:") ||
          // The pinned production SDK: types everywhere, the module itself only in the binding.
          (specifier === "@anthropic-ai/claude-agent-sdk" && (isTest || rel(file) === "server/src/provider/claude-sdk-binding.ts" || fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => /^\s*(import|export)\b/.test(line) && line.includes(specifier)).every((line) => /^(export type|import type) /.test(line)))) ||
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

  it("the Workspace providers depend only on core, Node built-ins, the execution port contracts (as types), and themselves: no persistence, database, Blob Store, provider, or execution service", () => {
    const files = listFiles("server/src/workspace-state", isCode);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const isTest = file.endsWith(".test.ts") || file.endsWith("test-support.ts");
      const source = fs.readFileSync(file, "utf8");
      for (const specifier of importsOf(file)) {
        if (isTest && specifier === "vitest") continue;
        const portContract = resolvesInto(file, specifier, "server/src/execution/ports") && source.split(/\r?\n/).filter((line) => /^\s*(import|export)\b/.test(line) && line.includes(specifier)).every((line) => /^(import type|export type) /.test(line));
        const allowed = specifier === "@agentique-console/core" || specifier.startsWith("node:") || resolvesInto(file, specifier, "server/src/workspace-state") || portContract;
        expect(allowed, `${rel(file)} imports ${specifier}`).toBe(true);
      }
      if (isTest) continue;
      // No persistence, database, or Blob Store reaches a Workspace provider; content arrives only through the content source capability.
      expect(source, rel(file)).not.toMatch(/PersistenceContext|\bStores\b|ArtifactStore|BlobStore|better-sqlite3|drizzle|storageKey|journal|\btx\b/);
      // No timer, interval, or sleep of the runtime's own, except the check runner's one process-bound deadline timer (cleared on exit; it ends the process tree while the shell is alive).
      if (!file.endsWith("checks.ts")) expect(source, rel(file)).not.toMatch(/setTimeout|setInterval|setImmediate|sleep\(/);
      else expect(source.split("setTimeout").length - 1, rel(file)).toBe(1);
      // Nothing force-updates a ref.
      expect(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), rel(file)).not.toMatch(/--force-with-lease|push\b.*--force|update-ref.*--no-deref.*-f\b|"--force"(?!,\s*(owned|worktreePath))/);
    }
  });

  it("the Agent Definition layer depends only on core, the YAML parser, Node built-ins, the persistence stores, the Workspace mechanics, the native tool classification, and itself; it never revives an overlay, a trust flag, or a bundle", () => {
    const files = listFiles("server/src/agents", isCode);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const isTest = file.endsWith(".test.ts") || file.endsWith("test-support.ts");
      for (const specifier of importsOf(file)) {
        if (isTest && (specifier === "vitest" || resolvesInto(file, specifier, "server/src/execution"))) continue;
        const allowed =
          specifier === "@agentique-console/core" ||
          specifier === "yaml" ||
          specifier.startsWith("node:") ||
          resolvesInto(file, specifier, "server/src/agents") ||
          resolvesInto(file, specifier, "server/src/persistence") ||
          resolvesInto(file, specifier, "server/src/workspace-state") ||
          rel(path.resolve(path.dirname(file), specifier)) === "server/src/provider/native-tools.ts";
        expect(allowed, `${rel(file)} imports ${specifier}`).toBe(true);
      }
      if (isTest) continue;
      const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // No overlay, sidecar, bundle, minted variant, or trust mechanism; no live-directory read of a definition file.
      expect(source, rel(file)).not.toMatch(/overlay|sidecar|bundle|mint|readFileSync\(.*agents|readdirSync/i);
    }
  });

  it("the scheduler, join settler, and Pattern runners import nothing legacy, poll nothing, and implement only the supported Patterns", () => {
    const files = [...listFiles("server/src/execution/patterns", isCode), path.join(repoRoot, "server/src/execution/scheduler.ts"), path.join(repoRoot, "server/src/execution/join.ts"), path.join(repoRoot, "server/src/execution/readiness.ts"), path.join(repoRoot, "server/src/execution/readiness-facts.ts"), path.join(repoRoot, "server/src/execution/handoff-routing.ts"), path.join(repoRoot, "server/src/execution/integration-service.ts"), path.join(repoRoot, "server/src/execution/task-projection.ts"), path.join(repoRoot, "server/src/execution/task-proposals.ts"), path.join(repoRoot, "server/src/execution/runtime-tools.ts"), path.join(repoRoot, "server/src/execution/acceptance-checks.ts"), path.join(repoRoot, "server/src/execution/gates.ts"), path.join(repoRoot, "server/src/execution/invocation-facts.ts"), path.join(repoRoot, "server/src/execution/patterns/root.ts"), path.join(repoRoot, "server/src/execution/completion.ts"), path.join(repoRoot, "server/src/execution/completion-requests.ts"), path.join(repoRoot, "server/src/execution/requirement-derivation.ts"), path.join(repoRoot, "server/src/execution/signoff.ts")];
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
    // The Gate engine decides every phase from Gate, Evaluation, Invocation, and Task rows: never from a transcript, a result summary, an
    // open item, an Event, a source path, or a timestamp; and it never reads Artifact content (raw command output stays in the Artifact Store).
    const gatesEngine = fs.readFileSync(path.join(repoRoot, "server/src/execution/gates.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(gatesEngine).not.toMatch(/journal\.read\(|\.summary|TRANSCRIPT_MEDIA_TYPE|artifacts\.read\(|result\.openItems|result\.blocker|sourcePath|openedAt|closedAt|createdAt|setTimeout|setInterval|TextDecoder/);
    // The completion engine decides every phase from Completion Request, Gate, Evaluation, Requirement, Invocation, and Task rows: never from
    // a transcript, a result summary, an open item, an Event, or a timestamp; it reads no Artifact content and starts no timer.
    const completion = fs.readFileSync(path.join(repoRoot, "server/src/execution/completion.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(completion).not.toMatch(/journal\.read\(|\.summary|TRANSCRIPT_MEDIA_TYPE|artifacts\.read\(|result\.openItems|result\.blocker|openedAt|closedAt|createdAt(?!:)|setTimeout|setInterval|TextDecoder/);
    // The requirement derivation is pure over its explicit input: no store, clock, id minting, or persistence reaches it.
    const derivation = fs.readFileSync(path.join(repoRoot, "server/src/execution/requirement-derivation.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(importsOf(path.join(repoRoot, "server/src/execution/requirement-derivation.ts"))).toEqual(["@agentique-console/core"]);
    expect(derivation).not.toMatch(/stores|ctx|clock\(|newId\(|\.ids\(|Date\.|journal|transcript/);
    // The optimizer runner never opens a Gate row: its rounds consume the node's Gate criteria (execution-model §5.6).
    expect(fs.readFileSync(path.join(repoRoot, "server/src/execution/patterns/evaluator-optimizer.ts"), "utf8")).not.toMatch(/gates\.(open|close)\(|support\.gates\./);
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

  it("signoff resolution reads rows only, inspects the Workspace through a read-only port, writes nothing outside the Run, and leaks no diff (invariants 16, 27)", () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const serviceFile = path.join(repoRoot, "server/src/execution/signoff.ts");
    const service = strip(fs.readFileSync(serviceFile, "utf8"));
    // Rows only: no transcript, Artifact content, result prose, Event replay, timestamp ordering, timer, or byte decoding decides anything.
    expect(service).not.toMatch(/journal\.read\(|\.summary\b|TRANSCRIPT_MEDIA_TYPE|artifacts\.read\(|blobs\.|result\.openItems|result\.blocker|openedAt|closedAt|createdAt|setTimeout|setInterval|TextDecoder|worktreePath/);
    // The external read runs outside every transaction and is refused inside one; nothing is polled.
    expect(service).toMatch(/if \(ctx\.tx\.inTransaction\) throw/);
    expect(service).toMatch(/await finalization\.inspect\(/);
    // No mutation outside the Run: no Publication, no operator-branch operation, no provider strategy, no Target read.
    const targetSafety = /\btarget\b|publish|publication|fast_forward|\bmerge\b|rebase|cherry|checkout|\bcommit\b|\bgit\b/i;
    expect(service).not.toMatch(targetSafety);
    // The final diff bytes reach the Artifact Store and nothing else: no outcome, projection, or Event type carries bytes.
    const surface = service.slice(service.indexOf("export interface SignoffArtifactFacts"), service.indexOf("export class RunSignoffService"));
    expect(surface).not.toMatch(/Uint8Array|bytes|\bdiff\b|content/);
    const diffLines = service.split(/\r?\n/).filter((line) => /\bdiff\b/.test(line));
    expect(diffLines).toHaveLength(1);
    expect(diffLines[0]).toMatch(/artifacts\.create\(/);
    const coreSignoff = strip(fs.readFileSync(path.join(repoRoot, "core/src/signoff.ts"), "utf8"));
    expect(coreSignoff).not.toMatch(/content|bytes|Uint8Array|diff:/);
    // The finalization port depends on core alone, names no persistence, storage, transcript, credential, or operator-branch concept, and exposes one read-only method.
    const portFile = path.join(repoRoot, "server/src/execution/ports/run-finalization-workspace.ts");
    expect(importsOf(portFile)).toEqual(["@agentique-console/core"]);
    const port = strip(fs.readFileSync(portFile, "utf8"));
    expect(port).not.toMatch(/PersistenceContext|\bStores\b|ArtifactStore|BlobStore|Database|better-sqlite3|drizzle|storageKey|\btx\b|transcript|continuation|artifactId|credential|token/i);
    expect(port).not.toMatch(targetSafety);
    const portMethods = (port.match(/export interface RunFinalizationWorkspacePort \{([\s\S]*?)\n\}/)?.[1] ?? "").match(/^\s*\w+\(.*\).*;$/gm) ?? [];
    expect(portMethods.map((m) => m.trim())).toEqual(["inspect(request: RunFinalizationRequest): Promise<RunFinalizationOutcome>;"]);
    const request = port.match(/export interface RunFinalizationRequest \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(request).not.toMatch(/store|blob|artifact|lookup|write|apply/i);
    // The fake port receives no persistence either.
    const support = fs.readFileSync(path.join(repoRoot, "server/src/execution/test-support.ts"), "utf8");
    const fake = support.slice(support.indexOf("export class FakeRunFinalizationWorkspace"), support.indexOf("export class FakeExecutionWorkspace"));
    expect(fake.length).toBeGreaterThan(100);
    expect(fake).not.toMatch(/\bstores\b|\bctx\b|\bblobs\b|artifacts\.|sha256Hex|BlobStore|ArtifactStore/);
    expect(strip(fake)).not.toMatch(targetSafety);
    // Nothing in the execution boundary but the publication service and its port touches Publications or the Target
    // (invariant 16): no Pattern runner, Gate, completion, signoff, or scheduler code creates, transitions, or names one.
    for (const file of listFiles("server/src/execution", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts") && !f.endsWith("publication.ts") && !f.endsWith("publication-workspace.ts") && !f.endsWith("publications.ts"))) {
      expect(strip(fs.readFileSync(file, "utf8")), rel(file)).not.toMatch(/publications\.(create|transition|recordStagingReleased)\(|targetBeforeSnapshot|fast_forward/);
    }
    // No compatibility mechanism anywhere in the signoff path.
    expect(`${service}\n${port}\n${coreSignoff}`).not.toMatch(/\b(legacy|compat\w*|fallback|shim|deprecated|feature.?flag)\b/i);
  });

  it("publication is the one Target boundary: a narrow three-operation port with no persistence, no force update, no model call, and no scheduler (invariant 16)", () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // The port depends on core and the shared content-source type alone, and names no persistence, storage, credential, or transcript concept.
    const portFile = path.join(repoRoot, "server/src/execution/ports/publication-workspace.ts");
    expect(importsOf(portFile).sort()).toEqual(["./integration-workspace.ts", "@agentique-console/core"]);
    const port = strip(fs.readFileSync(portFile, "utf8"));
    expect(port).not.toMatch(/PersistenceContext|\bStores\b|ArtifactStore|BlobStore|Database|better-sqlite3|drizzle|storageKey|\btx\b|transcript|continuation|credential|token|password/i);
    // Three separate operations, never an opaque publish-everything call, and no force update anywhere near the Target.
    const portMethods = (port.match(/export interface PublicationWorkspacePort \{([\s\S]*?)\n\}/)?.[1] ?? "").match(/^\s*\w+\(.*\).*;$/gm) ?? [];
    expect(portMethods.map((m) => m.trim())).toEqual([
      "prepare(request: PublicationPrepareRequest): Promise<PublicationPrepareOutcome>;",
      "apply(request: PublicationApplyRequest): Promise<PublicationApplyOutcome>;",
      "release(request: PublicationReleaseRequest): Promise<PublicationReleaseOutcome>;",
    ]);
    expect(port).not.toMatch(/force/i);
    // The service is deterministic runtime code: no Invocation, Attempt, lease, Task, manifest, provider, scheduler, timer, or transcript —
    // and no second scheduler; it advances only through the port and the shared check service.
    const service = strip(fs.readFileSync(path.join(repoRoot, "server/src/execution/publication.ts"), "utf8"));
    expect(service).not.toMatch(/invocations\.(create|prepare)|createAttempt|preparation\.|executor|governor|\blease\b|usage\.record|\bmanifest\b|\bscheduler\b|setTimeout|setInterval|journal\.read\(|TRANSCRIPT_MEDIA_TYPE|\bforce\b/i);
    expect(service).toMatch(/never run inside a transaction/);
    // Only the publication service drives the port and the Publication lifecycle (outside stores, tests, and test support).
    const drivers = listFiles("server/src", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts") && !f.endsWith("stores/publications.ts")).filter((f) => /publications\.(create|transition|recordStagingReleased)\(|PublicationWorkspacePort/.test(strip(fs.readFileSync(f, "utf8")))).map(rel).sort();
    // The production Workspace providers implement the port; nothing else outside the service drives a Publication.
    expect(drivers).toEqual(["server/src/execution/index.ts", "server/src/execution/ports/publication-workspace.ts", "server/src/execution/publication.ts", "server/src/workspace-state/index.ts", "server/src/workspace-state/publish.ts"]);
    // No provider code names a Target, a Publication, or a publish strategy: no Invocation or provider-model adapter can modify the Target.
    for (const file of listFiles("server/src/provider", isCode)) {
      expect(strip(fs.readFileSync(file, "utf8")), rel(file)).not.toMatch(/\bpublication\b|\bpublish\b|fast_forward|targetBefore|PublicationWorkspace/i);
    }
    // No compatibility mechanism anywhere in the publication path.
    const corePublication = strip(fs.readFileSync(path.join(repoRoot, "core/src/publication.ts"), "utf8"));
    expect(`${service}\n${port}\n${corePublication}`).not.toMatch(/\b(legacy|compat\w*|fallback\b|shim|deprecated|feature.?flag|v2|standing)\b/i);
  });

  it("budget accounting is deterministic runtime: no model or provider dependency, no transcript, no timer, no second scheduler, no mutable history, no compatibility mechanism, and no deferred extension phase (invariant 22)", () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const files = ["server/src/execution/plan-node-capacity.ts", "server/src/execution/budget-increases.ts", "server/src/persistence/stores/budget-increases.ts", "server/src/persistence/stores/allocation-extensions.ts", "server/src/persistence/stores/budgets.ts"].map((f) => path.join(repoRoot, f));
    for (const file of files) {
      const text = strip(fs.readFileSync(file, "utf8"));
      // Rows only: no provider, adapter, model, prompt, transcript, Artifact content, Event replay, timer, or polling decides capacity.
      expect(importsOf(file).some((s) => resolvesInto(file, s, "server/src/provider") || /provider|adapter|sdk/i.test(s)), rel(file)).toBe(false);
      expect(text, rel(file)).not.toMatch(/\bprovider\b|\badapter\b|\bmodel\b|\bprompt\b|transcript|TRANSCRIPT_MEDIA_TYPE|artifacts\.read\(|blobs\.|journal\.read\(|setTimeout|setInterval|setImmediate|Date\.now|\bscheduler\b/i);
      // No compatibility mechanism, no configured increment, no rounding, no retired vocabulary for the new facts.
      expect(text, rel(file)).not.toMatch(/\b(legacy|compat\w*|fallback\b|shim|deprecated|feature.?flag|v2)\b/i);
      expect(text, rel(file)).not.toMatch(/\b(credit|refill|boost|quota reset|top.?up|rollover|increment)\b/i);
      expect(text, rel(file)).not.toMatch(/Math\.(ceil|round)\(/);
    }
    // The base Budget, the final reserve, and every reservation amount stay immutable: no store rewrites them, and no store updates or deletes an increase or an extension.
    for (const file of listFiles("server/src/persistence/stores", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      const text = strip(fs.readFileSync(file, "utf8"));
      expect(text, rel(file)).not.toMatch(/update\((budgetIncreases|allocationExtensions)\)|delete\((budgetIncreases|allocationExtensions|budgetReservations)\)/);
      expect(text, rel(file)).not.toMatch(/set\(\{[^}]*(maxCostUsd|maxTokens|maxAttempts|finalReserveCostUsd|finalReserveTokens|finalReserveAttempts|reservedCostUsd|reservedTokens|reservedAttempts)/);
    }
    // The migration guards both records append-only and re-checks them at insertion.
    const sql = fs.readFileSync(path.join(repoRoot, "server/src/persistence/migrations/0000_orchestration_core.sql"), "utf8");
    for (const trigger of ["budget_increases_no_update", "budget_increases_no_delete", "budget_increases_valid", "allocation_extensions_no_update", "allocation_extensions_no_delete", "allocation_extensions_valid", "budget_reservations_definition_immutable", "runs_definition_immutable"]) {
      expect(sql, trigger).toMatch(new RegExp(`CREATE TRIGGER \`${trigger}\``));
    }
    // No runtime tool creates a Budget Increase or an Allocation Extension: the closed tool set and handler bindings name neither.
    const tools = fs.readFileSync(path.join(repoRoot, "core/src/runtime-tools.ts"), "utf8");
    expect(tools).not.toMatch(/budget_increase|allocation_extension|increase_budget|extend_allocation/);
    // The only writer of an Allocation Extension outside stores and tests is the one capacity operation; the only writer of a Budget Increase is the increase service.
    const extensionWriters = listFiles("server/src", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts") && !f.endsWith("stores/allocation-extensions.ts")).filter((f) => /allocationExtensions\.record\(/.test(strip(fs.readFileSync(f, "utf8")))).map(rel).sort();
    expect(extensionWriters).toEqual(["server/src/execution/plan-node-capacity.ts"]);
    const increaseWriters = listFiles("server/src", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts") && !f.endsWith("stores/budget-increases.ts")).filter((f) => /budgetIncreases\.record\(/.test(strip(fs.readFileSync(f, "utf8")))).map(rel).sort();
    expect(increaseWriters).toEqual(["server/src/execution/budget-increases.ts"]);
    // Every node-funded call site funds through the one capacity operation and none re-implements the arithmetic.
    for (const file of ["server/src/execution/patterns/support.ts", "server/src/execution/gates.ts", "server/src/execution/patterns/root.ts", "server/src/execution/signoff.ts", "server/src/execution/task-proposals.ts", "server/src/execution/run-start-service.ts"].map((f) => path.join(repoRoot, f))) {
      const text = strip(fs.readFileSync(file, "utf8"));
      expect(text, rel(file)).toMatch(/capacity\.(ensure|admits)\(/);
      expect(text, rel(file)).not.toMatch(/allocationFits\(|allocationShortfall\(/);
    }
    // The deferral no longer exists anywhere in the new source, its tests, or the normative documents.
    const scanned = [...NEW_SOURCE_DIRS.flatMap((dir) => listFiles(dir, isSource)), ...listFiles("docs/architecture", (f) => f.endsWith(".md"))];
    for (const file of scanned) {
      if (rel(file) === "server/src/persistence/boundaries.test.ts") continue;
      expect(fs.readFileSync(file, "utf8"), rel(file)).not.toMatch(/awaiting_allocation_extension_phase/);
    }
    const scheduler = strip(fs.readFileSync(path.join(repoRoot, "server/src/execution/scheduler.ts"), "utf8"));
    expect(scheduler).not.toMatch(/deferred|unsupported|later.phase/);
  });

  it("no execution code reads a transcript Artifact or blob to make a decision (invariant 6)", () => {
    // Code only: a comment may name a transcript to say it is never read.
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const file of listFiles("server/src/execution", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      const text = strip(fs.readFileSync(file, "utf8"));
      // The integration and publication services are the readers of Artifact content: each delivers one verified
      // Changeset diff to its Workspace port (§9.2, §9.4) and decides nothing from the bytes; neither touches a transcript.
      if (rel(file) === "server/src/execution/integration-service.ts" || rel(file) === "server/src/execution/publication.ts") {
        expect(text, rel(file)).not.toMatch(/blobs\.get\(|transcript|TRANSCRIPT_MEDIA_TYPE/i);
        continue;
      }
      // The read service is the one other reader: it authorizes from metadata and rows first, then binds verified bytes only
      // into the `read_artifact` response (§6.4) and decides nothing from them; it never touches a transcript either.
      if (rel(file) === "server/src/execution/runtime-reads.ts") {
        expect(text, rel(file)).not.toMatch(/blobs\.get\(|transcript|TRANSCRIPT_MEDIA_TYPE/i);
        continue;
      }
      expect(text, rel(file)).not.toMatch(/artifacts\.(read|content)\(|blobs\.get\(|\.transcriptArtifactId\b[^;\n]*\bread|TRANSCRIPT_MEDIA_TYPE[^;\n]*(read|get)\(/);
    }
  });

  it("the runtime-tool port exposes only the effective callable set and one call, and only the execution boundary binds it", () => {
    const adapter = fs.readFileSync(path.join(repoRoot, "server/src/provider/adapter.ts"), "utf8");
    const port = adapter.match(/export interface RuntimeToolCallPort \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(port).toMatch(/readonly tools: readonly ExecutableRuntimeTool\[\];/);
    const members = port.replace(/\/\*[\s\S]*?\*\//g, "").match(/^\s*(readonly\s+)?\w+(\(.*\))?:.*;$/gm) ?? [];
    expect(members.map((m) => m.trim())).toEqual(["readonly tools: readonly ExecutableRuntimeTool[];", "call(request: RuntimeToolCallRequest): Promise<RuntimeToolCallOutcome>;"]);
    // Provider code never constructs, imports, or reaches the executor, a store, a proposal service, or a transaction; it calls the port only.
    for (const file of listFiles("server/src/provider", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, rel(file)).not.toMatch(/RuntimeToolExecutor|TaskProposalService|runtimeToolCalls\.(record|find)|tx\.write|persistence\/(stores\/(?!continuations)|blob-store|database|client|schema|context|transactions)/);
    }
    // The executor is the one binder: it is constructed in the Attempt executor from the Attempt's canonical rows, nowhere else outside tests and test support.
    const binders = listFiles("server/src", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts")).filter((f) => /new RuntimeToolExecutor\(/.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(binders).toEqual(["server/src/execution/attempt-executor.ts"]);
    const executor = fs.readFileSync(path.join(repoRoot, "server/src/execution/runtime-tools.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // The port's runtime does not authorize provider-native calls and never touches approval uses, transcripts, or a Decision's resolution;
    // it reads a blocking Decision's kind only to bound a logical turn, and creates a Decision only through the request service.
    expect(executor).not.toMatch(/approvedToolCallUses|ToolCallAuthorizer|authorize\(|TRANSCRIPT_MEDIA_TYPE|artifacts\.read\(|stores\.decisions\.(request|resolve|supersede)\(/);
    // Runtime tools are closed unions in core: every executable tool appears as a typed member, no free tool name, no
    // `unknown` input at the boundary.
    const core = fs.readFileSync(path.join(repoRoot, "core/src/runtime-tools.ts"), "utf8");
    for (const [tool, input] of [
      ["propose_tasks", "TaskProposalBatch"],
      ["update_task", "TaskUpdateRequest"],
      ["request_completion", "CompletionCallInput"],
      ["request_decision", "RequestDecisionInput"],
      ["write_artifact", "WriteArtifactInput"],
      ["read_requirements", "ReadRequirementsInput"],
      ["read_decisions", "ReadDecisionsInput"],
      ["read_tasks", "ReadTasksInput"],
      ["read_artifact", "ReadArtifactInput"],
      ["read_execution_plan", "ReadExecutionPlanInput"],
      ["read_agent_definitions", "ReadAgentDefinitionsInput"],
    ] as const) {
      expect(core, tool).toMatch(new RegExp(`\\{ tool: "${tool}"; input: ${input} \\}`));
    }
    expect(core).not.toMatch(/input: unknown|tool: string;/);
  });

  it("agent-requested Decisions come only from request_decision through the canonical services, from rows, without timers, transcripts, messaging, a second scheduler, or duplicate capacity arithmetic (invariants 5, 6, 20, 28)", () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const read = (f: string) => strip(fs.readFileSync(path.join(repoRoot, f), "utf8"));
    const executionFiles = listFiles("server/src/execution", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts"));
    // 1. The requestable kinds are a closed pair; every kind with another owner is excluded from the tool contract and its handler.
    expect(read("core/src/decisions.ts")).toMatch(/export const REQUESTABLE_DECISION_KINDS = \["operator_choice", "requirement_waiver"\] as const/);
    for (const f of ["core/src/runtime-tools.ts", "server/src/execution/decision-requests.ts"]) {
      expect(read(f), f).not.toMatch(/kind: "(budget_increase|side_effect_approval|signoff|publish|orchestrator_choice)"/);
      expect(read(f), f).not.toMatch(/z\.literal\("(budget_increase|side_effect_approval|signoff|publish|orchestrator_choice)"\)/);
    }
    // 2. The handler and the resolution service import nothing legacy: core, the persistence boundary, and the execution boundary only.
    const service = path.join(repoRoot, "server/src/execution/decision-requests.ts");
    for (const specifier of importsOf(service)) {
      expect(specifier === "@agentique-console/core" || resolvesInto(service, specifier, "server/src/execution") || resolvesInto(service, specifier, "server/src/persistence"), specifier).toBe(true);
    }
    // 3. Provider adapters reach no store and no Decision: they see the runtime-tool port and the typed completion only.
    for (const file of listFiles("server/src/provider", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      const text = read(rel(file));
      expect(text, rel(file)).not.toMatch(/DecisionRequestService|decisions\.(request|resolve|supersede|get)\(|stores\.|resolveDefault|blockedByDecisionId/);
    }
    // 4. Deadline and default resolution, the blocking boundary, and the continuation are decided from rows and the caller's clock:
    //    no timer, interval, polling, wall clock, transcript, or agent messaging anywhere on those paths.
    for (const f of ["server/src/execution/decision-requests.ts", "server/src/execution/scheduler.ts", "server/src/execution/attempt-executor.ts", "server/src/execution/runtime-tools.ts", "server/src/execution/invocation-lifecycle.ts", "server/src/execution/recovery-service.ts"]) {
      const text = read(f);
      expect(text, f).not.toMatch(/setTimeout|setInterval|setImmediate|process\.nextTick|Date\.now|new Date\(\)|\bpoll\w*\(/);
      expect(text, f).not.toMatch(/sendMessage|mailbox|inbox|agent_message|messageTo|\bnotify\w*Agent/i);
    }
    for (const f of ["server/src/execution/decision-requests.ts", "server/src/execution/scheduler.ts", "server/src/execution/invocation-lifecycle.ts"]) {
      expect(read(f), f).not.toMatch(/transcript|TRANSCRIPT_MEDIA_TYPE|artifacts\.read\(|blobs\.|journal\.read\(/i);
    }
    // 5. One scheduler: nothing else in the execution boundary declares a scheduler or a loop that waits on time.
    const schedulers = executionFiles.filter((f) => /class \w*Scheduler\b|setInterval\(/.test(read(rel(f)))).map(rel);
    expect(schedulers).toEqual(["server/src/execution/scheduler.ts"]);
    expect(read("server/src/execution/decision-requests.ts")).not.toMatch(/class \w*(Scheduler|Loop|Poller|Timer)\b|advanceRun|reconcileRun/);
    // 6. No duplicate capacity arithmetic: the request service and the scheduler fund nothing and compute no shortfall; `wait` never extends.
    for (const f of ["server/src/execution/decision-requests.ts", "server/src/execution/scheduler.ts"]) {
      expect(read(f), f).not.toMatch(/allocationFits\(|allocationShortfall\(|capacity\.ensure\(|allocationExtensions\.record\(|subtractAllocation\(|addAllocation\(/);
    }
    const capacity = read("server/src/execution/plan-node-capacity.ts");
    expect(capacity).toMatch(/case "wait":[\s\S]*?return \{ kind: "refused", policy: "wait" \};/);
    expect(capacity.slice(capacity.indexOf('case "wait":'), capacity.indexOf('case "extend":'))).not.toMatch(/allocationExtensions\.record\(/);
    // 7. Only the canonical services create or end an agent-requested Decision: the requestable kind literals, the request service's
    //    handler, and every `supersede` live in decision-requests.ts; every other Decision writer names its own owned kind.
    const requestableWriters = executionFiles.filter((f) => /kind: "(operator_choice|requirement_waiver)"/.test(read(rel(f)))).map(rel).sort();
    expect(requestableWriters).toEqual(["server/src/execution/decision-requests.ts"]);
    const superseders = listFiles("server/src", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts") && !f.endsWith("stores/decisions.ts")).filter((f) => /stores\.decisions\.supersede\(/.test(read(rel(f)))).map(rel).sort();
    expect(superseders).toEqual(["server/src/execution/decision-requests.ts"]);
    const requesters = executionFiles.filter((f) => /stores\.decisions\.request\(/.test(read(rel(f)))).map(rel).sort();
    expect(requesters).toEqual(["server/src/execution/attempt-executor.ts", "server/src/execution/budget-increases.ts", "server/src/execution/completion.ts", "server/src/execution/decision-requests.ts", "server/src/execution/publication.ts"]);
    for (const [file, kind] of [["server/src/execution/attempt-executor.ts", "side_effect_approval"], ["server/src/execution/budget-increases.ts", "budget_increase"], ["server/src/execution/completion.ts", "signoff"], ["server/src/execution/publication.ts", "publish"]] as const) {
      expect(read(file), file).toMatch(new RegExp(`kind: "${kind}"`));
    }
    const resolvers = executionFiles.filter((f) => /stores\.decisions\.resolve\(/.test(read(rel(f)))).map(rel).sort();
    expect(resolvers).toEqual(["server/src/execution/budget-increases.ts", "server/src/execution/decision-requests.ts", "server/src/execution/publication.ts", "server/src/execution/signoff.ts"]);
    expect(read("server/src/execution/runtime-tools.ts")).toMatch(/this\.#decisions\.request\(/);
    // 8. The requester is refused typed before validation for every kind with another owner, and the store enforces the same closed set.
    expect(read("server/src/execution/runtime-tools.ts")).toMatch(/forbiddenDecisionKindOf\(/);
    expect(read("server/src/persistence/stores/decisions.ts")).toMatch(/isRequestableDecisionKind\(/);
    const sql = fs.readFileSync(path.join(repoRoot, "server/src/persistence/migrations/0000_orchestration_core.sql"), "utf8");
    for (const trigger of ["runtime_tool_calls_no_update", "runtime_tool_calls_no_delete"]) {
      expect(sql, trigger).toMatch(new RegExp(`CREATE TRIGGER \`${trigger}\``));
    }
    expect(sql).toMatch(/CONSTRAINT "decisions_requestable_by_invocation" CHECK/);
    expect(sql).toMatch(/CREATE TRIGGER `decisions_[a-z_]+` BEFORE UPDATE ON `decisions`/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX `runtime_tool_calls_one_decision_request` ON `runtime_tool_calls` \(`invocation_id`\) WHERE tool = 'request_decision';/);
    // 9. The normative documents describe request_decision as it is: callable when the manifest, a handler, and the exact role/purpose
    //    binding admit it; never as permitted-but-not-executable, handler-less, deferred, or absent from callable tools.
    for (const file of listFiles("docs/architecture", (f) => f.endsWith(".md"))) {
      const doc = fs.readFileSync(file, "utf8");
      expect(doc, rel(file)).not.toMatch(/`request_decision` is never exposed as callable|`request_decision` remains\s+permitted by role and not executable|not executable \(`request_decision`|`request_decision`[^.\n]{0,80}(typed deferral|has no handler|no handler)|deferral[^.\n]{0,40}`request_decision`/);
    }
    expect(fs.readFileSync(path.join(repoRoot, "docs/architecture/migration-contract.md"), "utf8")).toMatch(/at most one accepted `propose_tasks` per Invocation, and at most one accepted blocking `request_decision` per Invocation/);
    // 10. The canonical runtime-tool-call record and its Event carry the safe result and the digest, never the raw call input.
    const core = read("core/src/runtime-tools.ts");
    const record = core.match(/export interface RuntimeToolCall \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(record.length).toBeGreaterThan(0);
    expect(record).not.toMatch(/\binput\b|\bargs\b|\bpayload\b/);
    expect(read("server/src/execution/runtime-tools.ts")).not.toMatch(/journal\.append\([^)]*\binput\b/);
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

  it("runtime reads are ephemeral projections and write_artifact is store-owned: no transaction, row, Event, cursor state, timer, transcript, messaging, or compatibility mechanism, and future tools stay unbound (execution-model §6.4)", () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // 1. The read service reads canonical stores only: it opens no transaction, appends no Event, and performs no store write.
    const reads = strip(fs.readFileSync(path.join(repoRoot, "server/src/execution/runtime-reads.ts"), "utf8"));
    expect(reads).not.toMatch(/tx\.write\(|inTransaction|journal\b|\.append\(|\.record\(|\.create\(|\.transition\(|afterRollback|usage\.record|WriteOptions/);
    // 2. Stateless cursors: the service holds no field but its stores — no process-memory cursor, cache, or receipt survives a call.
    expect(reads).toMatch(/export class RuntimeReadService \{\r?\n  constructor\(private readonly stores: Stores\) \{\}/);
    // 3. No timer, polling, transcript, agent messaging, clock, or id minting on the read or write path.
    const writes = strip(fs.readFileSync(path.join(repoRoot, "server/src/execution/artifact-writes.ts"), "utf8"));
    for (const [name, text] of [["runtime-reads.ts", reads], ["artifact-writes.ts", writes]] as const) {
      expect(text, name).not.toMatch(/setTimeout|setInterval|setImmediate|Date\.now|new Date\(|clock\(|\.ids\(|newId\(/);
      expect(text, name).not.toMatch(/transcript|TRANSCRIPT_MEDIA_TYPE|continuation|sendMessage|mailbox|inbox|agent_message/i);
      expect(text, name).not.toMatch(/\b(legacy|compat\w*|fallback\b|shim|deprecated|feature.?flag|v2)\b/i);
      expect(text, name).not.toMatch(/query.?session|read.?receipt|access.?log/i);
    }
    // 4. write_artifact mutates through the canonical Artifact Store alone: no blob access, no direct insert, no journal append.
    expect(writes).toMatch(/artifacts\.create\(/);
    expect(writes).not.toMatch(/blobs\.|journal|\.insert\(|tx\.write\(/);
    // 5. Only the execution runtime reads Artifact content: the read service for `read_artifact` (metadata first, then
    //    `artifacts.content(` only after authorization), plus the two existing narrow content readers (Changeset integration,
    //    publication preparation). Nothing else — and no provider — touches `artifacts.read(` or `artifacts.content(`.
    const contentReaders = listFiles("server/src", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts") && !rel(f).startsWith("server/src/persistence/"))
      .filter((f) => /artifacts\.(read|content)\(/.test(strip(fs.readFileSync(f, "utf8"))))
      .map(rel)
      .sort();
    expect(contentReaders).toEqual(["server/src/execution/integration-service.ts", "server/src/execution/publication.ts", "server/src/execution/runtime-reads.ts"]);
    // The read service authorizes before it loads: the one content load sits in `readArtifact` after `authorizeArtifact` returned
    // the metadata, and Artifact authorization never consults the logical turn's replay scope.
    expect(reads.match(/artifacts\.content\(/g)).toHaveLength(1);
    expect(reads.indexOf("this.authorizeArtifact(")).toBeGreaterThan(-1);
    expect(reads.indexOf("this.authorizeArtifact(")).toBeLessThan(reads.indexOf("artifacts.content("));
    const authorize = reads.slice(reads.indexOf("private authorizeArtifact("), reads.indexOf("private artifactOrNull("));
    expect(authorize).toMatch(/runtimeToolCalls\.writtenArtifactCall\(/);
    expect(authorize).toMatch(/producer\.invocationId === caller\.invocation\.id/);
    expect(authorize).not.toMatch(/turnInvocationIds|logicalTurn/);
    // 6. The provider boundary knows neither the read service nor the write service and holds no read result of its own.
    for (const file of listFiles("server/src/provider", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      expect(fs.readFileSync(file, "utf8"), rel(file)).not.toMatch(/RuntimeReadService|ArtifactWriteService|runtime-reads|artifact-writes/);
    }
    // 7. The executor separates the outcomes: a read is dispatched before any transaction opens and is never recorded.
    const executor = strip(fs.readFileSync(path.join(repoRoot, "server/src/execution/runtime-tools.ts"), "utf8"));
    expect(executor).toMatch(/if \(isRuntimeToolReadTool\(tool\)\) return this\.#read\(/);
    expect(executor.slice(executor.indexOf("#read(tool:"), executor.indexOf("#handle("))).not.toMatch(/tx\.write\(|runtimeToolCalls\.record\(|journal\.append/);
    // 8. Future tools remain permitted-but-not-executable, and no full update_task semantics exist: the closed executable
    //    tuples name exactly the executable tools, and the one update_task operation is the Coordinator's cancel.
    const core = fs.readFileSync(path.join(repoRoot, "core/src/runtime-tools.ts"), "utf8");
    expect(core).toMatch(/export const RUNTIME_TOOL_CALL_TOOLS = \["propose_tasks", "update_task", "request_completion", "request_decision", "write_artifact"\] as const;/);
    expect(core).toMatch(/export const RUNTIME_TOOL_READ_TOOLS = \["read_requirements", "read_decisions", "read_tasks", "read_artifact", "read_execution_plan", "read_agent_definitions"\] as const;/);
    for (const future of ["create_tasks", "record_decision", "propose_requirements", "revise_execution_plan"]) {
      expect(core, future).not.toMatch(new RegExp(`${future}: \\[\\{ role`));
      expect(core, future).not.toMatch(new RegExp(`tool: "${future}"`));
    }
    expect(core).toMatch(/update_task: \[\{ role: "coordinator", purposes: \["decompose", "replan"\] \}\]/);
    expect(core).toMatch(/z\.discriminatedUnion\("kind", \[z\.strictObject\(\{ kind: z\.literal\("cancel"\), reason: nonEmptyString\.max\(TASK_UPDATE_MAX_REASON_LENGTH\) \}\)\]\)/);
    // 9. Raw Artifact content stays out of the safe result, the record, and the read rejections by shape: the result union's
    //    write_artifact member carries metadata fields only.
    expect(core).toMatch(/\{ tool: "write_artifact"; artifactId: ArtifactId; mediaType: string; digest: string; byteSize: number; title: string \}/);
    // 10. Bounded retrieval: the read service pages through the stores' keyset and batch APIs and never materializes a
    //     Conversation's Decision history, a Run's Task ledger, every Agent Definition or revision, or the whole graph for a page.
    expect(reads).not.toMatch(/decisions\.(listByConversation|listByRun|listOpen)\(|tasks\.(listByRun|listByPlanNode|dependencies)\(|agents\.(listDefinitions|listRevisions)\(|plans\.(currentGraph|listEdges|listNodes|graph)\(|\.all\(\)/);
    for (const api of ["decisions.page(", "decisions.contains(", "tasks.page(", "tasks.contains(", "tasks.visibleAmong(", "tasks.dependencyIdsOf(", "tasks.replacementsOf(", "agents.pageExecutable(", "agents.containsExecutable(", "agents.getDefinitions(", "plans.pageMembers(", "plans.pageEdges(", "plans.edgeKey(", "plans.memberPosition(", "plans.membersAmong(", "requirements.getMany(", "requirements.getAcceptanceCriteria(", "requirements.latestWaiverDecisionOf("]) {
      expect(reads, api).toContain(api);
    }
    // The one whole-value read is a Requirement revision's tree, bounded in core; the current revision is one row.
    expect(fs.readFileSync(path.join(repoRoot, "core/src/requirements.ts"), "utf8")).toMatch(/export const REQUIREMENT_TREE_MAX_ENTRIES = 1_000;/);
    expect(strip(fs.readFileSync(path.join(repoRoot, "server/src/persistence/stores/requirements.ts"), "utf8"))).toMatch(/currentRevision\(conversationId: ConversationId\)[\s\S]*?\.orderBy\(desc\(requirementRevisions\.number\)\)[\s\S]*?\.limit\(1\)[\s\S]*?\.get\(\)/);
    // 11. Every read result leaves the service through the serialized-ceiling check, and read_artifact measures its envelope exactly.
    expect(reads).toMatch(/return bounded\(this\.readArtifact\(/);
    expect(reads).toMatch(/artifactEnvelopeBytes\(artifact, offset, encoding\)/);
    expect(reads).toMatch(/readOutcomeBytes\(candidate\) > ceiling/);
    // 12. Infrastructure failures of a call carry the closed failure kind, never the thrown text.
    expect(executor).toMatch(/failureKindOf\(error\)/);
    expect(executor).not.toMatch(/error\.message|String\(error\)/);
    expect(strip(fs.readFileSync(path.join(repoRoot, "server/src/persistence/stores/artifacts.ts"), "utf8"))).toMatch(/blob removal failed: \$\{failureKindOf\(cleanupError\)\}/);
    // 13. No Artifact of a runtime component (a transcript, a captured call, a diff, an index) is ever readable through the producer route:
    //     the route requires an Invocation producer, and no runtime producer name appears in the read service.
    expect(reads).toMatch(/artifact\.producer\.kind === "invocation" && artifact\.producer\.invocationId === caller\.invocation\.id/);
    expect(reads).not.toMatch(/component:|"tool_call"|"changeset"|"final_report"|TOOL_CALL_MEDIA_TYPE/);
  });

  it("the pending-write marker protocol is storage housekeeping: one owner in the persistence boundary, one reconciliation call at the clean-break recovery boundary, no timer, sweep, fsync knob, recursive delete, or legacy bootstrap wiring (execution-model §2.1)", () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const read = (f: string) => strip(fs.readFileSync(path.join(repoRoot, f), "utf8"));
    const production = ["server/src/persistence", "server/src/execution", "server/src/provider"].flatMap((dir) => listFiles(dir, (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts")));
    const namers = (pattern: RegExp) => production.filter((f) => pattern.test(read(rel(f)))).map(rel).sort();
    const blobStore = read("server/src/persistence/blob-store.ts");
    const store = read("server/src/persistence/stores/artifacts.ts");
    const recovery = read("server/src/execution/recovery-service.ts");
    // 1. Markers, temporaries, and the pending area are the blob store's; the Artifact Store is the only writer of blobs and the only
    //    caller of the protocol's primitives, so every Artifact producer participates through `ArtifactStore.create` alone.
    expect(namers(/\b(markPending|clearPending|listPending|removeTemporary)\(/)).toEqual(["server/src/persistence/blob-store.ts", "server/src/persistence/stores/artifacts.ts"]);
    expect(namers(/blobs\.put\(/)).toEqual(["server/src/persistence/stores/artifacts.ts"]);
    expect(namers(/\.pending\/|"\.pending"|PENDING_DIRECTORY/)).toEqual(["server/src/persistence/blob-store.ts"]);
    expect(blobStore).toMatch(/const PENDING_DIRECTORY = "\.pending";/);
    // 2. One reconciliation, defined by the Artifact Store outside every transaction and invoked once by the clean-break
    //    RecoveryService after its canonical transaction and the worktree releases — no second recovery owner anywhere.
    expect(namers(/reconcilePendingBlobs\(/)).toEqual(["server/src/execution/recovery-service.ts", "server/src/persistence/stores/artifacts.ts"]);
    expect(recovery).toMatch(/const report = this\.reconcile\(options\);\s*const releases = this\.cleanup\.releaseOutstanding\(options\);\s*const blobs = this\.stores\.artifacts\.reconcilePendingBlobs\(\);/);
    expect(store).toMatch(/reconcilePendingBlobs\(\): PendingBlobReconciliation \{\s*if \(this\.ctx\.tx\.inTransaction\) throw/);
    // 3. Compensation and completion are registered before the marker or the blob can exist, and only the Artifact Store registers
    //    a commit hook; the marker is removed last on the rollback path (blob first) and never before its obligation is resolved.
    expect(store.indexOf("this.ctx.tx.afterRollback(")).toBeGreaterThan(-1);
    expect(store.indexOf("this.ctx.tx.afterRollback(")).toBeLessThan(store.indexOf("this.ctx.blobs.put(bytes)"));
    expect(store.indexOf("this.ctx.tx.afterCommit(")).toBeLessThan(store.indexOf("this.ctx.blobs.put(bytes)"));
    expect(namers(/\.afterCommit\(/)).toEqual(["server/src/persistence/stores/artifacts.ts"]);
    const compensate = store.slice(store.indexOf("private compensate("), store.indexOf("private settleMarker("));
    expect(compensate.indexOf("this.ctx.blobs.remove(digest)")).toBeLessThan(compensate.indexOf("this.ctx.blobs.clearPending(digest)"));
    expect(compensate).toMatch(/pending\.written && !this\.referenced\(digest\)/);
    const reconcile = store.slice(store.indexOf("reconcilePendingBlobs(): PendingBlobReconciliation {"));
    expect(reconcile.indexOf("this.referenced(entry.digest)")).toBeLessThan(reconcile.indexOf("this.ctx.blobs.remove(entry.digest)"));
    expect(reconcile.indexOf("this.ctx.blobs.remove(entry.digest)")).toBeLessThan(reconcile.indexOf("this.ctx.blobs.clearPending(entry.digest)"));
    // 4. No timer, polling, loop, second scheduler, sweep, lease or lock subsystem, fsync barrier, durability knob, transcript, or
    //    messaging on the protocol's paths; the proposal's `durableBarriers` option is absent from the whole new source.
    for (const f of ["server/src/persistence/blob-store.ts", "server/src/persistence/stores/artifacts.ts", "server/src/persistence/transactions.ts", "server/src/execution/recovery-service.ts"]) {
      const text = read(f);
      expect(text, f).not.toMatch(/setTimeout|setInterval|setImmediate|process\.nextTick|\bpoll\w*\(|class \w*(Scheduler|Loop|Poller|Timer|Lease|Lock|Collector)\b/);
      expect(text, f).not.toMatch(/fsync|fdatasync|durableBarriers|synchronous|journal_mode|garbage|sweep/i);
      expect(text, f).not.toMatch(/sendMessage|mailbox|inbox|agent_message/i);
      expect(text, f).not.toMatch(/\b(legacy|compat\w*|fallback\b|shim|deprecated|feature.?flag|v2)\b/i);
    }
    for (const f of ["server/src/persistence/blob-store.ts", "server/src/persistence/stores/artifacts.ts", "server/src/persistence/transactions.ts"]) {
      expect(read(f), f).not.toMatch(/transcript|TRANSCRIPT_MEDIA_TYPE/i);
    }
    for (const file of newFiles.filter((f) => isCode(f) && !f.endsWith(".test.ts"))) {
      expect(fs.readFileSync(file, "utf8"), rel(file)).not.toMatch(/durableBarriers/);
    }
    // 5. Bounded, non-destructive enumeration: the blob store opens exactly one directory handle (the pending area), reads it
    //    one entry at a time, closes it in a `finally`, and never materializes a listing or walks the tree; every removal is an
    //    lstat-guarded unlink of a regular file at a validated path; the only `rmSync` is the temporary file's own cleanup with
    //    `force` and never `recursive`; markers and temporaries are created exclusively (`wx`); every owned blob path is
    //    probed by `lstat` before it is reused, read, or reported (never `existsSync`, which follows a symlink); nothing is
    //    recognized by a `.tmp` suffix alone.
    expect(blobStore.match(/opendirSync\(/g)).toHaveLength(1);
    expect(blobStore).toMatch(/fs\.opendirSync\(this\.pendingDir\)/);
    expect(blobStore).toMatch(/const entry = dir\.readSync\(\);/);
    expect(blobStore).toMatch(/\} finally \{\s*dir\.closeSync\(\);\s*\}/);
    expect(blobStore).not.toMatch(/readdirSync\(|existsSync\(|readdir\(/);
    expect(blobStore).toMatch(/fs\.writeFileSync\(temp, bytes, \{ flag: "wx" \}\)/);
    expect(blobStore.match(/this\.blobEntry\(digest\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(blobStore.match(/fs\.readFileSync\(/g)).toHaveLength(1);
    expect(blobStore.match(/lstatSync\(/g)).toHaveLength(1);
    expect(blobStore.match(/\bunlinkSync\(/g)).toHaveLength(1);
    expect(blobStore).toMatch(/if \(!existing\.isFile\(\)\) throw new BlobUnsafeEntryError\(role, entry\);\s*fs\.unlinkSync\(target\);/);
    expect(blobStore.match(/\brmSync\(/g)).toHaveLength(1);
    expect(blobStore).toMatch(/rmSync\(temp, \{ force: true \}\)/);
    expect(blobStore).not.toMatch(/rmSync\([^)]*recursive|rmdirSync|\bstatSync\(|realpathSync|readlinkSync/);
    expect(blobStore).toMatch(/fs\.openSync\(marker, "wx"\)/);
    expect(blobStore).not.toMatch(/endsWith\("\.tmp"\)/);
    expect(blobStore).toMatch(/const TEMPORARY = \/\^\(\[0-9a-f\]\{64\}\)/);
    // 6. Diagnostics and reports carry closed kinds, digests, and safe entry identifiers only — never thrown text or a path.
    expect(store).toMatch(/blob removal failed: \$\{failureKindOf\(cleanupError\)\}/);
    expect(store).toMatch(/marker removal failed: \$\{failureKindOf\(cleanupError\)\}/);
    expect(store).toMatch(/failureKind: failureKindOf\(error\)/);
    expect(store).not.toMatch(/cleanupError\.message|error\.message|String\(error\)|\.stack\b/);
    expect(blobStore).toMatch(/readonly failureKind: FailureKind = "storage:unsafe_entry";/);
    // 7. The transactor's commit hooks run after its bookkeeping is settled, in registration order, and a throwing hook or sink
    //    never reaches the caller.
    const transactor = read("server/src/persistence/transactions.ts");
    expect(transactor).toMatch(/const committed = this\.#commitHooks;\s*this\.#reset\(\);\s*this\.#runCommitHooks\(committed\);\s*return result as T;/);
    expect(transactor.slice(transactor.indexOf("#runCommitHooks(hooks"), transactor.indexOf("#runRollbackHooks(hooks"))).not.toMatch(/\.reverse\(\)/);
    // 8. The clean-break recovery boundary is invoked by no production code yet: the replacement runtime is not wired into the
    //    legacy bootstrap (`main.ts`, `boot.ts`, `app.ts`), whose rewrite is the application cutover of the roadmap.
    expect(namers(/\.recover\(/)).toEqual([]);
    for (const f of ["server/src/main.ts", "server/src/boot.ts", "server/src/app.ts"]) {
      expect(read(f), f).not.toMatch(/RecoveryService|reconcilePendingBlobs|src\/persistence|src\/execution/);
    }
  });

  it("operator Run control is one internal execution boundary: durable intent on the Run row, one admission rule revalidated at every mutation boundary, delivery only through the executor, no timer, polling, messaging, provider persistence, second scheduler, HTTP wiring, or compatibility mechanism (execution-model §14)", () => {
    const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const read = (f: string) => strip(fs.readFileSync(path.join(repoRoot, f), "utf8"));
    const production = ["server/src/persistence", "server/src/execution", "server/src/provider"].flatMap((dir) => listFiles(dir, (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts")));
    const namers = (pattern: RegExp, except: string[] = []) => production.filter((f) => !except.includes(rel(f)) && pattern.test(read(rel(f)))).map(rel).sort();
    const control = read("server/src/execution/run-control.ts");
    const cancellation = read("server/src/execution/run-cancellation.ts");
    // 1. The Run store owns the durable pause and resume writes; the one service outside it that calls them is the control service.
    expect(namers(/runs\.(pause|resume)\(/, ["server/src/persistence/stores/runs.ts"])).toEqual(["server/src/execution/run-control.ts"]);
    // 2. Interruption is delivery through the executor alone; only the control service asks for it, and only after its transaction committed.
    expect(namers(/\.interruptRun\(/, ["server/src/execution/attempt-executor.ts"])).toEqual(["server/src/execution/run-control.ts"]);
    expect(control).toMatch(/const committed = ctx\.tx\.write\([\s\S]*?\);\s*\n[\s\S]*?executor\.interruptRun\(runId, "cancelled"\)/);
    expect(control).toMatch(/never runs inside a transaction/);
    // 3. Cancelled work converges through one shared settlement, called by the cancelling transaction, the finalizing executor, and recovery.
    expect(namers(/settleCancelledRunWork\(/, ["server/src/execution/run-cancellation.ts", "server/src/execution/index.ts"])).toEqual(["server/src/execution/attempt-executor.ts", "server/src/execution/recovery-service.ts", "server/src/execution/run-control.ts"]);
    // 4. One admission rule: the core helper is what every mutation boundary revalidates; no boundary re-derives it from a status list of its own.
    const admitters = namers(/\brunAdmitsNewWork\(/);
    for (const file of ["server/src/execution/attempt-executor.ts", "server/src/execution/completion.ts", "server/src/execution/join.ts", "server/src/execution/patterns/root.ts", "server/src/execution/patterns/support.ts", "server/src/execution/scheduler.ts"]) expect(admitters, file).toContain(file);
    expect(read("server/src/execution/invocation-preparation-service.ts")).toMatch(/run\.operatorPause !== null/);
    expect(namers(/\brunAdmitsExecution\(/)).toEqual(["server/src/execution/runtime-tools.ts"]);
    expect(namers(/\brunExecutionInterruptionOf\(/)).toEqual(["server/src/execution/attempt-executor.ts", "server/src/execution/tool-call-authorization.ts"]);
    expect(namers(/\brunIsRunningOrDraining\(/)).toEqual(["server/src/execution/completion-requests.ts", "server/src/execution/decision-requests.ts", "server/src/persistence/stores/completion-requests.ts"]);
    expect(read("server/src/execution/scheduler.ts")).toMatch(/run\.operatorPause !== null\) \{/);
    expect(read("server/src/execution/scheduler.ts")).toMatch(/run\.waitReason !== "operator" && actions\.length > 0\) actions\.unshift\(\{ kind: "resume_run"/);
    // 5. No permanent paused status, no second wait vocabulary, no compatibility mechanism, no timer, no polling, no messaging, no provider persistence, no scheduler driving from control.
    const core = fs.readFileSync(path.join(repoRoot, "core/src/runs.ts"), "utf8");
    expect(core).toMatch(/OPERATOR_PAUSE_MODES = \["soft", "hard"\] as const/);
    expect(core).not.toMatch(/"paused"/);
    expect(fs.readFileSync(path.join(repoRoot, "server/src/persistence/migrations/0000_orchestration_core.sql"), "utf8")).toMatch(/CONSTRAINT "runs_operator_wait_is_pause"/);
    for (const [file, text] of [["server/src/execution/run-control.ts", control], ["server/src/execution/run-cancellation.ts", cancellation]] as const) {
      expect(text, file).not.toMatch(/setTimeout|setInterval|setImmediate|Date\.now|\bscheduler\b|advanceRun|reconcileRun|conversations\.|postMessage|TRANSCRIPT_MEDIA_TYPE|transcript|continuation|\bprovider\b|\badapter\b|journal\.read\(/);
      expect(text, file).not.toMatch(/\b(legacy|compat\w*|fallback\b|shim|deprecated|feature.?flag|v2|force)\b/i);
      expect(importsOf(path.join(repoRoot, file)).some((s) => resolvesInto(path.join(repoRoot, file), s, "server/src/provider") || /provider|adapter|sdk/i.test(s)), file).toBe(false);
    }
    // 6. Not an agent tool and not wired to any route yet: the closed runtime-tool set names no control tool, and no legacy module reaches the service.
    expect(fs.readFileSync(path.join(repoRoot, "core/src/runtime-tools.ts"), "utf8")).not.toMatch(/cancel_run|pause_run|resume_run|run_control/);
    const callers = listFiles("server/src", (f) => isCode(f) && !f.endsWith(".test.ts") && !f.endsWith("test-support.ts") && !f.startsWith(path.join(repoRoot, "server", "src", "execution"))).filter((f) => /RunControlService|run-control\.ts/.test(fs.readFileSync(f, "utf8"))).map(rel);
    expect(callers).toEqual([]);
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
