import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  isAbsolute,
  join,
  posix,
  resolve,
} from 'node:path';
import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import {
  ExecutionCheckpointId,
  ExecutionId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type {
  CredentialBroker,
  CredentialLease,
} from './CredentialBroker.js';
import {
  type ExecutionCheckpoint,
  type ExecutionEgressController,
  type ExecutionEgressLease,
  type ExecutionExecRequest,
  type ExecutionExecResult,
  type ExecutionHandle,
  type ExecutionHost,
  ExecutionHostError,
  type ExecutionNetworkPolicy,
  type ExecutionProvisionRequest,
  type ExecutionResourceLimits,
  type ExecutionRestoreRequest,
  type ExecutionWorkspaceSource,
} from './ExecutionHost.js';

const CHECKPOINT_SCHEMA_VERSION = 1;
const CONTROL_TIMEOUT_MS = 60_000;
const CONTROL_OUTPUT_BYTES = 1024 * 1024;
const MIN_MEMORY_BYTES = 16 * 1024 * 1024;
const MIN_DISK_BYTES = 2 * 1024 * 1024;
const MIN_SHM_BYTES = 64 * 1024;
const MAX_SHM_BYTES = 4 * 1024 * 1024;
const MAX_MEMORY_BYTES = 512 * 1024 * 1024 * 1024;
const MAX_DISK_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PROVISION_BOOTSTRAP_TIMEOUT_TICKS = 1_800;
const EXECUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,255}$/;
const IMAGE_DIGEST_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:[a-f0-9]{64}$/;

function isSensitiveEnvironmentName(name: string): boolean {
  const compact = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return [
    'TOKEN',
    'SECRET',
    'PASSWORD',
    'PASSWD',
    'APIKEY',
    'KEYAPI',
    'ACCESSKEY',
    'PRIVATEKEY',
    'CREDENTIAL',
    'CLIENTSECRET',
  ].some((keyword) => compact.includes(keyword));
}

const RESERVED_NETWORK_NAMES = new Set([
  'bridge',
  'default',
  'host',
  'none',
]);

interface DockerExecutionHostOptions {
  readonly runtimeBinary?: string;
  readonly rootDirectory?: string;
  readonly checkpointDirectory?: string;
  readonly allowUnpinnedImages?: boolean;
  readonly containerUser?: string;
  readonly credentialBroker?: CredentialBroker;
  readonly credentialTtlMs?: number;
  readonly egressController?: ExecutionEgressController;
}

interface ExecutionRecord {
  readonly handle: ExecutionHandle;
  readonly containerName: string;
  readonly workspaceVolumeName: string;
  readonly rootPath: string;
  readonly mutex: Mutex;
  readonly expiresAtMs: number;
  readonly lifetimeTimer: NodeJS.Timeout;
  readonly egressLease?: ExecutionEgressLease;
  readonly environmentNames: ReadonlySet<string>;
  terminated: boolean;
  containerRemoved: boolean;
  volumeRemoved: boolean;
  egressReleased: boolean;
  rootRemoved: boolean;
}

interface CheckpointManifest {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly sourceExecutionId: string;
  readonly image: string;
  readonly resources: ExecutionResourceLimits;
  readonly network: ExecutionNetworkPolicy;
  readonly environment: Readonly<Record<string, string>>;
  readonly metadata: JsonObject;
  readonly createdAt: string;
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ProcessOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly redactValues?: readonly string[];
}

interface ProcessCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
}

interface DockerInspection {
  readonly Config?: {
    readonly Entrypoint?: readonly string[] | string | null;
    readonly Env?: readonly string[];
    readonly User?: string;
  };
  readonly HostConfig?: {
    readonly AutoRemove?: boolean;
    readonly NanoCpus?: number;
    readonly Memory?: number;
    readonly MemorySwap?: number;
    readonly PidsLimit?: number;
    readonly ReadonlyRootfs?: boolean;
    readonly ShmSize?: number;
    readonly NetworkMode?: string;
    readonly CapDrop?: readonly string[];
    readonly CapAdd?: readonly string[];
    readonly SecurityOpt?: readonly string[];
    readonly Tmpfs?: Readonly<Record<string, string>>;
  };
  readonly Mounts?: readonly {
    readonly Type?: string;
    readonly Name?: string;
    readonly Destination?: string;
    readonly RW?: boolean;
  }[];
}

interface DockerVolumeInspection {
  readonly Driver?: string;
  readonly Options?: Readonly<Record<string, string>>;
}

export class DockerExecutionHost implements ExecutionHost {
  private readonly runtimeBinary: string;
  private readonly rootDirectory: string;
  private readonly checkpointDirectory: string;
  private readonly allowUnpinnedImages: boolean;
  private readonly containerUser: string;
  private readonly credentialBroker?: CredentialBroker;
  private readonly credentialTtlMs: number;
  private readonly egressController?: ExecutionEgressController;
  private readonly executions = new Map<ExecutionId, ExecutionRecord>();
  private readonly pendingExecutionIds = new Set<ExecutionId>();
  private runtimeAvailability?: Promise<void>;

