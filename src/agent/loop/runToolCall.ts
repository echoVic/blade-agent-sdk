import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { ToolCatalog } from '../../tools/catalog/index.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import {
  normalizeToolEffects,
  type ToolEffect,
  type ToolResult,
  ToolErrorType,
} from '../../tools/types/index.js';
import type { BladeConfig, PermissionMode } from '../../types/common.js';
import type { IBackgroundAgentManager } from '../types.js';
import { repairToolCallParams } from './repairToolCallParams.js';
import {
  createInterruptAwareAbortSignal,
  resolveToolInterruptBehavior,
} from './toolInterruptBehavior.js';
import type { FunctionToolCall } from './types.js';

export interface ToolExecutionOutcome {
  toolCall: FunctionToolCall;
  result: ToolResult;
  toolUseUuid: string | null;
}

export type ToolExecutionUpdate =
  | {
      type: 'tool_ready';
      toolCall: FunctionToolCall;
    }
  | {
      type: 'tool_started';
      toolCall: FunctionToolCall;
      params: Record<string, unknown>;
      toolUseUuid: string | null;
    }
  | {
      type: 'tool_progress';
      toolCall: FunctionToolCall;
      message: string;
    }
  | {
      type: 'tool_message';
      toolCall: FunctionToolCall;
      message: string;
    }
  | {
      type: 'tool_runtime_patch';
      toolCall: FunctionToolCall;
      patch: Extract<ToolEffect, { type: 'runtimePatch' }>['patch'];
    }
  | {
      type: 'tool_context_patch';
      toolCall: FunctionToolCall;
      patch: Extract<ToolEffect, { type: 'contextPatch' }>['patch'];
    }
  | {
      type: 'tool_new_messages';
      toolCall: FunctionToolCall;
      messages: Extract<ToolEffect, { type: 'newMessages' }>['messages'];
    }
  | {
      type: 'tool_permission_updates';
      toolCall: FunctionToolCall;
      updates: Extract<ToolEffect, { type: 'permissionUpdates' }>['updates'];
    }
  | {
      type: 'tool_result';
      outcome: ToolExecutionOutcome;
    }
  | {
      type: 'tool_completed';
      outcome: ToolExecutionOutcome;
    };

export interface ToolExecutionContext {
  sessionId: string;
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
    params: Record<string, unknown>;
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
  const logger = input.logger ?? NOOP_LOGGER.child(LogCategory.AGENT);
  let outcome: ToolExecutionOutcome;

  try {
    const params = JSON.parse(input.toolCall.function.arguments) as Record<string, unknown>;
    await repairToolCallParams(input.toolCall, params);
    const interruptBehavior = resolveToolInterruptBehavior(
      input.executionPipeline.getRegistry(),
      input.toolCall.function.name,
      params,
    );
    const interruptSignal = createInterruptAwareAbortSignal({
      outerSignal: input.signal,
      batchSignal: input.batchSignal,
      interruptBehavior,
    });

    const toolUseUuid = await input.hooks?.onBeforeToolExec?.({
      toolCall: input.toolCall,
      params,
    }) ?? null;
    await emitToolExecutionUpdate(input.hooks, {
      type: 'tool_started',
      toolCall: input.toolCall,
      params,
      toolUseUuid,
    });

    let result: ToolResult;
    try {
      result = await input.executionPipeline.execute(
        input.toolCall.function.name,
        params,
        {
          sessionId: input.executionContext.sessionId,
          userId: input.executionContext.userId,
          contextSnapshot: input.executionContext.contextSnapshot,
          skillActivationPaths: input.executionContext.skillActivationPaths,
          signal: interruptSignal.signal,
          onProgress: (message) => {
            void emitToolExecutionUpdate(input.hooks, {
              type: 'tool_progress',
              toolCall: input.toolCall,
              message,
            });
          },
          updateOutput: (message) => {
            void emitToolExecutionUpdate(input.hooks, {
              type: 'tool_message',
              toolCall: input.toolCall,
              message,
            });
          },
          confirmationHandler: input.executionContext.confirmationHandler,
          bladeConfig: input.executionContext.bladeConfig,
          backgroundAgentManager: input.executionContext.backgroundAgentManager,
          toolCatalog: input.executionContext.toolCatalog,
          toolRegistry: input.executionContext.toolRegistry,
          discoveredTools: input.executionContext.discoveredTools,
          permissionMode: input.permissionMode,
        },
      );
    } finally {
      interruptSignal.cleanup();
    }

    outcome = { toolCall: input.toolCall, result, toolUseUuid };
  } catch (error) {
    logger.error(`Tool execution failed for ${input.toolCall.function.name}:`, error);
    outcome = {
      toolCall: input.toolCall,
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

  for (const effect of normalizeToolEffects(outcome.result)) {
    await emitToolExecutionUpdate(
      input.hooks,
      mapToolEffectToExecutionUpdate(outcome.toolCall, effect),
    );
  }
  await emitToolExecutionUpdate(input.hooks, {
    type: 'tool_result',
    outcome,
  });
  await emitToolExecutionUpdate(input.hooks, {
    type: 'tool_completed',
    outcome,
  });
  return outcome;
}

export async function emitToolExecutionUpdate(
  hooks: ToolExecutionHooks | undefined,
  update: ToolExecutionUpdate,
): Promise<void> {
  await hooks?.onUpdate?.(update);

  switch (update.type) {
    case 'tool_ready':
      await hooks?.onToolReady?.(update.toolCall);
      return;
    case 'tool_started':
    case 'tool_progress':
    case 'tool_message':
    case 'tool_runtime_patch':
    case 'tool_context_patch':
    case 'tool_new_messages':
    case 'tool_permission_updates':
      return;
    case 'tool_result':
      await hooks?.onAfterToolExec?.(update.outcome);
      return;
    case 'tool_completed':
      await hooks?.onToolComplete?.(update.outcome.toolCall, update.outcome.result);
      return;
  }
}

function mapToolEffectToExecutionUpdate(
  toolCall: FunctionToolCall,
  effect: ToolEffect,
): ToolExecutionUpdate {
  switch (effect.type) {
    case 'runtimePatch':
      return {
        type: 'tool_runtime_patch',
        toolCall,
        patch: effect.patch,
      };
    case 'contextPatch':
      return {
        type: 'tool_context_patch',
        toolCall,
        patch: effect.patch,
      };
    case 'newMessages':
      return {
        type: 'tool_new_messages',
        toolCall,
        messages: effect.messages,
      };
    case 'permissionUpdates':
      return {
        type: 'tool_permission_updates',
        toolCall,
        updates: effect.updates,
      };
  }
}
