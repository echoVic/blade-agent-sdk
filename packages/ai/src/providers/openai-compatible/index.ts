import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { normalizeOpenAICompatibleBaseUrl } from './baseUrl.js';
import { generateText, jsonSchema, Output, streamText } from 'ai';
import type {
  JsonObject,
  JsonValue,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  ModelToolDefinition,
  UsageInfo,
} from '../../model/index.js';

export { normalizeOpenAICompatibleBaseUrl } from './baseUrl.js';

export interface OpenAICompatibleModelPortOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  name?: string;
  headers?: Record<string, string>;
}

type RawUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    noCacheTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
};

type RawToolCall = {
  toolCallId?: string;
  tool_call_id?: string;
  id?: string;
  toolName?: string;
  tool_name?: string;
  name?: string;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type GenerateTextResult = {
  text?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  reasoningText?: string;
  reasoning?: Array<{ text?: string }>;
  toolCalls?: RawToolCall[];
  usage?: RawUsage;
  totalUsage?: RawUsage;
  finishReason?: string;
};

type StreamPart = {
  type?: string;
  text?: string;
  textDelta?: string;
  delta?: string;
  finishReason?: string;
  usage?: RawUsage;
  totalUsage?: RawUsage;
  providerMetadata?: JsonObject;
} & RawToolCall;

export function createOpenAICompatibleModelPort(options: OpenAICompatibleModelPortOptions): ModelPort {
  const provider = createOpenAICompatible({
    apiKey: options.apiKey,
    baseURL: normalizeOpenAICompatibleBaseUrl(options.baseUrl) ?? options.baseUrl,
    headers: options.headers,
    name: options.name ?? 'openai-compatible',
  });

  return {
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const result = await generateText({
        model: provider(request.model ?? options.model),
        messages: toAiMessages(request.messages),
        tools: toAiTools(request.tools),
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        abortSignal: request.signal,
        experimental_output: toExperimentalOutput(request.outputFormat),
        providerOptions: request.providerOptions,
      } as never) as GenerateTextResult;

      return toModelResponse(result);
    },

    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const result = streamText({
        model: provider(request.model ?? options.model),
        messages: toAiMessages(request.messages),
        tools: toAiTools(request.tools),
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        abortSignal: request.signal,
        experimental_output: toExperimentalOutput(request.outputFormat),
        providerOptions: request.providerOptions,
      } as never) as { fullStream: AsyncIterable<StreamPart> };

      for await (const part of result.fullStream) {
        yield* toModelStreamEvents(part);
      }
    },
  };
}

function toExperimentalOutput(outputFormat: ModelRequest['outputFormat']): unknown {
  if (!outputFormat || outputFormat.type !== 'json_schema') return undefined;
  const schema = outputFormat.json_schema?.schema;
  if (!schema) return undefined;
  return Output.object({
    schema: jsonSchema(schema as never),
  });
}

function toAiMessages(messages: readonly ModelMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const content: unknown[] = [];
      if (message.reasoningContent) {
        content.push({ type: 'reasoning', text: message.reasoningContent });
      }
      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }
      content.push(...message.toolCalls.map((toolCall) => ({
        type: 'tool-call',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.input,
      })));
      return { role: 'assistant', content };
    }

    if (message.role === 'assistant' && message.reasoningContent) {
      return {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: message.reasoningContent },
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ],
      };
    }

    if (message.role === 'tool' && message.toolCallId) {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName: message.name || 'unknown',
            output: { type: 'text', value: message.content },
          },
        ],
      };
    }

    return {
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    };
  });
}

function toAiTools(tools: readonly ModelToolDefinition[] | undefined): Record<string, {
  description?: string;
  inputSchema: unknown;
}> | undefined {
  if (!tools || tools.length === 0) return undefined;

  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as never),
      },
    ]),
  );
}

function toModelResponse(result: GenerateTextResult): ModelResponse {
  return {
    content: getTextContent(result),
    reasoningContent: getReasoningText(result),
    toolCalls: toModelToolCalls(result.toolCalls),
    usage: toUsageInfo(result.totalUsage ?? result.usage),
    finishReason: result.finishReason,
    raw: result as JsonValue,
  };
}

function getTextContent(result: GenerateTextResult): string {
  if (typeof result.text === 'string') return result.text;
  return result.content
    ?.filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('') ?? '';
}

function getReasoningText(result: GenerateTextResult): string | undefined {
  if (typeof result.reasoningText === 'string') return result.reasoningText;
  const contentReasoning = result.content
    ?.filter((part) => part.type === 'reasoning')
    .map((part) => part.text ?? '')
    .join('');
  if (contentReasoning) return contentReasoning;
  const reasoning = result.reasoning
    ?.map((item) => item.text ?? '')
    .join('');
  return reasoning || undefined;
}

function toModelToolCalls(toolCalls: RawToolCall[] | undefined): ModelToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((toolCall, index) => ({
    id: toolCall.toolCallId ?? toolCall.tool_call_id ?? toolCall.id ?? `call_${index}`,
    name: toolCall.toolName ?? toolCall.tool_name ?? toolCall.name ?? toolCall.function?.name ?? '',
    input: toJsonObject(
      toolCall.input
      ?? toolCall.args
      ?? toolCall.arguments
      ?? toolCall.function?.arguments
      ?? {},
    ),
  }));
}

function toJsonObject(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return toJsonObject(parsed);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}

function toUsageInfo(usage: RawUsage | undefined): UsageInfo | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
    ...(usage.reasoningTokens !== undefined || usage.outputTokenDetails?.reasoningTokens !== undefined
      ? { reasoningTokens: usage.reasoningTokens ?? usage.outputTokenDetails?.reasoningTokens }
      : {}),
    ...(usage.inputTokenDetails?.cacheReadTokens !== undefined || usage.cachedInputTokens !== undefined
      ? { cacheReadInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens }
      : {}),
    ...(usage.inputTokenDetails?.cacheWriteTokens !== undefined
      ? { cacheCreationInputTokens: usage.inputTokenDetails.cacheWriteTokens }
      : {}),
    ...(usage.inputTokenDetails?.noCacheTokens !== undefined
      ? {
          cacheMissInputTokens: usage.inputTokenDetails.noCacheTokens,
          billableInputTokens: usage.inputTokenDetails.noCacheTokens,
        }
      : {}),
  };
}

async function* toModelStreamEvents(part: StreamPart): AsyncIterable<ModelStreamEvent> {
  switch (part.type) {
    case 'text-delta': {
      const delta = part.text ?? part.textDelta ?? part.delta;
      if (delta !== undefined) yield { type: 'content_delta', delta };
      return;
    }
    case 'reasoning-delta': {
      const delta = part.text ?? part.textDelta ?? part.delta;
      if (delta !== undefined) yield { type: 'reasoning_delta', delta };
      return;
    }
    case 'tool-call': {
      yield {
        type: 'tool_call',
        toolCall: toModelToolCalls([part])?.[0] ?? { id: 'call_0', name: '', input: {} },
      };
      return;
    }
    case 'finish': {
      const usage = toUsageInfo(part.totalUsage ?? part.usage);
      if (usage) yield { type: 'usage', usage };
      yield { type: 'done', finishReason: part.finishReason };
      return;
    }
    case 'error': {
      yield {
        type: 'error',
        error: part instanceof Error ? part : new Error(String((part as { error?: unknown }).error ?? 'Model stream error')),
      };
      return;
    }
  }
}
