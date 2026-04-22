import type { RuntimeContextPatch, RuntimePatch } from '../../runtime/index.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { JsonValue } from '../../types/common.js';
import type { ToolEffect } from './ToolEffects.js';
import type { ToolResultMetadata } from './ToolMetadata.js';

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
  TIMEOUT_ERROR = 'timeout_error',
  NETWORK_ERROR = 'network_error',
}

export interface ToolValidationError {
  message: string;
  llmContent?: string | object;
  metadata?: ToolResultMetadata;
  errorType?: ToolErrorType;
}

interface ToolResultBase<TMetadata extends ToolResultMetadata = ToolResultMetadata> {
  llmContent: string | object;
  metadata?: TMetadata;
  effects?: ToolEffect[];
  runtimePatch?: RuntimePatch;
  contextPatch?: RuntimeContextPatch;
  newMessages?: Message[];
}

export interface ToolSuccessResult<
  TData = JsonValue,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> extends ToolResultBase<TMetadata> {
  success: true;
  data?: TData;
  error?: undefined;
}

export interface ToolFailureResult<TMetadata extends ToolResultMetadata = ToolResultMetadata>
  extends ToolResultBase<TMetadata> {
  success: false;
  data?: undefined;
  error: ToolError;
}

export type ToolResult<
  TData = JsonValue,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> = ToolSuccessResult<TData, TMetadata> | ToolFailureResult<TMetadata>;

export function validationErrorToToolResult(error: ToolValidationError): ToolResult {
  return {
    success: false,
    llmContent: error.llmContent ?? error.message,
    error: {
      type: error.errorType ?? ToolErrorType.VALIDATION_ERROR,
      message: error.message,
    },
    metadata: error.metadata,
  };
}
