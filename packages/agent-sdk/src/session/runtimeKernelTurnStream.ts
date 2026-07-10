import type { ModelPort } from '@blade-ai/ai';
import type { AgentModelRequestDefaults } from '@blade-ai/agent/kernel';
import type {
  AgentStreamEvent,
  AgentTokenBudgetPort,
  AgentToolCall,
} from '@blade-ai/agent/protocol';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import type { ExecutionContext } from '../tools/types/index.js';
import type { BladeConfig } from '../types/common.js';
import type { SessionId, StreamMessage } from './types.js';
import {
  projectPackageLocalKernelEventToStreamMessages,
} from './kernelStreamProjection.js';
import { HookEvent } from '../types/constants.js';
import {
  streamWithPackageLocalRuntimeTraceCollector,
  type PackageLocalRuntimeHookRuntimePort,
} from './runtimeHooks.js';
import type { PackageLocalRuntimeAgentKernelPort } from './runtimeAgentKernels.js';
import {
  finishPackageLocalKernelTraceError,
  updatePackageLocalKernelTraceFinalization,
  type PackageLocalKernelTraceFinalizationState,
} from './runtimeKernelTraceFinalization.js';
import {
  resolvePackageLocalRuntimeKernelModel,
  type PackageLocalRuntimeKernelModelOptions,
  type PackageLocalRuntimeKernelModelResolverPort,
  type PackageLocalRuntimeResolvedKernelModel,
} from './runtimeKernelModels.js';
import { createSessionTraceFinalizer, type SessionTraceManager } from './traces.js';

export interface PackageLocalRuntimeAgentKernelOptions
  extends PackageLocalRuntimeKernelModelOptions {
  model?: ModelPort;
  modelId?: string;
  modelRequestDefaults?: AgentModelRequestDefaults;
  traceRecorder?: TraceRecorder;
  createExecutionContext?: (
    toolCall: AgentToolCall,
    signal?: AbortSignal,
  ) => ExecutionContext;
  tokenBudget?: AgentTokenBudgetPort;
  maxSteps?: number;
}

export interface PackageLocalRuntimeAgentKernelStreamOptions
  extends PackageLocalRuntimeAgentKernelOptions {
  input: string;
  turnId?: string;
  signal?: AbortSignal;
  includeThinking?: boolean;
}

export interface PackageLocalRuntimeKernelTurnStreamOptions {
  sessionId: SessionId;
  streamOptions: PackageLocalRuntimeAgentKernelStreamOptions;
  kernel: PackageLocalRuntimeAgentKernelPort;
  traceRecorder?: TraceRecorder;
  traceManager: Pick<SessionTraceManager, 'remember' | 'notifySink'>;
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
  maxContextTokens: number;
}

export interface PackageLocalRuntimeKernelTurnResolutionOptions {
  sessionId: SessionId;
  streamOptions: PackageLocalRuntimeAgentKernelStreamOptions;
  bladeConfig: BladeConfig;
  traceManager: Pick<SessionTraceManager, 'createRecorder' | 'remember' | 'notifySink'>;
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
  kernelModelResolver: PackageLocalRuntimeKernelModelResolverPort;
  createAgentKernel: (
    options: PackageLocalRuntimeAgentKernelOptions,
    kernelModel: PackageLocalRuntimeResolvedKernelModel,
  ) => PackageLocalRuntimeAgentKernelPort;
}

export interface PackageLocalRuntimeKernelTurnStreamOperations {
  stream(
    options: PackageLocalRuntimeAgentKernelStreamOptions,
  ): AsyncGenerator<StreamMessage>;
}

export async function* streamPackageLocalAgentKernelTurn(
  options: PackageLocalRuntimeKernelTurnStreamOptions,
): AsyncGenerator<StreamMessage> {
  const traceFinalizer = createSessionTraceFinalizer(
    options.traceRecorder,
    options.traceManager,
  );
  const traceFinalizationState: PackageLocalKernelTraceFinalizationState = {};

  yield { type: 'turn_start', turn: 1, sessionId: options.sessionId };

  try {
    const kernelEvents = options.kernel.runTurn({
      input: options.streamOptions.input,
      turnId: options.streamOptions.turnId,
      signal: options.streamOptions.signal,
    });
    for await (const event of streamWithPackageLocalRuntimeTraceCollector({
      hookRuntime: options.hookRuntime,
      traceCollector: options.traceRecorder,
      stream: kernelEvents,
    })) {
      await tryReportPackageLocalKernelTaskCompleted(event, options);
      yield* projectPackageLocalKernelEventToStreamMessages(event, {
        sessionId: options.sessionId,
        maxContextTokens: options.maxContextTokens,
        includeThinking: options.streamOptions.includeThinking ?? false,
      });
      await updatePackageLocalKernelTraceFinalization(event, {
        state: traceFinalizationState,
        traceFinalizer,
      });
    }
  } catch (error) {
    options.hookRuntime.setTraceCollector?.(options.traceRecorder);
    try {
      await tryReportPackageLocalKernelTaskFailure(error, options);
    } finally {
      options.hookRuntime.setTraceCollector?.(undefined);
    }
    await finishPackageLocalKernelTraceError(error, traceFinalizer);
    throw error;
  }
}

