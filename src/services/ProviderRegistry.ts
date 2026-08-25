import { ProviderRegistryError } from '../errors/ProviderRegistryError.js';
import type { ProviderType } from '../types/common.js';
import type { ChatConfig, IChatService } from './ChatServiceInterface.js';

export interface ProviderAdapter {
  readonly type: ProviderType;
  create(config: Readonly<ChatConfig>): IChatService | PromiseLike<IChatService>;
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

function isChatService(value: unknown): value is IChatService {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const service = value as Partial<Record<keyof IChatService, unknown>>;
  return (
    typeof service.chat === 'function'
    && typeof service.sideQuery === 'function'
    && typeof service.streamChat === 'function'
    && typeof service.getConfig === 'function'
    && typeof service.updateConfig === 'function'
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
      registered.set(type, Object.freeze({
        type,
        create: adapter.create.bind(adapter),
      }));
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

  async create(config: Readonly<ChatConfig>): Promise<IChatService> {
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
    if (!isChatService(service)) {
      throw new ProviderRegistryError(
        'PROVIDER_ADAPTER_INVALID',
        `Provider adapter "${type}" returned an invalid chat service`,
        { providerType: type },
      );
    }
    return service;
  }
}
