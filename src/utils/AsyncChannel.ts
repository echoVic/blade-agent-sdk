export class AsyncChannel<T> implements AsyncIterable<T> {
  private readonly buffer: Array<{ value: T; acknowledge: () => void }> = [];
  private readonly producerWaiters = new Set<() => void>();
  private readonly acknowledgements = new Set<() => void>();
  private consumerWaiter: (() => void) | null = null;
  private backpressureReleased = false;
  private closed = false;
  private error: unknown;

  constructor(private readonly capacity = 1) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Async channel capacity must be a positive safe integer');
    }
  }

  async publish(value: T): Promise<boolean> {
    while (!this.closed && !this.backpressureReleased && this.buffer.length >= this.capacity) {
      await new Promise<void>((resolve) => this.producerWaiters.add(resolve));
    }
    if (this.closed) return false;
    let acknowledged = false;
    let acknowledge!: () => void;
    const consumed = new Promise<void>((resolve) => {
      acknowledge = () => {
        if (acknowledged) return;
        acknowledged = true;
        this.acknowledgements.delete(acknowledge);
        resolve();
      };
    });
    this.acknowledgements.add(acknowledge);
    this.buffer.push({ value, acknowledge });
    this.wakeConsumer();
    if (!this.backpressureReleased) await consumed;
    return true;
  }

  releaseBackpressure(): void {
    if (this.backpressureReleased) return;
    this.backpressureReleased = true;
    this.acknowledgeAll();
    this.wakeProducers();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.acknowledgeAll();
    this.wakeConsumer();
    this.wakeProducers();
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.error = error;
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.buffer.length > 0) {
        const item = this.buffer.shift();
        if (!item) break;
        this.wakeProducers();
        let consumed = false;
        try {
          yield item.value;
          consumed = true;
        } finally {
          if (consumed) item.acknowledge();
        }
      }
      if (this.error !== undefined) throw this.error;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.consumerWaiter = resolve;
        if (this.buffer.length > 0 || this.closed) this.wakeConsumer();
      });
    }
  }

  private wakeConsumer(): void {
    const waiter = this.consumerWaiter;
    this.consumerWaiter = null;
    waiter?.();
  }

  private wakeProducers(): void {
    const waiters = [...this.producerWaiters];
    this.producerWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  private acknowledgeAll(): void {
    const waiters = [...this.acknowledgements];
    this.acknowledgements.clear();
    for (const waiter of waiters) waiter();
  }
}
