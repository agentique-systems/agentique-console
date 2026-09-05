/**
 * The driven-browser acceptance suite: a real Chromium (Playwright) against
 * the built web application served by a real server process — the
 * production composition over a disposable directory, the SDK fixture as the
 * provider, and real SQLite, files, git, worktrees, and subprocess checks
 * behind it. Nothing below the HTTP boundary is a double; the browser does
 * what an operator does.
 *
 * Covered: the normal operator path (Workspace and Conversation creation,
 * Run launch, Requirement proposal review and approval, Decision resolution,
 * visible execution progress, completion and signoff, a separately
 * authorized publication to a disposable Target), then focused checks —
 * message pagination past the first page and a Decision beyond a page
 * boundary that is resolved, pause and resume, a reconnect after the network
 * dropped, deep-link reloads, the absence of significant console errors, and
 * usability at a narrow viewport.
 *
 * Prerequisites: `vite build` (the server serves `web/dist`) and Playwright's
 * Chromium (`npx playwright install chromium`).
 */
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Reply = { kind: "ready"; url: string; repo: string; webDir: string; servesWeb: boolean } | { kind: "scripted"; name: string } | { kind: "remaining"; value: number } | { kind: "disconnected"; count: number } | { kind: "error"; message: string };
type Script = "coding" | "hang" | "review" | "decisions";

const OLD_CLI = ["const args = process.argv.slice(2);", 'console.log("hello");', ""].join("\n");
const NEW_CLI = ["const args = process.argv.slice(2);", 'if (args[0] === "--version") {', "  console.log(require(" + "'../package.json').version);", "  process.exit(0);", "}", 'console.log("hello");', ""].join("\n");

function serverRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i += 1) {
    if (fs.existsSync(path.join(dir, "server", "package.json"))) return path.join(dir, "server");
    dir = path.dirname(dir);
  }
  throw new Error("the server workspace was not found above the working directory");
}

class ServerProcess {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-browser-"));
  #child: ChildProcess | null = null;
  #stderr = "";
  url = "";
  repo = "";

  async start(): Promise<void> {
    const root = serverRoot();
    const child = fork(path.join(root, "src", "api", "web-test-server.ts"), [], { cwd: root, execArgv: ["--import=tsx"], env: { ...process.env, WEB_TEST_DIR: this.dir, NODE_OPTIONS: "" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString();
    });
    this.#child = child;
    const ready = await this.#next((r) => r.kind === "ready", 120_000);
    if (ready.kind !== "ready") throw new Error("unreachable");
    if (!ready.servesWeb) throw new Error(`the server does not serve the built web application (${ready.webDir}); run \`vite build\` in web/ first`);
    this.url = ready.url;
    this.repo = ready.repo;
  }

  async script(name: Script, workspaceId: string): Promise<void> {
    this.#child!.send({ kind: "script", name, workspaceId });
    const reply = await this.#next((r) => r.kind === "scripted" || r.kind === "error", 30_000);
    if (reply.kind === "error") throw new Error(reply.message);
  }

  async remaining(): Promise<number> {
    this.#child!.send({ kind: "remaining" });
    const reply = await this.#next((r) => r.kind === "remaining", 30_000);
    return reply.kind === "remaining" ? reply.value : -1;
  }

  /** The server drops every event-stream subscriber. */
  async disconnect(): Promise<number> {
    this.#child!.send({ kind: "disconnect" });
    const reply = await this.#next((r) => r.kind === "disconnected", 30_000);
    return reply.kind === "disconnected" ? reply.count : -1;
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.send({ kind: "close" });
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 30_000))]);
    if (child.exitCode === null) child.kill();
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  get stderr(): string {
    return this.#stderr;
  }

  #next(accept: (reply: Reply) => boolean, timeoutMs: number): Promise<Reply> {
    const child = this.#child!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("message", onMessage);
        reject(new Error(`no reply from the server process within ${timeoutMs}ms; stderr: ${this.#stderr.slice(-2_000)}`));
      }, timeoutMs);
      const onExit = (code: number | null) => {
        clearTimeout(timer);
        child.off("message", onMessage);
        reject(new Error(`the server process exited with ${code}; stderr: ${this.#stderr.slice(-2_000)}`));
      };
      const onMessage = (reply: Reply) => {
        if (!accept(reply)) return;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        resolve(reply);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
    });
  }
}

