import type { SdkErrorOptions } from './SdkError.js';
import { SdkError } from './SdkError.js';

export class ToolExecutionError extends SdkError {
  readonly toolName: string;

  constructor(toolName: string, message: string, options?: SdkErrorOptions) {
    super('TOOL_EXECUTION_ERROR', `[${toolName}] ${message}`, options);
    this.toolName = toolName;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      toolName: this.toolName,
    };
  }
}
