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
    expect(drivers).toEqual(["server/src/execution/index.ts", "server/src/execution/ports/publication-workspace.ts", "server/src/execution/publication.ts"]);
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
    for (const file of listFiles("server/src/execution", (f) => isCode(f) && !f.endsWith(".test.ts"))) {
      const text = fs.readFileSync(file, "utf8");
      // The integration and publication services are the readers of Artifact content: each delivers one verified
      // Changeset diff to its Workspace port (§9.2, §9.4) and decides nothing from the bytes; neither touches a transcript.
      if (rel(file) === "server/src/execution/integration-service.ts" || rel(file) === "server/src/execution/publication.ts") {
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
    expect(core).toMatch(/export type RuntimeToolCallRequest = \{ tool: "propose_tasks"; input: TaskProposalBatch \} \| \{ tool: "update_task"; input: TaskUpdateRequest \} \| \{ tool: "request_completion"; input: CompletionCallInput \};/);
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
