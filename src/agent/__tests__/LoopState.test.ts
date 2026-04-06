import { describe, expect, it } from 'vitest';
import type { Message } from '../../services/ChatServiceInterface.js';
import { LoopState } from '../state/LoopState.js';

describe('LoopState', () => {
  it('exposes messages as a mutable buffer for the loop', () => {
    const initialMessages: Message[] = [{ role: 'user', content: 'hello' }];
    const replacementMessages: Message[] = [{ role: 'assistant', content: 'updated' }];

    const loopState = new LoopState({
      messages: initialMessages,
      executionContext: {
        sessionId: 'session-1',
        userId: 'user-1',
      },
      resolveTools: () => [],
      resolveChatService: () =>
        ({
          chat: async () => ({
            content: 'ok',
            toolCalls: [],
          }),
          getConfig: () => ({
            model: 'test-model',
            maxContextTokens: 128000,
          }),
        }) as never,
      resolveMaxContextTokens: () => 128000,
    });

    loopState.messages = replacementMessages;

    expect(loopState.messages).toBe(replacementMessages);
    expect(loopState.buildTurnState(1).messages).toBe(replacementMessages);
  });
});
