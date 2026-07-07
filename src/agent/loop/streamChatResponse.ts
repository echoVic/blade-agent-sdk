import type { JSONSchema7 } from 'json-schema';
import {
  streamPackageLocalChatResponse,
  type PackageLocalStreamDelta,
} from '../../../packages/agent-sdk/src/session/streamChatResponse.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type {
  ChatResponse,
  IChatService,
  Message,
} from '../../services/ChatServiceInterface.js';

export async function* streamChatResponse(
  getChatService: () => IChatService,
  messages: readonly Message[],
  tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
  signal?: AbortSignal,
  logger?: InternalLogger,
): AsyncGenerator<PackageLocalStreamDelta, ChatResponse> {
  const log = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
  const stream = streamPackageLocalChatResponse(
    getChatService,
    messages,
    tools as never,
    signal,
    {
      warn: (message) => log.warn(message),
    },
  );

  while (true) {
    const next = await stream.next();
    if (next.done) {
      return next.value as ChatResponse;
    }
    yield next.value;
  }
}
