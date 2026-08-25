import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '../../protocol/index.js';
import { CommandId, SessionId } from '../../types/identifiers.js';
import { InMemoryAgentServerStore } from '../AgentServerStore.js';

describe('InMemoryAgentServerStore', () => {
  it('claims, fences, and replays idempotent command results', async () => {
    let now = 1000;
    const store = new InMemoryAgentServerStore({ now: () => now });
    const claim = await store.claimCommand(
      'tenant-a',
      CommandId('command-1'),
      'fingerprint-1',
      100,
    );
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') return;

    await expect(
      store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-1', 100),
    ).resolves.toMatchObject({ status: 'in_progress' });
    now += 101;
    const replacement = await store.claimCommand(
      'tenant-a',
      CommandId('command-1'),
      'fingerprint-1',
      100,
    );
    expect(replacement.status).toBe('claimed');
    if (replacement.status !== 'claimed') return;

    await expect(
      store.completeCommand('tenant-a', CommandId('command-1'), claim.leaseId, {
        protocolVersion: 1,
        commandId: CommandId('command-1'),
        ok: true,
        data: { stale: true },
      }),
    ).rejects.toThrow(/no longer active/i);

    const result = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commandId: CommandId('command-1'),
      ok: true as const,
      data: { sessionId: 'session-1' },
    };
    await store.completeCommand('tenant-a', CommandId('command-1'), replacement.leaseId, result);
    await expect(
      store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-1', 100),
    ).resolves.toEqual({ status: 'completed', result });
    await expect(
      store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-2', 100),
    ).resolves.toEqual({ status: 'conflict' });
  });

  it('keeps sealed commands fail-closed after their initial lease expires', async () => {
    let now = 1000;
    const store = new InMemoryAgentServerStore({ now: () => now });
    const claim = await store.claimCommand(
      'tenant-a',
      CommandId('command-1'),
      'fingerprint-1',
      100,
    );
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') return;
    await store.sealCommand('tenant-a', CommandId('command-1'), claim.leaseId);
    await store.releaseCommand('tenant-a', CommandId('command-1'), claim.leaseId);

    now += 10_000;
    await expect(
      store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-1', 100),
    ).resolves.toEqual({ status: 'in_progress', retryAfterMs: 1000 });
  });

  it('isolates session ownership by tenant', async () => {
    const store = new InMemoryAgentServerStore();
    const sessionId = SessionId('session-1');
    await store.putSession({
      tenantId: 'tenant-a',
      createdBy: 'user-a',
      sessionId,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(store.getSession('tenant-a', sessionId)).resolves.toMatchObject({
      sessionId,
    });
    await expect(store.getSession('tenant-b', sessionId)).resolves.toBeNull();
  });

  it('sequences retained events and rejects stale cursors', async () => {
    const store = new InMemoryAgentServerStore({ maxEventsPerSession: 2 });
    const sessionId = SessionId('session-1');
    for (const delta of ['one', 'two', 'three']) {
      await store.appendEvent('tenant-a', sessionId, {
        protocolVersion: 1,
        sessionId,
        occurredAt: new Date().toISOString(),
        type: 'session.stream',
        data: {
          type: 'content',
          delta,
          sessionId,
        },
      });
    }

    await expect(store.readEvents('tenant-a', sessionId, { after: 1 })).resolves.toMatchObject({
      events: [
        { sequence: 2, data: { delta: 'two' } },
        { sequence: 3, data: { delta: 'three' } },
      ],
    });
    await expect(store.readEvents('tenant-a', sessionId, { after: 0 })).rejects.toThrow(/stale/i);
  });

  it('rejects an ahead cursor before a Session has emitted events', async () => {
    const store = new InMemoryAgentServerStore();
    await expect(
      store.readEvents('tenant-a', SessionId('session-1'), { after: 1 }),
    ).rejects.toThrow(/ahead/i);
  });

  it('rejects events addressed to a different Session log', async () => {
    const store = new InMemoryAgentServerStore();
    await expect(
      store.appendEvent('tenant-a', SessionId('session-1'), {
        protocolVersion: 1,
        sessionId: SessionId('session-2'),
        occurredAt: new Date().toISOString(),
        type: 'session.closed',
        data: {},
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it('wakes event subscribers without losing the append race', async () => {
    const store = new InMemoryAgentServerStore();
    const sessionId = SessionId('session-1');
    const waiting = store.waitForEvents('tenant-a', sessionId, 0);
    await store.appendEvent('tenant-a', sessionId, {
      protocolVersion: 1,
      sessionId,
      occurredAt: new Date().toISOString(),
      type: 'session.closed',
      data: {},
    });
    await expect(waiting).resolves.toBeUndefined();
  });
});
