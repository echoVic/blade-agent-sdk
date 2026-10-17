import { describe, expect, it } from 'vitest';
import { DurableExecutionLeaseError } from '../events/DurableExecutionLeaseStore.js';
import { SessionDurability } from '../SessionDurability.js';
import { SessionRequestCoordinator } from '../SessionRequestCoordinator.js';
import { SessionState } from '../SessionState.js';

describe('SessionRequestCoordinator admission', () => {
  it('preserves a lease failure that arrives as initialization settles', async () => {
    const state = new SessionState({
      provider: { type: 'openai-compatible', apiKey: 'test' },
      model: 'test',
      persistSession: false,
    });
    const failure = new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      'Execution lease lost',
    );
    const coordinator = new SessionRequestCoordinator(
      state,
      new SessionDurability(state),
      async () => {
        // Lease loss can run after the lifecycle guard, before admission resumes.
        state.executionLeaseFailure = failure;
      },
    );
    await expect(coordinator.send('hello')).rejects.toBe(failure);
  });
});
