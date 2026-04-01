import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../tools/types/index.js';
import { ToolErrorType } from '../../tools/types/index.js';
import type { PermissionMode } from '../../types/common.js';
import type { ToolExecutionPlan } from './planToolExecution.js';
import type { FunctionToolCall } from './types.js';

interface ToolExecutionContext {
  sessionId: string;
  userId: string;
  contextSnapshot?: ContextSnapshot;
  confirmationHandler?: ConfirmationHandler;
}

interface ToolExecutionHooks {
  onBeforeToolExec?: (ctx: {
    toolCall: FunctionToolCall;
    params: Record<string, unknown>;
  }) => Promise<string | null>;
}

interface ExecuteToolCallsInput {
  plan: ToolExecutionPlan;
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  hooks?: ToolExecutionHooks;
}

export interface ToolExecutionOutcome {
  toolCall: FunctionToolCall;
  result: ToolResult;
  toolUseUuid: string | null;
}

export async function executeToolCalls(
  input: ExecuteToolCallsInput,
): Promise<ToolExecutionOutcome[]> {
  const { plan } = input;
  if (plan.mode === 'serial') {
    const results: ToolExecutionOutcome[] = [];
    for (const toolCall of plan.calls) {
      results.push(await executeToolCall(toolCall, input));
    }
    return results;
  }

  if (plan.mode === 'mixed') {
    const groups = plan.groups ?? plan.calls.map((toolCall) => [toolCall]);
    const results: ToolExecutionOutcome[] = [];

    for (const group of groups) {
      const groupResults = await executeWithConcurrency(
        group,
        5,
        (toolCall) => executeToolCall(toolCall, input),
      );
      results.push(...groupResults);
    }

    return results;
  }

  return executeWithConcurrency(
    plan.calls,
    5,
    (toolCall) => executeToolCall(toolCall, input),
  );
}

async function executeToolCall(
  toolCall: FunctionToolCall,
  input: ExecuteToolCallsInput,
): Promise<ToolExecutionOutcome> {
  const logger = input.logger ?? NOOP_LOGGER.child(LogCategory.AGENT);
  try {
    const params = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    await repairToolCallParams(toolCall, params);

    const toolUseUuid = await input.hooks?.onBeforeToolExec?.({
      toolCall,
      params,
    }) ?? null;

    const result = await input.executionPipeline.execute(
      toolCall.function.name,
      params,
      {
        sessionId: input.executionContext.sessionId,
        userId: input.executionContext.userId,
        contextSnapshot: input.executionContext.contextSnapshot,
        signal: input.signal,
        confirmationHandler: input.executionContext.confirmationHandler,
        permissionMode: input.permissionMode,
      },
    );

    return { toolCall, result, toolUseUuid };
  } catch (error) {
    logger.error(`Tool execution failed for ${toolCall.function.name}:`, error);
    return {
      toolCall,
      result: {
        success: false,
        llmContent: '',
        displayContent: '',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      toolUseUuid: null,
    };
  }
}

async function repairToolCallParams(
  toolCall: FunctionToolCall,
  params: Record<string, unknown>,
): Promise<void> {
  if (
    toolCall.function.name === 'Task'
    && (typeof params.subagent_session_id !== 'string' || params.subagent_session_id.length === 0)
  ) {
    const { nanoid } = await import('nanoid');
    params.subagent_session_id =
      typeof params.resume === 'string' && params.resume.length > 0
        ? params.resume
        : nanoid();
  }

  if (typeof params.todos === 'string') {
    try {
      params.todos = JSON.parse(params.todos) as unknown;
    } catch {
      // Let the validation layer handle malformed todos payloads.
    }
  }
}

async function executeWithConcurrency(
  calls: FunctionToolCall[],
  maxConcurrency: number,
  executor: (toolCall: FunctionToolCall) => Promise<ToolExecutionOutcome>,
): Promise<ToolExecutionOutcome[]> {
  const results = new Array<ToolExecutionOutcome>(calls.length);
  let nextIndex = 0;

  const workerCount = Math.min(maxConcurrency, calls.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < calls.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await executor(calls[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}
