import type { ProviderType } from '../types/common.js';

export interface ModelIdentity {
  readonly provider: string;
  readonly api: ProviderType;
  readonly model: string;
}

export function resolveModelIdentity(config: {
  provider: ProviderType;
  providerId?: string;
  model: string;
}): ModelIdentity {
  return {
    provider: config.providerId?.trim() || config.provider,
    api: config.provider,
    model: config.model,
  };
}
