import { describe, expect, it } from 'vitest';
import { createKernelStorePort } from '../local/index.js';
import type { SessionMessageStore, KernelStorePortOptions } from '../local/index.js';
import type { JsonObject } from '@blade-ai/ai';
import type { AgentStorePort } from '@blade-ai/agent/state';

/** Minimal SessionMessageStore stub */
function makeStore(): SessionMessageStore {
  const messages: Array<{ role: string; content: unknown; metadata: JsonObject }> = [];
  return {
    async addMessage(role, content, metadata) {
      messages.push({ role, content, metadata });
    },
    _messages: messages,
  } as SessionMessageStore & { _messages: typeof messages };
}

describe('createKernelStorePort', () => {
  it('creates a store port', () => {
    const store = makeStore();
    const port = createKernelStorePort({ contextManager: store });
    expect(port).toBeDefined();
    expect(typeof port.appendMessage).toBe('function');
  });

  it('appends a message via the store', async () => {
    const store = makeStore();
    const port = createKernelStorePort({ contextManager: store });
    await port.appendMessage(
      { role: 'user', content: 'hello' },
      { source: 'input', step: 1 },
    );
    expect((store as any)._messages).toHaveLength(1);
    expect((store as any)._messages[0].role).toBe('user');
  });
});
