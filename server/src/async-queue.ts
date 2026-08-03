/**
 * Unbounded push queue consumable as an async iterable. Push never blocks;
 * close() ends iteration after the buffer drains. One consumer per queue.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #buffer: T[] = [];
  #closed = false;
  #wake: (() => void) | null = null;

  push(value: T): void {
    if (this.#closed) return;
    this.#buffer.push(value);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.#buffer.length > 0) {
        yield this.#buffer.shift() as T;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}