  constructor(options: DockerExecutionHostOptions = {}) {
    this.runtimeBinary = options.runtimeBinary ?? 'docker';
    this.rootDirectory =
      options.rootDirectory ?? join(tmpdir(), 'blade-execution-host');
    this.checkpointDirectory =
      options.checkpointDirectory
      ?? join(this.rootDirectory, 'checkpoints');
    this.allowUnpinnedImages = options.allowUnpinnedImages ?? false;
    this.containerUser = options.containerUser ?? '65532:65532';
    this.credentialBroker = options.credentialBroker;
    this.credentialTtlMs = options.credentialTtlMs ?? 60_000;
    this.egressController = options.egressController;
    const [rawUid, rawGid] = this.containerUser.split(':');
    const uid = Number(rawUid);
    const gid = Number(rawGid);
    if (
      !/^\d+:\d+$/.test(this.containerUser)
      || !Number.isSafeInteger(uid)
      || !Number.isSafeInteger(gid)
      || uid < 1
      || gid < 1
      || uid > 4_294_967_294
      || gid > 4_294_967_294
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'containerUser must use numeric uid:gid form with non-root identifiers',
      );
    }
    if (
      !Number.isSafeInteger(this.credentialTtlMs)
      || this.credentialTtlMs < 1
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'credentialTtlMs must be a positive safe integer',
      );
    }
  }

  async provision(request: ExecutionProvisionRequest): Promise<ExecutionHandle> {
    request.signal?.throwIfAborted();
    this.validateProvisionRequest(request);
    const executionId =
      request.executionId ?? ExecutionId(`exec-${nanoid()}`);
    this.assertExecutionId(executionId);
    await this.ensureRuntime();
    if (
      this.executions.has(executionId)
      || this.pendingExecutionIds.has(executionId)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_ALREADY_EXISTS',
        `Execution ${executionId} already exists`,
      );
    }
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.rootDirectory, 0o700);
    await mkdir(this.checkpointDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.checkpointDirectory, 0o700);
    const rootPath = await mkdtemp(join(this.rootDirectory, 'execution-'));
    if (
      this.executions.has(executionId)
      || this.pendingExecutionIds.has(executionId)
    ) {
      await rm(rootPath, { recursive: true, force: true });
      throw new ExecutionHostError(
        'EXECUTION_ALREADY_EXISTS',
        `Execution ${executionId} already exists`,
      );
    }
    this.pendingExecutionIds.add(executionId);
    const sourcePath = join(rootPath, 'source');
    const containerName = `blade-execution-${executionId}`;
    let sourceRepository: string | undefined;
    let egressLease: ExecutionEgressLease | undefined;
    let workspaceVolumeName: string | undefined;
    let containerCreated = false;
    try {
      const limits = this.workspaceLimits(request.resources);
      sourceRepository = await this.prepareWorkspace(
        request.workspace,
        sourcePath,
        limits.workspaceBytes,
        request.signal,
      );
      if (request.network.mode === 'proxy') {
        if (!this.egressController) {
          throw new ExecutionHostError(
            'EXECUTION_NETWORK_POLICY',
            'Proxy egress requires an ExecutionEgressController',
          );
        }
        egressLease = await this.egressController.provision(
          executionId,
          request.network,
          request.signal,
        );
        this.validateEgressLease(egressLease);
      }
      this.assertNoEnvironmentCollisions(
        Object.keys(request.environment ?? {}),
        egressLease?.environment ?? {},
        'Execution and egress environments',
        'EXECUTION_NETWORK_POLICY',
      );
      const environment = {
        ...(request.environment ?? {}),
        ...(egressLease?.environment ?? {}),
      };
      this.assertEnvironment(environment, false);
      const createArgs = [
        'create',
        '--name',
        containerName,
        '--rm',
        '--label',
        'com.blade.managed=true',
        '--label',
        `com.blade.execution-id=${executionId}`,
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
        '--shm-size',
        String(limits.shmBytes),
        '--network',
        egressLease?.networkName ?? 'none',
        '--user',
        this.containerUser,
        '--workdir',
        '/workspace',
        '--mount',
        [
          'type=volume',
          'destination=/workspace',
          'volume-nocopy',
          'volume-driver=local',
          '"volume-opt=type=tmpfs"',
          '"volume-opt=device=tmpfs"',
          `"volume-opt=o=rw,nosuid,nodev,size=${limits.workspaceBytes},uid=${limits.uid},gid=${limits.gid},mode=0700"`,
        ].join(','),
        '--tmpfs',
        `/tmp:rw,nosuid,nodev,noexec,size=${limits.tmpBytes},uid=${limits.uid},gid=${limits.gid},mode=0700`,
        '--stop-timeout',
        '1',
        '--entrypoint',
        '/bin/sh',
      ];
      for (const name of Object.keys(environment).sort()) {
        createArgs.push('--env', name);
      }
      createArgs.push(
        request.image,
        '-c',
        [
          'i=0',
          'while [ ! -f /tmp/.blade-runtime ]; do',
          '  i=$((i + 1))',
          `  [ "$i" -ge ${PROVISION_BOOTSTRAP_TIMEOUT_TICKS} ] && exit 124`,
          '  sleep 0.1',
          'done',
          'duration=$(cat /tmp/.blade-runtime) || exit 125',
          'sleep "$duration"',
        ].join('\n'),
      );
      const created = await this.runControl(
        createArgs,
        request.signal,
        environment,
      );
      if (!created.stdout.trim()) {
        throw new ExecutionHostError(
          'EXECUTION_RUNTIME_ERROR',
          'Container runtime did not return a container ID',
        );
      }
      containerCreated = true;
      workspaceVolumeName = await this.verifyContainerLimits(
        containerName,
        request.resources,
        egressLease?.networkName ?? 'none',
      );
      await this.runControl(['start', containerName], request.signal);
      if (request.workspace.kind === 'git-worktree') {
        await this.copyDirectoryToContainer(
          sourcePath,
          containerName,
          request.signal,
        );
        await this.runControl(
          [
            'exec',
            '--user',
            this.containerUser,
            containerName,
            'rm',
            '-f',
            '/workspace/.git',
          ],
          request.signal,
        );
      }
      if (sourceRepository) {
        await this.removeGitWorktree(sourceRepository, sourcePath);
        sourceRepository = undefined;
      }
      const createdAtMs = Date.now();
      const expiresAtMs = createdAtMs + request.resources.runtimeMs;
      await this.runControl([
        'exec',
        '--user',
        this.containerUser,
        containerName,
        '/bin/sh',
        '-c',
        'umask 077; printf "%s" "$1" > /tmp/.blade-runtime',
        'blade-runtime',
        (request.resources.runtimeMs / 1000).toFixed(3),
      ], request.signal);
      const handle: ExecutionHandle = {
        executionId,
        state: 'provisioned',
        image: request.image,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        resources: { ...request.resources },
        network: structuredClone(request.network),
        metadata: structuredClone(request.metadata ?? {}),
      };
      await this.writeExecutionManifest(rootPath, {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        sourceExecutionId: executionId,
        image: request.image,
        resources: { ...request.resources },
        network: structuredClone(request.network),
        environment: { ...(request.environment ?? {}) },
        metadata: structuredClone(request.metadata ?? {}),
        createdAt: handle.createdAt,
      });
      const lifetimeTimer = setTimeout(() => {
        void this.terminate(executionId).catch(() => undefined);
      }, Math.max(1, expiresAtMs - Date.now()));
      lifetimeTimer.unref();
      this.executions.set(executionId, {
        handle,
        containerName,
        workspaceVolumeName,
        rootPath,
        mutex: new Mutex(),
        expiresAtMs,
        lifetimeTimer,
        ...(egressLease ? { egressLease } : {}),
        environmentNames: new Set(Object.keys(environment)),
        terminated: false,
        containerRemoved: false,
        volumeRemoved: false,
        egressReleased: egressLease === undefined,
        rootRemoved: false,
      });
      return handle;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (containerCreated) {
        await this.removeContainer(containerName).catch((cleanupError) => {
          cleanupErrors.push(cleanupError);
        });
      }
      if (workspaceVolumeName) {
        await this.removeVolume(workspaceVolumeName).catch((cleanupError) => {
          cleanupErrors.push(cleanupError);
        });
      }
      if (sourceRepository) {
        await this.removeGitWorktree(sourceRepository, sourcePath)
          .catch((cleanupError) => {
            cleanupErrors.push(cleanupError);
          });
      }
      if (egressLease && this.egressController) {
        await this.egressController.release(executionId)
          .catch((cleanupError) => {
            cleanupErrors.push(cleanupError);
          });
      }
      await rm(rootPath, { recursive: true, force: true })
        .catch((cleanupError) => {
          cleanupErrors.push(cleanupError);
        });
      if (cleanupErrors.length > 0) {
        throw new ExecutionHostError(
          'EXECUTION_RUNTIME_ERROR',
          `Execution ${executionId} provisioning failed and cleanup was incomplete`,
          { cause: new AggregateError([error, ...cleanupErrors]) },
        );
      }
      throw error;
    } finally {
      this.pendingExecutionIds.delete(executionId);
    }
  }

  async exec(
    executionId: ExecutionId,
    request: ExecutionExecRequest,
  ): Promise<ExecutionExecResult> {
    const record = this.requireExecution(executionId);
    return record.mutex.runExclusive(async () => {
      await this.assertExecutionActive(record);
      request.signal?.throwIfAborted();
      this.validateExecRequest(request);
      const remainingMs = record.expiresAtMs - Date.now();
      if (remainingMs < 1) {
        await this.terminateRecord(record);
        throw new ExecutionHostError(
          'EXECUTION_TIMEOUT',
          `Execution ${executionId} exceeded its lifetime`,
        );
      }
      const timeoutMs = Math.min(
        request.timeoutMs ?? record.handle.resources.runtimeMs,
        remainingMs,
      );
      let credentialLease: CredentialLease | undefined;
      let execResult: ExecutionExecResult | undefined;
      let failure: unknown;
      try {
        if (request.credentials?.length) {
          if (!this.credentialBroker) {
            throw new ExecutionHostError(
              'EXECUTION_CREDENTIAL_ERROR',
              'Credential requests require a CredentialBroker',
            );
          }
          credentialLease = await this.credentialBroker.acquire(
            executionId,
            request.credentials,
            Math.min(timeoutMs, this.credentialTtlMs),
            request.signal,
          );
        }
        const environment = {
          ...(request.environment ?? {}),
          ...(credentialLease?.environment ?? {}),
        };
        this.assertEnvironment(request.environment ?? {}, false);
        this.assertNoEnvironmentCollisions(
          record.environmentNames,
          request.environment ?? {},
          'Persistent and per-command environments',
        );
        this.assertCredentialCollisions(
          request.environment ?? {},
          credentialLease?.environment ?? {},
          record.environmentNames,
        );
        const dockerEnvironment = {
          ...process.env,
          ...environment,
        };
        const args = ['exec'];
        if (request.stdin !== undefined) {
          args.push('-i');
        }
        args.push(
          '--user',
          this.containerUser,
          '--workdir',
          this.containerCwd(request.cwd),
        );
        for (const name of Object.keys(environment).sort()) {
          args.push('--env', name);
        }
        args.push(
          record.containerName,
          request.command,
          ...(request.args ?? []),
        );
        const startedAt = new Date().toISOString();
        const result = await this.runProcess(
          this.runtimeBinary,
          args,
          {
            environment: dockerEnvironment,
            ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
            timeoutMs,
            maxOutputBytes: record.handle.resources.maxOutputBytes,
            ...(request.signal ? { signal: request.signal } : {}),
            redactValues: Object.values(credentialLease?.environment ?? {}),
          },
        );
        execResult = {
          executionId,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      } catch (error) {
        failure = error;
        if (
          error instanceof ExecutionHostError
          && (
            error.code === 'EXECUTION_TIMEOUT'
            || error.code === 'EXECUTION_OUTPUT_LIMIT'
          )
        ) {
          await this.terminateRecord(record).catch((cleanupError) => {
            failure = new ExecutionHostError(
              'EXECUTION_RUNTIME_ERROR',
              `Execution ${executionId} failed and container cleanup was incomplete`,
              { cause: new AggregateError([error, cleanupError]) },
            );
          });
        } else if (request.signal?.aborted) {
          await this.terminateRecord(record).catch((cleanupError) => {
            failure = new ExecutionHostError(
              'EXECUTION_RUNTIME_ERROR',
              `Execution ${executionId} was aborted and container cleanup was incomplete`,
              { cause: new AggregateError([error, cleanupError]) },
            );
          });
        }
      } finally {
        if (credentialLease && this.credentialBroker) {
          await this.credentialBroker.release(credentialLease.leaseId)
            .catch((releaseError) => {
              failure = failure === undefined
                ? releaseError
                : new ExecutionHostError(
                    'EXECUTION_CREDENTIAL_ERROR',
                    `Execution ${executionId} failed and credential revocation also failed`,
                    { cause: new AggregateError([failure, releaseError]) },
                  );
            });
        }
      }
      if (failure !== undefined) {
        throw failure;
      }
      if (!execResult) {
        throw new ExecutionHostError(
          'EXECUTION_RUNTIME_ERROR',
          `Execution ${executionId} completed without a result`,
        );
      }
      return execResult;
    });
  }

  async checkpoint(
    executionId: ExecutionId,
    metadata: JsonObject = {},
  ): Promise<ExecutionCheckpoint> {
    this.assertJsonObject(metadata, 'Checkpoint metadata');
    const record = this.requireExecution(executionId);
    return record.mutex.runExclusive(async () => {
      await this.assertExecutionActive(record);
      const checkpointId =
        ExecutionCheckpointId(`checkpoint-${nanoid()}`);
      const checkpointPath = this.checkpointPath(checkpointId);
      const workspacePath = join(checkpointPath, 'workspace');
      let paused = false;
      let operationError: unknown;
      try {
        await mkdir(workspacePath, { recursive: true });
        await this.runControl(['pause', record.containerName]);
        paused = true;
        await this.runControl([
          'cp',
          `${record.containerName}:/workspace/.`,
          workspacePath,
        ]);
        const sizeBytes = await this.directorySize(workspacePath);
        if (
          sizeBytes
          > this.workspaceLimits(record.handle.resources).workspaceBytes
        ) {
          throw new ExecutionHostError(
            'EXECUTION_RESOURCE_LIMIT',
            'Checkpoint exceeds the configured disk limit',
          );
        }
        const executionManifest = await this.readExecutionManifest(
          record.rootPath,
        );
        this.validateManifest(executionManifest);
        const createdAt = new Date().toISOString();
        await this.writeExecutionManifest(checkpointPath, {
          ...executionManifest,
          sourceExecutionId: executionId,
          metadata: structuredClone(metadata),
          createdAt,
        });
        return {
          checkpointId,
          sourceExecutionId: executionId,
          createdAt,
          sizeBytes,
          metadata: structuredClone(metadata),
        };
      } catch (error) {
        operationError = error;
        await rm(checkpointPath, { recursive: true, force: true })
          .catch((cleanupError) => {
            operationError = new ExecutionHostError(
              'EXECUTION_RUNTIME_ERROR',
              `Checkpoint ${checkpointId} failed and cleanup was incomplete`,
              { cause: new AggregateError([error, cleanupError]) },
            );
          });
        throw operationError;
      } finally {
        if (paused && !record.terminated) {
          await this.runControl(['unpause', record.containerName])
            .catch(async (unpauseError) => {
              let cleanupError: unknown;
              await this.terminateRecord(record).catch((error) => {
                cleanupError = error;
              });
              throw new ExecutionHostError(
                'EXECUTION_RUNTIME_ERROR',
                `Checkpoint ${checkpointId} could not resume its container`,
                {
                  cause: new AggregateError([
                    ...(operationError === undefined ? [] : [operationError]),
                    unpauseError,
                    ...(cleanupError === undefined ? [] : [cleanupError]),
                  ]),
                },
              );
            });
        }
      }
    });
  }

  async restore(request: ExecutionRestoreRequest): Promise<ExecutionHandle> {
    request.signal?.throwIfAborted();
    const checkpointPath = this.checkpointPath(request.checkpointId);
    let manifest: unknown;
    try {
      manifest = await this.readExecutionManifest(checkpointPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ExecutionHostError(
          'EXECUTION_CHECKPOINT_NOT_FOUND',
          `Checkpoint ${request.checkpointId} was not found`,
          { cause: error },
        );
      }
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        `Checkpoint ${request.checkpointId} has an invalid manifest`,
        { cause: error },
      );
    }
    try {
      this.validateManifest(manifest);
    } catch (error) {
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        `Checkpoint ${request.checkpointId} has an invalid manifest`,
        { cause: error },
      );
    }
    const handle = await this.provision({
      ...(request.executionId ? { executionId: request.executionId } : {}),
      image: manifest.image,
      workspace: { kind: 'empty' },
      resources: manifest.resources,
      network: manifest.network,
      environment: manifest.environment,
      metadata: manifest.metadata,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const record = this.requireExecution(handle.executionId);
    try {
      await record.mutex.runExclusive(async () => {
        await this.copyDirectoryToContainer(
          join(checkpointPath, 'workspace'),
          record.containerName,
          request.signal,
        );
      });
      return handle;
    } catch (error) {
      await this.terminate(handle.executionId);
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        `Checkpoint ${request.checkpointId} could not be restored`,
        { cause: error },
      );
    }
  }

  async terminate(executionId: ExecutionId): Promise<void> {
    const record = this.executions.get(executionId);
    if (!record) {
      return;
    }
    await record.mutex.runExclusive(() => this.terminateRecord(record));
  }

  private async terminateRecord(record: ExecutionRecord): Promise<void> {
    record.terminated = true;
    clearTimeout(record.lifetimeTimer);
    const cleanupErrors: unknown[] = [];
    if (!record.containerRemoved) {
      await this.removeContainer(record.containerName).then(() => {
        record.containerRemoved = true;
      }).catch((error) => {
        cleanupErrors.push(error);
      });
    }
    if (record.containerRemoved && !record.volumeRemoved) {
      await this.removeVolume(record.workspaceVolumeName).then(() => {
        record.volumeRemoved = true;
      }).catch((error) => {
        cleanupErrors.push(error);
      });
    }
    if (
      record.containerRemoved
      && record.volumeRemoved
      && !record.egressReleased
    ) {
      await this.egressController?.release(record.handle.executionId)
        .then(() => {
          record.egressReleased = true;
        })
        .catch((error) => {
          cleanupErrors.push(error);
        });
    }
    if (
      record.containerRemoved
      && record.volumeRemoved
      && !record.rootRemoved
    ) {
      await rm(record.rootPath, { recursive: true, force: true }).then(() => {
        record.rootRemoved = true;
      }).catch((error) => {
        cleanupErrors.push(error);
      });
    }
    if (
      record.containerRemoved
      && record.volumeRemoved
      && record.egressReleased
      && record.rootRemoved
    ) {
      this.executions.delete(record.handle.executionId);
    }
    if (cleanupErrors.length > 0) {
      throw new ExecutionHostError(
        'EXECUTION_RUNTIME_ERROR',
        `Execution ${record.handle.executionId} cleanup was incomplete`,
        { cause: new AggregateError(cleanupErrors) },
      );
    }
  }

  private validateProvisionRequest(request: ExecutionProvisionRequest): void {
    this.assertImage(request.image);
    this.assertResourceLimits(request.resources);
    this.assertWorkspaceSource(request.workspace);
    this.assertEnvironment(request.environment ?? {}, false);
    this.assertJsonObject(request.metadata ?? {}, 'Execution metadata');
    this.assertNetworkPolicy(request.network);
    if (
      request.network.mode === 'proxy'
      && !this.egressController
    ) {
      throw new ExecutionHostError(
        'EXECUTION_NETWORK_POLICY',
        'Proxy egress requires an ExecutionEgressController',
      );
    }
  }

  private assertNetworkPolicy(network: ExecutionNetworkPolicy): void {
    if (
      network === null
      || typeof network !== 'object'
      || !('mode' in network)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_NETWORK_POLICY',
        'Execution network policy is invalid',
      );
    }
    if (network.mode === 'none') {
      return;
    }
    if (network.mode === 'proxy') {
      if (!Array.isArray(network.allowedHosts)) {
        throw new ExecutionHostError(
          'EXECUTION_NETWORK_POLICY',
          'Proxy egress requires a list of hostnames',
        );
      }
      if (
        network.allowedHosts.length === 0
        || network.allowedHosts.some((host) =>
          typeof host !== 'string'
          || !/^[A-Za-z0-9.-]+$/.test(host)
          || host.startsWith('.')
          || host.endsWith('.'))
        || new Set(network.allowedHosts.map((host) => host.toLowerCase()))
          .size !== network.allowedHosts.length
      ) {
        throw new ExecutionHostError(
          'EXECUTION_NETWORK_POLICY',
          'Proxy egress requires a unique, non-empty list of valid hostnames',
        );
      }
      return;
    }
    throw new ExecutionHostError(
      'EXECUTION_NETWORK_POLICY',
      'Execution network policy is invalid',
    );
  }

  private validateExecRequest(request: ExecutionExecRequest): void {
    if (
      typeof request.command !== 'string'
      || !request.command.trim()
      || request.command.includes('\0')
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution command must not be empty or contain NUL',
      );
    }
    if (
      (
        request.args !== undefined
        && (
          !Array.isArray(request.args)
          || request.args.some((argument) =>
            typeof argument !== 'string' || argument.includes('\0'))
        )
      )
      || (
        request.stdin !== undefined
        && typeof request.stdin !== 'string'
      )
      || (request.stdin?.length ?? 0) > MAX_OUTPUT_BYTES
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution arguments or stdin are invalid',
      );
    }
    if (
      request.timeoutMs !== undefined
      && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution timeoutMs must be a positive safe integer',
      );
    }
    this.containerCwd(request.cwd);
  }

  private assertImage(image: string): void {
    if (
      typeof image !== 'string'
      || !image.trim()
      || image.includes('\0')
      || (!this.allowUnpinnedImages && !IMAGE_DIGEST_PATTERN.test(image))
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution image must use an immutable sha256 digest',
      );
    }
  }

  private assertResourceLimits(resources: ExecutionResourceLimits): void {
    if (
      resources === null
      || typeof resources !== 'object'
      || !Number.isFinite(resources.cpus)
      || resources.cpus <= 0
      || resources.cpus > 128
      || !Number.isSafeInteger(resources.memoryBytes)
      || resources.memoryBytes < MIN_MEMORY_BYTES
      || resources.memoryBytes > MAX_MEMORY_BYTES
      || !Number.isSafeInteger(resources.diskBytes)
      || resources.diskBytes < MIN_DISK_BYTES
      || resources.diskBytes > MAX_DISK_BYTES
      || !Number.isSafeInteger(resources.pids)
      || resources.pids < 1
      || resources.pids > 32_768
      || !Number.isSafeInteger(resources.runtimeMs)
      || resources.runtimeMs < 1
      || resources.runtimeMs > MAX_RUNTIME_MS
      || !Number.isSafeInteger(resources.maxOutputBytes)
      || resources.maxOutputBytes < 1
      || resources.maxOutputBytes > MAX_OUTPUT_BYTES
    ) {
      throw new ExecutionHostError(
        'EXECUTION_RESOURCE_LIMIT',
        'Execution resource limits are invalid or exceed host maxima',
      );
    }
  }

  private async prepareWorkspace(
    source: ExecutionWorkspaceSource,
    sourcePath: string,
    diskBytes: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (source.kind === 'empty') {
      await mkdir(sourcePath, { recursive: true });
      return undefined;
    }
    if (
      !isAbsolute(source.repositoryPath)
      || !REVISION_PATTERN.test(source.revision)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Git worktree source requires an absolute repository and safe revision',
      );
    }
    const repositoryPath = await realpath(source.repositoryPath);
    let added = false;
    try {
      await this.runGit([
        '-C',
        repositoryPath,
        'worktree',
        'add',
        '--detach',
        sourcePath,
        source.revision,
      ], signal);
      added = true;
      const sizeBytes = await this.directorySize(sourcePath);
      if (sizeBytes > diskBytes) {
        throw new ExecutionHostError(
          'EXECUTION_RESOURCE_LIMIT',
          'Git worktree exceeds the configured disk limit',
        );
      }
      return repositoryPath;
    } catch (error) {
      if (added) {
        try {
          await this.removeGitWorktree(repositoryPath, sourcePath);
        } catch (cleanupError) {
          throw new ExecutionHostError(
            'EXECUTION_RUNTIME_ERROR',
            'Git worktree preparation failed and cleanup was incomplete',
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
      }
      throw error;
    }
  }

  private assertWorkspaceSource(source: ExecutionWorkspaceSource): void {
    if (
      source === null
      || typeof source !== 'object'
      || !('kind' in source)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution workspace source is invalid',
      );
    }
    if (source.kind === 'empty') {
      return;
    }
    if (
      source.kind !== 'git-worktree'
      || typeof source.repositoryPath !== 'string'
      || typeof source.revision !== 'string'
      || !isAbsolute(source.repositoryPath)
      || !REVISION_PATTERN.test(source.revision)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution workspace source is invalid',
      );
    }
  }

  private async removeGitWorktree(
    repositoryPath: string,
    sourcePath: string,
  ): Promise<void> {
    await this.runGit([
      '-C',
      repositoryPath,
      'worktree',
      'remove',
      '--force',
      sourcePath,
    ]);
  }

  private async verifyContainerLimits(
    containerName: string,
    resources: ExecutionResourceLimits,
    networkName: string,
  ): Promise<string> {
    const inspected = await this.runControl([
      'inspect',
      '--format',
      '{{json .}}',
      containerName,
    ]);
    let inspection: DockerInspection;
    try {
      inspection = JSON.parse(inspected.stdout) as DockerInspection;
    } catch (error) {
      throw new ExecutionHostError(
        'EXECUTION_RUNTIME_ERROR',
        'Container runtime returned invalid inspection data',
        { cause: error },
      );
    }
    const host = inspection.HostConfig;
    const limits = this.workspaceLimits(resources);
    const tempTmpfs = host?.Tmpfs?.['/tmp'] ?? '';
    const workspaceMount = inspection.Mounts?.find(
      (mount) => mount.Destination === '/workspace',
    );
    if (
      host?.AutoRemove !== true
      || host.NanoCpus !== Math.round(resources.cpus * 1_000_000_000)
      || host.Memory !== resources.memoryBytes
      || host.MemorySwap !== resources.memoryBytes
      || host.PidsLimit !== resources.pids
      || host.ShmSize !== limits.shmBytes
      || host.ReadonlyRootfs !== true
      || host.NetworkMode !== networkName
      || !host.CapDrop?.includes('ALL')
      || (host.CapAdd?.length ?? 0) !== 0
      || !host.SecurityOpt?.some((item) => item.includes('no-new-privileges'))
      || !tempTmpfs.includes(`size=${limits.tmpBytes}`)
      || inspection.Config?.User !== this.containerUser
      || !Array.isArray(inspection.Config.Entrypoint)
      || inspection.Config.Entrypoint.length !== 1
      || inspection.Config.Entrypoint[0] !== '/bin/sh'
      || workspaceMount?.Type !== 'volume'
      || !workspaceMount.Name
      || workspaceMount.RW !== true
    ) {
      throw new ExecutionHostError(
        'EXECUTION_RESOURCE_LIMIT',
        'Container runtime did not enforce every requested isolation limit',
      );
    }
    const volumeInspection = await this.inspectWorkspaceVolume(
      workspaceMount.Name,
    );
    const options = volumeInspection.Options;
    const mountOptions = new Set(options?.o?.split(',') ?? []);
    if (
      volumeInspection.Driver !== 'local'
      || options?.type !== 'tmpfs'
      || options.device !== 'tmpfs'
      || !mountOptions.has(`size=${limits.workspaceBytes}`)
      || !mountOptions.has(`uid=${limits.uid}`)
      || !mountOptions.has(`gid=${limits.gid}`)
      || !mountOptions.has('mode=0700')
    ) {
      throw new ExecutionHostError(
        'EXECUTION_RESOURCE_LIMIT',
        'Container runtime did not enforce the workspace disk limit',
      );
    }
    const sensitiveImageEnvironment = inspection.Config?.Env?.find((entry) => {
      const separator = entry.indexOf('=');
      const name = separator < 0 ? entry : entry.slice(0, separator);
      return isSensitiveEnvironmentName(name);
    });
    if (sensitiveImageEnvironment) {
      throw new ExecutionHostError(
        'EXECUTION_CREDENTIAL_ERROR',
        'Container image includes a potentially long-lived credential',
      );
    }
    return workspaceMount.Name;
  }

  private validateEgressLease(lease: ExecutionEgressLease): void {
    if (
      lease === null
      || typeof lease !== 'object'
      || typeof lease.networkName !== 'string'
      || !NETWORK_NAME_PATTERN.test(lease.networkName)
      || RESERVED_NETWORK_NAMES.has(lease.networkName)
      || lease.environment === null
      || typeof lease.environment !== 'object'
      || Array.isArray(lease.environment)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_NETWORK_POLICY',
        'Egress controller returned an invalid network name',
      );
    }
    this.assertEnvironment(lease.environment, false);
    for (const [name, value] of Object.entries(lease.environment)) {
      if (!/_PROXY$/i.test(name) || name.toUpperCase() === 'NO_PROXY') {
        continue;
      }
      try {
        const proxy = new URL(value);
        if (
          (proxy.protocol !== 'http:' && proxy.protocol !== 'https:')
          || proxy.username
          || proxy.password
        ) {
          throw new Error('Proxy URL is not an unauthenticated HTTP URL');
        }
      } catch (error) {
        throw new ExecutionHostError(
          'EXECUTION_NETWORK_POLICY',
          `Egress environment ${name} must be a proxy URL without credentials`,
          { cause: error },
        );
      }
    }
  }

  private assertEnvironment(
    environment: Readonly<Record<string, string>>,
    allowSecrets: boolean,
  ): void {
    if (
      environment === null
      || typeof environment !== 'object'
      || Array.isArray(environment)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution environment must be an object',
      );
    }
    for (const [name, value] of Object.entries(environment)) {
      if (
        !ENVIRONMENT_NAME_PATTERN.test(name)
        || typeof value !== 'string'
        || value.includes('\0')
        || Buffer.byteLength(value) > 32 * 1024
        || (!allowSecrets && isSensitiveEnvironmentName(name))
      ) {
        throw new ExecutionHostError(
          'EXECUTION_INVALID_REQUEST',
          `Environment variable ${name} is invalid or may contain a long-lived secret`,
        );
      }
    }
  }

  private assertCredentialCollisions(
    environment: Readonly<Record<string, string>>,
    credentials: Readonly<Record<string, string>>,
    persistentNames: ReadonlySet<string>,
  ): void {
    const collision = Object.keys(credentials).find(
      (name) =>
        environment[name] !== undefined
        || persistentNames.has(name),
    );
    if (collision) {
      throw new ExecutionHostError(
        'EXECUTION_CREDENTIAL_ERROR',
        `Credential environment ${collision} conflicts with request environment`,
      );
    }
  }

  private assertNoEnvironmentCollisions(
    existingNames: Iterable<string>,
    environment: Readonly<Record<string, string>>,
    label: string,
    code:
      | 'EXECUTION_INVALID_REQUEST'
      | 'EXECUTION_NETWORK_POLICY' = 'EXECUTION_INVALID_REQUEST',
  ): void {
    const names = new Set(existingNames);
    const collision = Object.keys(environment).find((name) => names.has(name));
    if (collision) {
      throw new ExecutionHostError(
        code,
        `${label} conflict on ${collision}`,
      );
    }
  }

  private assertJsonObject(value: unknown, label: string): void {
    const seen = new WeakSet<object>();
    const visit = (item: unknown, path: string): void => {
      if (
        item === null
        || typeof item === 'string'
        || typeof item === 'boolean'
      ) {
        return;
      }
      if (typeof item === 'number') {
        if (!Number.isFinite(item)) {
          throw new ExecutionHostError(
            'EXECUTION_INVALID_REQUEST',
            `${path} contains a non-finite number`,
          );
        }
        return;
      }
      if (typeof item !== 'object') {
        throw new ExecutionHostError(
          'EXECUTION_INVALID_REQUEST',
          `${path} contains a non-JSON value`,
        );
      }
      if (seen.has(item)) {
        throw new ExecutionHostError(
          'EXECUTION_INVALID_REQUEST',
          `${path} contains a circular reference`,
        );
      }
      seen.add(item);
      if (Array.isArray(item)) {
        item.forEach((entry, index) => {
          visit(entry, `${path}[${index}]`);
        });
        seen.delete(item);
        return;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ExecutionHostError(
          'EXECUTION_INVALID_REQUEST',
          `${path} contains a non-plain object`,
        );
      }
      for (const [key, entry] of Object.entries(item)) {
        visit(entry, `${path}.${key}`);
      }
      seen.delete(item);
    };
    visit(value, label);
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        `${label} must be a JSON object`,
      );
    }
  }

  private containerCwd(cwd: string | undefined): string {
    if (!cwd) {
      return '/workspace';
    }
    if (
      cwd.includes('\0')
      || cwd.startsWith('/')
      || cwd.split('/').includes('..')
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution cwd must stay within /workspace',
      );
    }
    const normalized = posix.normalize(cwd);
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'Execution cwd must stay within /workspace',
      );
    }
    return normalized === '.' ? '/workspace' : `/workspace/${normalized}`;
  }

  private workspaceLimits(resources: ExecutionResourceLimits): {
    readonly workspaceBytes: number;
    readonly tmpBytes: number;
    readonly shmBytes: number;
    readonly uid: number;
    readonly gid: number;
  } {
    const [rawUid, rawGid] = this.containerUser.split(':');
    const tmpBytes = Math.max(
      1024 * 1024,
      Math.min(16 * 1024 * 1024, Math.floor(resources.diskBytes / 10)),
    );
    const shmBytes = Math.max(
      MIN_SHM_BYTES,
      Math.min(MAX_SHM_BYTES, Math.floor(resources.diskBytes / 20)),
    );
    return {
      workspaceBytes: resources.diskBytes - tmpBytes - shmBytes,
      tmpBytes,
      shmBytes,
      uid: Number(rawUid),
      gid: Number(rawGid),
    };
  }

  private assertExecutionId(executionId: ExecutionId): void {
    if (!EXECUTION_ID_PATTERN.test(executionId)) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        'executionId contains unsupported characters',
      );
    }
  }

  private requireExecution(executionId: ExecutionId): ExecutionRecord {
    const record = this.executions.get(executionId);
    if (!record) {
      throw new ExecutionHostError(
        'EXECUTION_NOT_FOUND',
        `Execution ${executionId} was not found`,
      );
    }
    return record;
  }

  private async assertExecutionActive(record: ExecutionRecord): Promise<void> {
    if (record.terminated || Date.now() >= record.expiresAtMs) {
      await this.terminateRecord(record);
      throw new ExecutionHostError(
        'EXECUTION_TIMEOUT',
        `Execution ${record.handle.executionId} is no longer active`,
      );
    }
  }

  private async ensureRuntime(): Promise<void> {
    this.runtimeAvailability ??= this.runControl([
      'version',
      '--format',
      '{{.Server.Version}}',
    ]).then((result) => {
      if (!result.stdout.trim()) {
        throw new ExecutionHostError(
          'EXECUTION_HOST_UNAVAILABLE',
          'Container runtime server is unavailable',
        );
      }
    }).catch((error) => {
      this.runtimeAvailability = undefined;
      if (
        error instanceof ExecutionHostError
        && error.code === 'EXECUTION_HOST_UNAVAILABLE'
      ) {
        throw error;
      }
      throw new ExecutionHostError(
        'EXECUTION_HOST_UNAVAILABLE',
        'Container runtime server is unavailable',
        { cause: error },
      );
    });
    return this.runtimeAvailability;
  }

  private async runControl(
    args: readonly string[],
    signal?: AbortSignal,
    environment?: Readonly<Record<string, string>>,
  ): Promise<ProcessResult> {
    const result = await this.runProcess(
      this.runtimeBinary,
      args,
      {
        ...(environment
          ? { environment: { ...process.env, ...environment } }
          : {}),
        timeoutMs: CONTROL_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.exitCode !== 0) {
      throw new ExecutionHostError(
        'EXECUTION_RUNTIME_ERROR',
        `Container runtime command failed: ${result.stderr.trim() || 'unknown error'}`,
      );
    }
    return result;
  }

  private async inspectWorkspaceVolume(
    volumeName: string,
  ): Promise<DockerVolumeInspection> {
    const inspected = await this.runControl([
      'volume',
      'inspect',
      '--format',
      '{{json .}}',
      volumeName,
    ]);
    try {
      return JSON.parse(inspected.stdout) as DockerVolumeInspection;
    } catch (error) {
      throw new ExecutionHostError(
        'EXECUTION_RUNTIME_ERROR',
        'Container runtime returned invalid workspace volume data',
        { cause: error },
      );
    }
  }

  private async removeContainer(containerName: string): Promise<void> {
    const removed = await this.runProcess(
      this.runtimeBinary,
      ['rm', '-f', '-v', containerName],
      {
        timeoutMs: CONTROL_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
      },
    );
    if (removed.exitCode === 0) {
      return;
    }
    const inspected = await this.runProcess(
      this.runtimeBinary,
      ['inspect', '--format', '{{.Id}}', containerName],
      {
        timeoutMs: CONTROL_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
      },
    );
    if (
      inspected.exitCode !== 0
      && /no such (object|container)/i.test(inspected.stderr)
    ) {
      return;
    }
    throw new ExecutionHostError(
      'EXECUTION_RUNTIME_ERROR',
      `Container ${containerName} could not be removed: ${
        removed.stderr.trim() || 'unknown error'
      }`,
    );
  }

  private async removeVolume(volumeName: string): Promise<void> {
    const removed = await this.runProcess(
      this.runtimeBinary,
      ['volume', 'rm', volumeName],
      {
        timeoutMs: CONTROL_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
      },
    );
    if (removed.exitCode === 0) {
      return;
    }
    const inspected = await this.runProcess(
      this.runtimeBinary,
      ['volume', 'inspect', '--format', '{{.Name}}', volumeName],
      {
        timeoutMs: CONTROL_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
      },
    );
    if (
      inspected.exitCode !== 0
      && /no such volume/i.test(inspected.stderr)
    ) {
      return;
    }
    throw new ExecutionHostError(
      'EXECUTION_RUNTIME_ERROR',
      `Workspace volume ${volumeName} could not be removed: ${
        removed.stderr.trim() || 'unknown error'
      }`,
    );
  }

  private async copyDirectoryToContainer(
    sourcePath: string,
    containerName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const sourceBytes = await this.directorySize(sourcePath);
    await this.pipeProcesses(
      {
        command: 'tar',
        args: ['-C', sourcePath, '-cf', '-', '.'],
        environment: {
          ...process.env,
          COPYFILE_DISABLE: '1',
        },
      },
      {
        command: this.runtimeBinary,
        args: [
          'exec',
          '-i',
          '--user',
          this.containerUser,
          '--workdir',
          '/workspace',
          containerName,
          'tar',
          '-xf',
          '-',
          '-C',
          '/workspace',
        ],
      },
      this.transferTimeout(sourceBytes),
      Math.min(
        Number.MAX_SAFE_INTEGER,
        sourceBytes + Math.max(16 * 1024 * 1024, sourceBytes),
      ),
      signal,
    );
  }

  private transferTimeout(maxBytes: number): number {
    return Math.min(
      MAX_RUNTIME_MS,
      Math.max(
        CONTROL_TIMEOUT_MS,
        Math.ceil(maxBytes / (1024 * 1024)) * 1_000,
      ),
    );
  }

  private pipeProcesses(
    sourceCommand: ProcessCommand,
    destinationCommand: ProcessCommand,
    timeoutMs: number,
    maxTransferBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const source = spawn(
        sourceCommand.command,
        [...sourceCommand.args],
        {
          ...(sourceCommand.environment
            ? { env: sourceCommand.environment }
            : {}),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const destination = spawn(
        destinationCommand.command,
        [...destinationCommand.args],
        {
          ...(destinationCommand.environment
            ? { env: destinationCommand.environment }
            : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const output: Buffer[] = [];
      let outputBytes = 0;
      let transferBytes = 0;
      let sourceExitCode: number | null | undefined;
      let destinationExitCode: number | null | undefined;
      let failure: unknown;
      let settled = false;
      const kill = () => {
        source.kill('SIGKILL');
        destination.kill('SIGKILL');
      };
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = () => {
        if (
          settled
          || sourceExitCode === undefined
          || destinationExitCode === undefined
        ) {
          return;
        }
        settled = true;
        cleanup();
        if (failure !== undefined) {
          rejectPromise(failure);
          return;
        }
        if (sourceExitCode !== 0 || destinationExitCode !== 0) {
          rejectPromise(new ExecutionHostError(
            'EXECUTION_RUNTIME_ERROR',
            `Workspace transfer failed: ${
              Buffer.concat(output).toString('utf8').trim() || 'unknown error'
            }`,
          ));
          return;
        }
        resolvePromise();
      };
      const fail = (message: string, cause?: unknown) => {
        if (failure === undefined) {
          failure = new ExecutionHostError(
            'EXECUTION_RUNTIME_ERROR',
            message,
            cause === undefined ? undefined : { cause },
          );
          kill();
        }
      };
      const collect = (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > CONTROL_OUTPUT_BYTES) {
          fail('Workspace transfer produced excessive diagnostic output');
          return;
        }
        output.push(chunk);
      };
      const timeout = setTimeout(() => {
        fail(`Workspace transfer exceeded ${timeoutMs}ms`);
      }, timeoutMs);
      timeout.unref();
      const onAbort = () => {
        fail('Workspace transfer was aborted', signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      source.stdout.on('data', (chunk: Buffer) => {
        transferBytes += chunk.byteLength;
        if (transferBytes > maxTransferBytes) {
          fail('Workspace transfer exceeded its byte limit');
        }
      });
      source.stdout.pipe(destination.stdin);
      source.stderr.on('data', collect);
      destination.stdout.on('data', collect);
      destination.stderr.on('data', collect);
      destination.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') {
          fail('Workspace transfer pipe failed', error);
        }
      });
      source.once('error', (error) => {
        fail(`Failed to start ${sourceCommand.command}`, error);
      });
      destination.once('error', (error) => {
        fail(`Failed to start ${destinationCommand.command}`, error);
      });
      source.once('close', (code) => {
        sourceExitCode = code;
        finish();
      });
      destination.once('close', (code) => {
        destinationExitCode = code;
        finish();
      });
    });
  }

  private async runGit(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const result = await this.runProcess(
      'git',
      args,
      {
        timeoutMs: CONTROL_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.exitCode !== 0) {
      throw new ExecutionHostError(
        'EXECUTION_RUNTIME_ERROR',
        `Git worktree command failed: ${result.stderr.trim() || 'unknown error'}`,
      );
    }
    return result;
  }

  private runProcess(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    options.signal?.throwIfAborted();
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, [...args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.environment ? { env: options.environment } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let terminationError: unknown;
      let settled = false;
      const finishReject = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        rejectPromise(error);
      };
      const timeout = setTimeout(() => {
        terminationError = new ExecutionHostError(
          'EXECUTION_TIMEOUT',
          `Execution exceeded ${options.timeoutMs}ms`,
        );
        child.kill('SIGKILL');
      }, options.timeoutMs);
      timeout.unref();
      const onAbort = () => {
        terminationError = new ExecutionHostError(
          'EXECUTION_RUNTIME_ERROR',
          'Execution was aborted',
          { cause: options.signal?.reason },
        );
        child.kill('SIGKILL');
      };
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const collect = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (
          outputBytes > options.maxOutputBytes
          && terminationError === undefined
        ) {
          terminationError = new ExecutionHostError(
            'EXECUTION_OUTPUT_LIMIT',
            `Execution output exceeded ${options.maxOutputBytes} bytes`,
          );
          child.kill('SIGKILL');
          return;
        }
        if (outputBytes <= options.maxOutputBytes) {
          target.push(chunk);
        }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        collect(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        collect(stderr, chunk);
      });
      child.once('error', (error) => {
        finishReject(new ExecutionHostError(
          'EXECUTION_RUNTIME_ERROR',
          `Failed to start ${command}`,
          { cause: error },
        ));
      });
      child.once('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (terminationError !== undefined) {
          rejectPromise(terminationError);
          return;
        }
        const redact = (value: string): string => {
          let redacted = value;
          for (const secret of options.redactValues ?? []) {
            if (secret) {
              redacted = redacted.split(secret).join('[REDACTED]');
            }
          }
          return redacted;
        };
        resolvePromise({
          exitCode: code ?? 1,
          stdout: redact(Buffer.concat(stdout).toString('utf8')),
          stderr: redact(Buffer.concat(stderr).toString('utf8')),
        });
      });
      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin);
      } else {
        child.stdin.end();
      }
    });
  }

  private async directorySize(path: string): Promise<number> {
    const stat = await lstat(path);
    if (!stat.isDirectory()) {
      return stat.size;
    }
    let total = 0;
    for (const entry of await readdir(path)) {
      total += await this.directorySize(join(path, entry));
    }
    return total;
  }

  private checkpointPath(checkpointId: ExecutionCheckpointId): string {
    if (!EXECUTION_ID_PATTERN.test(checkpointId)) {
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        'checkpointId contains unsupported characters',
      );
    }
    return resolve(this.checkpointDirectory, checkpointId);
  }

  private async writeExecutionManifest(
    directory: string,
    manifest: CheckpointManifest,
  ): Promise<void> {
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  private async readExecutionManifest(
    directory: string,
  ): Promise<unknown> {
    return JSON.parse(
      await readFile(join(directory, 'manifest.json'), 'utf8'),
    ) as unknown;
  }

  private validateManifest(
    value: unknown,
  ): asserts value is CheckpointManifest {
    if (
      value === null
      || typeof value !== 'object'
      || Array.isArray(value)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        'Checkpoint manifest must be an object',
      );
    }
    const manifest = value as Partial<CheckpointManifest>;
    if (manifest.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        `Unsupported checkpoint schema ${String(manifest.schemaVersion)}`,
      );
    }
    if (
      typeof manifest.sourceExecutionId !== 'string'
      || !EXECUTION_ID_PATTERN.test(manifest.sourceExecutionId)
      || typeof manifest.image !== 'string'
      || manifest.resources === null
      || typeof manifest.resources !== 'object'
      || manifest.network === null
      || typeof manifest.network !== 'object'
      || manifest.environment === null
      || typeof manifest.environment !== 'object'
      || Array.isArray(manifest.environment)
      || manifest.metadata === null
      || typeof manifest.metadata !== 'object'
      || Array.isArray(manifest.metadata)
      || typeof manifest.createdAt !== 'string'
      || !Number.isFinite(Date.parse(manifest.createdAt))
    ) {
      throw new ExecutionHostError(
        'EXECUTION_CHECKPOINT_INVALID',
        'Checkpoint manifest fields are invalid',
      );
    }
    this.assertImage(manifest.image);
    this.assertResourceLimits(manifest.resources);
    this.assertNetworkPolicy(manifest.network);
    this.assertEnvironment(manifest.environment, false);
    this.assertJsonObject(manifest.metadata, 'Checkpoint metadata');
  }
}

export type {
  DockerExecutionHostOptions,
};
