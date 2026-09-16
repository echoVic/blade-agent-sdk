import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import { ExecutionCheckpointId, ExecutionId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import {
  buildContainerArgs,
  CHECKPOINT_VERSION,
  type CheckpointManifest,
  checkpointManifestSchema,
  validateCheckpointId,
  validateContainerUser,
  validateEnvironment,
  validateExec,
  validateExecutionId,
  validateMetadata,
  validateProvision,
  workspaceCwd,
} from './DockerExecutionPolicy.js';
import { runCheckedProcess, runProcess } from './DockerProcessRunner.js';
import { DockerWorkspace } from './DockerWorkspace.js';
import {
  type ExecutionCheckpoint,
  type ExecutionExecRequest,
  type ExecutionExecResult,
  type ExecutionHandle,
  type ExecutionHost,
  ExecutionHostError,
  type ExecutionProvisionRequest,
  type ExecutionRestoreRequest,
} from './ExecutionHost.js';

export interface DockerExecutionHostOptions {
  readonly runtimeBinary?: string;
  readonly rootDirectory?: string;
  readonly checkpointDirectory?: string;
  readonly allowUnpinnedImages?: boolean;
  readonly containerUser?: string;
}

interface ExecutionRecord {
  readonly handle: ExecutionHandle;
  readonly container: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly mutex: Mutex;
  readonly timer: NodeJS.Timeout;
}

const CONTROL_OPTIONS = { timeoutMs: 60_000, maxBytes: 1024 * 1024 };

export class DockerExecutionHost implements ExecutionHost {
  private readonly runtime: string;
  private readonly root: string;
  private readonly checkpoints: string;
  private readonly allowUnpinned: boolean;
  private readonly user: string;
  private readonly uid: string;
  private readonly gid: string;
  private readonly workspace: DockerWorkspace;
  private readonly records = new Map<ExecutionId, ExecutionRecord>();
  private readonly pending = new Set<ExecutionId>();

  constructor(options: DockerExecutionHostOptions = {}) {
    this.runtime = options.runtimeBinary ?? 'docker';
    this.root = options.rootDirectory ?? join(tmpdir(), 'blade-executions');
    this.checkpoints = options.checkpointDirectory ?? join(this.root, 'checkpoints');
    this.allowUnpinned = options.allowUnpinnedImages ?? false;
    this.user = options.containerUser ?? '65532:65532';
    ({ uid: this.uid, gid: this.gid } = validateContainerUser(this.user));
    this.workspace = new DockerWorkspace(this.runtime, this.root, this.user);
  }

  async provision(request: ExecutionProvisionRequest): Promise<ExecutionHandle> {
    validateProvision(request, this.allowUnpinned);
    request.signal?.throwIfAborted();
    const executionId = request.executionId ?? ExecutionId(`exec-${nanoid()}`);
    validateExecutionId(executionId);
    if (this.records.has(executionId) || this.pending.has(executionId)) {
      throw new ExecutionHostError(
        'EXECUTION_ALREADY_EXISTS',
        `Execution ${executionId} already exists`,
      );
    }
    this.pending.add(executionId);
    const container = `blade-execution-${executionId}`;
    let created = false;
    try {
      await this.prepareDirectories();
      await runCheckedProcess(
        this.runtime,
        buildContainerArgs(request, container, this.user, this.uid, this.gid),
        { ...CONTROL_OPTIONS, signal: request.signal, environment: request.environment },
      );
      created = true;
      await runCheckedProcess(this.runtime, ['start', container], {
        ...CONTROL_OPTIONS,
        signal: request.signal,
      });
      if (request.workspace.kind === 'git-worktree') {
        await this.workspace.importGit(
          container,
          request.workspace,
          request.resources.diskBytes,
          request.signal,
        );
      }
    } catch (error) {
      if (created) await this.removeContainer(container).catch(() => undefined);
      throw error;
    } finally {
      this.pending.delete(executionId);
    }

    const now = Date.now();
    const handle: ExecutionHandle = {
      executionId,
      state: 'provisioned',
      image: request.image,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + request.resources.runtimeMs).toISOString(),
      resources: { ...request.resources },
      network: { mode: 'none' },
      metadata: structuredClone(request.metadata ?? {}),
    };
    const timer = setTimeout(
      () => void this.terminate(executionId).catch(() => undefined),
      request.resources.runtimeMs,
    );
    timer.unref();
    this.records.set(executionId, {
      handle,
      container,
      environment: { ...request.environment },
      mutex: new Mutex(),
      timer,
    });
    return handle;
  }

  async exec(
    executionId: ExecutionId,
    request: ExecutionExecRequest,
  ): Promise<ExecutionExecResult> {
    const record = this.require(executionId);
    return record.mutex.runExclusive(async () => {
      validateExec(request);
      request.signal?.throwIfAborted();
      const remaining = Date.parse(record.handle.expiresAt) - Date.now();
      if (remaining < 1) {
        await this.terminateRecord(record);
        throw new ExecutionHostError('EXECUTION_TIMEOUT', `Execution ${executionId} expired`);
      }
      const environment = request.environment ?? {};
      const args = ['exec'];
      if (request.stdin !== undefined) args.push('-i');
      args.push('--user', this.user, '--workdir', workspaceCwd(request.cwd));
      for (const name of Object.keys(environment).sort()) args.push('--env', name);
      args.push(record.container, request.command, ...(request.args ?? []));
      const startedAt = new Date().toISOString();
      try {
        const result = await runProcess(this.runtime, args, {
          timeoutMs: Math.min(request.timeoutMs ?? remaining, remaining),
          maxBytes: record.handle.resources.maxOutputBytes,
          signal: request.signal,
          stdin: request.stdin,
          environment,
        });
        return {
          executionId,
          ...result,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      } catch (error) {
        try {
          await this.terminateRecord(record);
        } catch (cleanupError) {
          throw new ExecutionHostError(
            'EXECUTION_RUNTIME_ERROR',
            `Execution ${executionId} failed and cleanup was incomplete`,
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
        throw error;
      }
    });
  }

  async checkpoint(
    executionId: ExecutionId,
    metadata: JsonObject = {},
  ): Promise<ExecutionCheckpoint> {
    const parsedMetadata = validateMetadata(metadata, 'Checkpoint metadata');
    const record = this.require(executionId);
    return record.mutex.runExclusive(async () => {
      const checkpointId = ExecutionCheckpointId(`checkpoint-${nanoid()}`);
      const directory = join(this.checkpoints, checkpointId);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const workspace = join(directory, 'workspace');
        await runCheckedProcess(
          this.runtime,
          ['cp', `${record.container}:/workspace/.`, workspace],
          CONTROL_OPTIONS,
        );
        const sizeBytes = await this.workspace.directorySize(workspace);
        if (sizeBytes > record.handle.resources.diskBytes) {
          throw new ExecutionHostError(
            'EXECUTION_RESOURCE_LIMIT',
            'Checkpoint exceeds the execution disk limit',
          );
        }
        const checkpoint: ExecutionCheckpoint = {
          checkpointId,
          sourceExecutionId: executionId,
          createdAt: new Date().toISOString(),
          sizeBytes,
          metadata: structuredClone(parsedMetadata),
        };
        const manifest: CheckpointManifest = {
          version: CHECKPOINT_VERSION,
          image: record.handle.image,
          resources: record.handle.resources,
          environment: record.environment,
          metadata: parsedMetadata,
        };
        await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), {
          encoding: 'utf8',
          mode: 0o600,
        });
        return checkpoint;
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async restore(request: ExecutionRestoreRequest): Promise<ExecutionHandle> {
    request.signal?.throwIfAborted();
    validateCheckpointId(request.checkpointId);
    const directory = join(this.checkpoints, request.checkpointId);
    let encoded: string;
    try {
      encoded = await readFile(join(directory, 'manifest.json'), 'utf8');
    } catch (cause) {
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_NOT_FOUND',
        `Checkpoint ${request.checkpointId} was not found`,
        { cause },
      );
    }
    let manifest: CheckpointManifest;
    try {
      manifest = checkpointManifestSchema.parse(JSON.parse(encoded));
      validateEnvironment(manifest.environment);
      validateMetadata(manifest.metadata, 'Checkpoint metadata');
    } catch (cause) {
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        `Checkpoint ${request.checkpointId} has an invalid manifest`,
        { cause },
      );
    }
    const handle = await this.provision({
      executionId: request.executionId,
      image: manifest.image,
      workspace: { kind: 'empty' },
      resources: manifest.resources,
      network: { mode: 'none' },
      environment: manifest.environment,
      metadata: manifest.metadata,
      signal: request.signal,
    });
    try {
      const record = this.require(handle.executionId);
      await this.workspace.copyToContainer(
        record.container,
        join(directory, 'workspace'),
        record.handle.resources.diskBytes,
        request.signal,
      );
      return handle;
    } catch (cause) {
      await this.terminate(handle.executionId).catch(() => undefined);
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        `Checkpoint ${request.checkpointId} could not be restored`,
        { cause },
      );
    }
  }

  async terminate(executionId: ExecutionId): Promise<void> {
    const record = this.records.get(executionId);
    if (record) await record.mutex.runExclusive(() => this.terminateRecord(record));
  }

  async reclaim(executionId: ExecutionId): Promise<void> {
    validateExecutionId(executionId);
    const record = this.records.get(executionId);
    if (record) await record.mutex.runExclusive(() => this.terminateRecord(record));
    else await this.removeContainer(`blade-execution-${executionId}`);
  }

  private async prepareDirectories(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await mkdir(this.checkpoints, { recursive: true, mode: 0o700 });
    await chmod(this.checkpoints, 0o700);
  }

  private require(executionId: ExecutionId): ExecutionRecord {
    const record = this.records.get(executionId);
    if (!record) {
      throw new ExecutionHostError('EXECUTION_NOT_FOUND', `Execution ${executionId} was not found`);
    }
    return record;
  }

  private async terminateRecord(record: ExecutionRecord): Promise<void> {
    clearTimeout(record.timer);
    await this.removeContainer(record.container);
    this.records.delete(record.handle.executionId);
  }

  private async removeContainer(container: string): Promise<void> {
    const result = await runProcess(this.runtime, ['rm', '-f', '-v', container], CONTROL_OPTIONS);
    if (result.exitCode !== 0 && !/no such (object|container)/i.test(result.stderr)) {
      throw new ExecutionHostError(
        'EXECUTION_RUNTIME_ERROR',
        `Container ${container} could not be removed: ${result.stderr}`,
      );
    }
  }
}
