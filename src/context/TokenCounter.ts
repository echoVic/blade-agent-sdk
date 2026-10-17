import { encodingForModel } from 'js-tiktoken';
import { estimateImageTokens } from '../images/estimateImageTokens.js';
import type { ModelContent, ModelMessage, ModelToolCall } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';

interface Encoding {
  encode: (text: string) => number[];
}

const encodingCache = new Map<string, Encoding>();

function getEncoding(modelName: string): Encoding {
  let encoding = encodingCache.get(modelName);
  if (!encoding) {
    try {
      encoding = encodingForModel(modelName as Parameters<typeof encodingForModel>[0]);
    } catch {
      try {
        encoding = encodingForModel('gpt-4' as Parameters<typeof encodingForModel>[0]);
      } catch {
        console.warn(`[TokenCounter] 无法为模型 ${modelName} 获取 encoding，使用粗略估算`);
        encoding = {
          encode: (text: string) => {
            return new Array(Math.ceil(text.length / 4));
          },
        };
      }
    }
    encodingCache.set(modelName, encoding);
  }

  return encoding;
}

function countToolCallTokens(toolCalls: ModelToolCall[], encoding: Encoding): number {
  let tokens = 0;

  for (const call of toolCalls) {
    tokens += 4;

    if (call.type === 'function' && call.function?.name) {
      tokens += encoding.encode(call.function.name).length;
    }

    if (call.type === 'function' && call.function?.arguments) {
      tokens += encoding.encode(call.function.arguments).length;
    }

    if (call.id) {
      tokens += encoding.encode(call.id).length;
    }
  }

  return tokens;
}

export interface TokenCountOptions {
  /** Image capability of the model; images are estimated from their size, never from base64. */
  readonly vision?: Pick<VisionCapability, 'imageTokens'>;
}

function countContentTokens(
  content: readonly ModelContent[],
  encoding: Encoding,
  options: TokenCountOptions,
): number {
  let tokens = 0;
  for (const part of content) {
    tokens +=
      part.type === 'text'
        ? encoding.encode(part.text).length
        : estimateImageTokens(part.image_url, options.vision);
  }
  return tokens;
}

export function countTokens(
  messages: ModelMessage[],
  modelName: string,
  options: TokenCountOptions = {},
): number {
  const encoding = getEncoding(modelName);
  let totalTokens = 0;

  for (const msg of messages) {
    totalTokens += 4;

    if (msg.role) {
      totalTokens += encoding.encode(msg.role).length;
    }

    if (msg.content) {
      totalTokens +=
        typeof msg.content === 'string'
          ? encoding.encode(msg.content).length
          : countContentTokens(msg.content, encoding, options);
    }

    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      totalTokens += countToolCallTokens(msg.tool_calls, encoding);
    }

    if (msg.name) {
      totalTokens += encoding.encode(msg.name).length;
    }
  }

  return totalTokens;
}

export function getTokenLimit(maxTokens: number): number {
  return maxTokens;
}

export function shouldCompact(
  messages: ModelMessage[],
  modelName: string,
  maxTokens: number,
  thresholdPercent = 0.8,
): boolean {
  const currentTokens = countTokens(messages, modelName);
  const threshold = Math.floor(maxTokens * thresholdPercent);

  return currentTokens >= threshold;
}

export function clearCache(): void {
  encodingCache.clear();
}

export function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;

  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

export const TokenCounter = {
  countTokens,
  getTokenLimit,
  shouldCompact,
  clearCache,
  estimateTokens,
};
