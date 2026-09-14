import { nanoid } from 'nanoid';
import type { InitialInputPreparation } from '../agent/InitialInputPreparation.js';
import { RECONCILED_INITIAL_INPUT } from '../agent/InitialInputPreparation.js';
import type { UserMessageContent } from '../agent/types.js';
import { SessionInputError } from '../errors/SessionInputError.js';
import { type ContextSnapshot, createContextSnapshot } from '../runtime/index.js';
import { InputId, RequestId, type RequestId as RequestIdType } from '../types/identifiers.js';
import type { JsonValue } from '../types/json.js';
import { ActiveRequestController } from './ActiveRequestController.js';
import {
  parseDurableRuntimeContext,
  parseDurableUserMessageContent,
} from './DurableRequestRecovery.js';
import type { DurableRequestProjection } from './events/DurableSessionProjector.js';
import {
  SessionDurableRecorder,
  SessionDurableRecorderError,
} from './events/SessionDurableRecorder.js';
import type { SessionDurability } from './SessionDurability.js';
import type { SessionExecutionState, SessionState } from './SessionState.js';
import type { InputSubmission, PendingSessionInput, SendOptions } from './types.js';
import { InputPriority } from './types.js';

export class SessionRequestCoordinator {
  constructor(
    private readonly state: SessionState,
    private readonly durability: SessionDurability,
    private readonly ensureInitialized: () => Promise<void>,
  ) {}

  async loadHistory(): Promise<void> {
    let stored = null;
    try {
      stored = await this.state.store.loadState(this.state.sessionId);
    } catch (error) {
      if (this.state.durableAcceptedRequest) {
        throw new SessionDurableRecorderError(
          `Failed to load history before resuming request ${this.state.durableAcceptedRequest.requestId}`,
          { cause: error },
        );
      }
      throw error;
    }
    const durableProjection = this.state.durableJournal?.getProjection();
    const reconciledHistoryInputIds = new Set<string>(durableProjection?.reconciledInputIds ?? []);
    this.state.messages = (stored?.messages ?? []).filter((message) => {
      const messageInputId = message.correlation?.inputId ?? null;
      return messageInputId === null || !reconciledHistoryInputIds.has(messageInputId);
    });
    await this.state.inputMutex.runExclusive(() => {
      const durableAcceptedRequest = this.state.durableAcceptedRequest;
      if (durableAcceptedRequest) {
        this.restoreDurableAcceptedRequest(durableAcceptedRequest);
      }
      const consumedInputIds = new Set([
        ...(durableProjection?.appliedInputIds ?? []),
        ...(durableProjection?.reconciledInputIds ?? []),
        ...(durableAcceptedRequest?.reconciledInputIds ?? []),
        ...(durableAcceptedRequest ? [durableAcceptedRequest.inputId] : []),
      ]);
      const dropped = this.state.inputInbox.restore(
        (stored?.pendingInputs ?? [])
          .filter((input) => !consumedInputIds.has(input.inputId))
          .map((input) => ({
            ...input,
            content: input.content as UserMessageContent,
          })),
      );
      if (dropped > 0) {
        this.state.logger.warn(
          `[Session] Dropped ${dropped} pending input(s) exceeding queue capacity while restoring session ${this.state.sessionId}`,
        );
      }
      if (this.state.executionState.phase === 'idle') {
        this.scheduleNextQueuedInput();
      }
    });
    if (this.state.messages.length === 0) {
      this.state.logger.debug(`[Session] No history found for session ${this.state.sessionId}`);
      return;
    }
    this.state.logger.debug(`[Session] Loaded ${this.state.messages.length} messages from history`);
  }

