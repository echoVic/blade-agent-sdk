import { isHookProcessContainmentError } from '../../hooks/WindowsProcessJob.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { ModelToolCall } from '../../model/message.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import {
  type DurableExecutionFence,
  isExecutionLeaseFailure,
} from '../../session/events/DurableExecutionLeaseStore.js';
import type { ToolCatalog } from '../../tools/catalog/index.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ToolEffect } from '../../tools/types/effects.js';
import type { ConfirmationHandler, ToolExecutionLifecycle } from '../../tools/types/execution.js';
import { resolveToolBehaviorSafely, ToolSideEffect } from '../../tools/types/kind.js';
import type { ToolResult, ToolYield } from '../../tools/types/result.js';
import { ToolErrorType } from '../../tools/types/result.js';
import { isSteeringInterruptSignal } from '../../types/abort.js';
import type { PermissionMode } from '../../types/constants.js';
import {
  type MessageId,
  type ModelAttemptId,
  type SessionId,
  ToolUseId,
} from '../../types/identifiers.js';
import type { JsonObject } from '../../types/json.js';
import type { BladeConfig } from '../config.js';
import type { IBackgroundAgentManager } from '../types.js';
import { repairToolCallParams } from './repairToolCallParams.js';
import {
  createInterruptAwareAbortSignal,
  resolveToolInterruptBehavior,
} from './toolInterruptBehavior.js';

export interface ToolExecutionOutcome {
  toolCall: ModelToolCall;
  result: ToolResult;
  effects: ToolEffect[];
  toolMessageId: MessageId | null;
}

export type ToolExecutionUpdate =
  | {
      type: 'tool_ready';
      toolCall: ModelToolCall;
    }
  | {
      type: 'tool_started';
      toolCall: ModelToolCall;
      params: JsonObject;
      toolMessageId: MessageId | null;
    }
  | {
      type: 'tool_progress';
      toolCall: ModelToolCall;
      progress: Extract<ToolYield, { kind: 'progress' }>;
    }
  | {
      type: 'tool_message';
      toolCall: ModelToolCall;
      content: Extract<ToolYield, { kind: 'message' }>['content'];
    }
  | {
      type: 'tool_runtime_patch';
      toolCall: ModelToolCall;
      patch: Extract<ToolEffect, { type: 'runtimePatch' }>['patch'];
    }
  | {
      type: 'tool_context_patch';
      toolCall: ModelToolCall;
      patch: Extract<ToolEffect, { type: 'contextPatch' }>['patch'];
    }
  | {
      type: 'tool_new_messages';
      toolCall: ModelToolCall;
      messages: Extract<ToolEffect, { type: 'newMessages' }>['messages'];
    }
  | {
      type: 'tool_permission_updates';
      toolCall: ModelToolCall;
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
  modelAttemptId?: ModelAttemptId;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  confirmationHandler?: ConfirmationHandler;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: IBackgroundAgentManager;
  executionFence?: DurableExecutionFence;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  toolCatalog?: ToolCatalog;
  toolRegistry?: ToolRegistry;
  discoveredTools?: string[];
  lifecycle?: ToolExecutionLifecycle;
}

export interface ToolExecutionHooks {
  onBeforeToolExec?: (ctx: {
    toolCall: ModelToolCall;
    params: JsonObject;
  }) => Promise<MessageId | null>;
  onToolReady?: (toolCall: ModelToolCall) => void | Promise<void>;
  onAfterToolExec?: (ctx: ToolExecutionOutcome) => void | Promise<void>;
  onToolComplete?: (toolCall: ModelToolCall, result: ToolResult) => void | Promise<void>;
  onUpdate?: (update: ToolExecutionUpdate) => void | Promise<void>;
}

export interface RunToolCallInput {
  toolCall: ModelToolCall;
  executionPipeline: ExecutionPipeline;
  executionContext: ToolExecutionContext;
  logger?: InternalLogger;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  steeringSignal?: AbortSignal;
  hooks?: ToolExecutionHooks;
  batchSignal?: AbortSignal;
}

