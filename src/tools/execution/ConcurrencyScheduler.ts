/**
 * 并发调度器
 *
 * 按 ToolKind 将工具调用分桶,不同桶有不同的并发策略:
 *
 * | Bucket   | 最大并发 | 说明                                       |
 * |----------|---------|--------------------------------------------|
 * | readonly | 10      | 无副作用工具 (Read/Grep/Glob/WebFetch 等)  |
 * | write    | 10 *    | 写工具;* 不同文件可并行,同文件由调用方走   |
 * |          |         | FileLockManager 串行                       |
 * | execute  | 3       | Bash/Shell 限并发,避免系统资源争抢         |
 *
 * 注意: scheduler 只做"桶配额"管理;工具内部的串行化 (如同文件编辑)
 * 仍由 FileLockManager 负责。两者正交。
 * 调用方应直接提交所有已就绪任务,不要再叠加独立的数值并发限制。
 */

import { ToolKind } from '../types/ToolKind.js';

export interface ConcurrencyLease {
  release(): void;
}

interface PendingLease {
  resolve: (lease: ConcurrencyLease) => void;
};

interface BucketState {
  inFlight: number;
  maxConcurrent: number;
  queue: PendingLease[];
}

export interface ConcurrencyLimits {
  readonly?: number;
  write?: number;
  execute?: number;
}

const DEFAULT_LIMITS: Required<ConcurrencyLimits> = {
  readonly: 10,
  write: 10,
  execute: 3,
};

export class ConcurrencyScheduler {
  private static instance: ConcurrencyScheduler | null = null;

  private readonly buckets: Record<ToolKind, BucketState>;

  constructor(limits: ConcurrencyLimits = {}) {
    const merged = { ...DEFAULT_LIMITS, ...limits };
    this.buckets = {
      [ToolKind.ReadOnly]: {
        inFlight: 0,
        maxConcurrent: merged.readonly,
        queue: [],
      },
      [ToolKind.Write]: {
        inFlight: 0,
        maxConcurrent: merged.write,
        queue: [],
      },
      [ToolKind.Execute]: {
        inFlight: 0,
        maxConcurrent: merged.execute,
        queue: [],
      },
    };
  }

  static getInstance(): ConcurrencyScheduler {
    if (!ConcurrencyScheduler.instance) {
      ConcurrencyScheduler.instance = new ConcurrencyScheduler();
    }
    return ConcurrencyScheduler.instance;
  }

  static resetInstance(): void {
    ConcurrencyScheduler.instance = null;
  }

  async acquire(kind: ToolKind): Promise<ConcurrencyLease> {
    const bucket = this.buckets[kind];
    if (!bucket) {
      return { release() {} };
    }

    if (bucket.inFlight < bucket.maxConcurrent) {
      bucket.inFlight++;
      return this.createLease(bucket);
    }

    return new Promise<ConcurrencyLease>((resolve) => {
      bucket.queue.push({ resolve });
    });
  }

  async schedule<T>(kind: ToolKind, fn: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(kind);
    try {
      return await fn();
    } finally {
      lease.release();
    }
  }

  getStats(): Record<ToolKind, { inFlight: number; queued: number }> {
    return {
      [ToolKind.ReadOnly]: {
        inFlight: this.buckets[ToolKind.ReadOnly].inFlight,
        queued: this.buckets[ToolKind.ReadOnly].queue.length,
      },
      [ToolKind.Write]: {
        inFlight: this.buckets[ToolKind.Write].inFlight,
        queued: this.buckets[ToolKind.Write].queue.length,
      },
      [ToolKind.Execute]: {
        inFlight: this.buckets[ToolKind.Execute].inFlight,
        queued: this.buckets[ToolKind.Execute].queue.length,
      },
    };
  }

  private createLease(bucket: BucketState): ConcurrencyLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        bucket.inFlight--;
        this.drain(bucket);
      },
    };
  }

  private drain(bucket: BucketState): void {
    while (bucket.inFlight < bucket.maxConcurrent && bucket.queue.length > 0) {
      const pending = bucket.queue.shift();
      if (!pending) break;
      bucket.inFlight++;
      pending.resolve(this.createLease(bucket));
    }
  }
}