async function tryReportPackageLocalKernelTaskFailure(
  error: unknown,
  options: Pick<
    PackageLocalRuntimeKernelTurnStreamOptions,
    'sessionId' | 'streamOptions' | 'hookRuntime' | 'traceRecorder'
  >,
): Promise<void> {
  try {
    await reportPackageLocalKernelTaskFailure(error, options);
  } catch (hookError) {
    recordSuppressedPackageLocalTaskCompletedHookFailure(hookError, options.traceRecorder);
    // Hook failures are recorded by the hook runtime; the kernel failure owns this path.
  }
}

async function reportPackageLocalKernelTaskFailure(
  error: unknown,
  options: Pick<PackageLocalRuntimeKernelTurnStreamOptions, 'sessionId' | 'streamOptions' | 'hookRuntime'>,
): Promise<void> {
  await options.hookRuntime.runTaskCompleted?.({
    taskId: options.streamOptions.turnId ?? options.sessionId,
    taskDescription: options.streamOptions.input,
    resultSummary: error instanceof Error ? error.message : String(error),
    success: false,
    abortSignal: options.streamOptions.signal,
  });
}

async function tryReportPackageLocalKernelTaskCompleted(
  event: AgentStreamEvent,
  options: Pick<
    PackageLocalRuntimeKernelTurnStreamOptions,
    'sessionId' | 'streamOptions' | 'hookRuntime' | 'traceRecorder'
  >,
): Promise<void> {
  try {
    await reportPackageLocalKernelTaskCompleted(event, options);
  } catch (hookError) {
    recordSuppressedPackageLocalTaskCompletedHookFailure(hookError, options.traceRecorder);
    // Hook failures are recorded by the hook runtime; stream projection and trace finalization continue.
  }
}

function recordSuppressedPackageLocalTaskCompletedHookFailure(
  error: unknown,
  traceRecorder: TraceRecorder | undefined,
): void {
  try {
    traceRecorder?.addEvent?.('hook_error', {
      event: HookEvent.TaskCompleted,
      error: error instanceof Error ? error.message : String(error),
      suppressed: true,
    });
  } catch {
    // Suppressed-hook observability is best effort and must not replace the stream outcome.
  }
}

async function reportPackageLocalKernelTaskCompleted(
  event: AgentStreamEvent,
  options: Pick<PackageLocalRuntimeKernelTurnStreamOptions, 'sessionId' | 'streamOptions' | 'hookRuntime'>,
): Promise<void> {
  if (event.type !== 'result' && event.type !== 'error') {
    return;
  }

  await options.hookRuntime.runTaskCompleted?.({
    taskId: options.streamOptions.turnId ?? options.sessionId,
    taskDescription: options.streamOptions.input,
    resultSummary: event.type === 'result' ? event.content : event.message,
    success: event.type === 'result',
    abortSignal: options.streamOptions.signal,
  });
}

export async function* streamPackageLocalRuntimeAgentKernelTurn(
  options: PackageLocalRuntimeKernelTurnResolutionOptions,
): AsyncGenerator<StreamMessage> {
  const kernelModel = resolvePackageLocalRuntimeKernelModel({
    options: options.streamOptions,
    bladeConfig: options.bladeConfig,
    kernelModelResolver: options.kernelModelResolver,
  });
  const traceRecorder =
    options.streamOptions.traceRecorder ??
    options.traceManager.createRecorder(options.streamOptions.input);
  const kernel = options.createAgentKernel(
    {
      ...options.streamOptions,
      ...(traceRecorder ? { traceRecorder } : {}),
    },
    kernelModel,
  );
  const maxContextTokens = kernelModel.modelRequestDefaults?.maxContextTokens ?? 0;

  yield* streamPackageLocalAgentKernelTurn({
    sessionId: options.sessionId,
    streamOptions: options.streamOptions,
    kernel,
    traceRecorder,
    traceManager: options.traceManager,
    hookRuntime: options.hookRuntime,
    maxContextTokens,
  });
}

export function createPackageLocalRuntimeKernelTurnStreamOperations(
  options: Omit<PackageLocalRuntimeKernelTurnResolutionOptions, 'streamOptions'>,
): PackageLocalRuntimeKernelTurnStreamOperations {
  return {
    stream: (streamOptions) =>
      streamPackageLocalRuntimeAgentKernelTurn({
        ...options,
        streamOptions,
      }),
  };
}
