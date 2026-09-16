import { nanoid } from 'nanoid';
import { RECONCILED_INITIAL_INPUT } from '../agent/InitialInputPreparation.js';
import type { AgentExecutionContext, LoopResult, UserMessageContent } from '../agent/types.js';
import { createContextSnapshot } from '../runtime/index.js';
import { AsyncChannel } from '../utils/AsyncChannel.js';
import {
  durableRequestFinishFromLoopResult,
  SessionDurableRecorder,
} from './events/SessionDurableRecorder.js';
import type { SessionDurability } from './SessionDurability.js';
import { SERVER_SESSION_HOST } from './SessionHostProfile.js';
import type { SessionRequestCoordinator } from './SessionRequestCoordinator.js';
import { type ClaimedSessionRequest, SessionRequestExecution } from './SessionRequestExecution.js';
import type { SessionRuntime } from './SessionRuntime.js';
import type { SessionState, SessionStreamExecution } from './SessionState.js';
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
    return this.consume(options);
  }

  private async *consume(options?: StreamOptions): AsyncGenerator<SessionStreamEvent> {
    const channel = new AsyncChannel<SessionStreamEvent>(1);
    let settled = false;
    const completion = Promise.withResolvers<void>();
    void completion.promise.catch(() => undefined);
    const execution: SessionStreamExecution = {
      completion: completion.promise,
      startedBeforeHandoff: !this.state.handoffRequested,
      releaseBackpressure: () => channel.releaseBackpressure(),
      isSettled: () => settled,
    };
    this.state.streamExecutions.add(execution);
    void completion.promise.then(
      () => this.state.streamExecutions.delete(execution),
      () => this.state.streamExecutions.delete(execution),
    );

    void (async () => {
      try {
        for await (const event of this.execute(options, execution)) {
          await channel.publish(event);
        }
        settled = true;
        completion.resolve();
        channel.close();
      } catch (error) {
        settled = true;
        completion.reject(error);
        channel.fail(error);
      }
    })();

    let consumed = false;
    try {
      for await (const event of channel) yield event;
      consumed = true;
    } finally {
      if (!consumed && !execution.isSettled()) {
        execution.releaseBackpressure();
        await this.abort();
      }
    }
  }

  private async *execute(
    options: StreamOptions | undefined,
    execution: SessionStreamExecution,
  ): AsyncGenerator<SessionStreamEvent> {
    try {
      await this.ensureInitialized();
    } catch (error) {
      if (execution.startedBeforeHandoff && this.state.handoffRequested) return;
      throw error;
    }
    const runtime = this.state.getRuntime();
    const claimed = await this.claim(execution);
    if (!claimed) {
      if (execution.startedBeforeHandoff && this.state.handoffRequested) return;
      throw new Error('No pending message. Call send() before stream().');
    }

    const request = new SessionRequestExecution(
      this.state,
      this.durability,
      this.requests,
      claimed,
      execution,
      runtime.getHookRuntime(),
    );
    request.installAbortListener();
    let stream: AsyncGenerator<unknown, LoopResult> | undefined;
    let streamCompleted = false;
    try {
      let message: UserMessageContent;
      try {
        message = await this.prepareMessage(runtime, claimed, request.signal);
      } catch (error) {
        const failure = await request.handleFailure(error, 'setup');
        if (failure.action === 'throw') throw failure.error;
        if (failure.action === 'emit') yield this.errorEvent(failure.message);
        return;
      }

      const context = this.executionContext(runtime, claimed, request.signal);
      stream = this.state.getAgent().streamChat(message, context, {
        maxTurns: claimed.options?.maxTurns ?? this.state.maxTurns,
        signal: request.signal,
        inputApplication: { inputId: claimed.input.inputId, requestId: claimed.requestId },
        runControl: claimed.controller,
        inputApplicationLifecycle: request.recorder ?? undefined,
        modelExecutionLifecycle: request.recorder ?? undefined,
        toolExecutionLifecycle: request.recorder ?? undefined,
        initialInputPreparation:
          claimed.initialInputPreparation === RECONCILED_INITIAL_INPUT
            ? RECONCILED_INITIAL_INPUT
            : undefined,
      });
      const broadcaster = new StreamBroadcaster({
        sessionId: this.state.sessionId,
        includeThinking: options?.includeThinking,
        traceRecorder: request.trace,
      });
      const result = yield* this.consumeAgent(stream, request, broadcaster);
      if (!result) return;
      streamCompleted = true;
      yield* this.finishResult(runtime, result, message, context, request, broadcaster);
    } catch (error) {
      const failure = await request.handleFailure(error, 'execution');
      if (failure.action === 'throw') throw failure.error;
      if (failure.action === 'emit') yield this.errorEvent(failure.message);
    } finally {
      await request.cleanup(stream, streamCompleted);
    }
  }

  private async claim(execution: SessionStreamExecution): Promise<ClaimedSessionRequest | null> {
    return this.state.inputMutex.runExclusive(async () => {
      if (this.state.executionLeaseFailure) throw this.state.executionLeaseFailure;
      if (this.state.executionState.phase !== 'pending') return null;
      const pending = this.state.executionState;
      const recorder =
        pending.durableRecorder ??
        (this.state.durableJournal
          ? new SessionDurableRecorder(
              this.state.durableJournal,
              pending.requestId,
              this.state.options.model,
            )
          : null);
      try {
        if (recorder && !pending.durableRecorder) {
          await recorder.recordAccepted(
            pending.input.inputId,
            pending.input.content,
            pending.input.priority === InputPriority.LATER ? 'later' : 'next',
            this.durability.executionSnapshot(pending),
          );
        }
        await recorder?.recordStarted(
          pending.input.inputId,
          pending.input.priority === InputPriority.LATER ? 'later' : 'next',
        );
      } catch (error) {
        pending.controller.dispose();
        this.state.inputInbox.remove(pending.input.inputId);
        this.state.executionState = { phase: 'idle' };
        throw error;
      }
      this.state.executionState = {
        phase: 'running',
        requestId: pending.requestId,
        controller: pending.controller,
        durableRecorder: recorder,
        execution,
      };
      this.state.inputInbox.remove(pending.input.inputId);
      return {
        requestId: pending.requestId,
        input: pending.input,
        message: pending.message,
        options: pending.options,
        snapshot: pending.snapshot,
        controller: pending.controller,
        durableRecorder: recorder,
        initialInputPreparation: pending.initialInputPreparation,
      };
    });
  }

  private async prepareMessage(
    runtime: SessionRuntime,
    claimed: ClaimedSessionRequest,
    signal: AbortSignal,
  ): Promise<UserMessageContent> {
    if (claimed.initialInputPreparation === RECONCILED_INITIAL_INPUT) return claimed.message;
    return runtime.getHookRuntime().applyUserPromptSubmit(claimed.message, { abortSignal: signal });
  }

  private executionContext(
    runtime: SessionRuntime,
    claimed: ClaimedSessionRequest,
    signal: AbortSignal,
  ): AgentExecutionContext {
    const lease = this.state.executionLease;
    return {
      messages: this.state.messages,
      userId: 'sdk-user',
      sessionId: this.state.sessionId,
      snapshot:
        claimed.snapshot ??
        createContextSnapshot(
          this.state.sessionId,
          nanoid(),
          this.state.defaultContext,
          claimed.options?.context,
        ),
      signal,
      permissionMode: this.state.permissionMode,
      executionFence: lease?.fence,
      assertExecutionLease: lease ? () => lease.assertActive() : undefined,
      runWithExecutionLease: lease ? (operation) => lease.runFenced(operation) : undefined,
      backgroundAgentManager: runtime.getBackgroundAgentManager(),
      confirmationHandler: this.state.confirmationHandler,
      omitEnvironment: this.state.hostProfile === SERVER_SESSION_HOST,
    };
  }

  private async *consumeAgent(
    stream: AsyncGenerator<unknown, LoopResult>,
    request: SessionRequestExecution,
    broadcaster: StreamBroadcaster,
  ): AsyncGenerator<SessionStreamEvent, LoopResult | undefined> {
    while (true) {
      const next = await stream.next();
      if (this.state.executionLeaseFailure) throw this.state.executionLeaseFailure;
      if (request.signal.aborted) {
        const observesHandoff =
          request.handingOff &&
          (next.done ||
            (typeof next.value === 'object' &&
              next.value !== null &&
              'type' in next.value &&
              next.value.type === 'agent_end'));
        const observesAbort = next.done && next.value.error?.type === 'aborted';
        if (!observesHandoff && !observesAbort) {
          return undefined;
        }
      }
      if (next.done) return next.value;
      const event = next.value as Parameters<StreamBroadcaster['project']>[0];
      await request.recorder?.recordAgentEvent(event);
      const publicEvent = broadcaster.project(event);
      if (publicEvent) yield publicEvent;
    }
  }

  private async *finishResult(
    runtime: SessionRuntime,
    result: LoopResult,
    message: UserMessageContent,
    context: AgentExecutionContext,
    request: SessionRequestExecution,
    broadcaster: StreamBroadcaster,
  ): AsyncGenerator<SessionStreamEvent> {
    const { usage } = broadcaster.summary();
    const aborted = result.error?.type === 'aborted';
    const exits = result.metadata?.shouldExitLoop;
    if (request.handingOff && !result.success && !exits) {
      await request.finishTrace('aborted', { reason: 'session_handoff' });
      return;
    }
    if (!result.success && !aborted && !exits) {
      const error = result.error?.message || 'Unknown error';
      await request.finishDurable({ status: 'failed', error });
      await request.finishTrace('error', { error });
      yield this.errorEvent(error);
      return;
    }

    this.state.messages = context.messages;
    if (!request.signal.aborted) {
      const images = this.state.getImageCount(message);
      await runtime.getHookRuntime().runTaskCompleted({
        taskId: this.state.sessionId,
        taskDescription: this.state.getTextContent(message),
        hasImages: images > 0,
        imageCount: images,
        resultSummary: result.finalMessage || '',
        success: result.success,
        abortSignal: request.signal,
      });
    }
    await request.finishTrace(aborted ? 'aborted' : 'success', {
      content: result.finalMessage || '',
      usage,
      turnsCount: result.metadata?.turnsCount,
      toolCallsCount: result.metadata?.toolCallsCount,
      duration: result.metadata?.duration,
    });
    await request.finishDurable(
      durableRequestFinishFromLoopResult(
        result,
        usage,
        this.durability.interruptReason(request.claimed.controller),
      ),
    );
    yield { type: 'usage', usage, sessionId: this.state.sessionId };
    yield {
      type: 'result',
      subtype: 'success',
      content: result.finalMessage || '',
      sessionId: this.state.sessionId,
    };
  }

  private errorEvent(message: string): SessionStreamEvent {
    return { type: 'error', message, sessionId: this.state.sessionId };
  }
}
