import { SdkError, type SdkErrorOptions } from './SdkError.js';

export type SessionInputErrorCode =
  | 'SESSION_INPUT_QUEUE_FULL'
  | 'SESSION_REQUEST_MISMATCH'
  | 'SESSION_STEERING_UNAVAILABLE'
  | 'SESSION_INPUT_OPTIONS_UNSUPPORTED'
  | 'SESSION_INPUT_IMAGE_REJECTED';

/** Why `send()` refused an image part. */
export type ImageRejectionReason =
  | 'unsupported_model'
  | 'too_large'
  | 'too_many'
  | 'media_type'
  | 'remote_url'
  | 'unresolvable';

export interface SessionInputErrorDetails {
  /** Position of the rejected part in the submitted content array. */
  readonly index: number;
  readonly reason: ImageRejectionReason;
}

export interface SessionInputErrorOptions extends SdkErrorOptions {
  readonly details?: SessionInputErrorDetails;
}

export class SessionInputError extends SdkError {
  readonly details?: SessionInputErrorDetails;

  constructor(code: string, message: string, options?: SessionInputErrorOptions) {
    super(code, message, options);
    if (options?.details) this.details = options.details;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), ...(this.details ? { details: this.details } : {}) };
  }
}
