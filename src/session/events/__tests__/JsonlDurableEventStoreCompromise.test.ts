import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventId, SessionId } from '../../../types/branded.js';

const lockState = vi.hoisted(() => ({
  acquireError: undefined as Error | undefined,
  acquireResults: [] as boolean[],
  closeError: undefined as Error | undefined,
  releaseError: undefined as Error | undefined,
  acquireAttempts: 0,
  releaseAttempts: 0,
}));

vi.mock('fs-native-extensions', () => ({
  tryLock: vi.fn(() => {
    lockState.acquireAttempts += 1;
    if (lockState.acquireError) {
      throw lockState.acquireError;
    }
    return lockState.acquireResults.shift() ?? true;
  }),
  unlock: vi.fn(() => {
    lockState.releaseAttempts += 1;
    if (lockState.releaseError) {
      throw lockState.releaseError;
    }
  }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (path: string, flags: string, mode?: number) => {
      const file = await actual.open(path, flags, mode);
      if (path.endsWith('.lock')) {
        const close = file.close.bind(file);
        file.close = async () => {
          await close();
          if (lockState.closeError) {
            throw lockState.closeError;
          }
        };
      }
      return file;
    }),
  };
});

import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import { DurableEventType } from '../types.js';

describe('JsonlDurableEventStore native lock failures', () => {
  let storageRoot: string | undefined;

  afterEach(async () => {
    lockState.acquireError = undefined;
    lockState.acquireResults = [];
    lockState.closeError = undefined;
    lockState.releaseError = undefined;
    lockState.acquireAttempts = 0;
    lockState.releaseAttempts = 0;
    vi.restoreAllMocks();
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
      storageRoot = undefined;
    }
  });

  it('fails before mutation when native lock acquisition fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'durable-event-lock-failure-'));
    const store = new JsonlDurableEventStore(storageRoot, {
      eventIdFactory: () => EventId('must-not-be-written'),
    });
    const sessionId = SessionId('session-lock-failure');
    lockState.acquireError = new Error('native lock failed');

    await expect(
      store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
        expectedLastSequence: null,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_LOCK_FAILED',
      message: expect.stringContaining('Failed to acquire'),
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

  it('reports an unknown write outcome when the lock file fails to close', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'durable-event-lock-close-failure-'));
    const store = new JsonlDurableEventStore(storageRoot, {
      eventIdFactory: () => EventId('committed-before-close-failure'),
    });
    const sessionId = SessionId('session-lock-close-failure');
    lockState.closeError = new Error('close failed');

    await expect(
      store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
        expectedLastSequence: null,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_WRITE_FAILED',
      message: expect.stringContaining('failed while holding the Session lock'),
    });

    lockState.closeError = undefined;
    await expect(store.read(sessionId)).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          eventId: 'committed-before-close-failure',
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
    lockState.acquireResults.push(false);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValue(10);

    await expect(store.read(SessionId('session-lock-deadline'))).rejects.toMatchObject({
      code: 'DURABLE_EVENT_LOCK_TIMEOUT',
    });
    expect(lockState.acquireAttempts).toBe(1);
  });
});
