import { describe, expectTypeOf, it } from 'vitest';
import type {
  JsonObject,
  ModelPort,
  ModelOutputFormat,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  UsageInfo,
} from '../index.js';
import type {
  ModelPort as RootModelPort,
  ModelOutputFormat as RootModelOutputFormat,
  ModelUsageInfo,
  UsageInfo as RootUsageInfo,
} from '../../index.js';

describe('@blade-ai/ai model protocol types', () => {
  it('defines the provider-agnostic model port used by the agent kernel', () => {
    expectTypeOf<UsageInfo>().toMatchTypeOf<{
      promptTokens?: number;
      completionTokens?: number;
      totalTokens: number;
      reasoningTokens?: number;
      cacheReadInputTokens?: number;
      billableInputTokens?: number;
    }>();
    const totalOnlyUsage: UsageInfo = { totalTokens: 12 };
    const breakdownUsage: UsageInfo = {
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
    };
    void totalOnlyUsage;
    void breakdownUsage;

    expectTypeOf<ModelToolCall>().toMatchTypeOf<{
      id: string;
      name: string;
      input: JsonObject;
    }>();

    expectTypeOf<ModelRequest>().toMatchTypeOf<{
      messages: ReadonlyArray<{
        role: 'system' | 'user' | 'assistant' | 'tool';
        content: string;
        reasoningContent?: string;
        toolCalls?: readonly ModelToolCall[];
      }>;
      tools?: ReadonlyArray<{
        name: string;
        description?: string;
        parameters: JsonObject;
        strict?: boolean;
      }>;
      temperature?: number;
      maxOutputTokens?: number;
      maxContextTokens?: number;
      outputFormat?: ModelOutputFormat;
      providerOptions?: JsonObject;
      signal?: AbortSignal;
    }>();

    expectTypeOf<ModelStreamEvent>().toMatchTypeOf<
      | { type: 'content_delta'; delta: string }
      | { type: 'reasoning_delta'; delta: string }
      | { type: 'tool_call'; toolCall: ModelToolCall }
      | { type: 'usage'; usage: UsageInfo }
      | { type: 'done'; response?: ModelResponse; finishReason?: string }
      | { type: 'error'; error: Error }
    >();

    expectTypeOf<ModelResponse>().toMatchTypeOf<{
      content: string;
      reasoningContent?: string;
      toolCalls?: ModelToolCall[];
      usage?: UsageInfo;
      finishReason?: string;
    }>();

    type StreamReturn = ReturnType<ModelPort['stream']>;
    expectTypeOf<StreamReturn>().toEqualTypeOf<AsyncIterable<ModelStreamEvent>>();
    expectTypeOf<Parameters<ModelPort['stream']>[0]>().toEqualTypeOf<ModelRequest>();
    expectTypeOf<ReturnType<ModelPort['generate']>>().toEqualTypeOf<Promise<ModelResponse>>();
  });

  it('exposes model protocol types from the package root without replacing chat UsageInfo', () => {
    expectTypeOf<RootModelPort>().toEqualTypeOf<ModelPort>();
    expectTypeOf<RootModelOutputFormat>().toEqualTypeOf<ModelOutputFormat>();
    expectTypeOf<ModelUsageInfo>().toEqualTypeOf<UsageInfo>();
    expectTypeOf<RootUsageInfo>().toMatchTypeOf<{
      promptTokens?: number;
      completionTokens?: number;
      totalTokens: number;
    }>();
  });
});
