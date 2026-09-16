import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresRuntimeStore } from '../PostgresRuntimeStore.js';

describe('PostgresRuntimeStore event quotas', () => {
  it('rejects an invalid durable-event quota', () => {
    expect(
      () =>
        new PostgresRuntimeStore({
          pool: {} as Pool,
          maxDurableEventsPerSession: 0,
        }),
    ).toThrow(/positive safe integer/);
  });
});
