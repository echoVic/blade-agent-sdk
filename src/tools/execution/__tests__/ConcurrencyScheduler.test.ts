import { afterEach, describe, expect, it } from 'vitest';
import { ToolKind } from '../../types/ToolKind.js';
import { ConcurrencyScheduler } from '../ConcurrencyScheduler.js';

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ConcurrencyScheduler', () => {
  afterEach(() => {
    ConcurrencyScheduler.resetInstance();
  });

  describe('单例', () => {
    it('getInstance 返回同一实例', () => {
      const a = ConcurrencyScheduler.getInstance();
      const b = ConcurrencyScheduler.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance 后返回新实例', () => {
      const a = ConcurrencyScheduler.getInstance();
      ConcurrencyScheduler.resetInstance();
      const b = ConcurrencyScheduler.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('readonly 桶: 无限并发', () => {
    it('100 个 readonly 任务应全部并行启动', async () => {
      const scheduler = new ConcurrencyScheduler();
      const gates = Array.from({ length: 100 }, () => deferred<number>());

      const results = gates.map((g, i) =>
        scheduler.schedule(ToolKind.ReadOnly, async () => g.promise.then(() => i))
      );

      await new Promise((r) => setTimeout(r, 0));

      expect(scheduler.getStats()[ToolKind.ReadOnly]).toEqual({
        inFlight: 100,
        queued: 0,
      });

      for (const g of gates) {
        g.resolve(0);
      }
      const values = await Promise.all(results);
      expect(values).toHaveLength(100);
    });
  });

  describe('execute 桶: 限并发 3', () => {
    it('超过 3 个任务时,多余的应排队', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 3 });
      const gates = Array.from({ length: 5 }, () => deferred<void>());
      const started: number[] = [];

      const promises = gates.map((g, i) =>
        scheduler.schedule(ToolKind.Execute, async () => {
          started.push(i);
          await g.promise;
        })
      );

      await new Promise((r) => setTimeout(r, 0));
      expect(started).toEqual([0, 1, 2]);
      expect(scheduler.getStats()[ToolKind.Execute]).toEqual({
        inFlight: 3,
        queued: 2,
      });

      gates[0].resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(started).toEqual([0, 1, 2, 3]);

      gates[1].resolve();
      gates[2].resolve();
      gates[3].resolve();
      gates[4].resolve();
      await Promise.all(promises);
      expect(started).toEqual([0, 1, 2, 3, 4]);
    });

    it('任务抛错时仍应释放配额', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 1 });

      await expect(
        scheduler.schedule(ToolKind.Execute, async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(scheduler.getStats()[ToolKind.Execute].inFlight).toBe(0);

      const result = await scheduler.schedule(
        ToolKind.Execute,
        async () => 'ok'
      );
      expect(result).toBe('ok');
    });
  });

  describe('桶隔离', () => {
    it('execute 桶打满不影响 readonly', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 1 });
      const blockExec = deferred<void>();

      const execPromise = scheduler.schedule(
        ToolKind.Execute,
        async () => blockExec.promise
      );
      await new Promise((r) => setTimeout(r, 0));

      const readResult = await scheduler.schedule(
        ToolKind.ReadOnly,
        async () => 'read-ok'
      );
      expect(readResult).toBe('read-ok');

      blockExec.resolve();
      await execPromise;
    });
  });

  describe('自定义限额', () => {
    it('可以覆盖默认 execute 限额', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 1 });
      const gates = [deferred<void>(), deferred<void>()];
      const started: number[] = [];

      const promises = gates.map((g, i) =>
        scheduler.schedule(ToolKind.Execute, async () => {
          started.push(i);
          await g.promise;
        })
      );

      await new Promise((r) => setTimeout(r, 0));
      expect(started).toEqual([0]);

      gates[0].resolve();
      gates[1].resolve();
      await Promise.all(promises);
    });
  });

  describe('FIFO 顺序', () => {
    it('排队任务应按入队顺序唤醒', async () => {
      const scheduler = new ConcurrencyScheduler({ execute: 1 });
      const order: number[] = [];
      const first = deferred<void>();

      const p0 = scheduler.schedule(ToolKind.Execute, async () => {
        order.push(0);
        await first.promise;
      });

      const p1 = scheduler.schedule(ToolKind.Execute, async () => {
        order.push(1);
      });
      const p2 = scheduler.schedule(ToolKind.Execute, async () => {
        order.push(2);
      });
      const p3 = scheduler.schedule(ToolKind.Execute, async () => {
        order.push(3);
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(order).toEqual([0]);

      first.resolve();
      await Promise.all([p0, p1, p2, p3]);
      expect(order).toEqual([0, 1, 2, 3]);
    });
  });

  describe('进程级共享 (多 pipeline/多 agent 场景)', () => {
    it('多个独立的 scheduler 实例共用 getInstance() 时,execute 配额全局生效', async () => {
      const pipelineA = ConcurrencyScheduler.getInstance();
      const pipelineB = ConcurrencyScheduler.getInstance();
      const pipelineC = ConcurrencyScheduler.getInstance();
      expect(pipelineA).toBe(pipelineB);
      expect(pipelineB).toBe(pipelineC);

      const gates = Array.from({ length: 6 }, () => deferred<void>());
      const started: number[] = [];
      const promises = gates.map((g, i) =>
        [pipelineA, pipelineB, pipelineC][i % 3].schedule(
          ToolKind.Execute,
          async () => {
            started.push(i);
            await g.promise;
          }
        )
      );

      await new Promise((r) => setTimeout(r, 0));
      expect(started).toHaveLength(3);
      expect(pipelineA.getStats()[ToolKind.Execute]).toEqual({
        inFlight: 3,
        queued: 3,
      });

      for (const g of gates) {
        g.resolve();
      }
      await Promise.all(promises);
    });
  });
});
