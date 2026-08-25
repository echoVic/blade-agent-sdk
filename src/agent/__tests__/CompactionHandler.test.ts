import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompactionOptions,
  CompactionResult,
} from '../../context/CompactionService.js';
import { ProviderRegistryError } from '../../errors/ProviderRegistryError.js';
import { HookProcessContainmentError } from '../../hooks/WindowsProcessJob.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';
import { DurableExecutionLeaseError } from '../../session/events/DurableExecutionLeaseStore.js';
import { SessionId } from '../../types/branded.js';
import { ConversationState } from '../state/ConversationState.js';

const mockCompact = vi.fn(async (
  _messages: Message[],
  _options: CompactionOptions,
): Promise<CompactionResult> => ({
  success: true,
  summary: 'summary',
  preTokens: 700,
  postTokens: 120,
  filesIncluded: [],
  compactedMessages: [{ role: 'user' as const, content: 'summary' }],
  boundaryMessage: { role: 'system' as const, content: 'boundary' },
  summaryMessage: { role: 'user' as const, content: 'summary' },
}));

vi.mock('../../context/CompactionService.js', async () => {
  const actual = await vi.importActual<typeof import('../../context/CompactionService.js')>(
    '../../context/CompactionService.js',
  );

  return {
    ...actual,
    CompactionService: {
      ...actual.CompactionService,
      compact: mockCompact,
    },
  };
});

const { CompactionHandler } = await import('../CompactionHandler.js');