export async function runToolCall(input: RunToolCallInput): Promise<ToolExecutionOutcome> {
  const logger = input.logger ?? NOOP_LOGGER.child(LogCategory.AGENT);
  let interruptBehavior: 'cancel' | 'block' = 'block';
  let sideEffect: ToolSideEffect = ToolSideEffect.NON_IDEMPOTENT;
  let modelInput: JsonObject;
  let params: JsonObject;

  try {
    const parsed: unknown = JSON.parse(input.toolCall.function.arguments);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object');
    }
    params = parsed as JsonObject;
    modelInput = structuredClone(params);
    await repairToolCallParams(input.toolCall, params);
    interruptBehavior = resolveToolInterruptBehavior(
      input.executionPipeline.getRegistry(),
      input.toolCall.function.name,
      params,
    );
    sideEffect =
      resolveToolBehaviorSafely(
        input.executionPipeline.getRegistry().get(input.toolCall.function.name),
        params,
      )?.sideEffect ?? ToolSideEffect.NON_IDEMPOTENT;
  } catch (error) {
    const outcome = buildFailedOutcome(
      input.toolCall,
      error,
      interruptBehavior,
      input.steeringSignal,
    );
    await emitToolExecutionUpdate(input.hooks, {
      type: 'tool_ready',
      toolCall: input.toolCall,
    });
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

  const invocationLifecycle = await input.executionContext.lifecycle?.onToolScheduled?.({
    toolCallId: ToolUseId(input.toolCall.id),
    toolName: input.toolCall.function.name,
    ...(input.executionContext.modelAttemptId
      ? { modelAttemptId: input.executionContext.modelAttemptId }
      : {}),
    modelInput,
    input: structuredClone(params),
    sideEffect,
    interruptBehavior,
  });
  await emitToolExecutionUpdate(input.hooks, {
    type: 'tool_ready',
    toolCall: input.toolCall,
  });

  let outcome: ToolExecutionOutcome;
  try {
    const interruptSignal = createInterruptAwareAbortSignal({
      requestSignal: input.signal,
      steeringSignal: input.steeringSignal,
      batchSignal: input.batchSignal,
      interruptBehavior,
    });

    const toolMessageId =
      (await input.hooks?.onBeforeToolExec?.({
        toolCall: input.toolCall,
        params,
      })) ?? null;
    await emitToolExecutionUpdate(input.hooks, {
      type: 'tool_started',
      toolCall: input.toolCall,
      params,
      toolMessageId,
    });

    let result: ToolResult | undefined;
    const effects: ToolEffect[] = [];
    let execution: ReturnType<ExecutionPipeline['execute']> | undefined;
    let executionCompleted = false;
    let executionFailed = false;
    let executionFailure: unknown;
    let closeFailure: unknown;
    try {
      execution = input.executionPipeline.execute(input.toolCall.function.name, params, {
        sessionId: input.executionContext.sessionId,
        userId: input.executionContext.userId,
        contextSnapshot: input.executionContext.contextSnapshot,
        skillActivationPaths: input.executionContext.skillActivationPaths,
        signal: interruptSignal.signal,
        confirmationHandler: input.executionContext.confirmationHandler,
        bladeConfig: input.executionContext.bladeConfig,
        backgroundAgentManager: input.executionContext.backgroundAgentManager,
        executionFence: input.executionContext.executionFence,
        assertExecutionLease: input.executionContext.assertExecutionLease,
        runWithExecutionLease: input.executionContext.runWithExecutionLease,
        toolCatalog: input.executionContext.toolCatalog,
        toolRegistry: input.executionContext.toolRegistry,
        discoveredTools: input.executionContext.discoveredTools,
        permissionMode: input.permissionMode,
        toolInvocationLifecycle: invocationLifecycle,
      });
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
    } catch (error) {
      executionFailed = true;
      executionFailure = error;
    } finally {
      if (execution && !executionCompleted) {
        try {
          await execution.return(undefined as never);
        } catch (error) {
          if (isExecutionLeaseFailure(error) || isHookProcessContainmentError(error)) {
            closeFailure = error;
          }
        }
      }
      interruptSignal.cleanup();
    }

    if (closeFailure !== undefined) {
      throw executionFailed
        ? new AggregateError(
            [executionFailure, closeFailure],
            'Tool execution and cleanup both failed',
          )
        : closeFailure;
    }
    if (executionFailed) {
      throw executionFailure;
    }
    if (!result) {
      throw new Error('Tool execution completed without a result');
    }
    if (
      result.status === 'error' &&
      interruptBehavior === 'cancel' &&
      isSteeringInterruptSignal(input.steeringSignal)
    ) {
      result = {
        ...result,
        error: {
          ...result.error,
          type: ToolErrorType.INTERRUPTED,
        },
      };
    }
    outcome = { toolCall: input.toolCall, result, effects, toolMessageId };
  } catch (error) {
    if (isExecutionLeaseFailure(error) || isHookProcessContainmentError(error)) {
      throw error;
    }
    logger.error(`Tool execution failed for ${input.toolCall.function.name}:`, error);
    outcome = buildFailedOutcome(input.toolCall, error, interruptBehavior, input.steeringSignal);
  }

  await input.executionContext.lifecycle?.onToolSettled?.({
    toolCallId: ToolUseId(input.toolCall.id),
    toolName: input.toolCall.function.name,
    result: outcome.result,
  });
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

function buildFailedOutcome(
  toolCall: ModelToolCall,
  error: unknown,
  interruptBehavior: 'cancel' | 'block',
  steeringSignal: AbortSignal | undefined,
): ToolExecutionOutcome {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const interrupted = interruptBehavior === 'cancel' && isSteeringInterruptSignal(steeringSignal);
  return {
    toolCall,
    result: {
      status: 'error',
      model: `Tool execution failed: ${message}`,
      error: {
        type: interrupted ? ToolErrorType.INTERRUPTED : ToolErrorType.EXECUTION_ERROR,
        message,
      },
    },
    effects: [],
    toolMessageId: null,
  };
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
  toolCall: ModelToolCall,
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
  toolCall: ModelToolCall,
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
