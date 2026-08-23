import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventId, SessionId } from '../../../types/branded.js';

const lockState = vi.hoisted(() => ({
  onCompromised: undefined as ((error: Error) => void) | undefined,
  releaseError: undefined as Error | undefined,
  acquireErrors: [] as Error[],
  acquireAttempts: 0,
  acquireGate: undefined as Promise<void> | undefined,
  releaseAttempts: 0,
}));

vi.mock('proper-lockfile', () => ({
  lock: vi.fn(async (_filePath: string, options: { onCompromised?: (error: Error) => void }) => {
    lockState.acquireAttempts += 1;
    const acquireError = lockState.acquireErrors.shift();
    if (acquireError) {
      throw acquireError;
    }
    lockState.onCompromised = options.onCompromised;
    await lockState.acquireGate;
    return async () => {
      lockState.releaseAttempts += 1;
      if (lockState.releaseError) {
        throw lockState.releaseError;
      }
    };
  }),
}));

import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import { DurableEventType } from '../types.js';

describe('JsonlDurableEventStore compromised lock', () => {
  let storageRoot: string | undefined;

  afterEach(async () => {
    lockState.onCompromised = undefined;
    lockState.releaseError = undefined;
    lockState.acquireErrors = [];
    lockState.acquireAttempts = 0;
    lockState.acquireGate = undefined;
    lockState.releaseAttempts = 0;
    vi.restoreAllMocks();
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
      storageRoot = undefined;
    }
  });

  it('fences an append before mutation when the process lock is compromised', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'durable-event-compromised-lock-'));
    const store = new JsonlDurableEventStore(storageRoot, {
      eventIdFactory: () => {
        lockState.onCompromised?.(new Error('lock ownership lost'));
        return EventId('must-not-be-written');
      },
    });
    const sessionId = SessionId('session-compromised-lock');

    await expect(
      store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
        expectedLastSequence: null,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_WRITE_FAILED',
      message: expect.stringContaining('lost the Session lock'),
    });
    await expect(stat(store.getFilePath(sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports an unknown write outcome when lock release fails after fsync', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'durable-event-release-failure-'));
    const store = new JsonlDurableEventStore(storageRoot, {
      eventIdFactory: () => EventId('committed-before-release-failure'),
    });
    const sessionId = SessionId('session-release-failure');
    lockState.releaseError = new Error('release failed');

    await expect(
      store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
        expectedLastSequence: null,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_WRITE_FAILED',
      message: expect.stringContaining('failed while holding the Session lock'),
    });

    lockState.releaseError = undefined;
    await expect(store.read(sessionId)).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          eventId: 'committed-before-release-failure',
          sequence: 1,
        }),
      ],
      headSequence: 1,
    });
  });

  it('does not retry lock acquisition after the total deadline', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'durable-event-lock-deadline-'));
    const store = new JsonlDurableEventStore(storageRoot, {
      lockTimeoutMs: 10,
    });
    lockState.acquireErrors.push(Object.assign(new Error('lock held'), { code: 'ELOCKED' }));
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValue(10);

    await expect(store.read(SessionId('session-lock-deadline'))).rejects.toMatchObject({
      code: 'DURABLE_EVENT_LOCK_TIMEOUT',
    });
    expect(lockState.acquireAttempts).toBe(1);
  });

  it('times out an in-flight lock attempt and releases a late acquisition', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'durable-event-lock-attempt-timeout-'));
    const store = new JsonlDurableEventStore(storageRoot, {
      lockTimeoutMs: 10,
    });
    let resolveAcquire: (() => void) | undefined;
    lockState.acquireGate = new Promise<void>((resolve) => {
      resolveAcquire = resolve;
    });

    await expect(store.read(SessionId('session-lock-attempt-timeout'))).rejects.toMatchObject({
      code: 'DURABLE_EVENT_LOCK_TIMEOUT',
    });
    expect(lockState.acquireAttempts).toBe(1);

    resolveAcquire?.();
    await vi.waitFor(() => {
      expect(lockState.releaseAttempts).toBe(1);
    });
  });
});
