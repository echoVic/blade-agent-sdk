import { ProviderRegistryError } from '../errors/ProviderRegistryError.js';
import type { ModelServiceConfig, ProviderType } from '../model/config.js';
import type { ModelService } from '../model/service.js';

export interface ProviderAdapter {
  readonly type: ProviderType;
  create(config: Readonly<ModelServiceConfig>): ModelService | PromiseLike<ModelService>;
}

function normalizeAdapterType(type: unknown): ProviderType {
  if (typeof type !== 'string' || type.trim() === '' || type !== type.trim()) {
    throw new ProviderRegistryError(
      'PROVIDER_ADAPTER_INVALID',
      'Provider adapter type must be a non-empty trimmed string',
      { providerType: typeof type === 'string' ? type : undefined },
    );
  }
  return type;
}

function isModelService(value: unknown): value is ModelService {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const service = value as Partial<Record<keyof ModelService, unknown>>;
  return (
    typeof service.chat === 'function' &&
    typeof service.sideQuery === 'function' &&
    typeof service.streamChat === 'function' &&
    typeof service.getConfig === 'function' &&
    typeof service.updateConfig === 'function'
  );
}

/**
 * Immutable, instance-scoped registry for custom model provider adapters.
 */
export class ProviderRegistry {
  private readonly adapters: ReadonlyMap<ProviderType, ProviderAdapter>;

  constructor(adapters: readonly ProviderAdapter[] = []) {
    const registered = new Map<ProviderType, ProviderAdapter>();
    for (const adapter of adapters) {
      const type = normalizeAdapterType(adapter?.type);
      if (typeof adapter.create !== 'function') {
        throw new ProviderRegistryError(
          'PROVIDER_ADAPTER_INVALID',
          `Provider adapter "${type}" must define create()`,
          { providerType: type },
        );
      }
      if (registered.has(type)) {
        throw new ProviderRegistryError(
          'PROVIDER_ADAPTER_DUPLICATE',
          `Provider adapter "${type}" is already registered`,
          { providerType: type },
        );
      }
      registered.set(
        type,
        Object.freeze({
          type,
          create: adapter.create.bind(adapter),
        }),
      );
    }
    this.adapters = registered;
  }

  has(type: ProviderType): boolean {
    return this.adapters.has(type);
  }

  get(type: ProviderType): ProviderAdapter | undefined {
    return this.adapters.get(type);
  }

  list(): readonly ProviderAdapter[] {
    return Object.freeze([...this.adapters.values()]);
  }

  async create(config: Readonly<ModelServiceConfig>): Promise<ModelService> {
    const type = normalizeAdapterType(config.provider);
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new ProviderRegistryError(
        'PROVIDER_ADAPTER_NOT_FOUND',
        `No provider adapter is registered for "${type}"`,
        { providerType: type },
      );
    }

    const service = await adapter.create(config);
    if (!isModelService(service)) {
      throw new ProviderRegistryError(
        'PROVIDER_ADAPTER_INVALID',
        `Provider adapter "${type}" returned an invalid chat service`,
        { providerType: type },
      );
    }
    return service;
  }
}
