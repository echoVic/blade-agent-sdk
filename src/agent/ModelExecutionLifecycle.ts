import type { ChatResponse } from '../services/ChatServiceInterface.js';

export type ModelRequestAbortReason = 'request_interrupted' | 'steering';

export interface ModelRequestLifecycle {
  onCompleted(response: ChatResponse): Promise<void>;
  onFailed(error: unknown): Promise<void>;
  onAborted(reason: ModelRequestAbortReason): Promise<void>;
}

export interface ModelExecutionLifecycle {
  onModelRequestStarting(input: {
    readonly turn: number;
    readonly model: string;
    readonly streaming: boolean;
  }): Promise<ModelRequestLifecycle>;
}
