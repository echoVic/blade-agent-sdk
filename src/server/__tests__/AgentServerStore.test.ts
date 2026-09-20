import { describe, expect, it } from 'vitest';
import { SessionId } from '../../types/identifiers.js';
import { InMemoryAgentServerStore } from '../AgentServerStore.js';
import { describeAgentServerStoreContract } from './helpers/agentServerStoreContract.js';

describe('InMemoryAgentServerStore contract', () => {
  describeAgentServerStoreContract(async (options = {}) => new InMemoryAgentServerStore(options));
});

describe('InMemoryAgentServerStore', () => {
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
});

describe('InMemoryAgentServerStore idempotent appends', () => {
  const tenantId = 'tenant-idempotent';
  const sessionId = SessionId('session-idempotent');
  const event = {
    protocolVersion: 1,
    sessionId,
    occurredAt: new Date().toISOString(),
    type: 'session.stream',
    data: { type: 'result', subtype: 'success', content: 'done', sessionId },
  } as const;

  it('returns the stored event for a repeated key instead of appending again', async () => {
    const store = new InMemoryAgentServerStore();
    const first = await store.appendEvent(tenantId, sessionId, event, {
      idempotencyKey: 'terminal-1',
    });
    const repeat = await store.appendEvent(tenantId, sessionId, event, {
      idempotencyKey: 'terminal-1',
    });

    expect(repeat.eventId).toBe(first.eventId);
    expect(repeat.sequence).toBe(first.sequence);
    expect((await store.readEvents(tenantId, sessionId)).events).toHaveLength(1);
  });

  it('isolates the idempotency record from the caller object', async () => {
    const store = new InMemoryAgentServerStore();
    const draft = {
      protocolVersion: 1,
      sessionId,
      occurredAt: new Date().toISOString(),
      type: 'session.stream',
      data: { type: 'result', subtype: 'success', content: 'original', sessionId },
    } as const;
    const first = await store.appendEvent(tenantId, sessionId, draft, {
      idempotencyKey: 'terminal-3',
    });

    // The caller mutates the object it passed in after the append.
    (draft.data as { content: string }).content = 'mutated';

    const logged = (await store.readEvents(tenantId, sessionId)).events[0];
    const recorded = await store.getEventByIdempotencyKey(tenantId, sessionId, 'terminal-3');
    expect((logged?.data as { content?: string }).content).toBe('original');
    expect((recorded?.data as { content?: string }).content).toBe('original');
    expect(recorded?.eventId).toBe(first.eventId);
  });

  it('keeps appending without a key', async () => {
    const store = new InMemoryAgentServerStore();
    await store.appendEvent(tenantId, sessionId, event);
    await store.appendEvent(tenantId, sessionId, event);
    expect((await store.readEvents(tenantId, sessionId)).events).toHaveLength(2);
  });
});
