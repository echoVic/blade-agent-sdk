import { SdkError } from './SdkError.js';

export type ModelTimeoutErrorCode = 'MODEL_REQUEST_TIMEOUT' | 'MODEL_STREAM_IDLE_TIMEOUT';

export class ModelTimeoutError extends SdkError {
  constructor(
    code: ModelTimeoutErrorCode,
    public readonly timeoutMs: number,
  ) {
    super(
      code,
      code === 'MODEL_STREAM_IDLE_TIMEOUT'
        ? `Model stream produced no chunk for ${timeoutMs}ms`
        : `Model request exceeded ${timeoutMs}ms`,
    );
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      timeoutMs: this.timeoutMs,
    };
  }
}
