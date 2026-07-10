import type { JSONSchema7 } from 'json-schema';
import {
  PackageLocalStreamingToolExecutor,
  type PackageLocalStreamingToolExecutorConfig,
} from '@blade-ai/agent-sdk/session/internal';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type {
  ChatResponse,
  IChatService,
  Message,
} from '@blade-ai/ai/chat';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolResult } from '../tools/types/index.js';
import type { JsonObject, PermissionMode } from '../types/common.js';
import type { ExecutionEpoch } from './ExecutionEpoch.js';
import type { ToolExecutionOutcome } from './loop/executeToolCalls.js';
import type { ToolExecutionContext, ToolExecutionUpdate } from './loop/runToolCall.js';
import type { FunctionToolCall } from './loop/types.js';

interface ToolExecutionHooks {
  onBeforeToolExec?: (ctx: {
    toolCall: FunctionToolCall;
    params: JsonObject;
  }) => Promise<string | null>;
}

export interface StreamingToolExecutorConfig {
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  hooks?: ToolExecutionHooks;
  onContentDelta?: (delta: string) => void | Promise<void>;
  onThinkingDelta?: (delta: string) => void | Promise<void>;
  onStreamEnd?: () => void | Promise<void>;
  onToolExecutionUpdate?: (update: ToolExecutionUpdate) => void | Promise<void>;
  onToolReady?: (toolCall: FunctionToolCall) => void | Promise<void>;
  onToolComplete?: (
    toolCall: FunctionToolCall,
    result: ToolResult,
  ) => void | Promise<void>;
  onAfterToolExec?: (ctx: {
    toolCall: FunctionToolCall;
    result: ToolResult;
    toolUseUuid: string | null;
  }) => void | Promise<void>;
  onAfterToolExecEpochDiscard?: (ctx: {
    toolCall: FunctionToolCall;
    toolUseUuid: string | null;
    reason: string;
  }) => Promise<void>;
}

export class StreamingToolExecutor {
  private readonly delegate: PackageLocalStreamingToolExecutor;

  constructor(
    getChatService: () => IChatService,
    logger?: InternalLogger,
  ) {
    this.delegate = new PackageLocalStreamingToolExecutor(
      getChatService,
      (logger ?? NOOP_LOGGER).child(LogCategory.AGENT),
    );
  }

  collectAndExecute(
    messages: readonly Message[],
    tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
    signal: AbortSignal | undefined,
    executionConfig: StreamingToolExecutorConfig,
    epoch?: ExecutionEpoch,
  ): Promise<{
    chatResponse: ChatResponse;
    executionResults: ToolExecutionOutcome[];
  }> {
    return this.delegate.collectAndExecute(
      messages,
      tools as never,
      signal,
      executionConfig as unknown as PackageLocalStreamingToolExecutorConfig,
      epoch,
    ) as unknown as Promise<{
      chatResponse: ChatResponse;
      executionResults: ToolExecutionOutcome[];
    }>;
  }
}
