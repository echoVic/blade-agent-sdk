/**
 * Async producer/consumer queue used by agent streaming loops.
 *
 * Producers call enqueue/close/fail, while consumers iterate with for-await.
 * The optional isLive predicate filters stale events at enqueue time and again
 * at consumption time, covering the small window where a stream epoch is
 * invalidated after an event was buffered.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly isLive: () => boolean;
  private closed = false;
  private error: unknown;
  private waiter: (() => void) | null = null;

  constructor(opts?: { isLive?: () => boolean }) {
    this.isLive = opts?.isLive ?? (() => true);
  }

  enqueue(event: T): void {
    if (this.closed) return;
    if (!this.isLive()) return;
    this.buffer.push(event);
    this.flushWaiter();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushWaiter();
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.error = err;
    this.closed = true;
    this.flushWaiter();
  }

  private flushWaiter(): void {
    const resolve = this.waiter;
    this.waiter = null;
    resolve?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.buffer.length > 0) {
        const event = this.buffer.shift() as T;
        if (!this.isLive()) continue;
        yield event;
      }

      if (this.error !== undefined) {
        const err = this.error;
        this.error = undefined;
        throw err;
      }

      if (this.closed) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        if (this.buffer.length > 0 || this.closed) {
          this.flushWaiter();
        }
      });
    }
  }
}
