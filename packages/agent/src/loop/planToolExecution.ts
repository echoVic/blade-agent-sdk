import type { JsonObject } from '@blade-ai/ai';
import type {
  AgentLoopTurnStateFields,
  AgentLoopTurnStateProjection,
} from './turnState.js';
import {
  handleAgentLoopAbortIfRequested,
  type AgentLoopAbortCompletionTimingSource,
  type AgentLoopAbortCompletionToolResultTrackerLike,
  type AgentLoopAbortIfRequestedEvent,
  type AgentLoopAbortResult,
} from './loopResult.js';
import {
  buildAgentLoopToolStartEvents,
  buildAgentLoopToolStartEventsInputFromExecutionPipeline,
  type AgentLoopToolStartEvent,
} from './toolStartEvent.js';
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

export interface AgentLoopToolExecutionPlanExecutionPipelineProjectionInput<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
> {
  calls: AgentFunctionToolCall[];
  executionPipeline: TExecutionPipeline;
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
  hooks?: THooks;
}

export interface AgentLoopExecuteToolCallsProjectionInput<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline,
  TLogger,
  THooks,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
> {
  plan: ToolExecutionPlan;
  executionPipeline: TExecutionPipeline;
  turnStateProjection: AgentLoopTurnStateProjection<TTurnState>;
  logger?: TLogger;
  signal?: AbortSignal;
  hooks?: THooks;
  hookContainer?: AgentLoopExecuteToolCallsHookContainerInput<TBeforeExec, TOnUpdate> | null;
}

export interface AgentLoopExecuteToolCallsHooksInput<TBeforeExec, TOnUpdate> {
  beforeExec?: TBeforeExec;
  onUpdate?: TOnUpdate;
}

export interface AgentLoopExecuteToolCallsHookContainerInput<TBeforeExec, TOnUpdate> {
  tool?: AgentLoopExecuteToolCallsHooksInput<TBeforeExec, TOnUpdate> | null;
}

export interface AgentLoopExecuteToolCallsHooks<TBeforeExec, TOnUpdate> {
  onBeforeToolExec?: TBeforeExec;
  onUpdate?: TOnUpdate;
}

export interface AgentLoopToolExecutionResponseLike {
  toolCalls?: readonly unknown[];
}

export interface PrepareAgentLoopNonStreamingToolExecutionInput<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TExecutionResult,
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
> {
  executionResults: readonly TExecutionResult[] | undefined;
  response: AgentLoopToolExecutionResponseLike;
  executionPipeline: TExecutionPipeline;
  turnStateProjection: AgentLoopTurnStateProjection<TTurnState>;
  logger?: TLogger;
  signal?: AbortSignal;
  hooks?: AgentLoopExecuteToolCallsHookContainerInput<TBeforeExec, TOnUpdate> | null;
}

export interface HandleAgentLoopNonStreamingToolExecutionGateInput<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TExecutionResult,
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
> extends PrepareAgentLoopNonStreamingToolExecutionInput<
    TTurnState,
    TExecutionPipeline,
    TExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  > {
  loopClock: AgentLoopAbortCompletionTimingSource;
  turnsCount: number;
  toolResultTracker: AgentLoopAbortCompletionToolResultTrackerLike;
}

export interface HandleAgentLoopNonStreamingToolExecutionInput<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TExecutionResult,
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
> extends HandleAgentLoopNonStreamingToolExecutionGateInput<
    TTurnState,
    TExecutionPipeline,
    TExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  > {
  executeToolCalls(
    input: AgentLoopExecuteToolCallsInput<
      TExecutionPipeline,
      AgentLoopTurnStateProjection<TTurnState>['executionContext'],
      TLogger,
      AgentLoopExecuteToolCallsHooks<TBeforeExec, TOnUpdate> | undefined
    >,
  ): Promise<readonly TExecutionResult[]> | readonly TExecutionResult[];
}

export type AgentLoopNonStreamingToolExecutionPreparation<
  TExecutionPipeline,
  TExecutionContext,
  TExecutionResult,
  TLogger,
  TBeforeExec,
  TOnUpdate,
> =
  | {
      action: 'skip';
      executionResults: readonly TExecutionResult[];
    }
  | {
      action: 'execute';
      functionCalls: AgentFunctionToolCall[];
      executionPlan: ToolExecutionPlan;
      events: AgentLoopToolStartEvent[];
      executeInput: AgentLoopExecuteToolCallsInput<
        TExecutionPipeline,
        TExecutionContext,
        TLogger,
        AgentLoopExecuteToolCallsHooks<TBeforeExec, TOnUpdate> | undefined
      >;
    };

