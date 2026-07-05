import type { HookTraceCollector } from '../observability/types.js';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import {
  LegacyStreamEventProjector,
  type LegacyStreamAgentEvent,
} from './legacyStreamEvents.js';
import {
  applySessionPromptSubmit,
  type PromptSubmitHookRuntime,
} from './promptSubmit.js';
import {
  completeSessionStreamResult,
  type SessionStreamLoopResult,
} from './streamCompletion.js';
import type { TaskCompletedHookRuntime } from './taskCompleted.js';
import type { SessionId, StreamMessage, UserMessageContent } from './types.js';
import type { SessionTraceFinalizer } from './traces.js';

export interface LegacyStreamRunnerHookRuntime
  extends PromptSubmitHookRuntime,
    TaskCompletedHookRuntime {}

export type LegacyStreamAgent = (
  message: UserMessageContent,
  options: { signal: AbortSignal; maxTurns: number },
) => AsyncGenerator<LegacyStreamAgentEvent, SessionStreamLoopResult>;

export interface RunLegacySessionStreamTurnOptions {
  sessionId: SessionId;
  message: UserMessageContent;
  abortSignal: AbortSignal;
  maxTurns: number;
  includeThinking?: boolean;
  traceRecorder: TraceRecorder | undefined;
  traceCollector: HookTraceCollector | undefined;
  hookRuntime: LegacyStreamRunnerHookRuntime;
  traceFinalizer: SessionTraceFinalizer;
  streamAgent: LegacyStreamAgent;
}

export async function* runLegacySessionStreamTurn(
  options: RunLegacySessionStreamTurnOptions,
): AsyncGenerator<StreamMessage> {
  const promptSubmit = await applySessionPromptSubmit({
    sessionId: options.sessionId,
    message: options.message,
    abortSignal: options.abortSignal,
    traceCollector: options.traceCollector,
    hookRuntime: options.hookRuntime,
    traceFinalizer: options.traceFinalizer,
  });

  if (!promptSubmit.ok) {
    yield* promptSubmit.messages;
    return;
  }

  try {
    const projector = new LegacyStreamEventProjector({
      sessionId: options.sessionId,
      includeThinking: options.includeThinking,
      traceRecorder: options.traceRecorder,
    });
    const stream = options.streamAgent(promptSubmit.message, {
      signal: options.abortSignal,
      maxTurns: options.maxTurns,
    });

    let loopResult: SessionStreamLoopResult | undefined;
    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        loopResult = value;
        break;
      }

      const message = projector.project(value);
      if (message) {
        yield message;
      }
    }

    yield* await completeSessionStreamResult({
      sessionId: options.sessionId,
      message: promptSubmit.message,
      loopResult,
      usage: projector.getUsage(),
      hookRuntime: options.hookRuntime,
      traceFinalizer: options.traceFinalizer,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.traceFinalizer.finish('error', { error: message });
    yield { type: 'error', message, sessionId: options.sessionId };
  } finally {
    options.hookRuntime.setTraceCollector(undefined);
  }
}
