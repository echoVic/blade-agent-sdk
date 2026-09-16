import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import * as postgres from '../PostgresContext.js';

const { PostgresContext, quotePostgresIdentifier } = postgres;

describe('PostgresContext', () => {
  it('owns table naming, nested transactions, and advisory locks', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    } as unknown as Pool;
    const context = new PostgresContext(pool, 'runtime', 'blade');

    expect(context.table('events')).toBe('"runtime"."blade_events"');
    await context.transaction(async (outer) => {
      expect(context.client()).toBe(outer);
      await context.transaction(async (inner) => {
        expect(inner).toBe(outer);
        await context.lock(inner, 'tenant:session');
      });
    });

    expect(queries[0]?.text).toBe('BEGIN');
    expect(queries.some(({ text }) => /^SAVEPOINT "nested_[A-Za-z0-9_]+"$/.test(text))).toBe(true);
    expect(queries).toContainEqual({
      text: 'SELECT pg_advisory_xact_lock($1, $2)',
      values: expect.arrayContaining([expect.any(Number), expect.any(Number)]),
    });
    expect(queries.at(-1)?.text).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects unsafe PostgreSQL identifiers', () => {
    expect(() => quotePostgresIdentifier('runtime; DROP TABLE sessions', 'schema')).toThrow(
      /PostgreSQL identifier/,
    );
  });

  it('decodes shared PostgreSQL scalar and JSON values', () => {
    expect('postgresInteger' in postgres).toBe(true);
    expect('postgresTimestamp' in postgres).toBe(true);
    expect('postgresJsonObject' in postgres).toBe(true);

    const integer = Reflect.get(postgres, 'postgresInteger') as (value: string | number) => number;
    const timestamp = Reflect.get(postgres, 'postgresTimestamp') as (
      value: Date | string,
    ) => string;
    const jsonObject = Reflect.get(postgres, 'postgresJsonObject') as (
      value: unknown,
      label?: string,
    ) => Record<string, unknown>;

    expect(integer('42')).toBe(42);
    expect(() => integer(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
    expect(timestamp(new Date('2026-09-16T00:00:00.000Z'))).toBe('2026-09-16T00:00:00.000Z');

    const source = { nested: { value: 1 } };
    const decoded = jsonObject(source);
    expect(decoded).toEqual(source);
    expect(decoded).not.toBe(source);
    expect(() => jsonObject({ missing: undefined }, 'payload')).toThrow(/payload/);
  });
});
