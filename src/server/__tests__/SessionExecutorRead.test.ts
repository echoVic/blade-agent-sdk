import { describe, expect, it } from 'vitest';
import { CommandId, type InputId, type RequestId, type SessionId } from '../../types/identifiers.js';
import { InMemoryAgentServerStore } from '../AgentServerStore.js';
import type { PendingSessionInput } from '../../session/types.js';
import {
  InProcessSessionExecutor,
  type SessionExecutorCommandContext,
} from '../SessionExecutor.js';

const tenantId = 'tenant-read-boundary';
const principal = {
  tenantId,
  subject: 'reader',
  scopes: ['session:admin'] as const,
};

function context(commandId: string): SessionExecutorCommandContext {
  return { principal, commandId: CommandId(commandId) };
}

function createExecutor(store: InMemoryAgentServerStore): InProcessSessionExecutor {
  return new InProcessSessionExecutor({
    store,
    resolveSessionOptions: () => ({
      provider: { type: 'openai', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      persistSession: false,
    }),
    publish: async () => undefined,
  });
}

describe('InProcessSessionExecutor read', () => {
  it('reports a Session that another process owns as not loaded instead of empty', async () => {
    const store = new InMemoryAgentServerStore();
    const owner = createExecutor(store);
    const created = await owner.create(context('command-create'), {
      metadata: { origin: 'test' },
    } as never);
    const sessionId = created.sessionId;

    // A second executor stands in for a restarted process: it shares the store
    // but has not resumed the Session.
    const restarted = createExecutor(store);
    const result = await restarted.read(context('command-read'), { sessionId });

    expect(result.session.sessionId).toBe(sessionId);
    expect(result.loaded).toBe(false);
    // Empty is the placeholder value; `loaded: false` is what makes it honest.
    expect(result.messages).toEqual([]);
    expect(result.pendingInputs).toEqual([]);
  });

  it('reports a Session this process owns as loaded', async () => {
    const store = new InMemoryAgentServerStore();
    const executor = createExecutor(store);
    const created = await executor.create(context('command-create'), {
      metadata: { origin: 'test' },
    } as never);

    const result = await executor.read(context('command-read'), { sessionId: created.sessionId });

    expect(result.loaded).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it('does not load a Session as a side effect of reading it', async () => {
    const store = new InMemoryAgentServerStore();
    const owner = createExecutor(store);
    const created = await owner.create(context('command-create'), {
      metadata: { origin: 'test' },
    } as never);
    const sessionId = created.sessionId;

    const restarted = createExecutor(store);
    await restarted.read(context('command-read-first'), { sessionId });
    const second = await restarted.read(context('command-read-second'), { sessionId });

    expect(second.loaded).toBe(false);
    expect(second.pendingInputs).toEqual([]);
  });
});

describe('InProcessSessionExecutor read identifiers', () => {
  it('keeps the pending-input projection typed in the read result', async () => {
    const store = new InMemoryAgentServerStore();
    const executor = createExecutor(store);
    const created = await executor.create(context('command-create'), {
      metadata: { origin: 'test' },
    } as never);

    const result = await executor.read(context('command-read'), { sessionId: created.sessionId });

    // Guards the shape the protocol forwards without transformation.
    const pending: PendingSessionInput | undefined = result.pendingInputs[0];
    const targetRequestId: RequestId | undefined = pending?.targetRequestId;
    const inputId: InputId | undefined = pending?.inputId;
    expect(targetRequestId).toBeUndefined();
    expect(inputId).toBeUndefined();
    expect(result.loaded).toBe(true);
  });
});

describe('AgentServer session.read recovery snapshot', () => {
  it('reports the facts a reconnecting client needs without its local state', async () => {
    const { AgentServer } = await import('../AgentServer.js');
    const { InMemoryAgentServerStore } = await import('../AgentServerStore.js');
    const { InProcessSessionExecutor } = await import('../SessionExecutor.js');

    const store = new InMemoryAgentServerStore();
    const executor = new InProcessSessionExecutor({
      store,
      resolveSessionOptions: () => ({
        provider: { type: 'openai', apiKey: 'test-key' },
        model: 'gpt-4o-mini',
        persistSession: false,
      }),
      publish: async () => undefined,
    });
    const server = new AgentServer({
      store,
      sessionExecutor: executor,
      authenticate: () => principal,
    });

    const created = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-create-recovery'),
      type: 'session.create',
      data: { metadata: { origin: 'test' } },
    } as never, principal);
    const sessionId = (created as { data: { session: { sessionId: SessionId } } })
      .data.session.sessionId;

    // Three events: the recovery cursor must be the latest one, not the first.
    for (const data of [
      { type: 'content', delta: 'first', sessionId },
      { type: 'content', delta: 'second', sessionId },
      { type: 'result', subtype: 'success', content: 'done', sessionId },
    ] as const) {
      await store.appendEvent(principal.tenantId, sessionId, {
        protocolVersion: 1,
        sessionId,
        occurredAt: new Date().toISOString(),
        type: 'session.stream',
        data,
      });
    }

    const read = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-read-recovery'),
      type: 'session.read',
      data: { sessionId },
    } as never, principal);

    const recovery = (read as { data: { recovery: Record<string, unknown> } }).data.recovery;
    // Route state, load state, pending inputs and the event cursor must all be
    // server-provided, because a client that lost its storage has nothing else.
    expect(recovery).toMatchObject({ sessionLoaded: true, pendingInputCount: 0 });
    // A client resuming from this cursor must not replay events its local state
    // already contains, so the cursor is the head of the log, not its first page.
    expect(recovery.lastEventSequence).toBe(3);
  });

  it('does not present an unknown pending-input projection as empty', async () => {
    const { AgentServer } = await import('../AgentServer.js');
    const { InMemoryAgentServerStore } = await import('../AgentServerStore.js');

    const store = new InMemoryAgentServerStore();
    const owner = createExecutor(store);
    const created = await owner.create(context('command-create-recovery-unloaded'), {
      metadata: { origin: 'test' },
    } as never);
    // A second executor shares the store but has not resumed the Session, so the
    // projection is unknown rather than empty.
    const restarted = createExecutor(store);
    const server = new AgentServer({
      store,
      sessionExecutor: restarted,
      authenticate: () => principal,
    });

    const read = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-read-recovery-unloaded'),
      type: 'session.read',
      data: { sessionId: created.sessionId },
    } as never, principal);

    const recovery = (read as { data: { recovery: Record<string, unknown> } }).data.recovery;
    expect(recovery.sessionLoaded).toBe(false);
    // An unloaded Session has no projection to count; reporting 0 would claim
    // the unknown is empty.
    expect(recovery.pendingInputCount).toBeUndefined();
  });
});
