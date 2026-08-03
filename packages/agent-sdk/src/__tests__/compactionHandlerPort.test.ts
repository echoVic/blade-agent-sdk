import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@blade-ai/ai/chat';
import { CompactionHandler } from '../local/compactionHandler.js';
import { ConversationState } from '@blade-ai/agent/state';
import { SessionId } from '../local/branded.js';
import { NOOP_LOGGER } from '../local/Logger.js';

/**
 * Slice #344 — CompactionHandler ported into @blade-ai/agent-sdk/local.
 *
 * The in-loop compaction check (microcompact → LLM compaction → emergency
 * truncation → soft-compact fallback) was an agent-core leaf; root
 * src/agent/CompactionHandler.ts is now a re-export shim.
 * CompactionRuntimeContext is owned by local/compactionTypes.js.
 */

const chatServiceStub = {
  getConfig: () => ({
    model: 'glm-5.2',
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),
} as never;

function createConversation(messages: Message[]): ConversationState {
  const [first, ...rest] = messages;
  const state = new ConversationState(null, rest, first ?? { role: 'user', content: '' });
  state.append(...messages);
  return state;
}

/** Drains an async generator and returns its final (return) value. */
async function runToEnd<T>(
  generator: AsyncGenerator<unknown, T>,
): Promise<T> {
  const iterator = generator[Symbol.asyncIterator]();
  let result: IteratorResult<unknown, T>;
  do {
    result = await iterator.next();
  } while (!result.done);
  return result.value;
}

describe('CompactionHandler (package local)', () => {
  it('skips compaction when there is no usage data', async () => {
    const handler = new CompactionHandler(() => chatServiceStub, () => undefined, NOOP_LOGGER);
    const convState = createConversation([{ role: 'user', content: 'hi' }]);

    const compacted = await runToEnd(handler.checkAndCompactInLoop(
      convState,
      { sessionId: SessionId('ch-session') },
      0,
    ));
    expect(compacted).toBe(false);
  });

  it('skips compaction below the soft threshold', async () => {
    const handler = new CompactionHandler(() => chatServiceStub, () => undefined, NOOP_LOGGER);
    const convState = createConversation([{ role: 'user', content: 'short message' }]);

    const compacted = await runToEnd(handler.checkAndCompactInLoop(
      convState,
      { sessionId: SessionId('ch-session') },
      0,
      100,
    ));
    expect(compacted).toBe(false);
  });

  it('exposes the compaction runtime context type contract', () => {
    // CompactionRuntimeContext (from compactionTypes.js) is consumed by the
    // loop; the handler's signature accepts it.
    const handler = new CompactionHandler(() => chatServiceStub, () => undefined, NOOP_LOGGER);
    expect(handler).toBeInstanceOf(CompactionHandler);
  });
});