  async send(message: UserMessageContent, options?: SendOptions): Promise<InputSubmission> {
    await this.ensureInitialized();

    return this.state.inputMutex.runExclusive(async () => {
      if (this.state.executionLeaseFailure) {
        throw this.state.executionLeaseFailure;
      }
      if (
        this.state.executionState.phase === 'suspending' ||
        this.state.executionState.phase === 'closed'
      ) {
        throw new Error('Session is closed');
      }

      const inputId = InputId(nanoid());
      if (this.state.executionState.phase === 'idle') {
        this.durability.assertReadyForNewRequest();
        if (options?.expectedRequestId) {
          throw new SessionInputError(
            'SESSION_REQUEST_MISMATCH',
            `No active request matches "${options.expectedRequestId}"`,
          );
        }
        const requestId = RequestId(nanoid());
        const input: PendingSessionInput = {
          inputId,
          content: message,
          priority: InputPriority.NEXT,
          targetRequestId: requestId,
          acceptedAt: Date.now(),
        };
        const durableRecorder = this.state.durableJournal
          ? new SessionDurableRecorder(
              this.state.durableJournal,
              requestId,
              this.state.options.model,
            )
          : null;
        const pendingState = this.createPendingState(requestId, input, options, durableRecorder);
        this.state.inputInbox.reserve(input);
        try {
          await durableRecorder?.recordAccepted(
            inputId,
            message,
            'next',
            this.durability.executionSnapshot(pendingState),
          );
          try {
            await this.persistInput(input);
          } catch (error) {
            if (!durableRecorder) {
              throw error;
            }
            this.state.logger.warn(
              '[Session] Legacy input persistence failed after durable acceptance:',
              error,
            );
          }
          this.state.inputInbox.markCommitted(inputId);
        } catch (error) {
          pendingState.controller.dispose();
          this.state.inputInbox.remove(inputId);
          throw error;
        }
        this.state.executionState = pendingState;
        return {
          status: 'started',
          inputId,
          requestId,
        };
      }

      if (options?.signal || options?.maxTurns !== undefined || options?.context) {
        throw new SessionInputError(
          'SESSION_INPUT_OPTIONS_UNSUPPORTED',
          'signal, maxTurns, and context can only be set when starting an idle request',
        );
      }

      let priority = options?.priority ?? InputPriority.NEXT;
      const activeRequestId = this.state.executionState.requestId;
      const activeController = this.state.executionState.controller;
      if (options?.expectedRequestId && options.expectedRequestId !== activeRequestId) {
        throw new SessionInputError(
          'SESSION_REQUEST_MISMATCH',
          `Expected request "${options.expectedRequestId}" but "${activeRequestId}" is active`,
        );
      }
      let canSteerCurrentRequest =
        priority !== InputPriority.LATER &&
        this.state.executionState.phase !== 'stopping' &&
        (this.state.executionState.phase !== 'running' ||
          !this.state.executionState.controller.isSealed);
      if (!canSteerCurrentRequest) {
        priority = InputPriority.LATER;
      }

      const input: PendingSessionInput = {
        inputId,
        content: message,
        priority,
        targetRequestId: canSteerCurrentRequest ? activeRequestId : undefined,
        acceptedAt: Date.now(),
      };
      this.state.inputInbox.reserve(input);
      try {
        await this.persistInput(input);
        const requestStillAcceptsSteering =
          (this.state.executionState.phase === 'pending' ||
            this.state.executionState.phase === 'running') &&
          this.state.executionState.requestId === activeRequestId &&
          !activeController.isSealed;
        if (canSteerCurrentRequest && !requestStillAcceptsSteering) {
          canSteerCurrentRequest = false;
          priority = InputPriority.LATER;
          this.state.inputInbox.retargetLater(inputId);
        }
        this.state.inputInbox.markCommitted(inputId);
        if (
          canSteerCurrentRequest &&
          priority === InputPriority.NOW &&
          this.state.executionState.phase === 'running'
        ) {
          activeController.interruptStep(inputId);
        }
      } catch (error) {
        this.state.inputInbox.remove(inputId);
        throw error;
      }
      return canSteerCurrentRequest
        ? {
            status: 'steered',
            inputId,
            requestId: activeRequestId,
            priority: priority === InputPriority.NOW ? InputPriority.NOW : InputPriority.NEXT,
          }
        : {
            status: 'queued',
            inputId,
            priority: InputPriority.LATER,
          };
    });
  }

  getPendingInputs(): readonly PendingSessionInput[] {
    return this.state.inputInbox.getAll();
  }

  async cancelInput(inputId: InputId): Promise<boolean> {
    await this.ensureInitialized();
    return this.state.inputMutex.runExclusive(async () => {
      if (this.state.executionLeaseFailure) {
        throw this.state.executionLeaseFailure;
      }
      if (
        this.state.executionState.phase === 'suspending' ||
        this.state.executionState.phase === 'closed'
      ) {
        throw new Error('Session is closed');
      }
      if (
        (this.state.executionState.phase === 'running' ||
          this.state.executionState.phase === 'stopping') &&
        this.state.executionState.controller.isInitialInput(inputId)
      ) {
        return false;
      }
      const input = this.state.inputInbox.claimForCancellation(inputId);
      if (!input) {
        return false;
      }

      const pendingState =
        this.state.executionState.phase === 'pending' &&
        this.state.executionState.input.inputId === inputId
          ? this.state.executionState
          : null;
      let durablyInterrupted = false;
      if (pendingState) {
        const durableRecorder = await this.durability.ensureRecorder(pendingState);
        pendingState.durableRecorder = durableRecorder;
        if (durableRecorder) {
          await durableRecorder.finish({
            status: 'interrupted',
            reason: 'user_abort',
          });
          durablyInterrupted = true;
        }
      }
      try {
        await this.state.runWithExecutionLease(() =>
          this.state
            .getRuntime()
            .getContextManager()
            .saveInputCancelled(this.state.sessionId, inputId, 'cancelled_by_user'),
        );
      } catch (error) {
        if (!durablyInterrupted) {
          this.state.inputInbox.releaseClaim(inputId);
          throw error;
        }
        this.state.logger.warn(
          '[Session] Legacy input cancellation persistence failed after durable interruption:',
          error,
        );
      }
      this.state.inputInbox.remove(inputId);

      if (pendingState && this.state.executionState === pendingState) {
        pendingState.controller.dispose();
        this.state.executionState = { phase: 'idle' };
        this.scheduleNextQueuedInput();
      }
      return true;
    });
  }

