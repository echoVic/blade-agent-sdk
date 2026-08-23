/**
 * 文件锁管理器
 *
 * 功能：
 * 1. 同一文件支持共享读锁 / 独占写锁
 * 2. 不同文件可以并发执行
 * 3. 使用公平队列避免写锁饥饿
 */

import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import { getAbortSignalReason } from '../../utils/abortPromise.js';

type FileLockMode = 'read' | 'write';

export interface FileLockLease {
  release(): void;
}

interface QueuedLockRequest {
  mode: FileLockMode;
  resolve: (lease: FileLockLease) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface FileLockState {
  activeReaders: number;
  activeWriter: boolean;
  queue: QueuedLockRequest[];
}

export class FileLockManager {
  // 全局单例实例
  private static instance: FileLockManager | null = null;
  private logger: InternalLogger = NOOP_LOGGER.child(LogCategory.EXECUTION);

  // 文件锁映射: filePath -> lock state
  private locks: Map<string, FileLockState> = new Map();

  // 私有构造函数（单例模式）
  private constructor() {}

  /**
   * 获取全局单例实例
   */
  static getInstance(logger?: InternalLogger): FileLockManager {
    if (!FileLockManager.instance) {
      FileLockManager.instance = new FileLockManager();
    }
    if (logger) {
      FileLockManager.instance.setLogger(logger);
    }
    return FileLockManager.instance;
  }

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.EXECUTION);
  }

  /**
   * 获取文件锁并执行操作
   *
   * @param filePath 文件绝对路径
   * @param mode 锁模式，默认 write
   * @param operation 要执行的操作
   * @param signal 可选的排队取消信号
   * @returns 操作结果
   */
  acquireLock<T>(
    filePath: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  acquireLock<T>(
    filePath: string,
    mode: FileLockMode,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  acquireLock<T>(
    filePath: string,
    modeOrOperation: FileLockMode | (() => Promise<T>),
    operationOrSignal?: (() => Promise<T>) | AbortSignal,
    signal?: AbortSignal,
  ): Promise<T> {
    const mode = typeof modeOrOperation === 'function' ? 'write' : modeOrOperation;
    const operation = typeof modeOrOperation === 'function'
      ? modeOrOperation
      : operationOrSignal;
    const resolvedSignal = typeof modeOrOperation === 'function'
      ? operationOrSignal as AbortSignal | undefined
      : signal;

    if (typeof operation !== 'function') {
      throw new TypeError('FileLockManager.acquireLock requires an operation');
    }

    return this.runWithLock(filePath, mode, operation, resolvedSignal);
  }

  async acquire(
    filePath: string,
    mode: FileLockMode = 'write',
    signal?: AbortSignal,
  ): Promise<FileLockLease> {
    signal?.throwIfAborted();
    const state = this.getOrCreateState(filePath);
    return new Promise<FileLockLease>((resolve, reject) => {
      const request: QueuedLockRequest = {
        mode,
        resolve,
        reject,
        signal,
      };

      if (this.canGrantImmediately(state, mode)) {
        if (!this.grant(filePath, state, request)) {
          this.cleanupState(filePath, state);
        }
        return;
      }

      this.logger.debug(`排队等待${mode === 'read' ? '读' : '写'}锁: ${filePath}`);
      state.queue.push(request);
      if (signal) {
        request.onAbort = () => {
          const index = state.queue.indexOf(request);
          if (index < 0) {
            return;
          }
          state.queue.splice(index, 1);
          reject(getAbortSignalReason(signal));
          this.drainQueue(filePath, state);
        };
        signal.addEventListener('abort', request.onAbort, { once: true });
      }
    });
  }

  /**
   * 检查文件是否被锁定
   */
  isLocked(filePath: string): boolean {
    const state = this.locks.get(filePath);
    return state !== undefined && this.hasActiveOrQueuedLocks(state);
  }

  /**
   * 清除指定文件的锁
   */
  clearLock(filePath: string): void {
    this.locks.delete(filePath);
  }

  /**
   * 清除所有文件锁
   */
  clearAll(): void {
    this.locks.clear();
  }

  /**
   * 获取当前锁定的文件列表
   */
  getLockedFiles(): string[] {
    return Array.from(this.locks.entries())
      .filter(([, state]) => this.hasActiveOrQueuedLocks(state))
      .map(([filePath]) => filePath);
  }

  /**
   * 获取锁定文件数量
   */
  getLockedFileCount(): number {
    return this.getLockedFiles().length;
  }

  /**
   * 重置单例实例（仅用于测试）
   */
  static resetInstance(): void {
    FileLockManager.instance = null;
  }

  private getOrCreateState(filePath: string): FileLockState {
    const existing = this.locks.get(filePath);
    if (existing) {
      return existing;
    }

    const state: FileLockState = {
      activeReaders: 0,
      activeWriter: false,
      queue: [],
    };
    this.locks.set(filePath, state);
    return state;
  }

  private canGrantImmediately(state: FileLockState, mode: FileLockMode): boolean {
    if (mode === 'read') {
      return !state.activeWriter && state.queue.length === 0;
    }

    return !state.activeWriter && state.activeReaders === 0 && state.queue.length === 0;
  }

  private hasActiveOrQueuedLocks(state: FileLockState): boolean {
    return state.activeWriter || state.activeReaders > 0 || state.queue.length > 0;
  }

  private grant(
    filePath: string,
    state: FileLockState,
    request: QueuedLockRequest,
  ): boolean {
    if (request.onAbort && request.signal) {
      request.signal.removeEventListener('abort', request.onAbort);
    }
    if (request.signal?.aborted) {
      request.reject(getAbortSignalReason(request.signal));
      return false;
    }

    if (request.mode === 'read') {
      state.activeReaders += 1;
      this.logger.debug(`获取文件读锁: ${filePath} (activeReaders=${state.activeReaders})`);
    } else {
      state.activeWriter = true;
      this.logger.debug(`获取文件写锁: ${filePath}`);
    }

    let released = false;
    request.resolve({
      release: () => {
        if (released) return;
        released = true;
        this.releaseRequest(filePath, state, request.mode);
      },
    });
    return true;
  }

  private drainQueue(filePath: string, state: FileLockState): void {
    if (state.activeWriter) {
      return;
    }

    while (state.queue.length > 0) {
      const next = state.queue[0];
      if (state.activeReaders > 0 && next?.mode === 'write') {
        return;
      }
      if (next?.mode === 'read') {
        let grantedReader = false;
        while (state.queue[0]?.mode === 'read') {
          const request = state.queue.shift();
          if (!request) break;
          grantedReader = this.grant(filePath, state, request) || grantedReader;
        }
        if (grantedReader) {
          return;
        }
        continue;
      }

      const request = state.queue.shift();
      if (request && this.grant(filePath, state, request)) {
        return;
      }
    }

    this.cleanupState(filePath, state);
  }

  private cleanupState(filePath: string, state: FileLockState): void {
    if (!this.hasActiveOrQueuedLocks(state) && this.locks.get(filePath) === state) {
      this.locks.delete(filePath);
    }
  }

  private releaseRequest(
    filePath: string,
    state: FileLockState,
    mode: FileLockMode,
  ): void {
    if (mode === 'read') {
      state.activeReaders = Math.max(0, state.activeReaders - 1);
      this.logger.debug(`释放文件读锁: ${filePath} (activeReaders=${state.activeReaders})`);
    } else {
      state.activeWriter = false;
      this.logger.debug(`释放文件写锁: ${filePath}`);
    }

    this.drainQueue(filePath, state);
  }

  private async runWithLock<T>(
    filePath: string,
    mode: FileLockMode,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lease = await this.acquire(filePath, mode, signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      lease.release();
    }
  }
}
