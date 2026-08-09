import { chromium, type Browser, type Page } from "playwright-core";
import type { EventBus } from "../events/bus.ts";

interface BrowserSeat { browser: Browser; page: Page; console: string[]; }

/**
 * Why this is four fields and not a bare value: the seat has to be able to
 * distinguish "the page returned null", "the expression produced nothing",
 * "the page threw", and "I wrote JavaScript that will not compile". Collapsing
 * all four into `{result: null}` is what made db-live-2's evaluator failures
 * invisible to the agent using it.
 */
export interface EvaluateOutcome {
  result: unknown;
  /** The expression evaluated to `undefined` rather than to `null`. */
  undefined?: boolean;
  /** The page threw. A finding, not a tool failure. */
  threw?: string;
  /** The source would not parse as either an expression or a statement body. */
  compileError?: string;
  /** Evaluation outran `timeoutMs`; the page may still be working. */
  timedOut?: boolean;
}

/**
 * Compile and run a seat's expression, in the page.
 *
 * Tries an EXPRESSION first and falls back to a statement body only when that
 * genuinely will not parse. The old rule was `source.includes("return")` — a
 * substring test over the whole source — so any expression whose text merely
 * mentioned `return` anywhere, including inside a callback, was spliced in as
 * a statement body with no return of its own, evaluated to `undefined`, and
 * came back as `{result: null}`.
 *
 * In db-live-2 that silently swallowed probes like
 * `window.__probe().filter(function(b){return b.kind==='obstacle'})`, which is
 * a pure expression. The seat could not distinguish "the page returned null"
 * from "the tool did not run my code", and rewrote working probes twice
 * hunting for the shape the evaluator liked.
 *
 * MUST stay self-contained — Playwright serializes it into the page, so it can
 * close over nothing.
 */
export async function runInPage(source: string): Promise<EvaluateOutcome> {
  const asError = (error: unknown): string =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  let run: () => Promise<unknown>;
  try {
    run = new Function(`return (async () => (${source}))()`) as () => Promise<unknown>;
  } catch {
    try {
      run = new Function(`return (async () => { ${source} })()`) as () => Promise<unknown>;
    } catch (statementError) {
      return { result: null, compileError: asError(statementError) };
    }
  }
  try {
    const value = await run();
    // `undefined` is reported as such rather than collapsed into null: "this
    // produced nothing" and "this produced null" are different findings.
    return value === undefined ? { result: null, undefined: true } : { result: value };
  } catch (pageError) {
    // A thrown page exception is DATA for a reviewer, not a tool failure —
    // surfaced named, never as a bare null.
    return { result: null, threw: asError(pageError) };
  }
}

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
  async evaluate(key: string, expression: string, timeoutMs = 15_000): Promise<EvaluateOutcome> {
    const seat = await this.#seat(key);
    return Promise.race([
      // `runInPage` is passed by reference, not as a closure: Playwright
      // serializes it into the page, so it must stay self-contained — which is
      // also what lets the test suite call it directly (see
      // browser-evaluate.test.ts). `new Function` behaves identically in Node
      // and in Chrome, so that test exercises the real code path.
      seat.page.evaluate<EvaluateOutcome, string>(runInPage, expression),
      new Promise<EvaluateOutcome>((resolve) =>
        setTimeout(
          () => resolve({ result: null, timedOut: true }),
          Math.max(1_000, Math.min(timeoutMs, 60_000)),
        ).unref?.(),
      ),
    ]);
  }
  async screenshot(key: string, scope: { userSessionId: string; agentSessionId: string }): Promise<{ artifactId: string; bytes: number }> {
    const buffer = await (await this.#seat(key)).page.screenshot({ fullPage: true, type: "png" });
    return this.bus.storeArtifact(buffer.toString("base64"), "image/png;base64", scope);
  }
  async consoleMessages(key: string): Promise<string[]> { return [...(await this.#seat(key)).console]; }
  async closeAll(): Promise<void> { await Promise.all([...this.#seats.values()].map((seat) => seat.browser.close().catch(() => undefined))); this.#seats.clear(); }
  /** One seat's Chrome, released when its lane parks. Keys are `${agentSessionId}:${seat}`. */
  async closeParticipant(key: string): Promise<boolean> {
    const seat = this.#seats.get(key);
    if (!seat) return false;
    this.#seats.delete(key);
    await seat.browser.close().catch(() => undefined);
    return true;
  }
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