describe('CompactionHandler', () => {
  beforeEach(() => {
    mockCompact.mockClear();
  });

  it('uses microcompact before LLM compaction and skips the LLM when enough context is recovered', async () => {
    const handler = new CompactionHandler(
      () => ({
        getConfig: () => ({
          model: 'gpt-4o-mini',
          provider: 'openai-compatible' as const,
          maxContextTokens: 1000,
          maxOutputTokens: 200,
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
        }),
      }) as never,
      () => undefined,
    );

    const contextMessages: Message[] = [
      { role: 'user', content: 'Investigate the build failure' },
      { role: 'tool', tool_call_id: 'call-1', content: 'a'.repeat(4000) },
      { role: 'tool', tool_call_id: 'call-2', content: 'b'.repeat(3800) },
    ];
    const convState = new ConversationState(null, contextMessages.slice(0, -1), contextMessages[contextMessages.length - 1]);

    const stream = handler.checkAndCompactInLoop(convState, { sessionId: SessionId('session-1') }, 2, 700);
    let didCompact = false;
    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        didCompact = value;
        break;
      }
    }

    expect(didCompact).toBe(true);
    expect(mockCompact).not.toHaveBeenCalled();
    // After microcompact, the second context message (index 1 in contextMessages, index 1 in convState since no root prompt)
    const updatedCtx = convState.getContextMessages();
    expect(updatedCtx[1]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining('[Microcompact]'),
      }),
    );
  });

  it('checks execution ownership before compaction provider I/O', async () => {
    const handler = new CompactionHandler(
      () => ({
        getConfig: () => ({
          model: 'gpt-4o-mini',
          provider: 'openai-compatible' as const,
          maxContextTokens: 1000,
          maxOutputTokens: 200,
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
        }),
      }) as never,
      () => undefined,
    );
    const convState = new ConversationState(
      null,
      [{ role: 'user', content: 'context that requires compaction' }],
      { role: 'assistant', content: 'continue' },
    );
    const assertExecutionLease = vi.fn(async () => {
      throw new Error('execution lease lost');
    });
    const stream = handler.checkAndCompactInLoop(
      convState,
      {
        sessionId: SessionId('fenced-compaction-session'),
        assertExecutionLease,
      },
      2,
      700,
    );

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'compacting', isCompacting: true },
      done: false,
    });
    await expect(stream.next()).rejects.toThrow('execution lease lost');
    expect(assertExecutionLease).toHaveBeenCalledOnce();
    expect(mockCompact).not.toHaveBeenCalled();
  });

  it('discards a compaction result when execution ownership changes during provider I/O', async () => {
    const handler = new CompactionHandler(
      () => ({
        getConfig: () => ({
          model: 'gpt-4o-mini',
          provider: 'openai-compatible' as const,
          maxContextTokens: 1000,
          maxOutputTokens: 200,
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
        }),
      }) as never,
      () => undefined,
    );
    const originalMessages = [
      { role: 'user', content: 'context that must remain unchanged' },
      { role: 'assistant', content: 'continue' },
    ] satisfies Message[];
    const currentMessage = originalMessages.at(-1);
    if (!currentMessage) {
      throw new Error('Expected a current compaction message');
    }
    const convState = new ConversationState(
      null,
      originalMessages.slice(0, -1),
      currentMessage,
    );
    const leaseLost = new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      'execution ownership changed',
    );
    const assertExecutionLease = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(leaseLost);
    const stream = handler.checkAndCompactInLoop(
      convState,
      {
        sessionId: SessionId('mid-compaction-loss-session'),
        assertExecutionLease,
      },
      2,
      700,
    );

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'compacting', isCompacting: true },
      done: false,
    });
    await expect(stream.next()).rejects.toBe(leaseLost);
    expect(mockCompact).toHaveBeenCalledOnce();
    expect(convState.getContextMessages()).toEqual(originalMessages);
  });

  it('propagates the active provider registry to automatic and reactive compaction', async () => {
    const providerRegistry = new ProviderRegistry();
    const handler = new CompactionHandler(
      () => ({
        getConfig: () => ({
          model: 'gpt-4o-mini',
          provider: 'openai-compatible' as const,
          maxContextTokens: 1000,
          maxOutputTokens: 200,
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
        }),
      }) as never,
      () => undefined,
      undefined,
      () => providerRegistry,
    );
    const automaticState = new ConversationState(
      null,
      [{ role: 'user', content: 'context that requires compaction' }],
      { role: 'assistant', content: 'continue' },
    );
    const automaticStream = handler.checkAndCompactInLoop(
      automaticState,
      { sessionId: SessionId('provider-registry-auto-session') },
      2,
      700,
    );

    await automaticStream.next();
    await automaticStream.next();

    const reactiveState = new ConversationState(
      null,
      [{ role: 'user', content: 'context that requires compaction' }],
      { role: 'assistant', content: 'continue' },
    );
    const reactiveStream = handler.reactiveCompact(
      reactiveState,
      { sessionId: SessionId('provider-registry-reactive-session') },
    );

    await reactiveStream.next();
    await reactiveStream.next();

    expect(mockCompact).toHaveBeenCalledTimes(2);
    for (const [, options] of mockCompact.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ providerRegistry }));
    }
  });

  it('fails closed when automatic or reactive compaction cannot resolve an adapter', async () => {
    const registryError = new ProviderRegistryError(
      'PROVIDER_ADAPTER_NOT_FOUND',
      'No provider adapter is registered for "custom-api"',
      { providerType: 'custom-api' },
    );
    const handler = new CompactionHandler(
      () => ({
        getConfig: () => ({
          model: 'custom-model',
          provider: 'custom-api',
          maxContextTokens: 1000,
          maxOutputTokens: 200,
        }),
      }) as never,
      () => undefined,
    );
    const createState = () => new ConversationState(
      null,
      [{ role: 'user', content: 'context that requires compaction' }],
      { role: 'assistant', content: 'continue' },
    );

    mockCompact.mockRejectedValueOnce(registryError);
    const automaticStream = handler.checkAndCompactInLoop(
      createState(),
      { sessionId: SessionId('missing-adapter-auto-session') },
      2,
      700,
    );
    await automaticStream.next();
    await expect(automaticStream.next()).rejects.toBe(registryError);

    mockCompact.mockRejectedValueOnce(registryError);
    const reactiveStream = handler.reactiveCompact(
      createState(),
      { sessionId: SessionId('missing-adapter-reactive-session') },
    );
    await reactiveStream.next();
    await expect(reactiveStream.next()).rejects.toBe(registryError);
  });

  it('propagates process-containment failures from automatic compaction hooks', async () => {
    const containmentError = new HookProcessContainmentError(
      'Windows Job Object support is unavailable',
    );
    mockCompact.mockRejectedValueOnce(containmentError);
    const handler = new CompactionHandler(
      () => ({
        getConfig: () => ({
          model: 'gpt-4o-mini',
          provider: 'openai-compatible' as const,
          maxContextTokens: 1000,
          maxOutputTokens: 200,
        }),
      }) as never,
      () => undefined,
    );
    const convState = new ConversationState(
      null,
      [{ role: 'user', content: 'context that requires compaction' }],
      { role: 'assistant', content: 'continue' },
    );
    const stream = handler.checkAndCompactInLoop(
      convState,
      { sessionId: SessionId('containment-compaction-session') },
      2,
      700,
    );

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'compacting', isCompacting: true },
      done: false,
    });
    await expect(stream.next()).rejects.toBe(containmentError);
  });

  it('propagates process-containment failures from reactive compaction hooks', async () => {
    const containmentError = new HookProcessContainmentError(
      'Windows Job Object support is unavailable',
    );
    mockCompact.mockRejectedValueOnce(containmentError);
    const handler = new CompactionHandler(
      () => ({
        getConfig: () => ({
          model: 'gpt-4o-mini',
          provider: 'openai-compatible' as const,
          maxContextTokens: 1000,
          maxOutputTokens: 200,
        }),
      }) as never,
      () => undefined,
    );
    const convState = new ConversationState(
      null,
      [{ role: 'user', content: 'context that requires compaction' }],
      { role: 'assistant', content: 'continue' },
    );
    const stream = handler.reactiveCompact(
      convState,
      { sessionId: SessionId('containment-reactive-compaction-session') },
    );

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'compacting', isCompacting: true },
      done: false,
    });
    await expect(stream.next()).rejects.toBe(containmentError);
  });

  it('falls back from the original messages when reactive compaction fails after microcompact', async () => {
    mockCompact.mockRejectedValueOnce(new Error('compaction failed'));

    const handler = new CompactionHandler(
      () => ({
        getConfig: () => ({
          model: 'gpt-4o-mini',
          provider: 'openai-compatible' as const,
          maxContextTokens: 1000,
          maxOutputTokens: 200,
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
        }),
      }) as never,
      () => undefined,
    );

    const originalMessages = [
      { role: 'user', content: 'Investigate the build failure' },
      { role: 'tool', tool_call_id: 'call-1', content: 'a'.repeat(4000) },
      { role: 'tool', tool_call_id: 'call-2', content: 'b'.repeat(3800) },
    ] satisfies Message[];
    const convState = new ConversationState(null, originalMessages.slice(0, -1), originalMessages[originalMessages.length - 1]);
    const controller = new AbortController();

    const stream = handler.reactiveCompact(convState, {
      sessionId: SessionId('session-1'),
      signal: controller.signal,
    });
    let didCompact = false;
    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        didCompact = value;
        break;
      }
    }

    expect(didCompact).toBe(true);
    // After fallback (error path), convState should have emergency-truncated messages from originals
    const updatedCtx = convState.getContextMessages();
    // The fallback uses originalMessages.slice(-40), so content should still be original (not microcompacted)
    expect(updatedCtx[1]).toEqual(originalMessages[1]);
    expect(updatedCtx[1]?.content).not.toContain('[Microcompact]');
    expect(mockCompact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
