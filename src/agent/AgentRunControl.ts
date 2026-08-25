import type { ModelMessage } from '../model/message.js';
import type { InputId, RequestId } from '../types/identifiers.js';

export interface AgentSteeringInput {
  inputId: InputId;
  content: ModelMessage['content'];
  priority: 'now' | 'next';
  acceptedAt: number;
}

export interface AgentRunControl {
  readonly requestId: RequestId;
  readonly requestSignal: AbortSignal;
  readonly steeringSignal: AbortSignal;
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
