import { chromium, type Browser, type Page } from "playwright-core";
import type { EventBus } from "../events/bus.ts";

interface BrowserSeat { browser: Browser; page: Page; console: string[]; }

/** Profile-gated local Chrome automation; screenshots are durable artifacts. */
export class BrowserManager {
  readonly #seats = new Map<string, BrowserSeat>();
  constructor(readonly bus: EventBus) {}

  async open(key: string, url: string): Promise<{ url: string; title: string }> {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") throw new Error("browser_open accepts only http(s) URLs");
    const seat = await this.#seat(key);
    await seat.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { url: seat.page.url(), title: await seat.page.title() };
  }
  async snapshot(key: string): Promise<{ url: string; title: string; text: string }> {
    const seat = await this.#seat(key);
    return { url: seat.page.url(), title: await seat.page.title(), text: (await seat.page.locator("body").innerText()).slice(0, 24_000) };
  }
  async click(key: string, selector: string): Promise<void> { await (await this.#seat(key)).page.locator(selector).click(); }
  async fill(key: string, selector: string, value: string): Promise<void> { await (await this.#seat(key)).page.locator(selector).fill(value); }
  async screenshot(key: string, scope: { userSessionId: string; agentSessionId: string }): Promise<{ artifactId: string; bytes: number }> {
    const buffer = await (await this.#seat(key)).page.screenshot({ fullPage: true, type: "png" });
    return this.bus.storeArtifact(buffer.toString("base64"), "image/png;base64", scope);
  }
  async consoleMessages(key: string): Promise<string[]> { return [...(await this.#seat(key)).console]; }
  async closeAll(): Promise<void> { await Promise.all([...this.#seats.values()].map((seat) => seat.browser.close().catch(() => undefined))); this.#seats.clear(); }
  async closeSession(agentSessionId: string): Promise<void> {
    const owned = [...this.#seats.entries()].filter(([key]) => key.startsWith(`${agentSessionId}:`));
    await Promise.all(owned.map(async ([key, seat]) => { this.#seats.delete(key); await seat.browser.close().catch(() => undefined); }));
  }
  async #seat(key: string): Promise<BrowserSeat> {
    const existing = this.#seats.get(key); if (existing) return existing;
    const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const seat: BrowserSeat = { browser, page, console: [] };
    page.on("console", (message) => { seat.console.push(`${message.type()}: ${message.text()}`); if (seat.console.length > 200) seat.console.shift(); });
    page.on("pageerror", (error) => { seat.console.push(`pageerror: ${error.message}`); });
    this.#seats.set(key, seat); return seat;
  }
}
