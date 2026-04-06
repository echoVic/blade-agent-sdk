import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../services/ChatServiceInterface.js';

const mockCompact = vi.fn(async () => ({
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

    const context = {
      messages: [
        { role: 'user', content: 'Investigate the build failure' },
        { role: 'tool', tool_call_id: 'call-1', content: 'a'.repeat(4000) },
        { role: 'tool', tool_call_id: 'call-2', content: 'b'.repeat(3800) },
      ] satisfies Message[],
      sessionId: 'session-1',
    };

    const stream = handler.checkAndCompactInLoop(context as never, 2, 700);
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
    expect(context.messages[1]).toEqual(
      expect.objectContaining({
        content: expect.stringContaining('[Microcompact]'),
      }),
    );
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
    const context = {
      messages: originalMessages.map((message) => ({ ...message })),
      sessionId: 'session-1',
    };

    const stream = handler.reactiveCompact(context as never);
    let didCompact = false;
    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        didCompact = value;
        break;
      }
    }

    expect(didCompact).toBe(true);
    expect(context.messages[1]).toEqual(originalMessages[1]);
    expect(context.messages[1]?.content).not.toContain('[Microcompact]');
  });
});
