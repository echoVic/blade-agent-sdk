import { SdkError } from './SdkError.js';

export type ModelStreamErrorCode = 'MODEL_STREAM_FAILED';

/**
 * A failure the provider reported inside the stream rather than by rejecting it.
 *
 * The AI SDK encodes request failures as an `error` part in `fullStream`, so a
 * consumer that ignores that part observes a truncated response as a completed
 * one. Raising this error keeps partial output from being treated as the model's
 * answer.
 */
export class ModelStreamError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('MODEL_STREAM_FAILED' satisfies ModelStreamErrorCode, message, options);
  }
}
