import type { HookEvent } from '../types/constants.js';
import { SdkError } from './SdkError.js';

export type HookTimeoutErrorCode = 'HOOK_TIMEOUT';

export class HookTimeoutError extends SdkError {
  constructor(
    public readonly event: HookEvent,
    public readonly timeoutMs: number,
  ) {
    super('HOOK_TIMEOUT', `Hook ${event} exceeded ${timeoutMs}ms`);
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      event: this.event,
      timeoutMs: this.timeoutMs,
    };
  }
}
