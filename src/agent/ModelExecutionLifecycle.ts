import type { ChatResponse } from '../services/ChatServiceInterface.js';
import type { ModelAttemptId } from '../types/branded.js';
import type { ProviderType } from '../types/common.js';

export type ModelRequestAbortReason = 'request_interrupted' | 'steering';

export interface ModelRequestLifecycle {
  readonly modelAttemptId?: ModelAttemptId;
  onCompleted(response: ChatResponse): Promise<void>;
  onFailed(error: unknown): Promise<void>;
  onAborted(reason: ModelRequestAbortReason): Promise<void>;
}

export interface ModelExecutionLifecycle {
  onModelRequestStarting(input: {
    readonly turn: number;
    readonly model: string;
    readonly provider?: string;
    readonly api?: ProviderType;
    readonly streaming: boolean;
  }): Promise<ModelRequestLifecycle>;
}
