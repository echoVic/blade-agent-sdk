import { describe, expect, it } from 'vitest';
import { CommandId, type InputId, type RequestId } from '../../types/identifiers.js';
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
