import type { SdkErrorOptions } from './SdkError.js';
import { SdkError } from './SdkError.js';

export type ProviderRegistryErrorCode =
  | 'PROVIDER_ADAPTER_INVALID'
  | 'PROVIDER_ADAPTER_DUPLICATE'
  | 'PROVIDER_ADAPTER_NOT_FOUND';

interface ProviderRegistryErrorOptions extends SdkErrorOptions {
  readonly providerType?: string;
}

export class ProviderRegistryError extends SdkError {
  readonly providerType?: string;

  constructor(
    code: ProviderRegistryErrorCode,
    message: string,
    options: ProviderRegistryErrorOptions = {},
  ) {
    super(code, message, options);
    this.providerType = options.providerType;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.providerType !== undefined
        ? { providerType: this.providerType }
        : {}),
    };
  }
}
