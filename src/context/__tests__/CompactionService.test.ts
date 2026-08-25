import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistryError } from '../../errors/ProviderRegistryError.js';
import { HookManager } from '../../hooks/HookManager.js';
import { HookProcessContainmentError } from '../../hooks/WindowsProcessJob.js';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelMessage } from '../../model/message.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';

const mockChat = vi.fn(async () => ({
  content: '<summary>ok</summary>',
}));
const mockSideQuery = vi.fn(async () => ({
  content: '<summary>ok</summary>',
}));
const mockCreateModelServiceAsync = vi.fn(async (config: ModelServiceConfig) => {
  let currentConfig = config;
  return {
    chat: mockChat,
    sideQuery: mockSideQuery,
    async *streamChat() {
      yield { content: 'unused' };
    },
    getConfig() {
      return currentConfig;
    },
    updateConfig(next: Partial<ModelServiceConfig>) {
      currentConfig = { ...currentConfig, ...next };
    },
  };
});

vi.mock('../../services/createModelService.js', () => ({
  createModelService: mockCreateModelServiceAsync,
}));

vi.mock('../FileAnalyzer.js', () => ({
  FileAnalyzer: {
    analyzeFiles: () => [],
    readFilesContent: async () => [],
  },
}));

const { compact, retainRecentMessages } = await import('../CompactionService.js');

describe('CompactionService', () => {
  beforeEach(() => {
    mockCreateModelServiceAsync.mockClear();
    mockChat.mockClear();
    mockSideQuery.mockClear();
  });

  it('uses the native openai provider for official OpenAI compaction requests', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    const controller = new AbortController();
    const providerRegistry = new ProviderRegistry();

    await compact(messages, {
      trigger: 'manual',
      modelName: 'gpt-5',
      maxContextTokens: 128000,
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
      providerRegistry,
      signal: controller.signal,
    });

    expect(mockCreateModelServiceAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
        requestTimeoutMs: 60_000,
      }),
      expect.anything(),
      providerRegistry,
    );
    expect(mockSideQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(AbortSignal),
      undefined,
    );
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('does not convert an aborted provider request into fallback compaction', async () => {
    const controller = new AbortController();
    const abortError = new Error('execution ownership lost');
    mockSideQuery.mockImplementationOnce(async () => {
      controller.abort(abortError);
      throw abortError;
    });

    await expect(
      compact([{ role: 'user', content: 'hello' }], {
        trigger: 'auto',
        modelName: 'gpt-5',
        maxContextTokens: 128000,
        apiKey: 'test-key',
        baseURL: 'https://api.openai.com/v1',
        signal: controller.signal,
      }),
    ).rejects.toBe(abortError);
  });

  it('does not convert a missing provider adapter into fallback compaction', async () => {
    const registryError = new ProviderRegistryError(
      'PROVIDER_ADAPTER_NOT_FOUND',
      'No provider adapter is registered for "custom-api"',
      { providerType: 'custom-api' },
    );
    mockCreateModelServiceAsync.mockRejectedValueOnce(registryError);

    await expect(
      compact([{ role: 'user', content: 'hello' }], {
        trigger: 'auto',
        provider: 'custom-api',
        modelName: 'custom-model',
        maxContextTokens: 128000,
        providerRegistry: new ProviderRegistry(),
      }),
    ).rejects.toBe(registryError);
  });

  it('preserves a hook containment failure when cancellation races cleanup', async () => {
    const controller = new AbortController();
    const containmentError = new HookProcessContainmentError('Hook process cleanup failed');
    const preCompactHook = vi
      .spyOn(HookManager.getInstance(), 'executePreCompactHooks')
      .mockImplementationOnce(async () => {
        controller.abort(new Error('request cancelled'));
        throw containmentError;
      });

    await expect(
      compact([{ role: 'user', content: 'hello' }], {
        trigger: 'manual',
        modelName: 'gpt-5',
        maxContextTokens: 128000,
        projectDir: '/tmp',
        signal: controller.signal,
      }),
    ).rejects.toBe(containmentError);
    preCompactHook.mockRestore();
  });

  it('routes session-owned compaction hooks through the runtime boundary', async () => {
    const controller = new AbortController();
    const runFileHookOperation = vi.fn(
      async (signal: AbortSignal | undefined, operation: () => Promise<unknown>) => {
        expect(signal).toBe(controller.signal);
        return operation();
      },
    );

    await compact([{ role: 'user', content: 'hello' }], {
      trigger: 'manual',
      modelName: 'gpt-5',
      maxContextTokens: 128000,
      projectDir: '/tmp',
      signal: controller.signal,
      hookRuntime: { runFileHookOperation } as never,
    });

    expect(runFileHookOperation).toHaveBeenCalledTimes(3);
  });

  it('retainRecentMessages drops orphan tool results outside the retained window', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: 'a',
        tool_calls: [{ id: 'tc-keep', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'tool', tool_call_id: 'tc-keep', content: 'kept' },
      { role: 'tool', tool_call_id: 'tc-orphan', content: 'dropped' },
      {
        role: 'assistant',
        content: 'd',
        tool_calls: [
          { id: 'tc-orphan', type: 'function', function: { name: 'y', arguments: '{}' } },
        ],
      },
    ];

    // retain 50%: last 3 messages = tool(tc-keep) + tool(tc-orphan) + assistant(tc-orphan).
    // Only tc-orphan's tool_calls are inside the window, so tool(tc-keep) is an orphan.
    const retained = retainRecentMessages(messages, 0.5);

    expect(retained.map((m) => m.content)).toEqual(['dropped', 'd']);
  });

  it('retainRecentMessages keeps tool results whose tool_calls are in the window', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: 'a',
        tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'tc-1', content: 'result-1' },
    ];

    const retained = retainRecentMessages(messages, 1);

    expect(retained).toHaveLength(2);
    expect(retained[1].content).toBe('result-1');
  });
});
