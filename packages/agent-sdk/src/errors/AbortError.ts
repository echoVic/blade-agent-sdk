import type { SdkErrorOptions } from './SdkError.js';
import { SdkError } from './SdkError.js';

export class AbortError extends SdkError {
  constructor(message = 'Operation aborted', options?: SdkErrorOptions) {
    super('ABORT', message, options);
  }
}
