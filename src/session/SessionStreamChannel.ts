/**
 * Single-consumer channel for decoupling Session execution from stream reads.
 *
 * Normal publishing uses two-phase acknowledgement: the producer resumes only
 * when the consumer asks for the next event. Cancellation can release that
 * backpressure so cleanup is never blocked by a paused consumer.
 */
export class SessionStreamChannel<T> implements AsyncIterable<T> {
  private readonly buffer: Array<{
    value: T;
    acknowledge: () => void;
  }> = [];
  private readonly producerWaiters = new Set<() => void>();
  private readonly acknowledgementWaiters = new Set<() => void>();
  private consumerWaiter: (() => void) | null = null;
  private backpressureReleased = false;
  private closed = false;
  private failed = false;
  private error: unknown;

  constructor(private readonly capacity = 1) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Session stream channel capacity must be a positive safe integer');
    }
  }

  async publish(value: T): Promise<boolean> {
    while (
      !this.closed
      && !this.backpressureReleased
      && this.buffer.length >= this.capacity
    ) {
      await new Promise<void>((resolve) => {
        this.producerWaiters.add(resolve);
      });
    }
    if (this.closed) {
      return false;
    }
    let acknowledged = false;
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = () => {
        if (acknowledged) {
          return;
        }
        acknowledged = true;
        this.acknowledgementWaiters.delete(acknowledge);
        resolve();
      };
    });
    this.acknowledgementWaiters.add(acknowledge);
    this.buffer.push({ value, acknowledge });
    this.wakeConsumer();
    if (!this.backpressureReleased) {
      await acknowledgement;
    }
    return true;
  }

  releaseBackpressure(): void {
    if (this.backpressureReleased) {
      return;
    }
    this.backpressureReleased = true;
    this.acknowledgeAll();
    this.wakeProducers();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.acknowledgeAll();
    this.wakeConsumer();
    this.wakeProducers();
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.failed = true;
    this.error = error;
    this.closed = true;
    this.acknowledgeAll();
    this.wakeConsumer();
    this.wakeProducers();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.buffer.length > 0) {
        const item = this.buffer.shift();
        if (!item) {
          break;
        }
        this.wakeProducers();
        let advanced = false;
        try {
          yield item.value;
          advanced = true;
        } finally {
          if (advanced) {
            item.acknowledge();
          }
        }
      }
      if (this.failed) {
        throw this.error;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.consumerWaiter = resolve;
        if (this.buffer.length > 0 || this.closed) {
          this.wakeConsumer();
        }
      });
    }
  }

  private wakeConsumer(): void {
    const waiter = this.consumerWaiter;
    this.consumerWaiter = null;
    waiter?.();
  }

  private wakeProducers(): void {
    if (this.producerWaiters.size === 0) {
      return;
    }
    const waiters = [...this.producerWaiters];
    this.producerWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  private acknowledgeAll(): void {
    const waiters = [...this.acknowledgementWaiters];
    this.acknowledgementWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }
}
