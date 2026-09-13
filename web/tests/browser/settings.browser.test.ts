import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Settings in Chromium", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentique-settings-browser-"));
  const artifacts = path.resolve("test-artifacts");
  let child: ChildProcess; let browser: Browser; let page: Page; let url = ""; let repo = "";
  const errors: string[] = [];
  async function start() {
    child = fork(path.resolve("../server/src/api/web-test-server.ts"), [], { execArgv: ["--import=tsx"], env: { ...process.env, WEB_TEST_DIR: dir, NODE_OPTIONS: "" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const ready = await new Promise<{ url: string; repo: string }>((resolve, reject) => {
      let stderr = ""; child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject); child.once("exit", (code) => reject(new Error(`fixture exited: ${code}: ${stderr}`)));
      child.once("message", (value: { url: string; repo: string }) => resolve(value));
    }); url = ready.url; repo = ready.repo;
  }
  async function stop() { const exited = new Promise<void>((resolve) => child.once("exit", () => resolve())); child.send({ kind: "close" }); await exited; }
  beforeAll(async () => {
    fs.mkdirSync(artifacts, { recursive: true }); await start(); browser = await chromium.launch(); const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
  });
  afterAll(async () => { await browser?.close(); if (child?.connected) await stop(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const goto = (route: string) => page.goto(`${url}${route}`);
  const save = async () => { await page.getByRole("button", { name: "Save changes", exact: true }).click(); await page.getByText("Settings saved.", { exact: true }).waitFor(); };

  it("opens before a workspace, validates authentication, saves a provider, and consumes it from conversation", async () => {
    await goto("/"); await page.getByTestId("workspace-gate").waitFor();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Providers & models", exact: true }).click();
    await page.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
    await page.getByLabel("API credential", { exact: true }).fill("invalid-fixture-key");
    await page.getByRole("button", { name: "Test connection & discover models" }).click();
    await page.getByText("Check failed", { exact: true }).waitFor();
    await page.getByLabel("API credential", { exact: true }).fill("browser-private-credential");
    // Rate limits are real; let the fixture's deterministic check interval elapse through an assertion.
    await expect.poll(async () => {
      await page.getByRole("button", { name: "Test connection & discover models" }).click();
      return await page.getByText("Verified for this check", { exact: true }).count();
    }, { interval: 1100, timeout: 10_000 }).toBe(1);
    await save(); expect(await page.getByLabel("API credential", { exact: true }).inputValue()).toBe("");
    await page.getByLabel("Default model", { exact: true }).selectOption("claude-haiku-4-5-20251001");
    await save(); await page.screenshot({ path: path.join(artifacts, "settings-providers-desktop.png"), fullPage: true });
    await page.getByRole("link", { name: "Back to conversation" }).click();
    const workspaceResponse = await page.request.post(`${url}/api/workspaces`, { data: { rootPath: repo } }); expect(workspaceResponse.ok()).toBe(true);
    const workspace = await workspaceResponse.json() as { workspace: { id: string; name: string } };
    await goto("/"); await page.getByRole("button", { name: new RegExp(workspace.workspace.name) }).first().click();
    await new Promise<void>((resolve) => { child.once("message", () => resolve()); child.send({ kind: "script", name: "reply", workspaceId: workspace.workspace.id }); });
    await page.getByLabel("message", { exact: true }).fill("Hello with the saved configuration"); await page.getByTestId("send-message").click();
    await expect.poll(() => page.locator('[data-author="orchestrator"]').count(), { timeout: 30_000 }).toBe(1);
    const id = new URL(page.url()).pathname.split("/").at(-1);
    const detail = await (await page.request.get(`${url}/api/conversations/${id}`)).json() as { dialogueRun: { execution: { provider: string; model: string } } };
    expect(detail.dialogueRun.execution).toEqual({ provider: "claude", model: "claude-haiku-4-5-20251001" });
    const config = await page.request.get(`${url}/api/settings`); expect(await config.text()).not.toContain("browser-private-credential");
  });
  it("supports deep links, search, Save/Cancel, unsaved protection, and persistent preferences", async () => {
    await goto("/settings/general"); await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await page.getByRole("link", { name: "Providers & models", exact: true }).click();
    await page.getByRole("alertdialog").waitFor(); await page.getByRole("button", { name: "Keep editing" }).click();
    expect(new URL(page.url()).pathname).toBe("/settings/general");
    await page.getByRole("button", { name: "Cancel", exact: true }).click(); expect(await page.getByLabel("Theme", { exact: true }).inputValue()).toBe("system");
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await page.getByLabel("Send shortcut", { exact: true }).selectOption("mod-enter"); await save();
    await page.reload(); expect(await page.getByLabel("Theme", { exact: true }).inputValue()).toBe("dark");
    await page.getByLabel("Search settings").fill("browser"); expect(await page.getByRole("link", { name: "Integrations & tools", exact: true }).count()).toBe(1);
    expect(await page.getByRole("link", { name: "Providers & models", exact: true }).count()).toBe(0);
    await page.getByLabel("Search settings").fill("");
    await page.getByRole("link", { name: "Security & data", exact: true }).click(); await page.getByRole("heading", { name: "Security & data", exact: true }).waitFor();
    await page.getByRole("button", { name: "Prepare settings export" }).click();
    const exported = await page.getByLabel("Non-secret settings export").inputValue(); expect(exported).not.toContain("browser-private-credential"); expect(exported).toContain("agentique-settings");
    await page.getByRole("button", { name: "Reset section", exact: true }).click(); await page.getByRole("alertdialog").waitFor(); await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  });
  it("is keyboard-accessible and usable at narrow widths in both themes", async () => {
    for (const section of ["general", "providers", "integrations", "execution", "workspaces", "security", "system"]) {
      await goto(`/settings/${section}`); await page.getByRole("navigation", { name: "Settings sections" }).waitFor();
      const violations = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations;
      expect(violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), section).toEqual([]);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const section of ["general", "providers", "integrations", "execution", "security", "system"]) {
      await goto(`/settings/${section}`); await page.getByRole("navigation", { name: "Settings sections" }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), section).toBe(true);
    }
    await page.screenshot({ path: path.join(artifacts, "settings-system-mobile.png"), fullPage: true });
    await goto("/settings/general"); await page.getByLabel("Theme", { exact: true }).selectOption("light"); await save();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: path.join(artifacts, "settings-general-mobile.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
  it("keeps non-secret preferences and protected credential metadata after a process restart", async () => {
    await stop(); await start(); await goto("/settings/providers");
    expect(await page.getByLabel("Default model", { exact: true }).inputValue()).toBe("claude-haiku-4-5-20251001");
    expect(await page.getByLabel("API credential", { exact: true }).inputValue()).toBe("");
    await goto("/settings/general"); expect(await page.getByLabel("Theme", { exact: true }).inputValue()).toBe("light");
    expect(await page.getByLabel("Send shortcut", { exact: true }).inputValue()).toBe("mod-enter");
  });
});
