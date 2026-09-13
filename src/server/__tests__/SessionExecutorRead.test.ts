import { describe, expect, it } from 'vitest';
import { assertSessionExecutorReadResult } from '../testing/index.js';
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

/**
 * A store that predates `getEventStreamRange`, as a host store may. A proxy is
 * used because the method lives on the prototype: deleting it from the instance
 * would leave the capable implementation in place.
 */
function createStoreWithoutEventStreamRange(): InMemoryAgentServerStore {
  const store = new InMemoryAgentServerStore();
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getEventStreamRange') {
        return undefined;
      }
      return Reflect.get(target, property, receiver);
    },
  }) as InMemoryAgentServerStore;
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

    assertSessionExecutorReadResult(result, 'InProcessSessionExecutor.read');
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
    // The cursor is the head of the log at the moment the snapshot was taken —
    // not its first page, and not a later head either.
    expect(recovery.lastEventSequence).toBe(3);
  });

  it('replays streaming output the message projection has not recorded yet', async () => {
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
      commandId: CommandId('command-create-streaming'),
      type: 'session.create',
      data: { metadata: { origin: 'test' } },
    } as never, principal);
    const sessionId = (created as { data: { session: { sessionId: SessionId } } })
      .data.session.sessionId;

    // One finished request, then content that is still streaming: the assistant
    // message is written only when the turn completes, so `messages` cannot carry
    // this output yet and the cursor must not step over it.
    for (const data of [
      { type: 'content', delta: 'finished output', sessionId },
      { type: 'result', subtype: 'success', content: 'done', sessionId },
      { type: 'content', delta: 'still streaming', sessionId },
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
      commandId: CommandId('command-read-streaming'),
      type: 'session.read',
      data: { sessionId },
    } as never, principal);

    const data = (read as { data: { messages: unknown[]; recovery: { lastEventSequence: number } } })
      .data;
    // The projection is behind the log, which is exactly why the cursor stops at
    // the last completed request instead of at the head.
    expect(data.messages).toEqual([]);
    expect(data.recovery.lastEventSequence).toBe(2);

    const replay = await store.readEvents(principal.tenantId, sessionId, {
      after: data.recovery.lastEventSequence,
    });
    expect(replay.events.map((event) => (event.data as { delta?: string }).delta))
      .toEqual(['still streaming']);
  });

  it('replays the whole retained log when no request has completed yet', async () => {
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
      commandId: CommandId('command-create-first-turn'),
      type: 'session.create',
      data: { metadata: { origin: 'test' } },
    } as never, principal);
    const sessionId = (created as { data: { session: { sessionId: SessionId } } })
      .data.session.sessionId;
    for (const data of [
      { type: 'content', delta: 'only output so far', sessionId },
      { type: 'content', delta: 'more output', sessionId },
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
      commandId: CommandId('command-read-first-turn'),
      type: 'session.read',
      data: { sessionId },
    } as never, principal);

    const recovery = (read as { data: { recovery: { lastEventSequence: number } } }).data.recovery;
    expect(recovery.lastEventSequence).toBe(0);
    const replay = await store.readEvents(principal.tenantId, sessionId, {
      after: recovery.lastEventSequence,
    });
    expect(replay.events).toHaveLength(2);
  });

  it('never returns a cursor ahead of the snapshot it accompanies', async () => {
    const { AgentServer } = await import('../AgentServer.js');
    const { InMemoryAgentServerStore } = await import('../AgentServerStore.js');
    const { InProcessSessionExecutor } = await import('../SessionExecutor.js');

    class RacingStore extends InMemoryAgentServerStore {
      getEventStreamRange(...args: Parameters<InMemoryAgentServerStore['getEventStreamRange']>) {
        // The stream moves on between resolving the cursor and loading the state.
        return super.getEventStreamRange(...args);
      }
    }
    const store = new RacingStore();
    const executor = new InProcessSessionExecutor({
      store: store as never,
      resolveSessionOptions: () => ({
        provider: { type: 'openai', apiKey: 'test-key' },
        model: 'gpt-4o-mini',
        persistSession: false,
      }),
      publish: async () => undefined,
    });
    const racingExecutor = new Proxy(executor, {
      get(target, property, receiver) {
        if (property === 'read') {
          return async (...args: Parameters<InProcessSessionExecutor['read']>) => {
            await store.appendEvent(principal.tenantId, args[1].sessionId, {
              protocolVersion: 1,
              sessionId: args[1].sessionId,
              occurredAt: new Date().toISOString(),
              type: 'session.stream',
              data: { type: 'content', delta: 'appended during read', sessionId: args[1].sessionId },
            });
            return await target.read(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const server = new AgentServer({
      store: store as never,
      sessionExecutor: racingExecutor as never,
      authenticate: () => principal,
    });
    const created = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-create-race'),
      type: 'session.create',
      data: { metadata: { origin: 'test' } },
    } as never, principal);
    const sessionId = (created as { data: { session: { sessionId: SessionId } } })
      .data.session.sessionId;
    for (const data of [
      { type: 'content', delta: 'finished', sessionId },
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
      commandId: CommandId('command-read-race'),
      type: 'session.read',
      data: { sessionId },
    } as never, principal);

    const recovery = (read as { data: { recovery: { lastEventSequence: number } } }).data.recovery;
    // Events appended while the snapshot loaded are replayed: the cursor stops at
    // the completed request, never at a head read after the snapshot.
    expect(recovery.lastEventSequence).toBe(2);
    const replay = await store.readEvents(principal.tenantId, sessionId, {
      after: recovery.lastEventSequence,
    });
    expect(replay.events.map((event) => (event.data as { delta?: string }).delta))
      .toEqual(['appended during read']);
  });

  it('replays from the retained window when a long log holds no completed request', async () => {
    const { AgentServer } = await import('../AgentServer.js');
    const { InMemoryAgentServerStore } = await import('../AgentServerStore.js');
    const { InProcessSessionExecutor } = await import('../SessionExecutor.js');

    // Retention keeps the log short; the cursor still has to stay inside it and
    // still has to replay the events that remain.
    const store = new InMemoryAgentServerStore({ maxEventsPerSession: 3 });
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
      commandId: CommandId('command-create-retained'),
      type: 'session.create',
      data: { metadata: { origin: 'test' } },
    } as never, principal);
    const sessionId = (created as { data: { session: { sessionId: SessionId } } })
      .data.session.sessionId;
    for (const delta of ['one', 'two', 'three', 'four', 'five']) {
      await store.appendEvent(principal.tenantId, sessionId, {
        protocolVersion: 1,
        sessionId,
        occurredAt: new Date().toISOString(),
        type: 'session.stream',
        data: { type: 'content', delta, sessionId },
      });
    }

    const read = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-read-retained'),
      type: 'session.read',
      data: { sessionId },
    } as never, principal);

    const recovery = (read as { data: { recovery: { lastEventSequence: number } } }).data.recovery;
    const range = await store.getEventStreamRange(principal.tenantId, sessionId);
    // Never below what the log still retains, never above the head.
    expect(recovery.lastEventSequence).toBeGreaterThanOrEqual((range?.firstSequence ?? 1) - 1);
    expect(recovery.lastEventSequence).toBeLessThanOrEqual(range?.headSequence ?? 0);
    const replay = await store.readEvents(principal.tenantId, sessionId, {
      after: recovery.lastEventSequence,
    });
    expect(replay.events.length).toBeGreaterThan(0);
    expect(replay.events.at(-1)?.sequence).toBe(range?.headSequence);
  });

  it('replays a long in-flight request from its start instead of skipping the head of it', async () => {
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
      commandId: CommandId('command-create-long-stream'),
      type: 'session.create',
      data: { metadata: { origin: 'test' } },
    } as never, principal);
    const sessionId = (created as { data: { session: { sessionId: SessionId } } })
      .data.session.sessionId;
    // One request, 600 events, still streaming: more than one scan window, and no
    // completed request anywhere in the log.
    for (let index = 1; index <= 600; index += 1) {
      await store.appendEvent(principal.tenantId, sessionId, {
        protocolVersion: 1,
        sessionId,
        occurredAt: new Date().toISOString(),
        type: 'session.stream',
        data: { type: 'content', delta: `delta-${index}`, sessionId },
      });
    }

    const read = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-read-long-stream'),
      type: 'session.read',
      data: { sessionId },
    } as never, principal);

    const data = (read as { data: { messages: unknown[]; recovery: { lastEventSequence: number } } })
      .data;
    expect(data.messages).toEqual([]);
    // Nothing in the snapshot covers this output, so the cursor must replay all of
    // it - never the part that happened to fall outside the scan window.
    expect(data.recovery.lastEventSequence).toBe(0);
    const replay = await store.readEvents(principal.tenantId, sessionId, {
      after: data.recovery.lastEventSequence,
      limit: 1000,
    });
    expect(replay.events).toHaveLength(600);
    expect((replay.events[0]?.data as { delta?: string }).delta).toBe('delta-1');
  });

  it('finds a completed request that lies beyond one scan window', async () => {
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
      commandId: CommandId('command-create-deep-boundary'),
      type: 'session.create',
      data: { metadata: { origin: 'test' } },
    } as never, principal);
    const sessionId = (created as { data: { session: { sessionId: SessionId } } })
      .data.session.sessionId;
    // The completed request is more than one window behind the head.
    await store.appendEvent(principal.tenantId, sessionId, {
      protocolVersion: 1,
      sessionId,
      occurredAt: new Date().toISOString(),
      type: 'session.stream',
      data: { type: 'result', subtype: 'success', content: 'first turn', sessionId },
    });
    for (let index = 1; index <= 600; index += 1) {
      await store.appendEvent(principal.tenantId, sessionId, {
        protocolVersion: 1,
        sessionId,
        occurredAt: new Date().toISOString(),
        type: 'session.stream',
        data: { type: 'content', delta: `turn-2-${index}`, sessionId },
      });
    }

    const read = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-read-deep-boundary'),
      type: 'session.read',
      data: { sessionId },
    } as never, principal);

    const recovery = (read as { data: { recovery: { lastEventSequence: number } } }).data.recovery;
    // The scan widens until it finds the boundary, so the client replays only the
    // in-flight turn instead of the whole retained log.
    expect(recovery.lastEventSequence).toBe(1);
  });

  it('does not hand a store without the retained-range capability an unsafe cursor', async () => {
    const { AgentServer } = await import('../AgentServer.js');
    const { InProcessSessionExecutor } = await import('../SessionExecutor.js');

    // Stands in for a host store that predates the retained-range capability.
    const store = createStoreWithoutEventStreamRange();
    const executor = new InProcessSessionExecutor({
      store: store as never,
      resolveSessionOptions: () => ({
        provider: { type: 'openai', apiKey: 'test-key' },
        model: 'gpt-4o-mini',
        persistSession: false,
      }),
      publish: async () => undefined,
    });
    const server = new AgentServer({
      store: store as never,
      sessionExecutor: executor,
      authenticate: () => principal,
    });
    const created = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-create-no-range'),
      type: 'session.create',
      data: { metadata: { origin: 'test' } },
    } as never, principal);
    const sessionId = (created as { data: { session: { sessionId: SessionId } } })
      .data.session.sessionId;
    for (const delta of ['kept one', 'kept two']) {
      await store.appendEvent(principal.tenantId, sessionId, {
        protocolVersion: 1,
        sessionId,
        occurredAt: new Date().toISOString(),
        type: 'session.stream',
        data: { type: 'content', delta, sessionId },
      });
    }

    const read = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-read-no-range'),
      type: 'session.read',
      data: { sessionId },
    } as never, principal);

    const data = (read as { data: { messages: unknown[]; recovery: Record<string, unknown> } }).data;
    expect(data.messages).toEqual([]);
    // The head would be 2, which would skip both content events; without the
    // capability the store gets the conservative start instead.
    expect(data.recovery.lastEventSequence).toBe(0);
    const replay = await store.readEvents(principal.tenantId, sessionId, { limit: 100 });
    expect(replay.events).toHaveLength(2);
  });

  it('reports an incomplete recovery when no safe cursor can be established', async () => {
    const { AgentServer } = await import('../AgentServer.js');
    const { InProcessSessionExecutor } = await import('../SessionExecutor.js');

    // A trimmed log rejects a cursor it no longer retains, and the store has no
    // retained-range capability to fall back on.
    const store = createStoreWithoutEventStreamRange();
    store.readEvents = async () => {
      throw new RangeError('Event cursor is stale');
    };
    const executor = new InProcessSessionExecutor({
      store: store as never,
      resolveSessionOptions: () => ({
        provider: { type: 'openai', apiKey: 'test-key' },
        model: 'gpt-4o-mini',
        persistSession: false,
      }),
      publish: async () => undefined,
    });
    const server = new AgentServer({
      store: store as never,
      sessionExecutor: executor,
      authenticate: () => principal,
    });
    const created = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-create-trimmed'),
      type: 'session.create',
      data: { metadata: { origin: 'test' } },
    } as never, principal);
    const sessionId = (created as { data: { session: { sessionId: SessionId } } })
      .data.session.sessionId;

    const read = await server.execute({
      protocolVersion: 1,
      commandId: CommandId('command-read-trimmed'),
      type: 'session.read',
      data: { sessionId },
    } as never, principal);

    const recovery = (read as { data: { recovery: Record<string, unknown> } }).data.recovery;
    expect(recovery.recoveryIncomplete).toBe(true);
    expect(recovery).not.toHaveProperty('lastEventSequence');
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
