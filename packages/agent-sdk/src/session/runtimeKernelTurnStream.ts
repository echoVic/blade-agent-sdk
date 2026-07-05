import type { ModelPort } from '@blade-ai/ai';
import type { AgentModelRequestDefaults, AgentToolCall } from '@blade-ai/agent';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import type { ExecutionContext } from '../tools/types/index.js';
import type { SessionId, StreamMessage } from './types.js';
import {
  projectPackageLocalKernelEventToStreamMessages,
} from './kernelStreamProjection.js';
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
import type { PackageLocalRuntimeKernelModelOptions } from './runtimeKernelModels.js';
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
    await finishPackageLocalKernelTraceError(error, traceFinalizer);
    throw error;
  }
}
