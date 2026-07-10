import {
  executeToolExecutionPlan,
  type AgentFunctionToolCall,
} from '@blade-ai/agent/loop';
import type { InternalLogger } from '../../logging/Logger.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { PermissionMode } from '../../types/common.js';
import type {
  RunToolCallPort,
  ToolExecutionContext,
  ToolExecutionHooks,
  ToolExecutionOutcome,
  ToolExecutionUpdate,
} from './adapterContracts.js';
import type { ToolExecutionPlan } from './planToolExecution.js';

export type {
  ToolExecutionContext,
  ToolExecutionHooks,
  ToolExecutionOutcome,
} from './adapterContracts.js';

interface ExecuteToolCallsInput {
  plan: ToolExecutionPlan;
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  hooks?: ToolExecutionHooks;
}

export function createExecuteToolCalls(
  runToolCall: RunToolCallPort,
): (input: ExecuteToolCallsInput) => Promise<ToolExecutionOutcome[]> {
  return async function executeToolCalls(
    input: ExecuteToolCallsInput,
  ): Promise<ToolExecutionOutcome[]> {
    return executeToolExecutionPlan({
      plan: input.plan,
      execute: (toolCall) => executeToolCall(toolCall, input, runToolCall),
    });
  };
}

async function executeToolCall(
  toolCall: AgentFunctionToolCall,
  input: ExecuteToolCallsInput,
  runToolCall: RunToolCallPort,
): Promise<ToolExecutionOutcome> {
  const readyUpdate: ToolExecutionUpdate = {
    type: 'tool_ready',
    toolCall,
  };

  await input.hooks?.onUpdate?.(readyUpdate);
  await input.hooks?.onToolReady?.(toolCall);

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
