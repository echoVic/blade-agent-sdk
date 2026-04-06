/**
 * 文件锁管理器
 *
 * 功能：
 * 1. 同一文件支持共享读锁 / 独占写锁
 * 2. 不同文件可以并发执行
 * 3. 使用公平队列避免写锁饥饿
 */

import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';

type FileLockMode = 'read' | 'write';

interface QueuedLockRequest<T> {
  mode: FileLockMode;
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface FileLockState {
  activeReaders: number;
  activeWriter: boolean;
  queue: QueuedLockRequest<unknown>[];
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
   * @returns 操作结果
   */
  acquireLock<T>(filePath: string, operation: () => Promise<T>): Promise<T>;
  acquireLock<T>(filePath: string, mode: FileLockMode, operation: () => Promise<T>): Promise<T>;
  acquireLock<T>(
    filePath: string,
    modeOrOperation: FileLockMode | (() => Promise<T>),
    maybeOperation?: () => Promise<T>,
  ): Promise<T> {
    const mode = typeof modeOrOperation === 'function' ? 'write' : modeOrOperation;
    const operation = typeof modeOrOperation === 'function'
      ? modeOrOperation
      : maybeOperation;

    if (!operation) {
      throw new TypeError('FileLockManager.acquireLock requires an operation');
    }

    const state = this.getOrCreateState(filePath);
    return new Promise<T>((resolve, reject) => {
      const request: QueuedLockRequest<T> = {
        mode,
        operation,
        resolve,
        reject,
      };

      if (this.canGrantImmediately(state, mode)) {
        this.startRequest(filePath, state, request);
        return;
      }

      this.logger.debug(`排队等待${mode === 'read' ? '读' : '写'}锁: ${filePath}`);
      state.queue.push(request as QueuedLockRequest<unknown>);
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

  private startRequest<T>(
    filePath: string,
    state: FileLockState,
    request: QueuedLockRequest<T>,
  ): void {
    if (request.mode === 'read') {
      state.activeReaders += 1;
      this.logger.debug(`获取文件读锁: ${filePath} (activeReaders=${state.activeReaders})`);
    } else {
      state.activeWriter = true;
      this.logger.debug(`获取文件写锁: ${filePath}`);
    }

    void (async () => {
      try {
        const result = await request.operation();
        this.releaseRequest(filePath, state, request.mode);
        request.resolve(result);
      } catch (error) {
        this.releaseRequest(filePath, state, request.mode);
        request.reject(error);
      }
    })();
  }

  private drainQueue(filePath: string, state: FileLockState): void {
    if (state.activeWriter || state.activeReaders > 0) {
      return;
    }

    if (state.queue.length === 0) {
      this.cleanupState(filePath, state);
      return;
    }

    const next = state.queue[0];
    if (next?.mode === 'read') {
      while (state.queue[0]?.mode === 'read') {
        const request = state.queue.shift() as QueuedLockRequest<unknown>;
        this.startRequest(filePath, state, request);
      }
      return;
    }

    const request = state.queue.shift();
    if (request) {
      this.startRequest(filePath, state, request);
    }
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
}
