import type { SdkErrorOptions } from './SdkError.js';
import { SdkError } from './SdkError.js';

export class ConfigError extends SdkError {
  constructor(message: string, options?: SdkErrorOptions) {
    super('CONFIG_ERROR', message, options);
  }
}
