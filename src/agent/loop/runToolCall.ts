import {
  runPackageLocalToolCall,
} from '@blade-ai/agent-sdk/session/internal';
import type {
  ToolExecutionOutcomeOf as SdkToolExecutionOutcome,
  ToolExecutionUpdateOf as SdkToolExecutionUpdate,
} from '@blade-ai/agent-sdk/tools';
import type { AgentFunctionToolCall as FunctionToolCall } from '@blade-ai/agent/loop';
import type { JsonObject } from '../../types/common.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { ToolCatalog } from '../../tools/catalog/index.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { BladeConfig, PermissionMode } from '../../types/common.js';
import type { SessionId } from '../../types/branded.js';
import type { IBackgroundAgentManager } from '../types.js';

type PackageLocalRunToolCallInput = Parameters<typeof runPackageLocalToolCall>[0];

export type ToolExecutionOutcome = SdkToolExecutionOutcome<FunctionToolCall>;

export type ToolExecutionUpdate = SdkToolExecutionUpdate<FunctionToolCall>;

export interface ToolExecutionContext {
  sessionId: SessionId;
  userId: string;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  confirmationHandler?: ConfirmationHandler;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: IBackgroundAgentManager;
  toolCatalog?: ToolCatalog;
  toolRegistry?: ToolRegistry;
  discoveredTools?: string[];
}

export interface ToolExecutionHooks {
  onBeforeToolExec?: (ctx: {
    toolCall: FunctionToolCall;
    params: JsonObject;
  }) => Promise<string | null>;
  onToolReady?: (toolCall: FunctionToolCall) => void | Promise<void>;
  onAfterToolExec?: (ctx: ToolExecutionOutcome) => void | Promise<void>;
  onToolComplete?: (toolCall: FunctionToolCall, result: ToolResult) => void | Promise<void>;
  onUpdate?: (update: ToolExecutionUpdate) => void | Promise<void>;
}

export interface RunToolCallInput {
  toolCall: FunctionToolCall;
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  hooks?: ToolExecutionHooks;
  batchSignal?: AbortSignal;
}

export async function runToolCall(
  input: RunToolCallInput,
): Promise<ToolExecutionOutcome> {
  return runPackageLocalToolCall({
    ...input,
    logger: input.logger ?? NOOP_LOGGER.child(LogCategory.AGENT),
  } as unknown as PackageLocalRunToolCallInput) as unknown as Promise<ToolExecutionOutcome>;
}
