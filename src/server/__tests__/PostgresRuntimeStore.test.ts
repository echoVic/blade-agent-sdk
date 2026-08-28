import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  type EventId,
  type EventSequence,
  SessionId,
} from '../../types/identifiers.js';
import { PostgresRuntimeStore } from '../PostgresRuntimeStore.js';

describe('PostgresRuntimeStore event quotas', () => {
  it.each([
    'maxDurableEventsPerSession',
    'maxDomainEventsPerSession',
    'maxTranscriptEventsPerSession',
  ] as const)('rejects an invalid %s', (option) => {
    expect(
      () =>
        new PostgresRuntimeStore({
          pool: {} as Pool,
          [option]: 0,
        }),
    ).toThrow(/positive safe integer/);
  });

  it('rejects an append before a non-retained stream exceeds its quota', async () => {
    const store = new PostgresRuntimeStore({ pool: {} as Pool });
    const client = { query: vi.fn() } as unknown as PoolClient;
    const appendStream = (
      store as unknown as {
        appendStream(
          client: PoolClient,
          tenantId: string,
          sessionId: SessionId,
          streamName: string,
          knownHead: number,
          factories: readonly ((fields: {
            sequence: EventSequence;
            eventId: EventId;
            recordedAt: string;
          }) => {
            eventId: EventId;
            sequence: EventSequence;
            type: string;
            occurredAt: string;
          })[],
          retention: undefined,
          quota: number,
        ): Promise<unknown>;
      }
    ).appendStream.bind(store);

    await expect(
      appendStream(
        client,
        'tenant-a',
        SessionId('session-a'),
        'durable',
        1,
        [
          ({ sequence, eventId, recordedAt }) => ({
            sequence,
            eventId,
            type: 'test',
            occurredAt: recordedAt,
          }),
        ],
        undefined,
        1,
      ),
    ).rejects.toMatchObject({ code: 'RUNTIME_STORE_QUOTA_EXCEEDED' });
    expect(client.query).not.toHaveBeenCalled();
  });
});
