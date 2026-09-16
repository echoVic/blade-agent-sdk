import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { ExecutionCheckpointId, ExecutionId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import { jsonObjectSchema } from '../types/jsonSchema.js';
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

const CHECKPOINT_VERSION = 1;
const IMAGE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,255}$/;
const MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const resourceLimitsSchema = z
  .object({
    cpus: z.number().positive().max(128),
    memoryBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 ** 3),
    diskBytes: z
      .number()
      .int()
      .positive()
      .max(1024 ** 4),
    pids: z.number().int().positive().max(32_768),
    runtimeMs: z.number().int().positive().max(MAX_RUNTIME_MS),
    maxOutputBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES),
  })
  .strict();

const environmentSchema = z.record(z.string(), z.string());
const checkpointManifestSchema = z
  .object({
    version: z.literal(CHECKPOINT_VERSION),
    image: z.string(),
    resources: resourceLimitsSchema,
    environment: environmentSchema,
    metadata: jsonObjectSchema,
  })
  .strict();
type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

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

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class DockerExecutionHost implements ExecutionHost {
  private readonly runtime: string;
  private readonly root: string;
  private readonly checkpoints: string;
  private readonly allowUnpinned: boolean;
  private readonly user: string;
  private readonly uid: string;
  private readonly gid: string;
  private readonly records = new Map<ExecutionId, ExecutionRecord>();
  private readonly pending = new Set<ExecutionId>();

  constructor(options: DockerExecutionHostOptions = {}) {
    this.runtime = options.runtimeBinary ?? 'docker';
    this.root = options.rootDirectory ?? join(tmpdir(), 'blade-executions');
    this.checkpoints = options.checkpointDirectory ?? join(this.root, 'checkpoints');
    this.allowUnpinned = options.allowUnpinnedImages ?? false;
    this.user = options.containerUser ?? '65532:65532';
    const [uid, gid] = this.user.split(':');
    if (
      !/^[1-9]\d*:[1-9]\d*$/.test(this.user) ||
      !uid ||
      !gid ||
      Number(uid) > 4_294_967_294 ||
      Number(gid) > 4_294_967_294
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'containerUser must use numeric uid:gid form with non-root identifiers',
      );
    }
    this.uid = uid;
    this.gid = gid;
  }

  async provision(request: ExecutionProvisionRequest): Promise<ExecutionHandle> {
    this.validateProvision(request);
    request.signal?.throwIfAborted();
    const executionId = request.executionId ?? ExecutionId(`exec-${nanoid()}`);
    this.validateId(executionId);
    if (this.records.has(executionId) || this.pending.has(executionId)) {
      throw new ExecutionHostError(
        'EXECUTION_ALREADY_EXISTS',
        `Execution ${executionId} already exists`,
      );
    }
    this.pending.add(executionId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await mkdir(this.checkpoints, { recursive: true, mode: 0o700 });
    await chmod(this.checkpoints, 0o700);
    const container = `blade-execution-${executionId}`;
    const environment = request.environment ?? {};
    const temporaryBytes = Math.max(
      1024 * 1024,
      Math.min(16 * 1024 * 1024, Math.floor(request.resources.memoryBytes / 4)),
    );
    const args = [
      'create',
      '--name',
      container,
      '--rm',
      '--label',
      'com.blade.managed=true',
      '--init',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      String(request.resources.cpus),
      '--memory',
      String(request.resources.memoryBytes),
      '--memory-swap',
      String(request.resources.memoryBytes),
      '--pids-limit',
      String(request.resources.pids),
      '--network',
      'none',
      '--user',
      this.user,
      '--workdir',
      '/workspace',
      '--tmpfs',
      `/workspace:rw,nosuid,nodev,noexec,size=${request.resources.diskBytes},uid=${this.uid},gid=${this.gid},mode=0700`,
      '--tmpfs',
      `/tmp:rw,nosuid,nodev,noexec,size=${temporaryBytes},uid=${this.uid},gid=${this.gid},mode=0700`,
    ];
    for (const name of Object.keys(environment).sort()) args.push('--env', name);
    args.push(request.image, '/bin/sh', '-c', `sleep ${request.resources.runtimeMs / 1000}`);
    let created = false;
    try {
      await this.control(args, request.signal, environment);
      created = true;
      await this.control(['start', container], request.signal);
      if (request.workspace.kind === 'git-worktree') {
        await this.loadGitWorkspace(
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
      environment: { ...environment },
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
      this.validateExec(request);
      request.signal?.throwIfAborted();
      const remaining = Date.parse(record.handle.expiresAt) - Date.now();
      if (remaining < 1) {
        await this.terminateRecord(record);
        throw new ExecutionHostError('EXECUTION_TIMEOUT', `Execution ${executionId} expired`);
      }
      const environment = request.environment ?? {};
      const args = ['exec'];
      if (request.stdin !== undefined) args.push('-i');
      args.push('--user', this.user, '--workdir', this.cwd(request.cwd));
      for (const name of Object.keys(environment).sort()) args.push('--env', name);
      args.push(record.container, request.command, ...(request.args ?? []));
      const startedAt = new Date().toISOString();
      let result: ProcessResult;
      try {
        result = await this.run(this.runtime, args, {
          timeoutMs: Math.min(request.timeoutMs ?? remaining, remaining),
          maxBytes: record.handle.resources.maxOutputBytes,
          signal: request.signal,
          stdin: request.stdin,
          environment,
        });
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
      return {
        executionId,
        ...result,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    });
  }

  async checkpoint(
    executionId: ExecutionId,
    metadata: JsonObject = {},
  ): Promise<ExecutionCheckpoint> {
    const parsedMetadata = this.validateMetadata(metadata, 'Checkpoint metadata');
    const record = this.require(executionId);
    return record.mutex.runExclusive(async () => {
      const checkpointId = ExecutionCheckpointId(`checkpoint-${nanoid()}`);
      const directory = join(this.checkpoints, checkpointId);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const workspace = join(directory, 'workspace');
        await this.control(['cp', `${record.container}:/workspace/.`, workspace]);
        const sizeBytes = await this.directorySize(workspace);
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
    this.validateCheckpointId(request.checkpointId);
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
      this.validateEnvironment(manifest.environment);
      this.validateMetadata(manifest.metadata, 'Checkpoint metadata');
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
    const record = this.require(handle.executionId);
    try {
      await this.copyDirectoryToContainer(
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
    this.validateId(executionId);
    const record = this.records.get(executionId);
    if (record) {
      await record.mutex.runExclusive(() => this.terminateRecord(record));
      return;
    }
    await this.removeContainer(`blade-execution-${executionId}`);
  }

  private async terminateRecord(record: ExecutionRecord): Promise<void> {
    clearTimeout(record.timer);
    await this.removeContainer(record.container);
    this.records.delete(record.handle.executionId);
  }

  private async removeContainer(container: string): Promise<void> {
    const result = await this.run(this.runtime, ['rm', '-f', '-v', container], {
      timeoutMs: 60_000,
      maxBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0 && !/no such (object|container)/i.test(result.stderr)) {
      throw new ExecutionHostError(
        'EXECUTION_RUNTIME_ERROR',
        `Container ${container} could not be removed: ${result.stderr}`,
      );
    }
  }

  private control(
    args: readonly string[],
    signal?: AbortSignal,
    environment?: Readonly<Record<string, string>>,
    stdin?: Uint8Array,
  ): Promise<ProcessResult> {
    return this.run(this.runtime, args, {
      timeoutMs: 60_000,
      maxBytes: 1024 * 1024,
      signal,
      environment,
      stdin,
    }).then((result) => {
      if (result.exitCode !== 0) {
        throw new ExecutionHostError(
          'EXECUTION_RUNTIME_ERROR',
          result.stderr || 'Container runtime command failed',
        );
      }
      return result;
    });
  }

  private run(
    command: string,
    args: readonly string[],
    options: {
      timeoutMs: number;
      maxBytes: number;
      signal?: AbortSignal;
      stdin?: string | Uint8Array;
      environment?: Readonly<Record<string, string>>;
    },
  ): Promise<ProcessResult> {
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        env: { ...process.env, ...options.environment },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const stop = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(
        () =>
          stop(
            new ExecutionHostError(
              'EXECUTION_TIMEOUT',
              `Container runtime exceeded ${options.timeoutMs}ms`,
            ),
          ),
        options.timeoutMs,
      );
      timer.unref();
      const onAbort = () =>
        stop(
          new ExecutionHostError('EXECUTION_RUNTIME_ERROR', 'Container runtime was aborted', {
            cause: options.signal?.reason,
          }),
        );
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const collect = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > options.maxBytes) {
          stop(new ExecutionHostError('EXECUTION_OUTPUT_LIMIT', 'Execution output limit exceeded'));
        } else {
          target.push(chunk);
        }
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.stdin.on('error', () => undefined);
      child.once('error', (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new ExecutionHostError('EXECUTION_HOST_UNAVAILABLE', `Could not start ${command}`, {
            cause,
          }),
        );
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (failure) return reject(failure);
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      child.stdin.end(options.stdin);
    });
  }

  private require(executionId: ExecutionId): ExecutionRecord {
    const record = this.records.get(executionId);
    if (!record) {
      throw new ExecutionHostError('EXECUTION_NOT_FOUND', `Execution ${executionId} was not found`);
    }
    return record;
  }

  private async loadGitWorkspace(
    container: string,
    source: Extract<ExecutionProvisionRequest['workspace'], { kind: 'git-worktree' }>,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const repository = await realpath(source.repositoryPath);
    const staging = await mkdtemp(join(this.root, 'git-archive-'));
    const archive = join(staging, 'workspace.tar');
    try {
      await this.runCommand(
        'git',
        ['-C', repository, 'archive', '--format=tar', `--output=${archive}`, source.revision],
        signal,
      );
      await this.loadArchive(container, archive, maxBytes, signal);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async copyDirectoryToContainer(
    container: string,
    source: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const staging = await mkdtemp(join(this.root, 'restore-archive-'));
    const archive = join(staging, 'workspace.tar');
    try {
      await this.runCommand('tar', ['-C', source, '-cf', archive, '.'], signal);
      await this.loadArchive(container, archive, maxBytes, signal);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async loadArchive(
    container: string,
    archive: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const archiveSize = (await stat(archive)).size;
    if (archiveSize > maxBytes) {
      throw new ExecutionHostError(
        'EXECUTION_RESOURCE_LIMIT',
        'Workspace archive exceeds the execution disk limit',
      );
    }
    await this.control(
      [
        'exec',
        '-i',
        '--user',
        this.user,
        '--workdir',
        '/workspace',
        container,
        'tar',
        '-xf',
        '-',
        '-C',
        '/workspace',
      ],
      signal,
      undefined,
      await readFile(archive),
    );
  }

  private async runCommand(
    command: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.run(command, args, {
      timeoutMs: 60_000,
      maxBytes: 1024 * 1024,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new ExecutionHostError(
        'EXECUTION_RUNTIME_ERROR',
        `${command} failed: ${result.stderr || 'unknown error'}`,
      );
    }
  }

  private async directorySize(path: string): Promise<number> {
    const details = await lstat(path);
    if (!details.isDirectory()) return details.size;
    const sizes = await Promise.all(
      (await readdir(path)).map((entry) => this.directorySize(join(path, entry))),
    );
    return sizes.reduce((total, size) => total + size, 0);
  }

  private validateProvision(request: ExecutionProvisionRequest): void {
    if (
      typeof request.image !== 'string' ||
      !request.image.trim() ||
      request.image.includes('\0') ||
      (!this.allowUnpinned && !IMAGE_DIGEST.test(request.image))
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution image must use an immutable sha256 digest',
      );
    }
    const workspace = request.workspace;
    if (
      !workspace ||
      (workspace.kind !== 'empty' &&
        (workspace.kind !== 'git-worktree' ||
          !isAbsolute(workspace.repositoryPath) ||
          !REVISION_PATTERN.test(workspace.revision)))
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution workspace source is invalid',
      );
    }
    if (!request.network || request.network.mode !== 'none') {
      throw new ExecutionHostError(
        'EXECUTION_NETWORK_POLICY',
        'DockerExecutionHost supports only network mode none',
      );
    }
    if (!resourceLimitsSchema.safeParse(request.resources).success) {
      throw new ExecutionHostError('EXECUTION_RESOURCE_LIMIT', 'Execution limits are invalid');
    }
    this.validateEnvironment(request.environment);
    this.validateMetadata(request.metadata ?? {}, 'Execution metadata');
  }

  private validateExec(request: ExecutionExecRequest): void {
    if (
      !request.command?.trim() ||
      request.command.includes('\0') ||
      request.args?.some((value) => typeof value !== 'string' || value.includes('\0')) ||
      (request.stdin !== undefined &&
        (typeof request.stdin !== 'string' ||
          Buffer.byteLength(request.stdin) > MAX_OUTPUT_BYTES)) ||
      (request.timeoutMs !== undefined &&
        (!Number.isSafeInteger(request.timeoutMs) ||
          request.timeoutMs < 1 ||
          request.timeoutMs > MAX_RUNTIME_MS))
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution command or credentials are unsupported',
      );
    }
    this.cwd(request.cwd);
    this.validateEnvironment(request.environment);
  }

  private validateEnvironment(environment: Readonly<Record<string, string>> = {}): void {
    const parsed = environmentSchema.safeParse(environment);
    if (!parsed.success) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution environment must contain string values',
        { cause: parsed.error },
      );
    }
    for (const [name, value] of Object.entries(parsed.data)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        value.includes('\0') ||
        Buffer.byteLength(value) > 32 * 1024 ||
        /TOKEN|SECRET|PASSWORD|API.?KEY|CREDENTIAL/i.test(name)
      ) {
        throw new ExecutionHostError(
          'EXECUTION_INVALID_REQUEST',
          `Environment variable ${name} is invalid`,
        );
      }
    }
  }

  private validateMetadata(value: unknown, label: string): JsonObject {
    const parsed = jsonObjectSchema.safeParse(value);
    if (!parsed.success) {
      throw new ExecutionHostError('EXECUTION_INVALID_REQUEST', `${label} must be a JSON object`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private cwd(value?: string): string {
    if (value?.includes('\0')) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution cwd must stay within /workspace',
      );
    }
    const normalized = posix.normalize(value ?? '.');
    if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution cwd must stay within /workspace',
      );
    }
    return normalized === '.' ? '/workspace' : `/workspace/${normalized}`;
  }

  private validateId(id: string): void {
    if (!ID_PATTERN.test(id)) {
      throw new ExecutionHostError('EXECUTION_INVALID_REQUEST', 'Execution identifier is invalid');
    }
  }

  private validateCheckpointId(id: string): void {
    if (!ID_PATTERN.test(id)) {
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        'Checkpoint identifier is invalid',
      );
    }
  }
}