export type AgentLoopNonStreamingToolExecutionGateEvent = AgentLoopToolStartEvent
  | AgentLoopAbortIfRequestedEvent;

export type AgentLoopNonStreamingToolExecutionGateHandling<
  TExecutionPipeline,
  TExecutionContext,
  TExecutionResult,
  TLogger,
  TBeforeExec,
  TOnUpdate,
> =
  | {
      action: 'skip';
      executionResults: readonly TExecutionResult[];
    }
  | {
      action: 'execute';
      executeInput: AgentLoopExecuteToolCallsInput<
        TExecutionPipeline,
        TExecutionContext,
        TLogger,
        AgentLoopExecuteToolCallsHooks<TBeforeExec, TOnUpdate> | undefined
      >;
    }
  | {
      action: 'abort';
      result: AgentLoopAbortResult;
    };

export type AgentLoopNonStreamingToolExecutionHandling<TExecutionResult> =
  | {
      action: 'continue';
      executionResults: readonly TExecutionResult[];
    }
  | {
      action: 'abort';
      result: AgentLoopAbortResult;
    };

export function buildAgentLoopExecuteToolCallsHooksInput<TBeforeExec, TOnUpdate>(
  input: AgentLoopExecuteToolCallsHooksInput<TBeforeExec, TOnUpdate>,
): AgentLoopExecuteToolCallsHooks<TBeforeExec, TOnUpdate> {
  return {
    onBeforeToolExec: input.beforeExec,
    onUpdate: input.onUpdate,
  };
}

export function buildAgentLoopExecuteToolCallsHooksInputFromHookContainer<
  TBeforeExec,
  TOnUpdate,
