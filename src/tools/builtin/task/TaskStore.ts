/**
 * TaskStore - 结构化任务状态存储
 *
 * 按 sessionId 隔离，支持任务依赖关系 (blocks/blockedBy)。
 * 可选磁盘持久化：当 configDir 提供时，每个任务独立写入
 * <configDir>/tasks/<sessionId>/<taskId>.json。
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import writeFileAtomic from 'write-file-atomic';

import type { SessionId } from '../../../types/identifiers.js';
import type { JsonObject } from '../../../types/json.js';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  activeForm?: string;
  metadata?: JsonObject;
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
  metadata?: JsonObject;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: JsonObject;
  addBlocks?: string[];
  addBlockedBy?: string[];
}

/** Per-session store instances */
const instances = new Map<string, TaskStore>();

export class TaskStore {
  private tasks = new Map<string, Task>();
  private readonly legacyPersistPath: string | undefined;
  private readonly persistDirectory: string | undefined;

  private constructor(
    readonly sessionId: SessionId,
    configDir?: string,
  ) {
    this.legacyPersistPath = configDir
      ? path.join(configDir, 'tasks', `${sessionId}.json`)
      : undefined;
    this.persistDirectory = configDir
      ? path.join(configDir, 'tasks', String(sessionId))
      : undefined;
  }

  static getInstance(sessionId: SessionId, configDir?: string): TaskStore {
    const key = JSON.stringify([sessionId, configDir ?? '']);
    let store = instances.get(key);
    if (!store) {
      store = new TaskStore(sessionId, configDir);
      instances.set(key, store);
    }
    return store;
  }

  /** Remove a session's store from the cache (call on session end). */
  static clear(sessionId: SessionId, configDir?: string): void {
    const key = JSON.stringify([sessionId, configDir ?? '']);
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
    await this.persistTasks([task.id]);
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
    const changedTaskIds = new Set([id]);

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
          changedTaskIds.add(blockedId);
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
          changedTaskIds.add(blockingId);
        }
      }
    }

    this.tasks.set(id, updated);
    await this.persistTasks(changedTaskIds);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.tasks.delete(id);
    if (this.persistDirectory) {
      await rm(path.join(this.persistDirectory, `${id}.json`), { force: true });
    }
  }

  async list(): Promise<Task[]> {
    return Array.from(this.tasks.values()).filter((t) => t.status !== 'deleted');
  }

  private async persistTasks(taskIds: Iterable<string>): Promise<void> {
    if (!this.persistDirectory) return;
    await mkdir(this.persistDirectory, { recursive: true });
    await Promise.all(
      Array.from(taskIds, async (taskId) => {
        const task = this.tasks.get(taskId);
        if (!task) {
          return;
        }
        await writeFileAtomic(
          path.join(this.persistDirectory as string, `${taskId}.json`),
          JSON.stringify(task, null, 2),
          { encoding: 'utf-8', fsync: true },
        );
      }),
    );
  }

  /** Load tasks from disk (call after getInstance if you want to restore state). */
  async load(): Promise<void> {
    if (!this.persistDirectory || !this.legacyPersistPath) return;
    const persistDirectory = this.persistDirectory;
    try {
      const files = (await readdir(persistDirectory)).filter((file) => file.endsWith('.json'));
      const data = await Promise.all(
        files.map(
          async (file) =>
            JSON.parse(await readFile(path.join(persistDirectory, file), 'utf-8')) as Task,
        ),
      );
      this.tasks.clear();
      for (const task of data) {
        this.tasks.set(task.id, task);
      }
      return;
    } catch {
      // Fall through to the legacy aggregate file.
    }
    try {
      const raw = await readFile(this.legacyPersistPath, 'utf-8');
      const data: Task[] = JSON.parse(raw);
      this.tasks = new Map(data.map((task) => [task.id, task]));
      await this.persistTasks(this.tasks.keys());
    } catch {
      // No persisted state exists yet.
    }
  }
}
