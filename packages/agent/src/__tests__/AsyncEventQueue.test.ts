import { describe, expect, it } from 'vitest';
import { AsyncEventQueue } from '../loop/index.js';

async function collect<T>(queue: AsyncEventQueue<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const event of queue) {
    output.push(event);
  }
  return output;
}

describe('AsyncEventQueue', () => {
  it('yields queued events in enqueue order', async () => {
    const queue = new AsyncEventQueue<number>();

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    queue.close();

    expect(await collect(queue)).toEqual([1, 2, 3]);
  });

  it('waits for producers and then terminates on close', async () => {
    const queue = new AsyncEventQueue<string>();
    const consumer = collect(queue);

    setTimeout(() => {
      queue.enqueue('tool_start');
      queue.enqueue('tool_result');
      queue.close();
    }, 0);

    expect(await consumer).toEqual(['tool_start', 'tool_result']);
  });

  it('propagates queued events before fail throws', async () => {
    const queue = new AsyncEventQueue<number>();
    const output: number[] = [];

    queue.enqueue(1);
    queue.fail(new Error('stream failed'));

    await expect(async () => {
      for await (const event of queue) {
        output.push(event);
      }
    }).rejects.toThrow('stream failed');
    expect(output).toEqual([1]);
  });

  it('filters events at enqueue and consumption time with isLive', async () => {
    let live = true;
    const queue = new AsyncEventQueue<number>({ isLive: () => live });

    queue.enqueue(1);
    live = false;
    queue.enqueue(2);
    live = true;
    queue.enqueue(3);
    live = false;
    queue.close();

    expect(await collect(queue)).toEqual([]);
  });

  it('ignores enqueue and fail after close', async () => {
    const queue = new AsyncEventQueue<number>();

    queue.enqueue(1);
    queue.close();
    queue.enqueue(2);
    queue.fail(new Error('ignored'));

    expect(await collect(queue)).toEqual([1]);
  });
});
