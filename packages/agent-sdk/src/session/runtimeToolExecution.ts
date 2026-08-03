import {
  createInterruptAwareAbortSignal,
  executeToolExecutionPlan,
  repairToolCallParams,
  resolveToolInterruptBehavior,
  type AgentFunctionToolCall,
  type ToolExecutionPlan,
  type ToolExecutionRegistryLike,
} from '@blade-ai/agent/loop';
import type { JsonObject } from '../types/common.js';
import type { SessionId } from './types.js';
import {
  ToolErrorType,
  type ExecutionContext,
  type ToolEffect,
  type ToolExecutionOutcomeOf,
  type ToolExecutionUpdateOf,
  type ToolResult,
} from '../tools/types/index.js';

export type PackageLocalToolExecutionOutcome = ToolExecutionOutcomeOf<AgentFunctionToolCall>;
export type PackageLocalToolExecutionUpdate = ToolExecutionUpdateOf<AgentFunctionToolCall>;

export type PackageLocalToolExecutionContext = ExecutionContext & {
  sessionId: SessionId;
  userId: string;
};

export interface PackageLocalToolExecutionPipelinePort<
  TExecutionContext extends PackageLocalToolExecutionContext = PackageLocalToolExecutionContext,
> {
  execute: (
    toolName: string,
    params: JsonObject,
    context: TExecutionContext,
  ) => Promise<ToolResult>;
  getRegistry: () => ToolExecutionRegistryLike;
}

export interface PackageLocalToolExecutionHooks {
  onBeforeToolExec?: (ctx: {
    toolCall: AgentFunctionToolCall;
    params: JsonObject;
  }) => Promise<string | null>;
  onToolReady?: (toolCall: AgentFunctionToolCall) => void | Promise<void>;
  onAfterToolExec?: (ctx: PackageLocalToolExecutionOutcome) => void | Promise<void>;
  onToolComplete?: (toolCall: AgentFunctionToolCall, result: ToolResult) => void | Promise<void>;
  onUpdate?: (update: PackageLocalToolExecutionUpdate) => void | Promise<void>;
}

export interface PackageLocalRunToolCallInput<
  TExecutionContext extends PackageLocalToolExecutionContext = PackageLocalToolExecutionContext,
> {
  toolCall: AgentFunctionToolCall;
  executionPipeline: PackageLocalToolExecutionPipelinePort<TExecutionContext>;
  executionContext: TExecutionContext;
  permissionMode?: ExecutionContext['permissionMode'];
  signal?: AbortSignal;
  batchSignal?: AbortSignal;
  hooks?: PackageLocalToolExecutionHooks;
  logger?: {
    error(message: string, error?: unknown): void;
  };
}

export interface PackageLocalExecuteToolCallsInput<
  TExecutionContext extends PackageLocalToolExecutionContext = PackageLocalToolExecutionContext,
> extends Omit<PackageLocalRunToolCallInput<TExecutionContext>, 'toolCall' | 'batchSignal'> {
  plan: ToolExecutionPlan;
}

export async function executePackageLocalToolCalls<
  TExecutionContext extends PackageLocalToolExecutionContext = PackageLocalToolExecutionContext,
>(
  input: PackageLocalExecuteToolCallsInput<TExecutionContext>,
): Promise<PackageLocalToolExecutionOutcome[]> {
  return executeToolExecutionPlan({
    plan: input.plan,
    execute: (toolCall) => executePackageLocalToolCall(toolCall, input),
  });
}

async function executePackageLocalToolCall<
  TExecutionContext extends PackageLocalToolExecutionContext,
>(
  toolCall: AgentFunctionToolCall,
  input: PackageLocalExecuteToolCallsInput<TExecutionContext>,
): Promise<PackageLocalToolExecutionOutcome> {
  await emitPackageLocalToolExecutionUpdate(input.hooks, {
    type: 'tool_ready',
    toolCall,
  });

  return runPackageLocalToolCall({
    toolCall,
    executionPipeline: input.executionPipeline,
    executionContext: input.executionContext,
    permissionMode: input.permissionMode,
    signal: input.signal,
    hooks: input.hooks,
    logger: input.logger,
  });
}

export async function runPackageLocalToolCall<
  TExecutionContext extends PackageLocalToolExecutionContext = PackageLocalToolExecutionContext,
>(
  input: PackageLocalRunToolCallInput<TExecutionContext>,
): Promise<PackageLocalToolExecutionOutcome> {
  let outcome: PackageLocalToolExecutionOutcome;

  try {
    const params = JSON.parse(input.toolCall.function.arguments) as JsonObject;
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
    await emitPackageLocalToolExecutionUpdate(input.hooks, {
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
          ...input.executionContext,
          signal: interruptSignal.signal,
          onProgress: (message) => {
            void emitPackageLocalToolExecutionUpdate(input.hooks, {
              type: 'tool_progress',
              toolCall: input.toolCall,
              message,
            });
          },
          updateOutput: (message) => {
            void emitPackageLocalToolExecutionUpdate(input.hooks, {
              type: 'tool_message',
              toolCall: input.toolCall,
              message,
            });
          },
          permissionMode: input.permissionMode,
        },
      );
    } finally {
      interruptSignal.cleanup();
    }

    outcome = { toolCall: input.toolCall, result, toolUseUuid };
  } catch (error) {
    input.logger?.error(`Tool execution failed for ${input.toolCall.function.name}:`, error);
    outcome = {
      toolCall: input.toolCall,
      result: {
        success: false,
        llmContent: '',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      toolUseUuid: null,
    };
  }

  for (const effect of normalizePackageLocalToolEffects(outcome.result)) {
    await emitPackageLocalToolExecutionUpdate(
      input.hooks,
      mapPackageLocalToolEffectToExecutionUpdate(outcome.toolCall, effect),
    );
  }

  await emitPackageLocalToolExecutionUpdate(input.hooks, {
    type: 'tool_result',
    outcome,
  });
  await emitPackageLocalToolExecutionUpdate(input.hooks, {
    type: 'tool_completed',
    outcome,
  });

  return outcome;
}

export async function emitPackageLocalToolExecutionUpdate(
  hooks: PackageLocalToolExecutionHooks | undefined,
  update: PackageLocalToolExecutionUpdate,
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
      await hooks?.onToolComplete?.(
        update.outcome.toolCall,
        update.outcome.result,
      );
      return;
  }
}

function normalizePackageLocalToolEffects(result: ToolResult): ToolEffect[] {
  const effects = [...(result.effects ?? [])];

  if (!effects.some((effect) => effect.type === 'runtimePatch') && result.runtimePatch) {
    effects.push({
      type: 'runtimePatch',
      patch: result.runtimePatch,
    });
  }

  if (!effects.some((effect) => effect.type === 'contextPatch') && result.contextPatch) {
    effects.push({
      type: 'contextPatch',
      patch: result.contextPatch,
    });
  }

  if (
    !effects.some((effect) => effect.type === 'newMessages')
    && result.newMessages
    && result.newMessages.length > 0
  ) {
    effects.push({
      type: 'newMessages',
      messages: result.newMessages,
    });
  }

  return effects;
}

function mapPackageLocalToolEffectToExecutionUpdate(
  toolCall: AgentFunctionToolCall,
  effect: ToolEffect,
): PackageLocalToolExecutionUpdate {
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
