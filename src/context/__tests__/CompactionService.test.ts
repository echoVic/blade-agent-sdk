import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../services/ChatServiceInterface.js';

const mockChat = vi.fn(async () => ({
  content: '<summary>ok</summary>',
}));
const mockSideQuery = vi.fn(async () => ({
  content: '<summary>ok</summary>',
}));
const mockCreateChatServiceAsync = vi.fn(async (_config: Record<string, unknown>) => ({
  chat: mockChat,
  sideQuery: mockSideQuery,
}));

vi.mock('../../services/ChatServiceInterface.js', () => ({
  createChatServiceAsync: mockCreateChatServiceAsync,
}));

vi.mock('../FileAnalyzer.js', () => ({
  FileAnalyzer: {
    analyzeFiles: () => [],
    readFilesContent: async () => [],
  },
}));

const { compact } = await import('../CompactionService.js');

describe('CompactionService', () => {
  beforeEach(() => {
    mockCreateChatServiceAsync.mockClear();
    mockChat.mockClear();
    mockSideQuery.mockClear();
  });

  it('uses the native openai provider for official OpenAI compaction requests', async () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }];

    await compact(messages, {
      trigger: 'manual',
      modelName: 'gpt-5',
      maxContextTokens: 128000,
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
    });

    expect(mockCreateChatServiceAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
      }),
      expect.anything(),
    );
    expect(mockSideQuery).toHaveBeenCalledTimes(1);
    expect(mockChat).not.toHaveBeenCalled();
  });
});
