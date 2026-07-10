import {
  executeToolExecutionPlan,
  type AgentFunctionToolCall,
} from '@blade-ai/agent/loop';
import type { InternalLogger } from '../../logging/Logger.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { PermissionMode } from '../../types/common.js';
import type { ToolExecutionPlan } from './planToolExecution.js';
import type {
  ToolExecutionContext,
  ToolExecutionHooks,
  ToolExecutionOutcome,
} from './runToolCall.js';
import { emitToolExecutionUpdate, runToolCall } from './runToolCall.js';

export type {
  ToolExecutionContext,
  ToolExecutionHooks,
  ToolExecutionOutcome,
} from './runToolCall.js';

interface ExecuteToolCallsInput {
  plan: ToolExecutionPlan;
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  hooks?: ToolExecutionHooks;
}

export async function executeToolCalls(
  input: ExecuteToolCallsInput,
): Promise<ToolExecutionOutcome[]> {
  return executeToolExecutionPlan({
    plan: input.plan,
    execute: (toolCall) => executeToolCall(toolCall, input),
  });
}

async function executeToolCall(
  toolCall: AgentFunctionToolCall,
  input: ExecuteToolCallsInput,
): Promise<ToolExecutionOutcome> {
  await emitToolExecutionUpdate(input.hooks, {
    type: 'tool_ready',
    toolCall,
  });

  return runToolCall({
    toolCall,
    executionPipeline: input.executionPipeline,
    executionContext: input.executionContext,
    permissionMode: input.permissionMode,
    signal: input.signal,
    hooks: input.hooks,
    logger: input.logger,
  });
}
