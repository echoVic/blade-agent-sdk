import type { JsonObject } from '@blade-ai/ai';
import type {
  AgentLoopTurnStateFields,
  AgentLoopTurnStateProjection,
} from './turnState.js';
import {
  resolveToolBehaviorSafely,
  ToolKind,
  type ToolBehavior,
  type ToolExecutionRegistryEntry,
  type ToolExecutionRegistryLike,
  type ToolInterruptBehavior,
} from './toolBehavior.js';

export {
  ToolKind,
  type ToolBehavior,
  type ToolExecutionRegistryEntry,
  type ToolExecutionRegistryLike,
  type ToolInterruptBehavior,
};

export interface AgentFunctionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentToolCallCandidate {
  id?: unknown;
  type?: unknown;
  function?: unknown;
}

export type ToolExecutionPermissionMode = 'default' | 'autoEdit' | 'yolo' | 'plan';

export interface ToolExecutionPlan {
  mode: 'parallel' | 'serial' | 'mixed';
  calls: AgentFunctionToolCall[];
  groups?: AgentFunctionToolCall[][];
}

export interface AgentLoopToolExecutionPlanInput {
  calls: AgentFunctionToolCall[];
  registry: ToolExecutionRegistryLike;
  permissionMode?: ToolExecutionPermissionMode;
}

export interface AgentLoopToolExecutionPlanProjectionInput<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
> {
  calls: AgentFunctionToolCall[];
  registry: ToolExecutionRegistryLike;
  turnStateProjection: AgentLoopTurnStateProjection<TTurnState>;
}

export interface AgentLoopExecuteToolCallsInput<
  TExecutionPipeline,
  TExecutionContext,
  TLogger,
  THooks,
> {
  plan: ToolExecutionPlan;
  executionPipeline: TExecutionPipeline;
  executionContext: TExecutionContext;
  logger?: TLogger;
  permissionMode?: ToolExecutionPermissionMode;
  signal?: AbortSignal;
  hooks: THooks;
}

export interface AgentLoopExecuteToolCallsProjectionInput<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline,
  TLogger,
  THooks,
> {
  plan: ToolExecutionPlan;
  executionPipeline: TExecutionPipeline;
  turnStateProjection: AgentLoopTurnStateProjection<TTurnState>;
  logger?: TLogger;
  signal?: AbortSignal;
  hooks: THooks;
}

export interface AgentLoopExecuteToolCallsHooksInput<TBeforeExec, TOnUpdate> {
  beforeExec?: TBeforeExec;
  onUpdate?: TOnUpdate;
}

export interface AgentLoopExecuteToolCallsHooks<TBeforeExec, TOnUpdate> {
  onBeforeToolExec?: TBeforeExec;
  onUpdate?: TOnUpdate;
}

export function buildAgentLoopExecuteToolCallsHooksInput<TBeforeExec, TOnUpdate>(
  input: AgentLoopExecuteToolCallsHooksInput<TBeforeExec, TOnUpdate>,
): AgentLoopExecuteToolCallsHooks<TBeforeExec, TOnUpdate> {
  return {
    onBeforeToolExec: input.beforeExec,
    onUpdate: input.onUpdate,
  };
}

export function buildAgentLoopExecuteToolCallsInput<
  TExecutionPipeline,
  TExecutionContext,
  TLogger,
  THooks,
>(
  input: AgentLoopExecuteToolCallsInput<
    TExecutionPipeline,
    TExecutionContext,
    TLogger,
    THooks
  >,
): AgentLoopExecuteToolCallsInput<
  TExecutionPipeline,
  TExecutionContext,
  TLogger,
  THooks
> {
  return {
    plan: input.plan,
    executionPipeline: input.executionPipeline,
    executionContext: input.executionContext,
    logger: input.logger,
    permissionMode: input.permissionMode,
    signal: input.signal,
    hooks: input.hooks,
  };
}

export function buildAgentLoopExecuteToolCallsInputFromTurnProjection<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline,
  TLogger,
  THooks,
>(
  input: AgentLoopExecuteToolCallsProjectionInput<
    TTurnState,
    TExecutionPipeline,
    TLogger,
    THooks
  >,
): AgentLoopExecuteToolCallsInput<
  TExecutionPipeline,
  AgentLoopTurnStateProjection<TTurnState>['executionContext'],
  TLogger,
  THooks
