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
  /**
   * Keyboard input. Without it a visual reviewer cannot exercise anything
   * driven by keys — in db-live-1 `check` was assigned "play a round using
   * arrow keys" against a toolset that had no press primitive, searched for
   * one, found nothing, and correctly reported the play-through as
   * undrivable on any machine.
   */
  async press(key: string, keys: string, options: { selector?: string; repeat?: number; delayMs?: number } = {}): Promise<{ pressed: string; times: number }> {
    const seat = await this.#seat(key);
    const target = options.selector ? seat.page.locator(options.selector) : seat.page.keyboard;
    const times = Math.max(1, Math.min(options.repeat ?? 1, 100));
    for (let i = 0; i < times; i += 1) {
      await target.press(keys, options.delayMs === undefined ? undefined : { delay: options.delayMs });
      if (options.delayMs !== undefined && i < times - 1) await seat.page.waitForTimeout(options.delayMs);
    }
    return { pressed: keys, times };
  }
  /**
   * Read page state the DOM text does not expose — localStorage, a canvas
   * game's score, a module's exports. Verification otherwise stops at
   * "something rendered".
   */
  async evaluate(key: string, expression: string): Promise<{ result: unknown }> {
    const seat = await this.#seat(key);
    // Wrapped so a bare expression and a statement body both work.
    const value = await seat.page.evaluate<unknown, string>(
      (source) => (new Function(`return (async () => { ${source.includes("return") ? source : `return (${source});`} })()`) as () => Promise<unknown>)(),
      expression,
    );
    return { result: value === undefined ? null : value };
  }
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