  async finishRequest(requestId: RequestIdType): Promise<void> {
    await this.state.inputMutex.runExclusive(() => {
      if (
        (this.state.executionState.phase !== 'running' &&
          this.state.executionState.phase !== 'stopping') ||
        this.state.executionState.requestId !== requestId
      ) {
        return;
      }

      this.state.inputInbox.releaseRequest(requestId);
      this.state.executionState = { phase: 'idle' };
      this.scheduleNextQueuedInput();
    });
  }

  createPendingState(
    requestId: RequestIdType,
    input: PendingSessionInput,
    options?: SendOptions,
    durableRecorder: SessionDurableRecorder | null = null,
    snapshot?: ContextSnapshot,
    initialInputPreparation?: InitialInputPreparation,
  ): Extract<SessionExecutionState, { phase: 'pending' }> {
    return {
      phase: 'pending',
      requestId,
      input,
      controller: new ActiveRequestController(
        requestId,
        options?.signal,
        this.state.inputInbox,
        input.inputId,
      ),
      message: input.content,
      options: options || null,
      durableRecorder,
      initialInputPreparation,
      snapshot:
        snapshot ??
        createContextSnapshot(
          this.state.sessionId,
          nanoid(),
          this.state.defaultContext,
          options?.context,
        ),
    };
  }

  scheduleNextQueuedInput(): void {
    if (this.state.executionState.phase !== 'idle') {
      return;
    }
    if (
      this.state.durableJournal &&
      this.state.durableJournal.getRecoveryPlan().action !== 'none'
    ) {
      return;
    }
    const requestId = RequestId(nanoid());
    const input = this.state.inputInbox.claimNextLater(requestId);
    if (!input) {
      return;
    }
    this.state.executionState = this.createPendingState(requestId, input);
  }

  private restoreDurableAcceptedRequest(request: DurableRequestProjection): void {
    if (this.state.executionState.phase !== 'idle') {
      throw new SessionDurableRecorderError(
        `Cannot restore request ${request.requestId} while Session is ${this.state.executionState.phase}`,
      );
    }
    const content = parseDurableUserMessageContent(request.input);
    const acceptedAt = Date.parse(request.acceptedAt);
    const input: PendingSessionInput = {
      inputId: request.inputId,
      content,
      priority: request.priority === InputPriority.LATER ? InputPriority.LATER : InputPriority.NEXT,
      targetRequestId: request.requestId,
      acceptedAt: Number.isFinite(acceptedAt) ? acceptedAt : Date.now(),
    };
    this.state.inputInbox.remove(input.inputId);
    this.state.inputInbox.enqueue(input);

    const recoveredContext =
      parseDurableRuntimeContext(request.context) ?? this.state.defaultContext;
    const snapshot = createContextSnapshot(this.state.sessionId, nanoid(), recoveredContext);
    const sendOptions: SendOptions = {
      ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
    };
    const recorder = this.state.durableJournal
      ? new SessionDurableRecorder(
          this.state.durableJournal,
          request.requestId,
          this.state.options.model,
        )
      : null;
    this.state.executionState = this.createPendingState(
      request.requestId,
      input,
      sendOptions,
      recorder,
      snapshot,
      request.recoveryKind === 'pre_turn_request' ? RECONCILED_INITIAL_INPUT : undefined,
    );
    this.state.durableAcceptedRequest = null;
  }

  private async persistInput(input: PendingSessionInput): Promise<void> {
    await this.state.runWithExecutionLease(() =>
      this.state
        .getRuntime()
        .getContextManager()
        .saveInputEnqueued(this.state.sessionId, {
          inputId: input.inputId,
          content: input.content as JsonValue,
          priority: input.priority,
          targetRequestId: input.targetRequestId,
          acceptedAt: input.acceptedAt,
        }),
    );
  }
}