> {
  return buildAgentLoopExecuteToolCallsInput({
    plan: input.plan,
    executionPipeline: input.executionPipeline,
    executionContext: input.turnStateProjection.executionContext,
    logger: input.logger,
    permissionMode: input.turnStateProjection.permissionMode,
    signal: input.signal,
    hooks: input.hooks,
  });
}

export function buildAgentLoopToolExecutionPlanInput(
  input: AgentLoopToolExecutionPlanInput,
): AgentLoopToolExecutionPlanInput {
  return {
    calls: input.calls,
    registry: input.registry,
    permissionMode: input.permissionMode,
  };
}

export function buildAgentLoopToolExecutionPlanInputFromTurnProjection<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
>(
  input: AgentLoopToolExecutionPlanProjectionInput<TTurnState>,
): AgentLoopToolExecutionPlanInput {
  return buildAgentLoopToolExecutionPlanInput({
    calls: input.calls,
    registry: input.registry,
    permissionMode: input.turnStateProjection.permissionMode,
  });
}

export function shouldRunAgentLoopNonStreamingToolExecution<TExecutionResult>(
  executionResults: readonly TExecutionResult[] | undefined,
): executionResults is undefined {
  return executionResults === undefined;
}

export function shouldEmitAgentLoopNonStreamingToolResultEffects<TExecutionResult>(
  streamingExecutionResults: readonly TExecutionResult[] | undefined,
): streamingExecutionResults is undefined {
  return streamingExecutionResults === undefined;
}

function isAgentFunctionToolCall(call: unknown): call is AgentFunctionToolCall {
  if (!call || typeof call !== 'object') {
    return false;
  }

  const candidate = call as AgentToolCallCandidate;
  if (typeof candidate.id !== 'string' || candidate.type !== 'function') {
    return false;
  }

  if (!candidate.function || typeof candidate.function !== 'object') {
    return false;
  }

  const functionCall = candidate.function as { name?: unknown; arguments?: unknown };
  return typeof functionCall.name === 'string' && typeof functionCall.arguments === 'string';
}

export function selectAgentFunctionToolCalls(
  calls: readonly unknown[] | undefined,
): AgentFunctionToolCall[] {
  return (calls ?? []).filter(isAgentFunctionToolCall);
}

export function planToolExecution(
  calls: AgentFunctionToolCall[],
  registry: ToolExecutionRegistryLike,
  permissionMode?: ToolExecutionPermissionMode,
): ToolExecutionPlan {
  if (calls.length === 1 || permissionMode === 'plan') {
    return {
      mode: 'serial',
      calls,
    };
  }

  if (calls.length === 0) {
    return {
      mode: 'parallel',
      calls,
    };
  }

  const readonlyCalls: AgentFunctionToolCall[] = [];
  const nonReadonlyCalls: AgentFunctionToolCall[] = [];

  for (const call of calls) {
    const tool = registry.get(call.function.name);
    const parsedArgs = parseToolArguments(call.function.arguments);
    const behavior = parsedArgs ? resolveToolBehaviorSafely(tool, parsedArgs) : undefined;

    if (
      (behavior?.isReadOnly && behavior.isConcurrencySafe) ||
      (!behavior && tool?.kind === ToolKind.ReadOnly && tool?.isConcurrencySafe !== false)
    ) {
      readonlyCalls.push(call);
      continue;
    }

    nonReadonlyCalls.push(call);
  }

  if (nonReadonlyCalls.length === 0) {
    return {
      mode: 'parallel',
      calls,
    };
  }

  if (readonlyCalls.length === 0) {
    return {
      mode: 'serial',
      calls,
    };
  }

  const groups: AgentFunctionToolCall[][] = [
    readonlyCalls,
    ...nonReadonlyCalls.map((call) => [call]),
  ];

  return {
    mode: 'mixed',
    calls: [...readonlyCalls, ...nonReadonlyCalls],
    groups,
  };
}

export function planAgentLoopToolExecution(
  input: AgentLoopToolExecutionPlanInput,
): ToolExecutionPlan {
  return planToolExecution(input.calls, input.registry, input.permissionMode);
}

function parseToolArguments(argumentsText: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}
