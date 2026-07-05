import type { TokenUsage } from '../types/common.js';
import type { PromptResult, StreamMessage, ToolCallRecord } from './types.js';

const emptyUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  maxContextTokens: 0,
};

export class PromptStreamAccumulator {
  private readonly toolCalls: ToolCallRecord[] = [];
  private usage: TokenUsage = emptyUsage;
  private turnsCount = 0;
  private result = '';
  private errorMessage: string | null = null;

  accept(message: StreamMessage): void {
    switch (message.type) {
      case 'turn_start':
        this.turnsCount = message.turn;
        break;
      case 'tool_use':
        this.toolCalls.push({
          id: message.id,
          name: message.name,
          input: message.input,
          output: '',
          duration: 0,
        });
        break;
      case 'tool_result': {
        const record = this.toolCalls.find((toolCall) => toolCall.id === message.id);
        if (record) {
          record.output = message.output;
          record.isError = message.isError;
        }
        break;
      }
      case 'usage':
        this.usage = message.usage;
        break;
      case 'result':
        if (message.subtype === 'success') {
          this.result = message.content ?? '';
        } else {
          this.errorMessage = message.error ?? 'Unknown error';
        }
        break;
      case 'error':
        this.errorMessage = message.message;
        break;
    }
  }

  build(options: { duration: number }): PromptResult {
    if (this.errorMessage) {
      throw new Error(this.errorMessage);
    }

    return {
      result: this.result,
      toolCalls: this.toolCalls.map((toolCall) => ({ ...toolCall })),
      usage: this.usage,
      duration: options.duration,
      turnsCount: this.turnsCount,
    };
  }
}
