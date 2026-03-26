/**
 * ChatService 接口抽象
 * 定义统一的聊天服务接口，支持多种 API 提供商
 */

import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { JsonValue, MessageRole, OutputFormat, ProviderType } from '../types/common.js';
import { VercelAIChatService } from './VercelAIChatService.js';

/**
 * 工具调用（完整版，LLM 返回的最终结果）
 * 替代 openai 的 ChatCompletionMessageToolCall
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 流式 delta 中的工具调用（字段可选，逐步拼装）
 * 替代 openai 的 ChatCompletionChunk.Choice.Delta.ToolCall
 */
export interface StreamDeltaToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

function getProviderHeaders(_providerId: string): Record<string, string> {
  return {};
}

/**
 * Anthropic Prompt Caching 配置
 * 用于标记可缓存的内容，减少 token 消耗（成本降低 90%，延迟降低 85%）
 */
export interface AnthropicCacheControl {
  type: 'ephemeral';
}

/**
 * Provider 特定选项
 */
export interface ProviderOptions {
  anthropic?: {
    cacheControl?: AnthropicCacheControl;
  };
}

/**
 * 多模态内容部分 - 文本
 */
interface TextContentPart {
  type: 'text';
  text: string;
  providerOptions?: ProviderOptions;
}

/**
 * 多模态内容部分 - 图片 (OpenAI Vision API 格式)
 */
interface ImageContentPart {
  type: 'image_url';
  image_url: {
    url: string; // data:image/png;base64,... 或 https://...
  };
}

/**
 * 多模态内容部分
 */
export type ContentPart = TextContentPart | ImageContentPart;

/**
 * 消息类型
 * content 支持纯文本或多模态内容（文本+图片）
 */
export type Message = {
  id?: string;
  role: MessageRole;
  content: string | ContentPart[];
  reasoningContent?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
  metadata?: JsonValue;
};

/**
 * ChatConfig - 聊天服务所需的配置
 * 注意：这些字段现在从 ModelConfig 中获取，而非直接从 BladeConfig
 */
export interface ChatConfig {
  provider: ProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxContextTokens?: number; // 上下文窗口大小（用于压缩判断）
  maxOutputTokens?: number; // 输出 token 限制（传给 API 的 max_tokens）
  timeout?: number;
  apiVersion?: string; // GPT OpenAI Platform 专用：API 版本（如 '2024-03-01-preview'）
  supportsThinking?: boolean; // 是否支持 thinking 模式（DeepSeek Reasoner 等）
  customHeaders?: Record<string, string>; // Provider 特定的自定义 HTTP Headers
  providerId?: string; // models.dev 中的 Provider ID（用于获取特定配置）
  outputFormat?: OutputFormat; // 结构化输出格式（JSON Schema）
}

/**
 * 聊天响应
 */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number; // Thinking 模型消耗的推理 tokens
  cacheCreationInputTokens?: number; // Anthropic: 缓存创建消耗的 tokens
  cacheReadInputTokens?: number; // Anthropic: 缓存读取的 tokens（节省的部分）
}

export interface ChatResponse {
  content: string;
  reasoningContent?: string; // Thinking 模型的推理过程（如 DeepSeek R1）
  toolCalls?: ToolCall[];
  usage?: UsageInfo;
}

/**
 * 流式 tool_calls 的统一类型：
 * - 流式 delta 期间的 tool call（id 等字段可能是可选的）
 * - 以及收敛后的完整 tool call
 */
export type StreamToolCall = ToolCall | StreamDeltaToolCall;

/**
 * 流式响应块
 */
export interface StreamChunk {
  content?: string;
  reasoningContent?: string; // Thinking 模型的推理过程片段
  toolCalls?: StreamToolCall[];
  finishReason?: string;
  usage?: UsageInfo; // 流式响应的使用统计（通常仅在结束时提供）
}

/**
 * 聊天服务接口
 * 所有 Provider 实现必须实现此接口
 */
export interface IChatService {
  /**
   * 发送聊天请求（非流式）
   */
  chat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>,
    signal?: AbortSignal
  ): Promise<ChatResponse>;

  /**
   * 发送聊天请求（流式）
   */
  streamChat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown>;

  /**
   * 获取当前配置
   */
  getConfig(): ChatConfig;

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<ChatConfig>): void;
}

/**
 * ChatService 工厂函数（异步版本）
 *
 * @param config ChatConfig + provider 字段
 * @returns Promise<IChatService> 实例
 */
export async function createChatServiceAsync(
  config: ChatConfig,
  logger: InternalLogger = NOOP_LOGGER,
): Promise<IChatService> {
  let resolvedConfig = config;

  // 自动注入 Provider 特定的 Headers
  if (resolvedConfig.providerId) {
    const providerHeaders = getProviderHeaders(resolvedConfig.providerId);
    if (Object.keys(providerHeaders).length > 0) {
      resolvedConfig = {
        ...resolvedConfig,
        customHeaders: {
          ...providerHeaders,
          ...resolvedConfig.customHeaders, // 用户配置优先
        },
      };
      logger.child(LogCategory.SERVICE).debug(`🔧 注入 ${resolvedConfig.providerId} 特定 headers:`, Object.keys(providerHeaders));
    }
  }

  return await createChatServiceInternal(resolvedConfig, logger);
}

async function createChatServiceInternal(config: ChatConfig, logger: InternalLogger): Promise<IChatService> {
  const service = new VercelAIChatService(config, logger);
  await service.ready();
  return service;
}
