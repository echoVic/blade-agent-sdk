/**
 * TaskStore - 结构化任务状态存储
 *
 * 按 sessionId 隔离，支持任务依赖关系 (blocks/blockedBy)。
 * 可选磁盘持久化：当 configDir 提供时，任务写入 <configDir>/tasks/<sessionId>.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  /** 此任务完成前阻塞的任务 ID 列表 */
  blocks: string[];
  /** 阻塞此任务的任务 ID 列表 */
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
}

/** Per-session store instances */
const instances = new Map<string, TaskStore>();

export class TaskStore {
  private tasks = new Map<string, Task>();
  private readonly persistPath: string | undefined;

  private constructor(
    private readonly sessionId: string,
    configDir?: string,
  ) {
    this.persistPath = configDir
      ? path.join(configDir, 'tasks', `${sessionId}.json`)
      : undefined;
  }

  static getInstance(sessionId: string, configDir?: string): TaskStore {
    const key = configDir ? `${sessionId}::${configDir}` : sessionId;
    let store = instances.get(key);
    if (!store) {
      store = new TaskStore(sessionId, configDir);
      instances.set(key, store);
    }
    return store;
  }

  /** Remove a session's store from the cache (call on session end). */
  static clear(sessionId: string, configDir?: string): void {
    const key = configDir ? `${sessionId}::${configDir}` : sessionId;
    instances.delete(key);
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const now = Date.now();
    const task: Task = {
      id: nanoid(8),
      subject: input.subject,
      description: input.description,
      status: 'pending',
      activeForm: input.activeForm,
      metadata: input.metadata,
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    await this.persist();
    return task;
  }

  async get(id: string): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    return task?.status === 'deleted' ? undefined : task;
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const updated: Task = {
      ...task,
      ...(input.status !== undefined && { status: input.status }),
      ...(input.subject !== undefined && { subject: input.subject }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.activeForm !== undefined && { activeForm: input.activeForm }),
      ...(input.owner !== undefined && { owner: input.owner }),
      ...(input.metadata !== undefined && {
        metadata: { ...task.metadata, ...input.metadata },
      }),
      updatedAt: Date.now(),
    };

    if (input.addBlocks?.length) {
      updated.blocks = [...new Set([...task.blocks, ...input.addBlocks])];
      for (const blockedId of input.addBlocks) {
        const blockedTask = this.tasks.get(blockedId);
        if (blockedTask && !blockedTask.blockedBy.includes(id)) {
          this.tasks.set(blockedId, {
            ...blockedTask,
            blockedBy: [...blockedTask.blockedBy, id],
            updatedAt: Date.now(),
          });
        }
      }
    }

    if (input.addBlockedBy?.length) {
      updated.blockedBy = [...new Set([...task.blockedBy, ...input.addBlockedBy])];
      for (const blockingId of input.addBlockedBy) {
        const blockingTask = this.tasks.get(blockingId);
        if (blockingTask && !blockingTask.blocks.includes(id)) {
          this.tasks.set(blockingId, {
            ...blockingTask,
            blocks: [...blockingTask.blocks, id],
            updatedAt: Date.now(),
          });
        }
      }
    }

    this.tasks.set(id, updated);
    await this.persist();
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.tasks.delete(id);
    await this.persist();
  }

  async list(): Promise<Task[]> {
    return Array.from(this.tasks.values()).filter((t) => t.status !== 'deleted');
  }

  private async persist(): Promise<void> {
    if (!this.persistPath) return;
    const dir = path.dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const data = Array.from(this.tasks.values());
    await writeFile(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Load tasks from disk (call after getInstance if you want to restore state). */
  async load(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const raw = await readFile(this.persistPath, 'utf-8');
      const data: Task[] = JSON.parse(raw);
      this.tasks.clear();
      for (const task of data) {
        this.tasks.set(task.id, task);
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
  }
}
