import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '../../../types/branded.js';

vi.mock('fs-native-extensions', () => {
  throw new Error('native lock addon unavailable');
});

import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';

describe('JsonlDurableEventStore native lock availability', () => {
  it('loads the Store module but fails closed on the first operation', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'durable-event-lock-unavailable-'));
    try {
      const store = new JsonlDurableEventStore(storageRoot);

      await expect(store.read(SessionId('session-lock-unavailable'))).rejects.toMatchObject({
        code: 'DURABLE_EVENT_LOCK_FAILED',
        message: expect.stringContaining('Failed to initialize'),
      });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
