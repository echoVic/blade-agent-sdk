import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { ToolCatalog } from '../../tools/catalog/index.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import {
  type ToolEffect,
  ToolErrorType,
  type ToolResult,
  type ToolYield,
} from '../../tools/types/index.js';
import { isSteeringInterruptSignal } from '../../types/abort.js';
import type { SessionId } from '../../types/branded.js';
import type { BladeConfig, JsonObject, PermissionMode } from '../../types/common.js';
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
  effects: ToolEffect[];
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
      params: JsonObject;
      toolUseUuid: string | null;
    }
  | {
      type: 'tool_progress';
      toolCall: FunctionToolCall;
      progress: Extract<ToolYield, { kind: 'progress' }>;
    }
  | {
      type: 'tool_message';
      toolCall: FunctionToolCall;
      content: Extract<ToolYield, { kind: 'message' }>['content'];
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
  steeringSignal?: AbortSignal;
  hooks?: ToolExecutionHooks;
  batchSignal?: AbortSignal;
}

export async function runToolCall(
  input: RunToolCallInput,
): Promise<ToolExecutionOutcome> {
  const logger = input.logger ?? NOOP_LOGGER.child(LogCategory.AGENT);
  let outcome: ToolExecutionOutcome;
  let interruptBehavior: 'cancel' | 'block' = 'block';

  try {
    const params = JSON.parse(input.toolCall.function.arguments) as JsonObject;
    await repairToolCallParams(input.toolCall, params);
    interruptBehavior = resolveToolInterruptBehavior(
      input.executionPipeline.getRegistry(),
      input.toolCall.function.name,
      params,
    );
    const interruptSignal = createInterruptAwareAbortSignal({
      requestSignal: input.signal,
      steeringSignal: input.steeringSignal,
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
    const effects: ToolEffect[] = [];
    let execution: ReturnType<ExecutionPipeline['execute']> | undefined;
    let executionCompleted = false;
    try {
      execution = input.executionPipeline.execute(
        input.toolCall.function.name,
        params,
        {
          sessionId: input.executionContext.sessionId,
          userId: input.executionContext.userId,
          contextSnapshot: input.executionContext.contextSnapshot,
          skillActivationPaths: input.executionContext.skillActivationPaths,
          signal: interruptSignal.signal,
          confirmationHandler: input.executionContext.confirmationHandler,
          bladeConfig: input.executionContext.bladeConfig,
          backgroundAgentManager: input.executionContext.backgroundAgentManager,
          toolCatalog: input.executionContext.toolCatalog,
          toolRegistry: input.executionContext.toolRegistry,
          discoveredTools: input.executionContext.discoveredTools,
          permissionMode: input.permissionMode,
        },
      );
      while (true) {
        const step = await execution.next();
        if (step.done) {
          result = step.value;
          executionCompleted = true;
          break;
        }
        if (step.value.kind === 'effect') {
          effects.push(step.value.effect);
        }
        await emitToolExecutionUpdate(
          input.hooks,
          mapToolYieldToExecutionUpdate(input.toolCall, step.value),
        );
      }
      if (
        result.status === 'error'
        && interruptBehavior === 'cancel'
        && isSteeringInterruptSignal(input.steeringSignal)
      ) {
        result = {
          ...result,
          error: {
            ...result.error,
            type: ToolErrorType.INTERRUPTED,
          },
        };
      }
    } finally {
      if (execution && !executionCompleted) {
        try {
          await execution.return(undefined as never);
        } catch {
          // Preserve the original execution or event-consumer failure.
        }
      }
      interruptSignal.cleanup();
    }

    outcome = { toolCall: input.toolCall, result, effects, toolUseUuid };
  } catch (error) {
    logger.error(`Tool execution failed for ${input.toolCall.function.name}:`, error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const interrupted =
      interruptBehavior === 'cancel'
      && isSteeringInterruptSignal(input.steeringSignal);
    outcome = {
      toolCall: input.toolCall,
      result: {
        status: 'error',
        model: `Tool execution failed: ${message}`,
        error: {
          type: interrupted
            ? ToolErrorType.INTERRUPTED
            : ToolErrorType.EXECUTION_ERROR,
          message,
        },
      },
      effects: [],
      toolUseUuid: null,
    };
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

function mapToolYieldToExecutionUpdate(
  toolCall: FunctionToolCall,
  event: ToolYield,
): ToolExecutionUpdate {
  switch (event.kind) {
    case 'progress':
      return {
        type: 'tool_progress',
        toolCall,
        progress: event,
      };
    case 'message':
      return {
        type: 'tool_message',
        toolCall,
        content: event.content,
      };
    case 'effect':
      return mapToolEffectToExecutionUpdate(toolCall, event.effect);
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
