import { ProviderRegistryError } from '../errors/ProviderRegistryError.js';
import { type InternalLogger, NOOP_LOGGER } from '../logging/Logger.js';
import type { ModelServiceConfig } from '../model/config.js';
import { isBuiltinProviderType } from '../model/config.js';
import type { ModelService } from '../model/service.js';
import type { ProviderRegistry } from './ProviderRegistry.js';
import { VercelAIModelService } from './VercelAIModelService.js';

export async function createModelService(
  config: ModelServiceConfig,
  logger: InternalLogger = NOOP_LOGGER,
  registry?: ProviderRegistry,
): Promise<ModelService> {
  if (registry?.has(config.provider)) {
    return await registry.create(config);
  }
  if (!isBuiltinProviderType(config.provider)) {
    throw new ProviderRegistryError(
      'PROVIDER_ADAPTER_NOT_FOUND',
      `No provider adapter is registered for "${config.provider}"`,
      { providerType: config.provider },
    );
  }

  const service = new VercelAIModelService(config, logger);
  await service.ready();
  return service;
}
