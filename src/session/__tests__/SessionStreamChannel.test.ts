import { describe, expect, it } from 'vitest';
import { SessionStreamChannel } from '../SessionStreamChannel.js';

describe('SessionStreamChannel', () => {
  it('preserves event order', async () => {
    const channel = new SessionStreamChannel<number>(2);
    const producer = (async () => {
      await channel.publish(1);
      await channel.publish(2);
      channel.close();
    })();

    const values: number[] = [];
    for await (const value of channel) {
      values.push(value);
    }

    await producer;
    expect(values).toEqual([1, 2]);
  });

  it('waits for the consumer to advance before acknowledging an event', async () => {
    const channel = new SessionStreamChannel<number>(1);
    let published = false;
    const publication = channel.publish(1).then(() => {
      published = true;
    });

    const iterator = channel[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    expect(published).toBe(false);

    const completed = iterator.next();
    await publication;
    expect(published).toBe(true);
    channel.close();
    await expect(completed).resolves.toEqual({ value: undefined, done: true });
  });

  it('releases blocked producers during cancellation', async () => {
    const channel = new SessionStreamChannel<number>(1);
    let published = false;
    const publication = channel.publish(1).then(() => {
      published = true;
    });
    const iterator = channel[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    expect(published).toBe(false);

    channel.releaseBackpressure();
    await publication;
    expect(published).toBe(true);

    channel.close();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('does not acknowledge an event when the consumer returns early', async () => {
    const channel = new SessionStreamChannel<number>();
    let published = false;
    const publication = channel.publish(1).then(() => {
      published = true;
    });
    const iterator = channel[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await iterator.return?.();
    await Promise.resolve();
    expect(published).toBe(false);

    channel.releaseBackpressure();
    await publication;
    expect(published).toBe(true);
  });

  it('drains buffered events before propagating producer failure', async () => {
    const channel = new SessionStreamChannel<number>();
    const publication = channel.publish(1);
    channel.fail(new Error('producer failed'));
    await publication;

    const values: number[] = [];
    await expect(async () => {
      for await (const value of channel) {
        values.push(value);
      }
    }).rejects.toThrow('producer failed');
    expect(values).toEqual([1]);
  });

  it('rejects invalid capacities', () => {
    expect(() => new SessionStreamChannel(0)).toThrow(RangeError);
    expect(() => new SessionStreamChannel(1.5)).toThrow(RangeError);
  });
});
