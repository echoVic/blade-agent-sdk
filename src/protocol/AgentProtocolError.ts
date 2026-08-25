import { SdkError } from '../errors/SdkError.js';
import type { JsonObject } from '../types/json.js';
import type { AgentProtocolErrorCode } from './types.js';

export class AgentProtocolError extends SdkError {
  constructor(
    readonly protocolCode: AgentProtocolErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly details?: JsonObject,
    options?: { cause?: unknown },
  ) {
    super(protocolCode, message, options);
  }
}
