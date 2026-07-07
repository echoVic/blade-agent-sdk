import type { ModelMessage } from '@blade-ai/ai';

export * from './messageProjection.js';
export * from './systemSource.js';
export * from './toolInjectedMessages.js';

export type AgentStoreMessageSource = 'input' | 'model' | 'tool';

export interface AgentStoreAppendContext {
  turnId?: string;
  source: AgentStoreMessageSource;
  step: number;
}

export interface AgentStorePort {
  appendMessage(
    message: ModelMessage,
    context: AgentStoreAppendContext,
    signal?: AbortSignal,
  ): Promise<void> | void;
}
