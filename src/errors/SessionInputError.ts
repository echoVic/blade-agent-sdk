import { SdkError } from './SdkError.js';

export type SessionInputErrorCode =
  | 'SESSION_INPUT_QUEUE_FULL'
  | 'SESSION_REQUEST_MISMATCH'
  | 'SESSION_STEERING_UNAVAILABLE'
  | 'SESSION_INPUT_OPTIONS_UNSUPPORTED';

export class SessionInputError extends SdkError {}
