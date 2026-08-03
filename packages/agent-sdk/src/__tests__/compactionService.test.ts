import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@blade-ai/ai/chat';

const { mockCreateChatServiceAsync, mockSideQuery } = vi.hoisted(() => ({
  mockSideQuery: vi.fn(async () => ({
    content: '<summary>package-local summary</summary>',
  })),
  mockCreateChatServiceAsync: vi.fn(async () => ({
    chat: vi.fn(),
    sideQuery: mockSideQuery,
  })),
}));

vi.mock('../local/chatServiceFactory.js', () => ({
  createChatServiceAsync: mockCreateChatServiceAsync,
}));

vi.mock('../local/FileAnalyzer.js', () => ({
  FileAnalyzer: {
    analyzeFiles: () => [{ path: '/workspace/src/index.ts' }],
    readFilesContent: async () => [
      { path: '/workspace/src/index.ts', content: 'export const x = 1;' },
    ],
  },
}));

import { SessionId } from '../local/branded.js';
import {
  compact,
  CompactionService,
  microcompactMessages,
  type CompactionOptions,
} from '../local/compactionService.js';
import { microcompact } from '../local/microcompactStrategy.js';

/**
 * Slice #337 — CompactionService ported into @blade-ai/agent-sdk/local.
 *
 * The compaction orchestration (hook gating, file analysis, LLM summary,
 * boundary/summary message creation, fallback truncation) now lives in the
 * package; root src/context/CompactionService.ts is a re-export shim.
 */

const messages: Message[] = [
  { id: 'm1', role: 'user', content: 'hello' },
  { id: 'm2', role: 'assistant', content: 'hi there' },
];

function makeOptions(): CompactionOptions {
  return {
    trigger: 'auto',
    modelName: 'glm-5.2',
    maxContextTokens: 8000,
    apiKey: 'test-key',
    sessionId: SessionId('compaction-session'),
    projectDir: '/workspace',
    permissionMode: 'default' as CompactionOptions['permissionMode'],
  };
}

describe('CompactionService (package local)', () => {
  beforeEach(() => {
    mockCreateChatServiceAsync.mockClear();
    mockSideQuery.mockClear();
  });

  it('compacts messages through hooks, file analysis and LLM summary', async () => {
    const result = await compact(messages, makeOptions());

    expect(result.success).toBe(true);
    expect(result.summary).toBe('package-local summary');
    expect(result.filesIncluded).toEqual(['/workspace/src/index.ts']);
    expect(result.boundaryMessage.metadata).toMatchObject({
      subtype: 'compact_boundary',
    });
    expect(result.summaryMessage.metadata).toMatchObject({
      isCompactSummary: true,
    });
    expect(result.compactedMessages[0]).toBe(result.summaryMessage);
    expect(mockCreateChatServiceAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'glm-5.2',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      }),
      expect.anything(),
    );
  });

  it('exposes microcompact through the facade and passthrough', () => {
    const viaFacade = CompactionService.microcompact(messages, {});
    const viaPassthrough = microcompactMessages(messages, {});
    expect(viaFacade).toEqual(microcompact(messages, {}));
    expect(viaPassthrough).toEqual(viaFacade);
  });

  it('falls back to truncation when the summary generation fails', async () => {
    mockSideQuery.mockRejectedValueOnce(new Error('model unavailable'));

    const result = await compact(messages, makeOptions());

    expect(result.success).toBe(false);
    expect(result.error).toContain('model unavailable');
    expect(result.compactedMessages.length).toBeGreaterThan(0);
  });
});
