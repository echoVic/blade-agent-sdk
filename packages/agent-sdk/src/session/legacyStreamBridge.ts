import type { HookTraceCollector } from '../observability/types.js';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import {
  type LegacyStreamAgent,
  type LegacyStreamRunnerHookRuntime,
  runLegacySessionStreamTurn,
} from './legacyStreamRunner.js';
import type {
  PackageLocalSessionStreamContext,
  PackageLocalSessionStreamTurn,
} from './sessionInstance.js';
import type { SessionTraceFinalizer } from './traces.js';
import type { ActiveSessionTurn } from './turn.js';
import type { StreamOptions, UserMessageContent } from './types.js';

export interface LegacyStreamBridgeDriver {
  prepareTurn?: (
    turn: ActiveSessionTurn,
    context: PackageLocalSessionStreamContext,
  ) => Promise<void> | void;
  createTraceRecorder?: (
    message: UserMessageContent,
    context: PackageLocalSessionStreamContext,
  ) => TraceRecorder | undefined;
  getTraceCollector?: (
    recorder: TraceRecorder | undefined,
    context: PackageLocalSessionStreamContext,
  ) => HookTraceCollector | undefined;
  hookRuntime: LegacyStreamRunnerHookRuntime;
  traceFinalizer: SessionTraceFinalizer;
  streamAgent: LegacyStreamAgent;
}

export interface LegacyStreamTurnBridgeOptions {
  context: PackageLocalSessionStreamContext;
  driver: LegacyStreamBridgeDriver;
}

function resolveMaxTurns(
  turn: ActiveSessionTurn,
  context: PackageLocalSessionStreamContext,
): number {
  return turn.sendOptions?.maxTurns ?? context.options.maxTurns ?? 200;
}

export function createLegacyStreamTurnBridge(
  options: LegacyStreamTurnBridgeOptions,
): PackageLocalSessionStreamTurn {
  return async function* bridgeLegacyStreamTurn(
    turn: ActiveSessionTurn,
    streamOptions?: StreamOptions,
    streamContext?: PackageLocalSessionStreamContext,
  ) {
    const context = streamContext ?? options.context;
    await options.driver.prepareTurn?.(turn, context);
    const traceRecorder = options.driver.createTraceRecorder?.(turn.message, context);
    const traceCollector = options.driver.getTraceCollector
      ? options.driver.getTraceCollector(traceRecorder, context)
      : traceRecorder;

    yield* runLegacySessionStreamTurn({
      sessionId: context.sessionId,
      message: turn.message,
      abortSignal: turn.signal,
      maxTurns: resolveMaxTurns(turn, context),
      includeThinking: streamOptions?.includeThinking,
      traceRecorder,
      traceCollector,
      hookRuntime: options.driver.hookRuntime,
      traceFinalizer: options.driver.traceFinalizer,
      streamAgent: options.driver.streamAgent,
    });
  };
}
