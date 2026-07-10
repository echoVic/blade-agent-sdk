import type { ChatConfig, IChatService } from '@blade-ai/ai/chat';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import { VercelAIChatService } from '../services/VercelAIChatService.js';

function getProviderHeaders(_providerId: string): Record<string, string> {
  return {};
}

export async function createChatServiceAsync(
  config: ChatConfig,
  logger: InternalLogger = NOOP_LOGGER,
): Promise<IChatService> {
  let resolvedConfig = config;

  if (resolvedConfig.providerId) {
    const providerHeaders = getProviderHeaders(resolvedConfig.providerId);
    if (Object.keys(providerHeaders).length > 0) {
      resolvedConfig = {
        ...resolvedConfig,
        customHeaders: {
          ...providerHeaders,
          ...resolvedConfig.customHeaders,
        },
      };
      logger
        .child(LogCategory.SERVICE)
        .debug(`🔧 注入 ${resolvedConfig.providerId} 特定 headers:`, Object.keys(providerHeaders));
    }
  }

  return await createChatServiceInternal(resolvedConfig, logger);
}

async function createChatServiceInternal(
  config: ChatConfig,
  logger: InternalLogger,
): Promise<IChatService> {
  const service = new VercelAIChatService(config, logger);
  await service.ready();
  return service;
}
