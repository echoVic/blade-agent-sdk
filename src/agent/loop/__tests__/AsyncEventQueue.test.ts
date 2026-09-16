import { describe, expect, it } from 'vitest';
import { AsyncEventQueue, AsyncEventQueueOverflowError } from '../AsyncEventQueue.js';

async function collect<T>(queue: AsyncEventQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of queue) out.push(event);
  return out;
}

describe('AsyncEventQueue backpressure', () => {
  it('merges consecutive text deltas instead of buffering each one', async () => {
    const queue = new AsyncEventQueue<{ type: 'content_delta'; delta: string }>({
      coalesce: (pending, incoming) =>
        pending.type === incoming.type
          ? { type: 'content_delta', delta: pending.delta + incoming.delta }
          : undefined,
    });

    for (const char of ['H', 'e', 'l', 'l', 'o']) {
      queue.enqueue({ type: 'content_delta', delta: char });
    }
    expect(queue.pending).toBe(1);
    queue.close();

    const seen = [];
    for await (const event of queue) seen.push(event.delta);
    // Every character survives; only the event count collapsed.
    expect(seen).toEqual(['Hello']);
  });

  it('fails loudly rather than dropping events when the buffer is exceeded', async () => {
    const queue = new AsyncEventQueue<number>({ maxBufferSize: 3 });
    for (const value of [1, 2, 3]) {
      queue.enqueue(value);
    }
    // The fourth event cannot be buffered, so the consumer must learn about it.
    queue.enqueue(4);

    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const event of queue) seen.push(event);
      })(),
    ).rejects.toBeInstanceOf(AsyncEventQueueOverflowError);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('honours close and isLive without buffering dead events', async () => {
    let live = true;
    const queue = new AsyncEventQueue<number>({ isLive: () => live, maxBufferSize: 2 });
    queue.enqueue(1);
    live = false;
    queue.enqueue(2);
    expect(queue.pending).toBe(1);
    queue.close();

    const seen: number[] = [];
    for await (const event of queue) seen.push(event);
    expect(seen).toEqual([]);
  });
});

describe('AsyncEventQueue', () => {
  it('yields events in enqueue order', async () => {
    const queue = new AsyncEventQueue<number>();
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    queue.close();

    expect(await collect(queue)).toEqual([1, 2, 3]);
  });

  it('waits for producers then terminates on close', async () => {
    const queue = new AsyncEventQueue<string>();
    const consumer = collect(queue);

    setTimeout(() => {
      queue.enqueue('a');
      queue.enqueue('b');
      queue.close();
    }, 0);

    expect(await consumer).toEqual(['a', 'b']);
  });

  it('propagates errors via fail()', async () => {
    const queue = new AsyncEventQueue<number>();
    queue.enqueue(1);
    queue.fail(new Error('boom'));

    const out: number[] = [];
    await expect(async () => {
      for await (const event of queue) out.push(event);
    }).rejects.toThrow('boom');
    expect(out).toEqual([1]);
  });

  it('drops events when isLive returns false at enqueue time', async () => {
    let live = true;
    const queue = new AsyncEventQueue<number>({ isLive: () => live });
    queue.enqueue(1);
    live = false;
    queue.enqueue(2);
    live = true;
    queue.enqueue(3);
    queue.close();

    expect(await collect(queue)).toEqual([1, 3]);
  });

  it('drops buffered events when isLive flips to false before consumption', async () => {
    let live = true;
    const queue = new AsyncEventQueue<number>({ isLive: () => live });
    queue.enqueue(1);
    queue.enqueue(2);
    live = false;
    queue.close();

    expect(await collect(queue)).toEqual([]);
  });

  it('handles concurrent enqueue while consumer is waiting', async () => {
    const queue = new AsyncEventQueue<number>();
    const consumer = collect(queue);

    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      queue.enqueue(i);
    }
    queue.close();

    expect(await consumer).toEqual([0, 1, 2, 3, 4]);
  });

  it('is idempotent on close/fail', async () => {
    const queue = new AsyncEventQueue<number>();
    queue.enqueue(1);
    queue.close();
    queue.close();
    queue.fail(new Error('ignored'));

    expect(await collect(queue)).toEqual([1]);
  });
});
