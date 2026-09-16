import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Pool, PoolClient } from 'pg';
import type { JsonObject } from '../types/json.js';
import { jsonObjectSchema } from '../types/jsonSchema.js';

export function postgresInteger(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`PostgreSQL value is not a safe integer: ${String(value)}`);
  }
  return parsed;
}

export function postgresTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function postgresJsonObject(value: unknown, label = 'PostgreSQL JSON object'): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${label} must be a JSON object`, { cause: parsed.error });
  }
  return parsed.data;
}

export function quotePostgresIdentifier(value: string, label = 'identifier'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new RangeError(`${label} must be a PostgreSQL identifier`);
  }
  return `"${value}"`;
}

export function postgresAdvisoryLockKey(key: string): readonly [number, number] {
  const digest = createHash('sha256').update(key).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export class PostgresContext {
  readonly schema: string;
  readonly prefix: string;
  private readonly transactionContext = new AsyncLocalStorage<PoolClient>();

  constructor(
    readonly pool: Pool,
    schema = 'public',
    prefix = 'blade_runtime',
  ) {
    this.schema = quotePostgresIdentifier(schema, 'schema');
    this.prefix = quotePostgresIdentifier(prefix, 'tablePrefix').slice(1, -1);
  }

  table(suffix: string): string {
    return `${this.schema}.${quotePostgresIdentifier(`${this.prefix}_${suffix}`, 'table')}`;
  }

  client(): Pool | PoolClient {
    return this.transactionContext.getStore() ?? this.pool;
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const active = this.transactionContext.getStore();
    if (active) {
      const savepoint = quotePostgresIdentifier(`nested_${nanoid().replaceAll('-', '_')}`);
      await active.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await operation(active);
        await active.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await active.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
        await active.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
        throw error;
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.transactionContext.run(client, () => operation(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async lock(client: PoolClient, key: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...postgresAdvisoryLockKey(key)]);
  }
}
