import { describe, expect, it, vi } from 'vitest';
import type { ExecutionHandle, ExecutionHost } from '../../execution/ExecutionHost.js';
import {
  ExecutionCheckpointId,
  ExecutionId,
  ExecutionLeaseId,
  FencingToken,
  SessionId,
  WorkerId,
} from '../../types/identifiers.js';
import { ExecutionHostSessionRunner } from '../ExecutionHostSessionRunner.js';
import type { RuntimeStore } from '../RuntimeStore.js';
import type { SessionRunnerContext } from '../SessionRunner.js';

const resources = {
  cpus: 1,
  memoryBytes: 64 * 1024 * 1024,
  diskBytes: 16 * 1024 * 1024,
  pids: 32,
  runtimeMs: 60_000,
  maxOutputBytes: 1024,
};

function executionHandle(executionId = ExecutionId('execution-1')): ExecutionHandle {
  return {
    executionId,
    state: 'provisioned',
    image: 'image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resources,
    network: { mode: 'none' },
    metadata: {},
  };
}

function createHost() {
  const handle = executionHandle();
  return {
    provision: vi.fn(async () => handle),
    restore: vi.fn(async () => handle),
    exec: vi.fn(async () => ({
      executionId: handle.executionId,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    })),
    checkpoint: vi.fn(async () => ({
      checkpointId: ExecutionCheckpointId('checkpoint-1'),
      sourceExecutionId: handle.executionId,
      createdAt: new Date().toISOString(),
      sizeBytes: 3,
      metadata: {},
    })),
    terminate: vi.fn(async () => undefined),
  } satisfies ExecutionHost;
}

function createContext(
  host: ExecutionHost,
  metadata = {},
  signal = new AbortController().signal,
): SessionRunnerContext {
  return {
    workerId: WorkerId('worker-1'),
    store: {} as RuntimeStore,
    claim: {
      route: {
        tenantId: 'tenant-1',
        sessionId: SessionId('session-1'),
        state: 'provisioning',
        priority: 0,
        attempt: 1,
        fencingToken: FencingToken(1),
        workerId: WorkerId('worker-1'),
        leaseId: ExecutionLeaseId('lease-1'),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        queuedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata,
      },
      lease: {
        sessionId: SessionId('session-1'),
        ownerId: WorkerId('worker-1'),
        leaseId: ExecutionLeaseId('lease-1'),
        fencingToken: FencingToken(1),
        acquiredAt: new Date().toISOString(),
        renewedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    signal,
    executionHost: host,
    transition: vi.fn(async (state, nextMetadata) => ({
      ...createContext(host, metadata, signal).claim.route,
      state,
      metadata: nextMetadata ?? metadata,
    })),
  };
}

describe('ExecutionHostSessionRunner', () => {
  it('provisions, executes, checkpoints, and returns a resumable route', async () => {
    const host = createHost();
    const runner = new ExecutionHostSessionRunner({
      resolvePlan: () => ({
        provision: {
          image: executionHandle().image,
          workspace: { kind: 'empty' },
          resources,
          network: { mode: 'none' },
        },
        command: {
          command: '/bin/sh',
          args: ['-c', 'printf ok > result.txt'],
        },
        checkpoint: 'suspend',
      }),
    });
    const context = createContext(host);

    const result = await runner.run(context);

    expect(host.provision).toHaveBeenCalledOnce();
    expect(host.restore).not.toHaveBeenCalled();
    expect(host.exec).toHaveBeenCalledWith(
      ExecutionId('execution-1'),
      expect.objectContaining({ command: '/bin/sh' }),
    );
    expect(host.checkpoint).toHaveBeenCalledOnce();
    expect(host.terminate).toHaveBeenCalledWith(ExecutionId('execution-1'));
    expect(result).toMatchObject({
      status: 'suspended',
      metadata: {
        bladeExecution: {
          version: 1,
          checkpointId: 'checkpoint-1',
          lastExitCode: 0,
        },
      },
    });
  });

  it('restores a persisted checkpoint before completing the Session', async () => {
    const host = createHost();
    const runner = new ExecutionHostSessionRunner({
      resolvePlan: () => ({
        provision: {
          image: executionHandle().image,
          workspace: { kind: 'empty' },
          resources,
          network: { mode: 'none' },
        },
        command: { command: '/bin/true' },
      }),
    });
    const context = createContext(host, {
      bladeExecution: {
        version: 1,
        checkpointId: 'checkpoint-1',
      },
    });

    const result = await runner.run(context);

    expect(host.restore).toHaveBeenCalledWith({
      checkpointId: ExecutionCheckpointId('checkpoint-1'),
      signal: context.signal,
    });
    expect(host.provision).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });
});
