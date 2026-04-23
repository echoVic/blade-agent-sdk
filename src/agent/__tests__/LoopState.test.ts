import { describe, expect, it } from 'vitest';
import type { Message } from '../../services/ChatServiceInterface.js';
import { SessionId } from '../../types/branded.js';
import { LoopState } from '../state/LoopState.js';
import { ConversationState } from '../state/ConversationState.js';

describe('LoopState', () => {
  it('exposes conversationState for the loop', () => {
    const initialMessages: Message[] = [{ role: 'user', content: 'hello' }];
    const convState = new ConversationState(null, [], { role: 'user', content: 'hello' });

    const loopState = new LoopState({
      conversationState: convState,
      executionContext: {
        sessionId: SessionId('session-1'),
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

    expect(loopState.conversationState).toBe(convState);
    const turnState = loopState.buildTurnState(1);
    expect(turnState.messages).toEqual(convState.toArray());
  });
});
