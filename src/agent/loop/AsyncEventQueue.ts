/**
 * 简单的异步事件队列：producer 侧调用 enqueue/close/fail，
 * consumer 侧用 for-await 迭代即可按顺序拿到事件。
 *
 * 可选 isLive() 谓词：入队时若返回 false 则静默丢弃。
 * 用来统一 epoch 失效时的事件过滤（避免手写 pendingEvents + waitForEventsResolve）。
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
        // 消费时再过滤一次，覆盖"入队后 isLive 才变 false"的窗口
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
        // 再检查一次避免竞态
        if (this.buffer.length > 0 || this.closed) {
          this.flushWaiter();
        }
      });
    }
  }
}