>(
  input: {
    hooks?: AgentLoopExecuteToolCallsHookContainerInput<TBeforeExec, TOnUpdate> | null;
  },
): AgentLoopExecuteToolCallsHooks<TBeforeExec, TOnUpdate> {
  return buildAgentLoopExecuteToolCallsHooksInput({
    beforeExec: input.hooks?.tool?.beforeExec,
    onUpdate: input.hooks?.tool?.onUpdate,
  });
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
  TBeforeExec = unknown,
  TOnUpdate = unknown,
>(
  input: AgentLoopExecuteToolCallsProjectionInput<
    TTurnState,
    TExecutionPipeline,
    TLogger,
    THooks,
    TBeforeExec,
    TOnUpdate
  >,
): AgentLoopExecuteToolCallsInput<
  TExecutionPipeline,
  AgentLoopTurnStateProjection<TTurnState>['executionContext'],
  TLogger,
  THooks | AgentLoopExecuteToolCallsHooks<TBeforeExec, TOnUpdate> | undefined
> {
  return buildAgentLoopExecuteToolCallsInput({
    plan: input.plan,
    executionPipeline: input.executionPipeline,
    executionContext: input.turnStateProjection.executionContext,
    logger: input.logger,
    permissionMode: input.turnStateProjection.permissionMode,
    signal: input.signal,
    hooks: input.hookContainer
      ? buildAgentLoopExecuteToolCallsHooksInputFromHookContainer({
        hooks: input.hookContainer,
      })
      : input.hooks,
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

export function buildAgentLoopToolExecutionPlanInputFromExecutionPipelineProjection<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
>(
  input: AgentLoopToolExecutionPlanExecutionPipelineProjectionInput<
    TTurnState,
    TExecutionPipeline
  >,
): AgentLoopToolExecutionPlanInput {
  return buildAgentLoopToolExecutionPlanInputFromTurnProjection({
    calls: input.calls,
    registry: input.executionPipeline.getRegistry(),
    turnStateProjection: input.turnStateProjection,
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

export function prepareAgentLoopNonStreamingToolExecution<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
>(
  input: Omit<
    PrepareAgentLoopNonStreamingToolExecutionInput<
      TTurnState,
      TExecutionPipeline,
      never,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >,
    'executionResults'
  > & { executionResults: undefined },
): Extract<
  AgentLoopNonStreamingToolExecutionPreparation<
    TExecutionPipeline,
    AgentLoopTurnStateProjection<TTurnState>['executionContext'],
    never,
    TLogger,
    TBeforeExec,
    TOnUpdate
  >,
  { action: 'execute' }
>;
export function prepareAgentLoopNonStreamingToolExecution<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TExecutionResult,
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
>(
  input: Omit<
    PrepareAgentLoopNonStreamingToolExecutionInput<
      TTurnState,
      TExecutionPipeline,
      TExecutionResult,
      TLogger,
      TBeforeExec,
      TOnUpdate
    >,
    'executionResults'
  > & { executionResults: readonly TExecutionResult[] },
): Extract<
  AgentLoopNonStreamingToolExecutionPreparation<
    TExecutionPipeline,
    AgentLoopTurnStateProjection<TTurnState>['executionContext'],
    TExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  >,
  { action: 'skip' }
>;
export function prepareAgentLoopNonStreamingToolExecution<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TExecutionResult,
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
>(
  input: PrepareAgentLoopNonStreamingToolExecutionInput<
    TTurnState,
    TExecutionPipeline,
    TExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  >,
): AgentLoopNonStreamingToolExecutionPreparation<
  TExecutionPipeline,
  AgentLoopTurnStateProjection<TTurnState>['executionContext'],
  TExecutionResult,
  TLogger,
  TBeforeExec,
  TOnUpdate
> {
  if (!shouldRunAgentLoopNonStreamingToolExecution(input.executionResults)) {
    return {
      action: 'skip',
      executionResults: input.executionResults,
    };
  }

  const functionCalls = selectAgentFunctionToolCalls(input.response.toolCalls);
  const executionPlan = planAgentLoopToolExecution(
    buildAgentLoopToolExecutionPlanInputFromExecutionPipelineProjection({
      calls: functionCalls,
      executionPipeline: input.executionPipeline,
      turnStateProjection: input.turnStateProjection,
    }),
  );

  return {
    action: 'execute',
    functionCalls,
    executionPlan,
    events: buildAgentLoopToolStartEvents(
      buildAgentLoopToolStartEventsInputFromExecutionPipeline({
        plan: executionPlan,
        executionPipeline: input.executionPipeline,
      }),
    ),
    executeInput: buildAgentLoopExecuteToolCallsInputFromTurnProjection({
      plan: executionPlan,
      executionPipeline: input.executionPipeline,
      turnStateProjection: input.turnStateProjection,
      logger: input.logger,
      signal: input.signal,
      hookContainer: input.hooks,
    }),
  };
}

export async function* handleAgentLoopNonStreamingToolExecutionGateWithEmissions<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TExecutionResult,
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
>(
  input: HandleAgentLoopNonStreamingToolExecutionGateInput<
    TTurnState,
    TExecutionPipeline,
    TExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  >,
): AsyncGenerator<
  AgentLoopNonStreamingToolExecutionGateEvent,
  AgentLoopNonStreamingToolExecutionGateHandling<
    TExecutionPipeline,
    AgentLoopTurnStateProjection<TTurnState>['executionContext'],
    TExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  >
> {
  if (!shouldRunAgentLoopNonStreamingToolExecution(input.executionResults)) {
    return {
      action: 'skip',
      executionResults: input.executionResults,
    };
  }

  const preparation = prepareAgentLoopNonStreamingToolExecution({
    ...input,
    executionResults: undefined,
  });

  for (const event of preparation.events) {
    yield event;
  }

  const abortBeforeToolExecution = yield* handleAgentLoopAbortIfRequested({
    kind: 'loop_state',
    signal: input.signal,
    loopClock: input.loopClock,
    turnsCount: input.turnsCount,
    toolResultTracker: input.toolResultTracker,
  });
  if (abortBeforeToolExecution.action === 'abort') {
    return {
      action: 'abort',
      result: abortBeforeToolExecution.result,
    };
  }

  return {
    action: 'execute',
    executeInput: preparation.executeInput,
  };
}

export async function* handleAgentLoopNonStreamingToolExecutionWithEmissions<
  TTurnState extends AgentLoopTurnStateFields<
    ToolExecutionPermissionMode | undefined,
    unknown
  >,
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
  TExecutionResult,
  TLogger = unknown,
  TBeforeExec = unknown,
  TOnUpdate = unknown,
>(
  input: HandleAgentLoopNonStreamingToolExecutionInput<
    TTurnState,
    TExecutionPipeline,
    TExecutionResult,
    TLogger,
    TBeforeExec,
    TOnUpdate
  >,
): AsyncGenerator<
  AgentLoopNonStreamingToolExecutionGateEvent,
  AgentLoopNonStreamingToolExecutionHandling<TExecutionResult>
> {
  const gate = yield* handleAgentLoopNonStreamingToolExecutionGateWithEmissions(input);
  if (gate.action === 'abort') {
    return {
      action: 'abort',
      result: gate.result,
    };
  }

  if (gate.action === 'skip') {
    return {
      action: 'continue',
      executionResults: gate.executionResults,
    };
  }

  return {
    action: 'continue',
    executionResults: await input.executeToolCalls(gate.executeInput),
  };
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
