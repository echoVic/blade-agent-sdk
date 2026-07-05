import type { AgentToolCall } from '@blade-ai/agent';
import { getUserMessageText } from './content.js';
import type { PackageLocalRuntimeAgentKernelStreamOptions } from './runtimeKernelTurnStream.js';
import type {
  PackageLocalSessionStreamContext,
  PackageLocalSessionStreamTurn,
} from './sessionInstance.js';
import type { ActiveSessionTurn } from './turn.js';
import type { StreamMessage } from './types.js';
import type { ExecutionContext } from '../tools/types/index.js';

export interface KernelStreamBridgeRuntime {
  prepareTurn(snapshot: ActiveSessionTurn['snapshot']): Promise<void> | void;
  streamAgentKernelTurn(
    options: PackageLocalRuntimeAgentKernelStreamOptions,
  ): AsyncGenerator<StreamMessage>;
}

export interface KernelStreamTurnBridgeOptions {
  context: PackageLocalSessionStreamContext;
  runtime: KernelStreamBridgeRuntime;
}

function resolveMaxSteps(
  turn: ActiveSessionTurn,
  context: PackageLocalSessionStreamContext,
): number | undefined {
  return turn.sendOptions?.maxTurns ?? context.options.maxTurns;
}

function createKernelExecutionContext(
  turn: ActiveSessionTurn,
  context: PackageLocalSessionStreamContext,
): (toolCall: AgentToolCall, signal?: AbortSignal) => ExecutionContext {
  return (_toolCall, signal) => ({
    sessionId: context.sessionId,
    contextSnapshot: turn.snapshot,
    signal,
  });
}

export function createKernelStreamTurnBridge(
  options: KernelStreamTurnBridgeOptions,
): PackageLocalSessionStreamTurn {
  return async function* bridgeKernelStreamTurn(
    turn: ActiveSessionTurn,
    streamOptions,
    streamContext,
  ) {
    const context = streamContext ?? options.context;
    await options.runtime.prepareTurn(turn.snapshot);
    const maxSteps = resolveMaxSteps(turn, context);

    yield* options.runtime.streamAgentKernelTurn({
      input: getUserMessageText(turn.message),
      turnId: turn.snapshot.turnId,
      signal: turn.signal,
      includeThinking: streamOptions?.includeThinking,
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      createExecutionContext: createKernelExecutionContext(turn, context),
    });
  };
}
