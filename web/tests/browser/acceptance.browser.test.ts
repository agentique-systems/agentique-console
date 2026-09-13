/**
 * The driven-browser acceptance suite: a real Chromium (Playwright) against
 * the built web application served by a real server process — the
 * production composition over a disposable directory, the SDK fixture as the
 * provider, and real SQLite, files, git, worktrees, and subprocess checks
 * behind it. Nothing below the HTTP boundary is a double; the browser does
 * what an operator does.
 *
 * Covered: the normal operator path (Workspace and Conversation creation,
 * Send-driven work, Requirement proposal review and approval, Decision resolution,
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
type Script = "coding" | "hang" | "review" | "decisions" | "clarify" | "reply";

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

  async seedHistory(conversationId: string, count: number): Promise<void> {
    this.#child!.send({ kind: "seed_history", conversationId, count });
    await this.#next((r) => r.kind === "scripted", 30_000);
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

describe("conversation-first operator experience in Chromium", () => {
  const server = new ServerProcess();
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let workspaceId = "";
  let conversationId = "";
  let workId = "";
  const errors: string[] = [];
  const api = async <T,>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${server.url}${route}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.ok, await response.clone().text()).toBe(true);
    return await response.json() as T;
  };
  const send = async (content: string) => {
    await page.getByLabel("message", { exact: true }).fill(content);
    await page.getByTestId("send-message").click();
    await expect.poll(() => page.getByLabel("message", { exact: true }).inputValue(), { timeout: 30_000 }).toBe("");
  };
  const workCount = async (id = conversationId) => (await api<{ items: { mode?: string }[] }>("GET", `/api/conversations/${id}/runs`)).items.filter((r) => !r.mode).length;

  beforeAll(async () => {
    await server.start();
    browser = await chromium.launch();
    context = await browser.newContext({ baseURL: server.url, viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(e.message));
  }, 240_000);
  afterAll(async () => { await browser?.close(); await server.close(); });

  it("opens on chat, clarifies, reviews decisions, receives and publishes a result, then continues the same thread", async () => {
    await page.goto("/");
    await page.getByTestId("workspace-gate").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /New Workspace/ }).click();
    const wizard = page.getByTestId("workspace-wizard");
    const directory = wizard.getByLabel("directory path");
    await expect.poll(() => directory.inputValue()).not.toBe("");
    await directory.fill(server.repo);
    await directory.press("Enter");
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.getByRole("button", { name: "Add Workspace" }).click();
    await page.getByTestId("composer").waitFor({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe("/conversations");
    expect(await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Runs", exact: true }).count()).toBe(0);
    expect(await page.getByTestId("start-run").count()).toBe(0);
    const workspaces = await api<{ items: { workspace: { id: string } }[] }>("GET", "/api/workspaces");
    workspaceId = workspaces.items[0]!.workspace.id;
    await server.script("clarify", workspaceId);
    await send("Add a flag to the CLI");
    await expect.poll(() => page.getByTestId("messages").textContent()).toContain("Which flag would you like to add?");
    conversationId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(await workCount()).toBe(0);

    await server.script("review", workspaceId);
    await send("Add --version");
    await page.getByTestId("proposal-review").waitFor({ timeout: 60_000 });
    await page.getByTestId("proposal-approve").click();
    const choice = page.getByTestId("conversation-work").getByTestId("decision-form");
    await choice.getByRole("radio", { name: /Yes/ }).check();
    await choice.getByTestId("decision-submit").click();
    await expect.poll(() => server.remaining(), { timeout: 60_000 }).toBe(0);
    expect(new URL(page.url()).pathname).toBe(`/conversations/${conversationId}`);
    expect(await workCount()).toBe(1);
    await server.script("coding", workspaceId);
    await send("Go ahead with the plan");
    workId = (await page.getByTestId("conversation-work").getAttribute("data-work-id"))!;
    await page.getByTestId("signoff-accept").waitFor({ timeout: 30_000 });
    expect(await workCount()).toBe(1);
    expect(await page.getByText(/^empty changeset of /).count()).toBe(0);
    expect(fs.readFileSync(path.join(server.repo, "src", "cli.js"), "utf8")).toBe(OLD_CLI);
    await page.reload();
    await page.getByTestId("signoff-accept").waitFor({ timeout: 30_000 });
    await server.script("reply", workspaceId);
    await send("yes, approve and publish");
    await expect.poll(() => server.remaining()).toBe(0);
    expect((await api<{ run: { status: string } }>("GET", `/api/runs/${workId}`)).run.status).toBe("awaiting_signoff");
    await page.getByTestId("signoff-accept").click();
    await page.getByTestId("signoff-accept-confirm").click();
    await page.getByTestId("publish-request").waitFor({ timeout: 30_000 });
    await page.getByTestId("publish-request").click();
    expect(fs.readFileSync(path.join(server.repo, "src", "cli.js"), "utf8")).toBe(OLD_CLI);
    await page.getByTestId("publish-confirm").click();
    await expect.poll(() => fs.readFileSync(path.join(server.repo, "src", "cli.js"), "utf8"), { timeout: 60_000 }).toBe(NEW_CLI);
    await server.script("reply", workspaceId);
    await send("Thanks, what changed?");
    await expect.poll(() => page.getByTestId("messages").textContent()).toContain("What would you like to do next?");
    expect(await workCount()).toBe(1);
    expect(new URL(page.url()).pathname).toBe(`/conversations/${conversationId}`);
  }, 300_000);

  it("retries a lost message response after refresh without duplicating history or execution, and pages older messages", async () => {
    const c = await api<{ conversation: { id: string } }>("POST", "/api/conversations", { workspaceId, title: "History" });
    const id = c.conversation.id;
    await server.seedHistory(id, 205);
    await page.goto(`/conversations/${id}`);
    await expect.poll(() => page.getByTestId("messages").textContent()).toContain("seeded message 204");
    expect(await page.locator("[data-message]").count()).toBeLessThanOrEqual(50);
    await server.script("reply", workspaceId);
    let lost = false;
    await page.route(`**/api/conversations/${id}/messages`, async (route) => {
      if (route.request().method() !== "POST" || lost) return route.continue();
      lost = true;
      await route.fetch();
      await route.abort("failed");
    });
    await page.getByLabel("message", { exact: true }).fill("A message whose response is lost");
    await page.getByTestId("send-message").click();
    await expect.poll(() => lost).toBe(true);
    await page.reload();
    await expect.poll(() => page.getByLabel("message", { exact: true }).inputValue(), { timeout: 30_000 }).toBe("");
    await page.unroute(`**/api/conversations/${id}/messages`);
    for (let i = 0; i < 6 && await page.getByTestId("messages-older").count(); i++) {
      const count = await page.locator("[data-message]").count();
      await page.getByTestId("messages-older").click();
      await expect.poll(() => page.locator("[data-message]").count()).toBeGreaterThan(count);
    }
    const messages = page.locator("[data-message]");
    const ids = await messages.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-message")));
    expect(new Set(ids).size).toBe(ids.length);
    expect(await page.locator('[data-author="operator"]').filter({ hasText: "A message whose response is lost" }).count()).toBe(1);
    expect(await workCount(id)).toBe(0);
    expect(await server.remaining()).toBe(0);
  }, 120_000);

  it("stops and resumes work in the thread across reconnect and reload", async () => {
    const c = await api<{ conversation: { id: string } }>("POST", "/api/conversations", { workspaceId, title: "Controls" });
    await page.goto(`/conversations/${c.conversation.id}`);
    await server.script("hang", workspaceId);
    await send("Work on another change");
    const work = page.getByTestId("conversation-work");
    await work.waitFor({ timeout: 30_000 });
    await work.getByTestId("pause-menu").click();
    await page.getByTestId("pause-hard").click();
    await expect.poll(() => work.textContent()).toContain("Work paused");
    await server.disconnect();
    await page.reload();
    await work.getByTestId("resume").click();
    await expect.poll(() => work.textContent(), { timeout: 30_000 }).toContain("Working on your request");
    await expect.poll(() => server.remaining(), { timeout: 30_000 }).toBe(0);
    await work.getByTestId("cancel").click();
    await page.getByTestId("cancel-confirm").click();
    const stoppedId = await work.getAttribute("data-work-id");
    await expect.poll(async () => (await api<{ run: { status: string } }>("GET", `/api/runs/${stoppedId}`)).run.status, { timeout: 30_000 }).toBe("cancelled");
    await expect.poll(() => work.textContent(), { timeout: 30_000 }).toContain("Work stopped");
    expect(new URL(page.url()).pathname).toBe(`/conversations/${c.conversation.id}`);
  }, 120_000);

  it("surfaces a required decision beyond the first history page inside the conversation", async () => {
    const c = await api<{ conversation: { id: string } }>("POST", "/api/conversations", { workspaceId, title: "Decision history" });
    await page.goto(`/conversations/${c.conversation.id}`);
    await server.script("decisions", workspaceId);
    await send("Work through the choices");
    const choice = page.getByTestId("conversation-work").getByTestId("decision-form");
    await choice.waitFor({ timeout: 60_000 });
    expect(await page.getByTestId("conversation-work").textContent()).toContain("The fifty-third: proceed?");
    await choice.getByRole("radio", { name: /Yes/ }).check();
    await choice.getByTestId("decision-submit").click();
    await expect.poll(() => server.remaining()).toBe(0);
    await expect.poll(() => choice.count(), { timeout: 30_000 }).toBe(0);
    expect(new URL(page.url()).pathname).toBe(`/conversations/${c.conversation.id}`);
  }, 90_000);

  it("selects each supported provider from Settings and pins the model without starting work", async () => {
    for (const [provider, model] of [["codex", "gpt-5.6-sol"], ["ai-sdk", "openai/gpt-5.6-terra"]]) {
      const c = await api<{ conversation: { id: string } }>("POST", "/api/conversations", { workspaceId, title: provider });
      await page.goto("/settings/providers");
      await page.getByLabel("Default provider", { exact: true }).selectOption(provider!);
      await page.getByLabel("Default model", { exact: true }).selectOption(model!);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await page.getByText("Settings saved.", { exact: true }).waitFor();
      await page.goto(`/conversations/${c.conversation.id}`);
      await send("Hello");
      await expect.poll(() => page.locator('[data-author="orchestrator"]').count(), { timeout: 60_000 }).toBe(1);
      const detail = await api<{ dialogueRun: { id: string; execution: unknown } }>("GET", `/api/conversations/${c.conversation.id}`);
      expect(detail.dialogueRun.execution).toEqual({ provider, model });
      const invocations = await api<{ items: { id: string }[] }>("GET", `/api/runs/${detail.dialogueRun.id}/invocations`);
      const invocation = await api<{ manifest: { content: { modelPolicy: { provider: string; model: string } } } }>("GET", `/api/invocations/${invocations.items[0]!.id}`);
      expect(invocation.manifest.content.modelPolicy).toMatchObject({ provider, model });
      expect(await workCount(c.conversation.id)).toBe(0);
    }
  }, 120_000);

  it("keeps optional execution deep links and a usable narrow conversation", async () => {
    await page.goto(`/runs/${workId}/decisions`);
    await page.getByTestId("run-header").waitFor({ timeout: 30_000 });
    await page.reload();
    await page.getByTestId("run-header").waitFor({ timeout: 30_000 });
    await page.goto(`/conversations/${conversationId}`);
    await page.getByTestId("composer").waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(os.tmpdir(), "agentique-conversation-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/conversations/${conversationId}`);
    await page.getByTestId("composer").waitFor({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.getByLabel("message", { exact: true }).isVisible()).toBe(true);
    await page.screenshot({ path: path.join(os.tmpdir(), "agentique-conversation-mobile.png"), fullPage: true });
    expect(significant(errors)).toEqual([]);
  }, 90_000);
});
