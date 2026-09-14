import { nanoid } from 'nanoid';
import { RECONCILED_INITIAL_INPUT } from '../agent/InitialInputPreparation.js';
import type { ChatContext, LoopResult } from '../agent/types.js';
import { isHookProcessContainmentError } from '../hooks/WindowsProcessJob.js';
import { createContextSnapshot } from '../runtime/index.js';
import {
  type DurableRequestFinish,
  durableRequestFinishFromLoopResult,
  SessionDurableRecorder,
  SessionDurableRecorderError,
} from './events/SessionDurableRecorder.js';
import type { SessionDurability } from './SessionDurability.js';
import { SERVER_SESSION_HOST } from './SessionHostProfile.js';
import type { SessionRequestCoordinator } from './SessionRequestCoordinator.js';
import type { SessionState, SessionStreamExecution } from './SessionState.js';
import { SessionStreamChannel } from './SessionStreamChannel.js';
import { StreamBroadcaster } from './StreamBroadcaster.js';
import { InputPriority, type SessionStreamEvent, type StreamOptions } from './types.js';

export class SessionStreamRunner {
  constructor(
    private readonly state: SessionState,
    private readonly durability: SessionDurability,
    private readonly requests: SessionRequestCoordinator,
    private readonly ensureInitialized: () => Promise<void>,
    private readonly abort: () => Promise<void>,
  ) {}

  stream(options?: StreamOptions): AsyncGenerator<SessionStreamEvent> {
    return this.consumeRequestStream(options);
  }

  private async *consumeRequestStream(options?: StreamOptions): AsyncGenerator<SessionStreamEvent> {
    const channel = new SessionStreamChannel<SessionStreamEvent>(1);
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);
    const execution: SessionStreamExecution = {
      completion,
      startedBeforeHandoff: !this.state.handoffRequested,
      releaseBackpressure: () => channel.releaseBackpressure(),
      isSettled: () => settled,
    };
    this.state.streamExecutions.add(execution);
    void completion.then(
      () => this.state.streamExecutions.delete(execution),
      () => this.state.streamExecutions.delete(execution),
    );
    const source = this.executeStream(options, execution);

    void (async () => {
      try {
        for await (const event of source) {
          await channel.publish(event);
        }
        settled = true;
        resolveCompletion();
        channel.close();
      } catch (error) {
        settled = true;
        rejectCompletion(error);
        channel.fail(error);
      }
    })();

