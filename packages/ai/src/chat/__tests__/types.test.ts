import { describe, expectTypeOf, it } from 'vitest';
import type {
  ChatConfig,
  ChatResponse,
  ChatToolDefinition,
  ContentPart,
  IChatService,
  Message,
  ProviderOptions,
  StreamChunk,
  UsageInfo,
} from '../index.js';

describe('@blade-ai/ai chat protocol types', () => {
  it('models provider config, messages, tools, responses, streams, and usage', () => {
    expectTypeOf<ChatConfig['provider']>().toEqualTypeOf<
      'anthropic' | 'azure-openai' | 'deepseek' | 'gemini' | 'openai' | 'openai-compatible'
    >();
    expectTypeOf<ChatConfig['apiKey']>().toEqualTypeOf<string>();
    expectTypeOf<ChatConfig['baseUrl']>().toEqualTypeOf<string>();
    expectTypeOf<ChatConfig['model']>().toEqualTypeOf<string>();
    expectTypeOf<ChatConfig['providerOptions']>().toEqualTypeOf<ProviderOptions | undefined>();

    expectTypeOf<ContentPart>().toMatchTypeOf<
      | { type: 'text'; text: string; providerOptions?: ProviderOptions }
      | { type: 'image_url'; image_url: { url: string } }
    >();

    expectTypeOf<Message>().toMatchTypeOf<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string | ContentPart[];
    }>();

    expectTypeOf<UsageInfo>().toMatchTypeOf<{
      promptTokens?: number;
      completionTokens?: number;
      totalTokens: number;
      reasoningTokens?: number;
    }>();
    const totalOnlyUsage: UsageInfo = { totalTokens: 12 };
    const breakdownUsage: UsageInfo = {
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
    };
    void totalOnlyUsage;
    void breakdownUsage;

    expectTypeOf<ChatResponse>().toMatchTypeOf<{
      content: string;
      toolCalls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
      usage?: UsageInfo;
    }>();

    expectTypeOf<StreamChunk>().toMatchTypeOf<{
      content?: string;
      reasoningContent?: string;
      finishReason?: string;
      usage?: UsageInfo;
    }>();

    type ChatParameters = Parameters<IChatService['chat']>;
    expectTypeOf<ChatParameters[0]>().toEqualTypeOf<readonly Message[]>();
    expectTypeOf<ChatParameters[1]>().toEqualTypeOf<ChatToolDefinition[] | undefined>();
    expectTypeOf<ChatParameters[2]>().toEqualTypeOf<AbortSignal | undefined>();
  });
});
