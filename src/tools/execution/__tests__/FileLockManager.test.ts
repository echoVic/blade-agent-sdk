import { describe, expect, it, beforeEach } from 'bun:test';
import { FileLockManager } from '../FileLockManager.js';

describe('FileLockManager', () => {
  beforeEach(() => {
    // 每个测试前重置单例，确保测试隔离
    FileLockManager.resetInstance();
  });

  describe('getInstance', () => {
    it('should return a FileLockManager instance', () => {
      const instance = FileLockManager.getInstance();
      expect(instance).toBeInstanceOf(FileLockManager);
    });

    it('should return the same instance on multiple calls (singleton)', () => {
      const instance1 = FileLockManager.getInstance();
      const instance2 = FileLockManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should return a new instance after resetInstance', () => {
      const instance1 = FileLockManager.getInstance();
      FileLockManager.resetInstance();
      const instance2 = FileLockManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('acquireLock', () => {
    it('should execute the operation and return its result', async () => {
      const manager = FileLockManager.getInstance();
      const result = await manager.acquireLock('/tmp/file.ts', async () => {
        return 'hello';
      });
      expect(result).toBe('hello');
    });

    it('should recover after a failed operation', async () => {
      const manager = FileLockManager.getInstance();
      // acquireLock stores currentLock.then(() => undefined) internally,
      // which creates an unhandled rejection branch in bun test.
      // So we test error recovery instead of direct error propagation.
      await manager.acquireLock('/tmp/file-err.ts', async () => {
        throw new Error('operation failed');
      }).catch(() => {});

      // Can still use the lock after failure
      const result = await manager.acquireLock('/tmp/file-err.ts', async () => 'recovered');
      expect(result).toBe('recovered');
    });

    it('should serialize operations on the same file', async () => {
      const manager = FileLockManager.getInstance();
      const executionOrder: number[] = [];

      const op1 = manager.acquireLock('/tmp/file.ts', async () => {
        // 模拟耗时操作
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionOrder.push(1);
        return 'first';
      });

      const op2 = manager.acquireLock('/tmp/file.ts', async () => {
        executionOrder.push(2);
        return 'second';
      });

      const [result1, result2] = await Promise.all([op1, op2]);

      expect(result1).toBe('first');
      expect(result2).toBe('second');
      // op1 必须在 op2 之前完成
      expect(executionOrder).toEqual([1, 2]);
    });

    it('should allow concurrent operations on different files', async () => {
      const manager = FileLockManager.getInstance();
      const executionOrder: string[] = [];

      const op1 = manager.acquireLock('/tmp/fileA.ts', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionOrder.push('A');
        return 'A';
      });

      const op2 = manager.acquireLock('/tmp/fileB.ts', async () => {
        // fileB 不需要等待 fileA，应该先完成
        executionOrder.push('B');
        return 'B';
      });

      const [resultA, resultB] = await Promise.all([op1, op2]);

      expect(resultA).toBe('A');
      expect(resultB).toBe('B');
      // fileB 的操作没有延迟，应该先完成
      expect(executionOrder).toEqual(['B', 'A']);
    });

    it('should allow re-acquiring lock after previous operation completes', async () => {
      const manager = FileLockManager.getInstance();

      const result1 = await manager.acquireLock('/tmp/file.ts', async () => 'first');
      expect(result1).toBe('first');

      const result2 = await manager.acquireLock('/tmp/file.ts', async () => 'second');
      expect(result2).toBe('second');
    });

    it('should allow re-acquiring lock after previous operation fails', async () => {
      const manager = FileLockManager.getInstance();

      // 第一个操作失败
      try {
        await manager.acquireLock('/tmp/file.ts', async () => {
          throw new Error('fail');
        });
      } catch {
        // expected
      }

      // 失败后仍然可以重新获取锁
      const result = await manager.acquireLock('/tmp/file.ts', async () => 'recovered');
      expect(result).toBe('recovered');
    });

    it('should serialize three sequential operations on the same file', async () => {
      const manager = FileLockManager.getInstance();
      const executionOrder: number[] = [];

      // Run sequentially to ensure deterministic order
      await manager.acquireLock('/tmp/file.ts', async () => {
        executionOrder.push(1);
      });

      await manager.acquireLock('/tmp/file.ts', async () => {
        executionOrder.push(2);
      });

      await manager.acquireLock('/tmp/file.ts', async () => {
        executionOrder.push(3);
      });

      expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('should continue executing subsequent operations even if one fails', async () => {
      const manager = FileLockManager.getInstance();
      const executionOrder: string[] = [];

      const op1 = manager.acquireLock('/tmp/file.ts', async () => {
        executionOrder.push('op1');
        throw new Error('op1 failed');
      }).catch(() => {
        // 捕获错误，不让 Promise.all 短路
      });

      const op2 = manager.acquireLock('/tmp/file.ts', async () => {
        executionOrder.push('op2');
        return 'success';
      });

      await Promise.all([op1, op2]);

      expect(executionOrder).toEqual(['op1', 'op2']);
    });
  });

  describe('isLocked', () => {
    it('should return false for a file that has never been locked', () => {
      const manager = FileLockManager.getInstance();
      expect(manager.isLocked('/tmp/file.ts')).toBe(false);
    });

    it('should return true for a file that has been locked', async () => {
      const manager = FileLockManager.getInstance();

      // 启动一个长时间操作来保持锁
      const lockPromise = manager.acquireLock('/tmp/file.ts', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // 锁应该已经被设置
      expect(manager.isLocked('/tmp/file.ts')).toBe(true);

      await lockPromise;
    });

    it('should still return true after operation completes (lock entry remains in map)', async () => {
      const manager = FileLockManager.getInstance();

      await manager.acquireLock('/tmp/file.ts', async () => 'done');

      // 注意：acquireLock 完成后锁条目仍然在 map 中
      // isLocked 只检查 map 中是否有条目
      expect(manager.isLocked('/tmp/file.ts')).toBe(true);
    });
  });

  describe('clearLock', () => {
    it('should clear the lock for a specific file', async () => {
      const manager = FileLockManager.getInstance();

      await manager.acquireLock('/tmp/file.ts', async () => 'done');
      expect(manager.isLocked('/tmp/file.ts')).toBe(true);

      manager.clearLock('/tmp/file.ts');
      expect(manager.isLocked('/tmp/file.ts')).toBe(false);
    });

    it('should not affect locks on other files', async () => {
      const manager = FileLockManager.getInstance();

      await manager.acquireLock('/tmp/fileA.ts', async () => 'A');
      await manager.acquireLock('/tmp/fileB.ts', async () => 'B');

      manager.clearLock('/tmp/fileA.ts');

      expect(manager.isLocked('/tmp/fileA.ts')).toBe(false);
      expect(manager.isLocked('/tmp/fileB.ts')).toBe(true);
    });

    it('should not throw when clearing a non-existent lock', () => {
      const manager = FileLockManager.getInstance();
      expect(() => {
        manager.clearLock('/tmp/nonexistent.ts');
      }).not.toThrow();
    });
  });

  describe('clearAll', () => {
    it('should clear all locks', async () => {
      const manager = FileLockManager.getInstance();

      await manager.acquireLock('/tmp/fileA.ts', async () => 'A');
      await manager.acquireLock('/tmp/fileB.ts', async () => 'B');
      await manager.acquireLock('/tmp/fileC.ts', async () => 'C');

      expect(manager.getLockedFileCount()).toBe(3);

      manager.clearAll();

      expect(manager.getLockedFileCount()).toBe(0);
      expect(manager.isLocked('/tmp/fileA.ts')).toBe(false);
      expect(manager.isLocked('/tmp/fileB.ts')).toBe(false);
      expect(manager.isLocked('/tmp/fileC.ts')).toBe(false);
    });

    it('should not throw when no locks exist', () => {
      const manager = FileLockManager.getInstance();
      expect(() => {
        manager.clearAll();
      }).not.toThrow();
    });
  });

  describe('getLockedFiles', () => {
    it('should return an empty array when no files are locked', () => {
      const manager = FileLockManager.getInstance();
      expect(manager.getLockedFiles()).toEqual([]);
    });

    it('should return all locked file paths', async () => {
      const manager = FileLockManager.getInstance();

      await manager.acquireLock('/tmp/fileA.ts', async () => 'A');
      await manager.acquireLock('/tmp/fileB.ts', async () => 'B');

      const lockedFiles = manager.getLockedFiles();
      expect(lockedFiles).toContain('/tmp/fileA.ts');
      expect(lockedFiles).toContain('/tmp/fileB.ts');
      expect(lockedFiles).toHaveLength(2);
    });

    it('should not include cleared files', async () => {
      const manager = FileLockManager.getInstance();

      await manager.acquireLock('/tmp/fileA.ts', async () => 'A');
      await manager.acquireLock('/tmp/fileB.ts', async () => 'B');

      manager.clearLock('/tmp/fileA.ts');

      const lockedFiles = manager.getLockedFiles();
      expect(lockedFiles).not.toContain('/tmp/fileA.ts');
      expect(lockedFiles).toContain('/tmp/fileB.ts');
      expect(lockedFiles).toHaveLength(1);
    });
  });

  describe('getLockedFileCount', () => {
    it('should return 0 when no files are locked', () => {
      const manager = FileLockManager.getInstance();
      expect(manager.getLockedFileCount()).toBe(0);
    });

    it('should return the correct count of locked files', async () => {
      const manager = FileLockManager.getInstance();

      await manager.acquireLock('/tmp/fileA.ts', async () => 'A');
      expect(manager.getLockedFileCount()).toBe(1);

      await manager.acquireLock('/tmp/fileB.ts', async () => 'B');
      expect(manager.getLockedFileCount()).toBe(2);
    });

    it('should decrease count after clearLock', async () => {
      const manager = FileLockManager.getInstance();

      await manager.acquireLock('/tmp/fileA.ts', async () => 'A');
      await manager.acquireLock('/tmp/fileB.ts', async () => 'B');
      expect(manager.getLockedFileCount()).toBe(2);

      manager.clearLock('/tmp/fileA.ts');
      expect(manager.getLockedFileCount()).toBe(1);
    });

    it('should return 0 after clearAll', async () => {
      const manager = FileLockManager.getInstance();

      await manager.acquireLock('/tmp/fileA.ts', async () => 'A');
      await manager.acquireLock('/tmp/fileB.ts', async () => 'B');

      manager.clearAll();
      expect(manager.getLockedFileCount()).toBe(0);
    });
  });

  describe('resetInstance', () => {
    it('should create a fresh instance with no locks', async () => {
      const manager1 = FileLockManager.getInstance();
      await manager1.acquireLock('/tmp/file.ts', async () => 'done');
      expect(manager1.getLockedFileCount()).toBe(1);

      FileLockManager.resetInstance();

      const manager2 = FileLockManager.getInstance();
      expect(manager2.getLockedFileCount()).toBe(0);
      expect(manager2.isLocked('/tmp/file.ts')).toBe(false);
    });
  });

  describe('concurrency edge cases', () => {
    it('should handle rapid sequential lock acquisitions on the same file', async () => {
      const manager = FileLockManager.getInstance();
      const results: number[] = [];

      const promises = Array.from({ length: 10 }, (_, i) =>
        manager.acquireLock('/tmp/file.ts', async () => {
          results.push(i);
          return i;
        })
      );

      const returnValues = await Promise.all(promises);

      // 所有操作应该按顺序执行
      expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(returnValues).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('should handle mixed success and failure operations in sequence', async () => {
      const manager = FileLockManager.getInstance();
      const executionOrder: string[] = [];

      const r1 = await manager.acquireLock('/tmp/file.ts', async () => {
        executionOrder.push('op1-success');
        return 'ok';
      });

      let r2: string;
      try {
        await manager.acquireLock('/tmp/file.ts', async () => {
          executionOrder.push('op2-fail');
          throw new Error('op2 error');
        });
        r2 = 'should not reach';
      } catch (e: any) {
        r2 = e.message;
      }

      const r3 = await manager.acquireLock('/tmp/file.ts', async () => {
        executionOrder.push('op3-success');
        return 'recovered';
      });

      expect(r1).toBe('ok');
      expect(r2).toBe('op2 error');
      expect(r3).toBe('recovered');
      expect(executionOrder).toEqual(['op1-success', 'op2-fail', 'op3-success']);
    });

    it('should handle concurrent locks on many different files', async () => {
      const manager = FileLockManager.getInstance();
      const fileCount = 20;

      const promises = Array.from({ length: fileCount }, (_, i) =>
        manager.acquireLock(`/tmp/file${i}.ts`, async () => `result-${i}`)
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(fileCount);
      results.forEach((result, i) => {
        expect(result).toBe(`result-${i}`);
      });
      expect(manager.getLockedFileCount()).toBe(fileCount);
    });
  });
});
