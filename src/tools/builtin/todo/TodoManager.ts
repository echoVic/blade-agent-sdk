import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { SessionId } from '../../../types/identifiers.js';
import { getErrorCode } from '../../../utils/errorUtils.js';
import type { TodoItem, TodoStatus, ValidationResult } from './types.js';

/**
 * TODO 任务管理器
 * 负责管理会话级别的 TODO 列表，支持持久化存储和状态验证。
 * configDir 未提供时降级为纯内存模式（不读写磁盘）。
 */
export class TodoManager {
  private static instances = new Map<string, TodoManager>();
  private todos: TodoItem[] = [];
  private filePath: string | undefined;
  private loaded = false;

  private constructor(sessionId: SessionId, configDir?: string) {
    this.filePath = configDir
      ? path.join(configDir, 'todos', `${sessionId}-agent-${sessionId}.json`)
      : undefined;
  }

  /**
   * 获取 TodoManager 实例（单例模式，按会话隔离）
   */
  static getInstance(sessionId: SessionId, configDir?: string): TodoManager {
    const key = JSON.stringify([sessionId, configDir ?? '']);
    let instance = TodoManager.instances.get(key);
    if (!instance) {
      instance = new TodoManager(sessionId, configDir);
      TodoManager.instances.set(key, instance);
    }
    return instance;
  }

  static clear(sessionId: SessionId, configDir?: string): void {
    TodoManager.instances.delete(JSON.stringify([sessionId, configDir ?? '']));
  }

  /**
   * 验证 TODO 列表
   * 规则：同时只能有一个任务处于 in_progress 状态
   */
  validate(todos: TodoItem[]): ValidationResult {
    const inProgress = todos.filter((t) => t.status === 'in_progress').length;

    if (inProgress > 1) {
      return {
        valid: false,
        error: '同时只能有一个任务处于 in_progress 状态',
      };
    }

    return { valid: true };
  }

  /**
   * 更新 TODO 列表
   */
  async updateTodos(
    newTodos: Array<Partial<TodoItem> & Pick<TodoItem, 'content' | 'status' | 'activeForm'>>,
  ): Promise<void> {
    await this.ensureLoaded();

    const now = new Date().toISOString();

    const processed: TodoItem[] = newTodos.map((todo) => {
      const existing = todo.id
        ? this.todos.find((item) => item.id === todo.id)
        : this.findUniqueContentMatch(todo.content);

      return {
        ...todo,
        id: todo.id || existing?.id || randomUUID(),
        priority: todo.priority || existing?.priority || 'medium',
        createdAt: existing?.createdAt || now,
        startedAt:
          todo.status === 'in_progress' && !existing?.startedAt ? now : existing?.startedAt,
        completedAt:
          todo.status === 'completed' && !existing?.completedAt ? now : existing?.completedAt,
      };
    });

    const validation = this.validate(processed);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    this.todos = processed;
    await this.saveTodos();
  }

  /**
   * 获取排序后的 TODO 列表
   * 排序规则：
   * 1. 按状态：completed < in_progress < pending
   * 2. 按优先级：high < medium < low
   */
  getSortedTodos(): TodoItem[] {
    const statusOrder: Record<TodoStatus, number> = {
      completed: 0,
      in_progress: 1,
      pending: 2,
    };

    const priorityOrder = { high: 0, medium: 1, low: 2 };

    return [...this.todos].sort((a, b) => {
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;

      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * 获取 TODO 列表（已排序）
   */
  getTodos(): TodoItem[] {
    return this.getSortedTodos();
  }

  /**
   * 确保已加载数据
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.loadTodos();
      this.loaded = true;
    }
  }

  /**
   * 从文件加载 TODO 列表（无路径时跳过）
   */
  private async loadTodos(): Promise<void> {
    if (!this.filePath) return;
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      this.todos = JSON.parse(data);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        this.todos = [];
      } else {
        console.warn('加载 TODO 列表失败:', error);
        this.todos = [];
      }
    }
  }

  /**
   * 保存 TODO 列表到文件（无路径时跳过）
   */
  private async saveTodos(): Promise<void> {
    if (!this.filePath) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o755 });
      await writeFileAtomic(this.filePath, JSON.stringify(this.todos, null, 2), {
        encoding: 'utf-8',
        fsync: true,
      });
    } catch (error) {
      console.error('保存 TODO 列表失败:', error);
      throw error;
    }
  }

  private findUniqueContentMatch(content: string): TodoItem | undefined {
    const matches = this.todos.filter((item) => item.content === content);
    if (matches.length > 1) {
      throw new Error(`TODO content is ambiguous; provide an id for "${content}"`);
    }
    return matches[0];
  }
}
