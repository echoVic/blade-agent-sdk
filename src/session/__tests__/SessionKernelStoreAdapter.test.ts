import type { ModelMessage } from '@blade-ai/ai';
import type { AgentStoreAppendContext } from '@blade-ai/agent/state';
import { describe, expect, it, vi } from 'vitest';
import { createKernelStorePort } from '../SessionKernelStoreAdapter.js';

describe('SessionKernelStoreAdapter', () => {
  it('maps kernel user and assistant messages into the session context store', async () => {
    const addMessage = vi.fn(async () => {});
    const store = createKernelStorePort({
      contextManager: { addMessage } as never,
    });

    await store.appendMessage(
      { role: 'user', content: 'Remember this' } satisfies ModelMessage,
      { turnId: 'turn_store', source: 'input', step: 0 } satisfies AgentStoreAppendContext,
    );
    await store.appendMessage(
      {
        role: 'assistant',
        content: 'Stored answer',
        reasoningContent: 'brief thought',
        toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
      } satisfies ModelMessage,
      { turnId: 'turn_store', source: 'model', step: 1 } satisfies AgentStoreAppendContext,
    );

    expect(addMessage).toHaveBeenNthCalledWith(
      1,
      'user',
      'Remember this',
      {
        kernel: { turnId: 'turn_store', source: 'input', step: 0 },
      },
    );
    expect(addMessage).toHaveBeenNthCalledWith(
      2,
      'assistant',
      'Stored answer',
      {
        kernel: { turnId: 'turn_store', source: 'model', step: 1 },
        reasoningContent: 'brief thought',
        toolCalls: [
          {
            id: 'call_search',
            type: 'function',
            function: {
              name: 'Search',
              arguments: '{"q":"blade"}',
            },
          },
        ],
      },
    );
  });

  it('maps kernel tool messages into the session context store', async () => {
    const addMessage = vi.fn(async () => {});
    const store = createKernelStorePort({
      contextManager: { addMessage } as never,
    });

    await store.appendMessage(
      {
        role: 'tool',
        content: '{"ok":true}',
        name: 'Search',
        toolCallId: 'call_search',
      } satisfies ModelMessage,
      { turnId: 'turn_store', source: 'tool', step: 1 } satisfies AgentStoreAppendContext,
    );

    expect(addMessage).toHaveBeenCalledWith(
      'tool',
      '{"ok":true}',
      {
        kernel: { turnId: 'turn_store', source: 'tool', step: 1 },
        name: 'Search',
        tool_call_id: 'call_search',
      },
    );
  });
});
