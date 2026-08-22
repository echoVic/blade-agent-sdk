import type { Message } from '../services/ChatServiceInterface.js';
import type { InputId, RequestId } from '../types/branded.js';

export interface AgentSteeringInput {
  inputId: InputId;
  content: Message['content'];
  priority: 'now' | 'next';
  acceptedAt: number;
}

export interface AgentRunControl {
  readonly requestId: RequestId;
  readonly requestSignal: AbortSignal;
  readonly stepSignal: AbortSignal;
  readonly isSealed: boolean;

  claimSteeringInputs(options?: {
    includeNow?: boolean;
    sealIfEmpty?: boolean;
  }): AgentSteeringInput[];
  acknowledgeInput(inputId: InputId): void;
  releaseInput(inputId: InputId): void;
  interruptStep(inputId: InputId): void;
  advanceStep(): void;
  seal(): void;
}