    let consumedToEnd = false;
    try {
      for await (const event of channel) {
        yield event;
      }
      consumedToEnd = true;
    } finally {
      if (!consumedToEnd && !execution.isSettled()) {
        execution.releaseBackpressure();
        await this.abort();
      }
    }
  }

  private async *executeStream(
    options: StreamOptions | undefined,
    execution: SessionStreamExecution,
  ): AsyncGenerator<SessionStreamEvent> {
    try {
      await this.ensureInitialized();
    } catch (error) {
      if (execution.startedBeforeHandoff && this.state.handoffRequested) {
        return;
      }
      throw error;
    }
    const runtime = this.state.getRuntime();

    const claimed = await this.state.inputMutex.runExclusive(async () => {
      if (this.state.executionLeaseFailure) {
        throw this.state.executionLeaseFailure;
      }
      if (this.state.executionState.phase !== 'pending') {
        return null;
      }
      const pendingState = this.state.executionState;
      const {
        requestId,
        input,
        message: initialMessage,
        options: sendOptions,
        snapshot: pendingSnapshot,
        durableRecorder: pendingDurableRecorder,
        initialInputPreparation,
      } = pendingState;
      const requestController = pendingState.controller;
      const durableRecorder =
        pendingDurableRecorder ??
        (this.state.durableJournal
          ? new SessionDurableRecorder(
              this.state.durableJournal,
              requestId,
              this.state.options.model,
            )
          : null);
      try {
        if (durableRecorder && !pendingDurableRecorder) {
          await durableRecorder.recordAccepted(
            input.inputId,
            input.content,
            input.priority === InputPriority.LATER ? 'later' : 'next',
            this.durability.executionSnapshot(pendingState),
          );
        }
        await durableRecorder?.recordStarted(
          input.inputId,
          input.priority === InputPriority.LATER ? 'later' : 'next',
        );
      } catch (error) {
        requestController.dispose();
        this.state.inputInbox.remove(input.inputId);
        this.state.executionState = { phase: 'idle' };
        throw error;
      }
      this.state.executionState = {
        phase: 'running',
        requestId,
        controller: requestController,
        durableRecorder,
        execution,
      };
      this.state.inputInbox.remove(input.inputId);
      return {
        requestId,
        input,
        initialMessage,
        sendOptions,
        pendingSnapshot,
        requestController,
        durableRecorder,
        initialInputPreparation,
      };
    });

    if (!claimed) {
      if (execution.startedBeforeHandoff && this.state.handoffRequested) {
        return;
      }
      throw new Error('No pending message. Call send() before stream().');
    }

    const {
      requestId,
      input,
      initialMessage,
      sendOptions,
      pendingSnapshot,
      requestController,
      durableRecorder,
      initialInputPreparation,
    } = claimed;

    let durableFinishAttempted = false;
    let durableFinishCommitted = !durableRecorder;
    const finishDurableRequest = async (finish: DurableRequestFinish): Promise<void> => {
      if (!durableRecorder || durableFinishAttempted) {
        return;
      }
      durableFinishAttempted = true;
      if (!(await durableRecorder.finish(finish))) {
        throw new SessionDurableRecorderError(
          `Request ${requestId} has a tool outcome that requires reconciliation`,
        );
      }
      durableFinishCommitted = true;
    };
    let message = initialMessage;
    const traceRecorder = this.state.createTraceRecorder(message);
    let traceFinished = false;
    const finishTrace = async (
      status: 'success' | 'error' | 'aborted',
      data?: Record<string, unknown>,
    ) => {
      if (!traceRecorder || traceFinished) return;
      traceFinished = true;
      const trace = traceRecorder.finish(status, data);
      this.state.rememberTrace(trace);
      await this.state.notifyTraceSink(trace);
    };
    const signal = requestController.requestSignal;
    const isHandoffRequested = () => durableRecorder?.isHandoffRequested() === true;
    const releaseBackpressureOnAbort = () => execution.releaseBackpressure();
    if (signal.aborted) {
      releaseBackpressureOnAbort();
    } else {
      signal.addEventListener('abort', releaseBackpressureOnAbort, { once: true });
    }

    runtime.getHookRuntime().setTraceCollector(traceRecorder);
    try {
      if (initialInputPreparation !== RECONCILED_INITIAL_INPUT) {
        message = await runtime.getHookRuntime().applyUserPromptSubmit(message, {
          abortSignal: signal,
        });
      }
    } catch (error) {
      const handingOff = isHandoffRequested();
      const leaseFailure = this.state.executionLeaseFailure;
      const requestAborted = signal.aborted;
      const containmentFailure = isHookProcessContainmentError(error);
      let terminalError = error;
      if (!handingOff && !leaseFailure) {
        try {
          await finishDurableRequest(
            requestAborted && !containmentFailure
              ? {
                  status: 'interrupted',
                  reason: this.durability.interruptReason(requestController),
                }
              : { status: 'failed', error },
          );
        } catch (durableError) {
          terminalError = new AggregateError(
            [error, durableError],
            'Request setup and durable finalization both failed',
          );
        }
      }
      let errorMessage =
        terminalError instanceof Error ? terminalError.message : String(terminalError);
      let terminalContainmentFailure = isHookProcessContainmentError(terminalError);
      try {
        await finishTrace(
          !terminalContainmentFailure && (handingOff || leaseFailure || requestAborted)
            ? 'aborted'
            : 'error',
          {
            ...(terminalContainmentFailure
              ? { error: errorMessage }
              : handingOff
                ? { reason: 'session_handoff' }
                : leaseFailure
                  ? { reason: 'process_restart' }
                  : requestAborted
                    ? { reason: this.durability.interruptReason(requestController) }
                    : { error: errorMessage }),
          },
        );
      } catch (traceError) {
        const combinedError = new AggregateError(
          [terminalError, traceError],
          'Request setup and trace finalization both failed',
        );
        terminalError = combinedError;
        errorMessage = combinedError.message;
        terminalContainmentFailure = isHookProcessContainmentError(terminalError);
      }
      try {
        if (terminalContainmentFailure) {
          throw terminalError;
        }
        if (handingOff) {
          return;
        }
        if (leaseFailure) {
          throw leaseFailure;
        }
        if (durableRecorder && !durableFinishCommitted) {
          throw terminalError;
        }
        if (requestAborted) {
          return;
        }
        yield { type: 'error', message: errorMessage, sessionId: this.state.sessionId };
      } finally {
        runtime.getHookRuntime().setTraceCollector(undefined);
        signal.removeEventListener('abort', releaseBackpressureOnAbort);
        requestController.dispose();
        await this.requests.finishRequest(requestId);
      }
      return;
    }

    const snapshot =
      pendingSnapshot ??
      createContextSnapshot(
        this.state.sessionId,
        nanoid(),
        this.state.defaultContext,
        sendOptions?.context,
      );
    runtime.prepareTurn(snapshot);
    const executionLease = this.state.executionLease;

    const context: ChatContext = {
      messages: this.state.messages,
      userId: 'sdk-user',
      sessionId: this.state.sessionId,
      snapshot,
      signal,
      permissionMode: this.state.permissionMode,
      executionFence: executionLease?.fence,
      assertExecutionLease: executionLease ? () => executionLease.assertActive() : undefined,
      runWithExecutionLease: executionLease
        ? (operation) => executionLease.runFenced(operation)
        : undefined,
      backgroundAgentManager: runtime.getBackgroundAgentManager(),
      confirmationHandler: this.state.confirmationHandler,
      omitEnvironment: this.state.hostProfile === SERVER_SESSION_HOST,
    };

    const stream = this.state.getAgent().streamChat(message, context, {
      maxTurns: sendOptions?.maxTurns ?? this.state.maxTurns,
      signal,
      inputApplication: {
        inputId: input.inputId,
        requestId,
      },
      runControl: requestController,
      inputApplicationLifecycle: durableRecorder ?? undefined,
      modelExecutionLifecycle: durableRecorder ?? undefined,
      toolExecutionLifecycle: durableRecorder ?? undefined,
      initialInputPreparation:
        initialInputPreparation === RECONCILED_INITIAL_INPUT ? RECONCILED_INITIAL_INPUT : undefined,
    });
    let agentStreamCompleted = false;
    const broadcaster = new StreamBroadcaster({
      sessionId: this.state.sessionId,
      includeThinking: options?.includeThinking,
      traceRecorder,
    });

    try {
      let loopResult: LoopResult | undefined;

      while (true) {
        const next = await stream.next();
        if (this.state.executionLeaseFailure) {
          throw this.state.executionLeaseFailure;
        }
        if (signal.aborted) {
          const canObserveHandoffCompletion =
            isHandoffRequested() && (next.done || next.value.type === 'agent_end');
          if (
            !canObserveHandoffCompletion &&
            (!next.done || next.value.error?.type !== 'aborted')
          ) {
            return;
          }
        }
        const { value, done } = next;
        if (done) {
          loopResult = value;
          agentStreamCompleted = true;
          break;
        }
        await durableRecorder?.recordAgentEvent(value);
        const publicEvent = broadcaster.project(value);
        if (publicEvent) {
          yield publicEvent;
        }
      }

      if (!loopResult) {
        throw new Error('Stream ended without result');
      }
      const { usage: totalUsage } = broadcaster.summary();
      const isAborted = loopResult.error?.type === 'aborted';
      const shouldExit = loopResult.metadata?.shouldExitLoop;

      if (isHandoffRequested() && !loopResult.success && !shouldExit) {
        await finishTrace('aborted', { reason: 'session_handoff' });
        return;
      }

      if (!loopResult.success && !isAborted && !shouldExit) {
        const messageText = loopResult.error?.message || 'Unknown error';
        await finishDurableRequest({
          status: 'failed',
          error: messageText,
        });
        await finishTrace('error', { error: messageText });
        yield { type: 'error', message: messageText, sessionId: this.state.sessionId };
        return;
      }

      this.state.messages = context.messages;
      const imageCount = this.state.getImageCount(message);
      if (!signal.aborted) {
        await runtime.getHookRuntime().runTaskCompleted({
          taskId: this.state.sessionId,
          taskDescription: this.state.getTextContent(message),
          hasImages: imageCount > 0,
          imageCount,
          resultSummary: loopResult.finalMessage || '',
          success: loopResult.success,
          abortSignal: signal,
        });
      }
      await finishTrace(isAborted ? 'aborted' : 'success', {
        content: loopResult.finalMessage || '',
        usage: totalUsage,
        turnsCount: loopResult.metadata?.turnsCount,
        toolCallsCount: loopResult.metadata?.toolCallsCount,
        duration: loopResult.metadata?.duration,
      });
      await finishDurableRequest(
        durableRequestFinishFromLoopResult(
          loopResult,
          totalUsage,
          this.durability.interruptReason(requestController),
        ),
      );
      yield { type: 'usage', usage: totalUsage, sessionId: this.state.sessionId };
      yield {
        type: 'result',
        subtype: 'success',
        content: loopResult.finalMessage || '',
        sessionId: this.state.sessionId,
      };
    } catch (error) {
      const handingOff = isHandoffRequested();
      const leaseFailure = this.state.executionLeaseFailure;
      const requestAborted = signal.aborted;
      const containmentFailure = isHookProcessContainmentError(error);
      let terminalError = error;
      if (!handingOff && !leaseFailure && !durableFinishAttempted) {
        try {
          await finishDurableRequest(
            requestAborted && !containmentFailure
              ? {
                  status: 'interrupted',
                  reason: this.durability.interruptReason(requestController),
                }
              : { status: 'failed', error },
          );
        } catch (durableError) {
          terminalError = new AggregateError(
            [error, durableError],
            'Request execution and durable finalization both failed',
          );
        }
      }
      let errorMessage =
        terminalError instanceof Error ? terminalError.message : String(terminalError);
      let terminalContainmentFailure = isHookProcessContainmentError(terminalError);
      try {
        await finishTrace(
          !terminalContainmentFailure && (handingOff || leaseFailure || requestAborted)
            ? 'aborted'
            : 'error',
          {
            ...(terminalContainmentFailure
              ? { error: errorMessage }
              : handingOff
                ? { reason: 'session_handoff' }
                : leaseFailure
                  ? { reason: 'process_restart' }
                  : requestAborted
                    ? { reason: this.durability.interruptReason(requestController) }
                    : { error: errorMessage }),
          },
        );
      } catch (traceError) {
        const combinedError = new AggregateError(
          [terminalError, traceError],
          'Request execution and trace finalization both failed',
        );
        terminalError = combinedError;
        errorMessage = combinedError.message;
        terminalContainmentFailure = isHookProcessContainmentError(terminalError);
      }
      if (terminalContainmentFailure) {
        throw terminalError;
      }
      if (handingOff) {
        return;
      }
      if (leaseFailure) {
        throw leaseFailure;
      }
      if (durableRecorder && !durableFinishCommitted) {
        throw terminalError;
      }
      if (requestAborted) {
        return;
      }
      yield { type: 'error', message: errorMessage, sessionId: this.state.sessionId };
    } finally {
      let cleanupError: unknown;
      if (!agentStreamCompleted) {
        requestController.abortRequest({ kind: 'user_abort' });
        try {
          await stream.return(undefined as never);
        } catch (error) {
          cleanupError = error;
        }
        try {
          await finishTrace('aborted', {
            reason: this.durability.interruptReason(requestController),
          });
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError(
                [cleanupError, error],
                'Agent stream cleanup and trace finalization both failed',
              )
            : error;
        }
        if (!isHandoffRequested() && !this.state.executionLeaseFailure) {
          try {
            if (!durableFinishAttempted) {
              await finishDurableRequest({
                status: 'interrupted',
                reason: this.durability.interruptReason(requestController),
              });
            }
          } catch (error) {
            cleanupError = cleanupError
              ? new AggregateError(
                  [cleanupError, error],
                  'Agent stream cleanup and durable finalization both failed',
                )
              : error;
          }
        }
      }
      runtime.getHookRuntime().setTraceCollector(undefined);
      signal.removeEventListener('abort', releaseBackpressureOnAbort);
      requestController.dispose();
      await this.requests.finishRequest(requestId);
      if (
        this.state.executionState.phase === 'closed' &&
        this.state.executionState.disposition === 'terminal'
      ) {
        await this.durability.closeSession();
      }
      if (cleanupError) {
        await Promise.reject(cleanupError);
      }
    }
  }
}
