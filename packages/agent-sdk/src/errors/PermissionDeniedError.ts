import type { SdkErrorOptions } from './SdkError.js';
import { SdkError } from './SdkError.js';

export class PermissionDeniedError extends SdkError {
  constructor(message: string, options?: SdkErrorOptions) {
    super('PERMISSION_DENIED', message, options);
  }
}
