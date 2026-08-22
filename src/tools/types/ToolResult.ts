import type { JsonValue } from '../../types/common.js';
import type { ToolEffect } from './ToolEffects.js';
import type { ToolResultMetadata } from './ToolMetadata.js';

export type ToolModelContent = JsonValue;

export interface ToolDisplayContent {
  summary: string;
  detail?: JsonValue;
}

export interface ToolProgress {
  kind: 'progress';
  message?: string;
  data?: JsonValue;
  completed?: number;
  total?: number;
  resumeToken?: string;
}

export interface ToolMessage {
  kind: 'message';
  content: ToolDisplayContent;
}

export interface ToolEffectYield {
  kind: 'effect';
  effect: ToolEffect;
}

export type ToolYield = ToolProgress | ToolMessage | ToolEffectYield;

export interface ToolError {
  message: string;
  type: ToolErrorType;
  code?: string;
  details?: unknown;
}

export enum ToolErrorType {
  VALIDATION_ERROR = 'validation_error',
  PERMISSION_DENIED = 'permission_denied',
  EXECUTION_ERROR = 'execution_error',
  INTERRUPTED = 'interrupted',
  TIMEOUT_ERROR = 'timeout_error',
  NETWORK_ERROR = 'network_error',
}

export interface ToolValidationError {
  message: string;
  model?: ToolModelContent;
  display?: ToolDisplayContent;
  metadata?: ToolResultMetadata;
  errorType?: ToolErrorType;
}

interface ToolResultBase<TMetadata extends ToolResultMetadata = ToolResultMetadata> {
  model: ToolModelContent;
  display?: ToolDisplayContent;
  metadata?: TMetadata;
}

export interface ToolSuccessResult<
  TData = JsonValue,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> extends ToolResultBase<TMetadata> {
  status: 'success';
  data?: TData;
  error?: undefined;
}

export interface ToolFailureResult<TMetadata extends ToolResultMetadata = ToolResultMetadata>
  extends ToolResultBase<TMetadata> {
  status: 'error';
  data?: undefined;
  error: ToolError;
}

export type ToolResult<
  TData = JsonValue,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> = ToolSuccessResult<TData, TMetadata> | ToolFailureResult<TMetadata>;

export type ToolExecution<
  TData = JsonValue,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> = AsyncGenerator<ToolYield, ToolResult<TData, TMetadata>, void>;

export async function collectToolExecution<
  TData = JsonValue,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
>(
  execution: ToolExecution<TData, TMetadata>,
  onYield?: (event: ToolYield) => void | Promise<void>,
): Promise<ToolResult<TData, TMetadata>> {
  let completed = false;
  try {
    while (true) {
      const step = await execution.next();
      if (step.done) {
        completed = true;
        return step.value;
      }
      await onYield?.(step.value);
    }
  } finally {
    if (!completed) {
      try {
        await execution.return(undefined as never);
      } catch {
        // Preserve the original execution or event-consumer failure.
      }
    }
  }
}

// biome-ignore lint/correctness/useYield: terminal-only executions are valid tool streams
export async function* completeToolExecution<
  TData = JsonValue,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
>(
  result: ToolResult<TData, TMetadata>,
): ToolExecution<TData, TMetadata> {
  return result;
}

export function validationErrorToToolResult(error: ToolValidationError): ToolResult {
  return {
    status: 'error',
    model: error.model ?? error.message,
    display: error.display,
    error: {
      type: error.errorType ?? ToolErrorType.VALIDATION_ERROR,
      message: error.message,
    },
    metadata: error.metadata,
  };
}