/** Console output the suite treats as a defect: errors and page exceptions, except the network failures the offline check provokes on purpose. */
function significant(messages: string[]): string[] {
  return messages.filter((m) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|Load failed|net::ERR|NetworkError|favicon/i.test(m));
}

describe("the operator's web application in a real browser", () => {
  const server = new ServerProcess();
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const consoleErrors: string[] = [];
  let workspaceId = "";
  let conversationId = "";
  let decisionRunId = "";

  const api = async <T,>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${server.url}${route}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as T };
  };
  const cli = () => fs.readFileSync(path.join(server.repo, "src", "cli.js"), "utf8");
  const header = () => page.getByTestId("run-header");
  const watch = (target: Page) => {
    target.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`[console.error] ${message.text()}`);
    });
    target.on("pageerror", (error) => consoleErrors.push(`[pageerror] ${error.message}`));
  };

  beforeAll(async () => {
    await server.start();
    browser = await chromium.launch();
    context = await browser.newContext({ baseURL: server.url, viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    watch(page);
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await server.close();
  });

  it("walks the normal operator path: Workspace, Conversation, Run, proposal approval, Decision resolution, visible progress, signoff, and publication to the Target", async () => {
    // Workspace: the gate, the wizard over the browse roots, the shell.
    await page.goto("/");
    await page.getByTestId("workspace-gate").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /New Workspace/ }).click();
    const wizard = page.getByTestId("workspace-wizard");
    const pathInput = wizard.getByLabel("directory path");
    await expect.poll(() => pathInput.inputValue(), { timeout: 30_000 }).not.toBe("");
    await pathInput.fill(server.repo);
    await pathInput.press("Enter");
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByRole("button", { name: "Add Workspace" }).click();
    await page.getByTestId("topbar").waitFor({ timeout: 30_000 });
    const workspaces = await api<{ items: { workspace: { id: string; rootPath: string } }[] }>("GET", "/api/workspaces");
    workspaceId = workspaces.body.items.find((w) => w.workspace.rootPath === server.repo)!.workspace.id;
    // Conversation.
    await page.getByTestId("new-conversation").click();
    await page.getByTestId("conversation-pane").waitFor({ timeout: 30_000 });
    conversationId = new URL(page.url()).pathname.split("/").at(-1)!;
    // Run: the goal and the fixture's real completion check; the first turn proposes Requirements and asks a Decision.
    await server.script("review", workspaceId);
    await page.getByTestId("goal").fill("Add a --version flag to the CLI.");
    await page.getByLabel("completion check").fill("node test.js");
    await page.getByTestId("start-run-button").click();
    await header().waitFor({ timeout: 30_000 });
    await expect.poll(() => header().textContent(), { timeout: 60_000 }).toContain("Waiting for a decision");
    // The proposal: reviewed and approved in the Requirements tab.
    await page.getByTestId("tab-requirements").click();
    await page.getByTestId("proposal-review").waitFor({ timeout: 30_000 });
    // The proposal keeps the goal's Requirement and adds new ones; each entry says which it is.
    await expect.poll(() => page.getByTestId("proposal-review").locator('[data-entry="kept"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => page.getByTestId("proposal-review").locator('[data-entry="new"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByTestId("proposal-approve").click();
    await expect.poll(() => page.getByTestId("requirements-tree").textContent(), { timeout: 30_000 }).toContain("Revision 2");
    await expect.poll(() => page.getByTestId("requirements-tree").textContent(), { timeout: 30_000 }).toContain("--version");
    // The Decision: resolved in the Decisions tab from its open section.
    await page.getByTestId("tab-decisions").click();
    const open = page.getByTestId("decisions-open");
    await open.waitFor({ timeout: 30_000 });
    await open.getByRole("radio", { name: /Yes/ }).check();
    await open.getByTestId("decision-submit").click();
    await expect.poll(() => header().textContent(), { timeout: 60_000 }).toContain("Running");
    await expect.poll(() => server.remaining(), { timeout: 60_000 }).toBe(0);
    // The plan and the work: the operator's message triggers the plan; progress is visible in the header and the plan graph.
    await server.script("coding", workspaceId);
    await page.goto(`/conversations/${conversationId}`);
    await page.getByTestId("composer").waitFor({ timeout: 30_000 });
    await page.getByLabel("message").fill("Go ahead with the plan.");
    await page.getByTestId("send-message").click();
    await expect.poll(() => page.getByTestId("messages").textContent(), { timeout: 30_000 }).toContain("Go ahead with the plan.");
    await page.getByTestId("active-run-link").click();
    await header().waitFor({ timeout: 30_000 });
    await page.getByTestId("tab-plan").click();
    await expect.poll(() => page.getByTestId("plan-graph").textContent(), { timeout: 60_000 }).toContain("Add --version");
    await expect.poll(() => header().textContent(), { timeout: 180_000 }).toContain("Awaiting signoff");
    expect(cli()).toBe(OLD_CLI);
    await page.getByTestId("tab-verification").click();
    await page.getByTestId("final-report").waitFor({ timeout: 30_000 });
    await expect.poll(() => page.getByTestId("gates").textContent(), { timeout: 30_000 }).toContain("run completion");
    // Signoff, then the separately authorized publication.
    await page.getByTestId("tab-publish").click();
    await page.getByTestId("signoff-accept").click();
    // Acceptance is final for the Run, so the console asks once more before recording it.
    await page.getByTestId("signoff-accept-confirm").click();
    await expect.poll(() => header().textContent(), { timeout: 30_000 }).toContain("Completed, not published");
    expect(cli()).toBe(OLD_CLI);
    await page.getByTestId("publish-request").click();
    await page.getByTestId("publish-confirm").click();
    await expect.poll(() => header().textContent(), { timeout: 60_000 }).toContain("Published");
    expect(cli()).toBe(NEW_CLI);
    await expect.poll(() => page.getByTestId("publication").textContent(), { timeout: 30_000 }).toContain("brought forward");
    expect(await server.remaining()).toBe(0);
  }, 400_000);

  it("shows a message posted beyond the old first-page boundary, pages older history on demand, and resolves a Decision beyond a page boundary", async () => {
    // A Conversation with more than 200 messages: the newest page shows at once; a new message shows as it is posted; older history pages.
    const paged = await api<{ conversation: { id: string } }>("POST", "/api/conversations", { workspaceId, title: "paged" });
    const pagedId = paged.body.conversation.id;
    for (let i = 0; i < 205; i += 1) expect((await api("POST", `/api/conversations/${pagedId}/messages`, { content: `seeded message ${String(i).padStart(3, "0")}` })).status).toBe(201);
    await page.goto(`/conversations/${pagedId}`);
    const messages = page.getByTestId("messages");
    await messages.waitFor({ timeout: 30_000 });
    await expect.poll(() => messages.textContent(), { timeout: 30_000 }).toContain("seeded message 204");
    expect(await page.locator("[data-message]").count()).toBeLessThanOrEqual(50);
    await page.getByLabel("message").fill("posted from the browser, message 206");
    await page.getByTestId("send-message").click();
    await expect.poll(() => messages.textContent(), { timeout: 30_000 }).toContain("posted from the browser, message 206");
    // Older history, page by page, down to the first message; nothing duplicated.
    for (let loads = 0; loads < 6 && (await page.locator("[data-message]").count()) < 206; loads += 1) {
      const before = await page.locator("[data-message]").count();
      await page.getByTestId("messages-older").click();
      await expect.poll(() => page.locator("[data-message]").count(), { timeout: 30_000 }).toBeGreaterThan(before);
      await expect.poll(() => page.getByTestId("messages-older").evaluate((b) => !(b as HTMLButtonElement).disabled).catch(() => true), { timeout: 30_000 }).toBe(true);
    }
    await expect.poll(() => messages.textContent(), { timeout: 30_000 }).toContain("seeded message 000");
    const ids = await page.locator("[data-message]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-message")));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(206);
    expect(await page.getByTestId("messages-older").count()).toBe(0);
    // A Run whose Orchestrator recorded fifty-two choices before asking one: the open Decision is beyond the first page of the history
    // and is resolved from the open section all the same.
    const forDecisions = await api<{ conversation: { id: string } }>("POST", "/api/conversations", { workspaceId, title: "decisions" });
    await server.script("decisions", workspaceId);
    await page.goto(`/conversations/${forDecisions.body.conversation.id}`);
    await page.getByTestId("goal").fill("Decide many things.");
    await page.getByLabel("completion check").fill("node test.js");
    await page.getByTestId("start-run-button").click();
    await header().waitFor({ timeout: 30_000 });
    decisionRunId = new URL(page.url()).pathname.split("/")[2]!;
    await expect.poll(() => header().textContent(), { timeout: 60_000 }).toContain("Waiting for a decision");
    await page.getByTestId("tab-decisions").click();
    const open = page.getByTestId("decisions-open");
    await open.waitFor({ timeout: 30_000 });
    await expect.poll(() => open.textContent(), { timeout: 30_000 }).toContain("fifty-third");
    await page.getByTestId("decisions-more").waitFor({ state: "visible", timeout: 30_000 });
    await open.getByRole("radio", { name: /Yes/ }).check();
    await open.getByTestId("decision-submit").click();
    await expect.poll(() => header().textContent(), { timeout: 60_000 }).toContain("Running");
    await expect.poll(() => page.getByTestId("decisions-panel").textContent(), { timeout: 30_000 }).toContain("No open Decision");
    await expect.poll(() => server.remaining(), { timeout: 60_000 }).toBe(0);
  }, 400_000);

  it("pauses and resumes a Run, and reconnects the event stream after the network dropped so later state still arrives", async () => {
    const forControl = await api<{ conversation: { id: string } }>("POST", "/api/conversations", { workspaceId, title: "control" });
    await server.script("hang", workspaceId);
    await page.goto(`/conversations/${forControl.body.conversation.id}`);
    await page.getByTestId("goal").fill("Reorganize the notes.");
    await page.getByLabel("completion check").fill("node test.js");
    await page.getByTestId("start-run-button").click();
    await header().waitFor({ timeout: 30_000 });
    const runId = new URL(page.url()).pathname.split("/")[2]!;
    await expect.poll(() => header().textContent(), { timeout: 30_000 }).toContain("Running");
    await page.getByTestId("pause-menu").click();
    await page.getByTestId("pause-hard").click();
    await expect.poll(() => header().textContent(), { timeout: 30_000 }).toContain("Paused");
    await page.getByTestId("resume").click();
    await expect.poll(() => header().textContent(), { timeout: 30_000 }).toContain("Running");
    // The network drops and the server ends the stream (as a restart or a proxy would): the subscription reports it and cannot
    // reconnect while offline; once the network is back it resumes from its last sequence, and a later state change reaches the page.
    const status = page.getByTestId("connection-status");
    await expect.poll(() => status.textContent(), { timeout: 30_000 }).toContain("live");
    try {
      await context.setOffline(true);
      expect(await server.disconnect()).toBeGreaterThan(0);
      await expect.poll(() => status.textContent(), { timeout: 60_000 }).toContain("disconnected");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await status.textContent()).toContain("disconnected");
    } finally {
      await context.setOffline(false);
    }
    await expect.poll(() => status.textContent(), { timeout: 60_000 }).toContain("live");
    expect((await api("POST", `/api/runs/${runId}/cancel`, {})).status).toBe(200);
    await expect.poll(() => header().textContent(), { timeout: 60_000 }).toContain("Cancelled");
  }, 300_000);

  it("reloads deep links, reports no significant console error, and stays usable at a narrow viewport", async () => {
    await context.setOffline(false);
    expect(decisionRunId).not.toBe("");
    await page.goto(`/runs/${decisionRunId}/decisions`);
    await page.getByTestId("panel-decisions").waitFor({ timeout: 30_000 });
    await expect.poll(() => page.getByTestId("decisions-panel").textContent(), { timeout: 30_000 }).toContain("Recorded choice");
    await page.reload();
    await page.getByTestId("panel-decisions").waitFor({ timeout: 30_000 });
    await page.goto(`/conversations/${conversationId}`);
    await page.getByTestId("conversation-pane").waitFor({ timeout: 30_000 });
    await expect.poll(() => page.getByTestId("messages").textContent(), { timeout: 30_000 }).toContain("Go ahead with the plan.");
    // A narrow viewport: the conversation view, the composer, and the Run header remain reachable without horizontal scrolling.
    const narrow = await context.newPage();
    watch(narrow);
    await narrow.setViewportSize({ width: 390, height: 844 });
    await narrow.goto(`/conversations/${conversationId}`);
    await narrow.getByTestId("conversation-pane").waitFor({ timeout: 30_000 });
    await narrow.getByLabel("message").waitFor({ state: "visible", timeout: 30_000 });
    await narrow.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
    const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await narrow.goto(`/runs/${decisionRunId}`);
    await narrow.getByTestId("run-header").waitFor({ timeout: 30_000 });
    await narrow.getByTestId("next-step").waitFor({ state: "visible", timeout: 30_000 });
    await narrow.getByTestId("tab-decisions").click();
    await narrow.getByTestId("panel-decisions").waitFor({ timeout: 30_000 });
    expect(await narrow.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await narrow.close();
    expect(significant(consoleErrors)).toEqual([]);
  }, 300_000);
});
