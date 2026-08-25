import type { ModelIdentity } from '../model/identity.js';
import type { ModelResponse } from '../model/service.js';
import type { ModelAttemptId } from '../types/identifiers.js';

export type ModelRequestAbortReason = 'request_interrupted' | 'steering';

export interface ModelRequestLifecycle {
  readonly modelAttemptId?: ModelAttemptId;
  onCompleted(response: ModelResponse): Promise<void>;
  onFailed(error: unknown): Promise<void>;
  onAborted(reason: ModelRequestAbortReason): Promise<void>;
}

export interface ModelExecutionLifecycle {
  onModelRequestStarting(input: {
    readonly turn: number;
    readonly model: string;
    readonly modelIdentity?: ModelIdentity;
    readonly streaming: boolean;
  }): Promise<ModelRequestLifecycle>;
}
