import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ExecutionId } from '../../types/branded.js';
import {
  EphemeralCredentialBroker,
  type CredentialIssuer,
} from '../CredentialBroker.js';

const executionId = ExecutionId('execution-credential-test');

afterEach(() => {
  vi.useRealTimers();
});

describe('EphemeralCredentialBroker', () => {
  it('issues an issuer-named environment and revokes it idempotently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'));
    const revoke = vi.fn(async () => undefined);
    const issue = vi.fn<CredentialIssuer['issue']>(async () => ({
      value: 'short-lived-value',
      expiresAt: new Date(Date.now() + 500).toISOString(),
      revoke,
    }));
    const broker = new EphemeralCredentialBroker({
      github: {
        environmentVariable: 'GITHUB_EPHEMERAL_TOKEN',
        issue,
      },
    });

    const lease = await broker.acquire(
      executionId,
      [{
        name: 'github',
        audience: 'api.github.com',
      }],
      1_000,
    );

    expect(issue).toHaveBeenCalledWith({
      name: 'github',
      audience: 'api.github.com',
      executionId,
      expiresBy: '2026-08-26T00:00:01.000Z',
    });
    expect(lease).toMatchObject({
      executionId,
      expiresAt: '2026-08-26T00:00:00.500Z',
      environment: {
        GITHUB_EPHEMERAL_TOKEN: 'short-lived-value',
      },
    });
    expect(lease.leaseId).toMatch(/^credential-/);
    expect(Object.isFrozen(lease.environment)).toBe(true);

    await broker.release(lease.leaseId);
    await broker.release(lease.leaseId);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('automatically revokes and forgets an expired lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'));
    const revoke = vi.fn(async () => undefined);
    const broker = new EphemeralCredentialBroker({
      registry: {
        environmentVariable: 'REGISTRY_EPHEMERAL_TOKEN',
        async issue() {
          return {
            value: 'expires-fast',
            expiresAt: new Date(Date.now() + 100).toISOString(),
            revoke,
          };
        },
      },
    });
    const lease = await broker.acquire(
      executionId,
      [{ name: 'registry', audience: 'registry.example.com' }],
      100,
    );

    await vi.advanceTimersByTimeAsync(101);
    expect(revoke).toHaveBeenCalledTimes(1);
    await broker.release(lease.leaseId);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('revokes every issued credential when a later issuer fails', async () => {
    const revoke = vi.fn(async () => undefined);
    const broker = new EphemeralCredentialBroker({
      first: {
        environmentVariable: 'FIRST_EPHEMERAL_TOKEN',
        async issue(context) {
          return {
            value: 'first-value',
            expiresAt: new Date(
              Date.parse(context.expiresBy) - 1,
            ).toISOString(),
            revoke,
          };
        },
      },
      second: {
        environmentVariable: 'SECOND_EPHEMERAL_TOKEN',
        async issue() {
          throw new Error('issuer unavailable');
        },
      },
    });

    await expect(broker.acquire(
      executionId,
      [
        { name: 'first', audience: 'first.example.com' },
        { name: 'second', audience: 'second.example.com' },
      ],
      1_000,
    )).rejects.toThrow('issuer unavailable');
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('rejects and revokes credentials that outlive the requested lease', async () => {
    const revoke = vi.fn(async () => undefined);
    const broker = new EphemeralCredentialBroker({
      invalid: {
        environmentVariable: 'INVALID_EPHEMERAL_TOKEN',
        async issue(context) {
          return {
            value: 'too-long-lived',
            expiresAt: new Date(
              Date.parse(context.expiresBy) + 1,
            ).toISOString(),
            revoke,
          };
        },
      },
    });

    await expect(broker.acquire(
      executionId,
      [{ name: 'invalid', audience: 'invalid.example.com' }],
      1_000,
    )).rejects.toMatchObject({
      code: 'EXECUTION_CREDENTIAL_ERROR',
    });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid limits, requests, and issuer environment collisions', async () => {
    expect(() => new EphemeralCredentialBroker({}, 0)).toThrow(
      /maxTtlMs/,
    );
    expect(() => new EphemeralCredentialBroker({
      first: {
        environmentVariable: 'SHARED_EPHEMERAL_TOKEN',
        async issue() {
          throw new Error('not reached');
        },
      },
      second: {
        environmentVariable: 'SHARED_EPHEMERAL_TOKEN',
        async issue() {
          throw new Error('not reached');
        },
      },
    })).toThrow(/duplicated/);

    const broker = new EphemeralCredentialBroker({
      valid: {
        environmentVariable: 'VALID_EPHEMERAL_TOKEN',
        async issue(context) {
          return {
            value: 'valid',
            expiresAt: new Date(
              Date.parse(context.expiresBy) - 1,
            ).toISOString(),
          };
        },
      },
    }, 1_000);
    await expect(broker.acquire(executionId, [], 100))
      .rejects.toMatchObject({ code: 'EXECUTION_CREDENTIAL_ERROR' });
    await expect(broker.acquire(
      executionId,
      [{
        name: 'valid',
        audience: 'example.com',
        scopes: ['read', 'read'],
      }],
      100,
    )).rejects.toMatchObject({ code: 'EXECUTION_CREDENTIAL_ERROR' });
    await expect(broker.acquire(
      executionId,
      [{ name: 'missing', audience: 'example.com' }],
      100,
    )).rejects.toMatchObject({ code: 'EXECUTION_CREDENTIAL_ERROR' });
    await expect(broker.acquire(
      executionId,
      [{ name: 'valid', audience: 'example.com' }],
      1_001,
    )).rejects.toMatchObject({ code: 'EXECUTION_CREDENTIAL_ERROR' });
  });

  it('surfaces revocation failures after removing the lease', async () => {
    const revoke = vi.fn(async () => {
      throw new Error('revoke failed');
    });
    const broker = new EphemeralCredentialBroker({
      failing: {
        environmentVariable: 'FAILING_EPHEMERAL_TOKEN',
        async issue(context) {
          return {
            value: 'value',
            expiresAt: new Date(
              Date.parse(context.expiresBy) - 1,
            ).toISOString(),
            revoke,
          };
        },
      },
    });
    const lease = await broker.acquire(
      executionId,
      [{ name: 'failing', audience: 'example.com' }],
      1_000,
    );

    await expect(broker.release(lease.leaseId)).rejects.toMatchObject({
      code: 'EXECUTION_CREDENTIAL_ERROR',
    });
    await expect(broker.release(lease.leaseId)).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
