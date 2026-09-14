import { Agent } from '../agent/Agent.js';
import { SessionHandoffError } from '../errors/SessionHandoffError.js';
import { registerCleanup } from '../lifecycle/CleanupRegistry.js';
import type { RequestAbortReason } from './ActiveRequestController.js';
import { DurableExecutionLease } from './events/DurableExecutionLease.js';
import { DurableExecutionLeaseError } from './events/DurableExecutionLeaseStore.js';
import type { SessionDurability } from './SessionDurability.js';
import { NODE_SESSION_HOST } from './SessionHostProfile.js';
import type { SessionRequestCoordinator } from './SessionRequestCoordinator.js';
import { SessionRuntime } from './SessionRuntime.js';
import type { SessionState, SessionStreamExecution } from './SessionState.js';
import type { SessionHandoffResult } from './types.js';

export class SessionLifecycle {
  constructor(
    private readonly state: SessionState,
    private readonly durability: SessionDurability,
    private readonly requests: SessionRequestCoordinator,
  ) {}

  async initialize(): Promise<void> {
    if (this.state.executionLeaseFailure) {
      throw this.state.executionLeaseFailure;
    }
    if (
      this.state.handoffRequested ||
      this.state.executionState.phase === 'suspending' ||
      this.state.executionState.phase === 'closed'
    ) {
      throw new Error('Session is closed');
    }
    if (this.state.initialized) return;

    await this.initializeExecutionLease();
    try {
      await this.durability.initializeJournal();
      const config = this.state.buildBladeConfig();
      this.state.runtime = new SessionRuntime(
        this.state.sessionId,
        this.state.options,
        config,
        this.state.permissionMode,
        this.state.defaultContext,
        this.state.rootLogger,
        this.state.hostProfile,
        this.state.store,
        this.state.eventStore,
      );
      await this.state.runtime.initialize();
      if (this.state.isResumeSession) {
        await this.state.runWithExecutionLease(() => this.state.getRuntime().ensureSessionLoaded());
      } else {
        await this.state.runWithExecutionLease(() =>
          this.state.getRuntime().ensureSessionCreated(),
        );
      }

      this.state.agent = await Agent.create(
        config,
        {
          permissionMode: this.state.permissionMode,
          systemPrompt: this.state.options.systemPrompt,
          maxTurns: this.state.maxTurns,
          permissionHandler: this.state.options.permissionHandler,
          canUseTool: this.state.options.canUseTool,
          toolSourcePolicy: this.state.options.toolSourcePolicy,
          outputFormat: this.state.options.outputFormat,
          sandbox: this.state.options.sandbox,
          tokenBudget: this.state.options.tokenBudget,
          localDiscovery: this.state.hostProfile === NODE_SESSION_HOST,
        },
        this.state.runtime.getAgentRuntimeDeps(),
      );

      this.state.executionLeaseLossCleanup =
        this.state.executionLease?.onLost((error) => {
          this.handleExecutionLeaseLoss(error);
        }) ?? null;
      await this.state.executionLease?.assertActive();
      await this.state.runtime.getHookRuntime().runSessionStart({
        isResume: this.state.isResumeSession,
        resumeSessionId: this.state.isResumeSession ? this.state.sessionId : undefined,
        abortSignal: this.state.executionLease?.signal,
      });
      await this.state.executionLease?.assertActive();
      if (this.state.executionLeaseFailure) {
        throw this.state.executionLeaseFailure;
      }
      this.state.initialized = true;
      this.state.cleanupHandle = registerCleanup(() => this.close());
      this.state.logger.debug(`[Session] Initialized session ${this.state.sessionId}`);
    } catch (error) {
      const cleanupErrors = await this.releaseLocalRuntime();
      if (cleanupErrors.length === 0) {
        try {
          await this.releaseExecutionLease();
        } catch (leaseError) {
          this.state.executionLease?.abandon(leaseError);
          cleanupErrors.push(leaseError);
        }
      } else {
        this.state.executionLease?.abandon(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Session ${this.state.sessionId} initialization failed during cleanup`,
        );
      }
      throw error;
    }
  }

  async ensureInitialized(): Promise<void> {
    if (this.state.executionLeaseFailure) {
      throw this.state.executionLeaseFailure;
    }
    if (
      this.state.handoffRequested ||
      this.state.executionState.phase === 'suspending' ||
      this.state.executionState.phase === 'closed'
    ) {
      throw new Error('Session is closed');
    }
    if (!this.state.initialized) {
      await this.initialize();
      return;
    }
    await this.state.executionLease?.assertActive();
  }

  close(): Promise<void> {
    if (this.state.closePromise) {
      return this.state.closePromise;
    }
    const closePromise = this.state.handoffPromise
      ? this.state.handoffPromise.then(() => undefined)
      : this.closeInternal('terminal');
    this.state.closePromise = closePromise;
    void closePromise.catch(() => {
      if (this.state.closePromise === closePromise) {
        this.state.closePromise = null;
      }
    });
    return closePromise;
  }

  suspendForHandoff(): Promise<SessionHandoffResult> {
    if (this.state.executionLeaseFailure) {
      return Promise.reject(this.state.executionLeaseFailure);
    }
    if (!this.state.options.durableEventStore) {
      return Promise.reject(
        new SessionHandoffError(
          'SESSION_HANDOFF_NOT_CONFIGURED',
          'Session handoff requires durableEventStore',
        ),
      );
    }
    if (!this.state.persistenceEnabled) {
      return Promise.reject(
        new SessionHandoffError(
          'SESSION_HANDOFF_NOT_CONFIGURED',
          'Session handoff requires persistent transcript storage',
        ),
      );
    }
    if (this.state.handoffPromise) {
      return this.state.handoffPromise;
    }
    if (this.state.closePromise) {
      return Promise.reject(
        new SessionHandoffError('SESSION_HANDOFF_UNAVAILABLE', 'Session close has already started'),
      );
    }

    const handoffPromise = this.suspendForHandoffInternal();
    this.state.handoffRequested = true;
    this.state.handoffPromise = handoffPromise;
    void handoffPromise.catch(() => {
      if (this.state.handoffPromise === handoffPromise) {
        this.state.handoffPromise = null;
        if (
          this.state.executionState.phase !== 'suspending' &&
          this.state.executionState.phase !== 'closed'
        ) {
          this.state.handoffRequested = false;
        }
      }
    });
    return handoffPromise;
  }

  async disposeAfterFork(): Promise<void> {
    await this.closeInternal('detached');
  }

  async abort(): Promise<void> {
    if (this.state.handoffPromise) {
      await this.state.handoffPromise;
      return;
    }
    const result = await this.state.inputMutex.runExclusive(async () => {
      if (this.state.executionState.phase === 'running') {
        const { requestId, controller, durableRecorder, execution } = this.state.executionState;
        controller.abortRequest({ kind: 'user_abort' });
        execution.releaseBackpressure();
        this.state.executionState = {
          phase: 'stopping',
          requestId,
          controller,
          durableRecorder,
          execution,
        };
        return { completion: execution.completion };
      }
      if (
        this.state.executionState.phase === 'stopping' ||
        this.state.executionState.phase === 'suspending'
      ) {
        this.state.executionState.execution.releaseBackpressure();
        return { completion: this.state.executionState.execution.completion };
      }
      if (this.state.executionState.phase === 'pending') {
        const pendingState = this.state.executionState;
        const durableRecorder = await this.durability.ensureRecorder(pendingState);
        pendingState.durableRecorder = durableRecorder;
        await durableRecorder?.finish({
          status: 'interrupted',
          reason: 'user_abort',
        });
        pendingState.controller.abortRequest({ kind: 'user_abort' });
        const { controller, input } = pendingState;
        controller.dispose();
        this.state.inputInbox.remove(input.inputId);
        this.state.executionState = { phase: 'idle' };
        this.requests.scheduleNextQueuedInput();
      }
      return { completion: null };
    });
    if (result.completion) {
      await result.completion;
    }
  }

  private async closeInternal(
    disposition: 'terminal' | 'detached',
    abortReason: RequestAbortReason = { kind: 'session_close' },
  ): Promise<void> {
    this.state.runtime?.assertNoPendingCleanup({ includeTerminalFailures: false });
    const recordDurableClose = disposition === 'terminal';
    const closeState = await this.state.inputMutex.runExclusive(async () => {
      if (this.state.executionState.phase === 'closed') {
        this.state.executionState.execution?.releaseBackpressure();
        return {
          alreadyClosed: true,
          disposition: this.state.executionState.disposition,
          execution: this.state.executionState.execution,
        };
      }
      let execution: SessionStreamExecution | undefined;
      if (this.state.executionState.phase === 'pending') {
        const { controller, input } = this.state.executionState;
        if (recordDurableClose) {
          const durableRecorder = await this.durability.ensureRecorder(this.state.executionState);
          this.state.executionState.durableRecorder = durableRecorder;
          await durableRecorder?.finish({
            status: 'interrupted',
            reason: 'session_close',
          });
        }
        controller.abortRequest(abortReason);
        controller.dispose();
        this.state.inputInbox.remove(input.inputId);
      } else if (
        this.state.executionState.phase === 'running' ||
        this.state.executionState.phase === 'stopping' ||
        this.state.executionState.phase === 'suspending'
      ) {
        if (this.state.executionState.phase !== 'suspending') {
          this.state.executionState.controller.abortRequest(abortReason);
        }
        execution = this.state.executionState.execution;
        execution.releaseBackpressure();
      }
      this.state.executionState = {
        phase: 'closed',
        disposition,
        ...(execution ? { execution } : {}),
      };
      return {
        alreadyClosed: false,
        disposition,
        execution,
      };
    });

    const closeErrors: unknown[] = [];
    if (closeState.execution) {
      try {
        await closeState.execution.completion;
      } catch (error) {
        closeErrors.push(error);
      }
      await this.state.inputMutex.runExclusive(() => {
        if (
          this.state.executionState.phase === 'closed' &&
          this.state.executionState.execution === closeState.execution
        ) {
          this.state.executionState = {
            phase: 'closed',
            disposition: closeState.disposition,
          };
        }
      });
    }

    this.state.runtime?.assertNoPendingCleanup({ includeTerminalFailures: false });
    if (this.state.runtime) {
      closeErrors.push(...(await this.releaseLocalRuntime()));
    }
    if (recordDurableClose && closeState.disposition === 'terminal') {
      try {
        await this.durability.closeSession();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (!this.state.runtime && (closeErrors.length === 0 || this.state.executionLeaseFailure)) {
      try {
        await this.releaseExecutionLease();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (!closeState.alreadyClosed) {
      this.state.logger.debug(`[Session] Closed session ${this.state.sessionId}`);
    }
    if (closeErrors.length === 1) {
      throw closeErrors[0];
    }
    if (closeErrors.length > 1) {
      throw new AggregateError(closeErrors, 'Session close failed in multiple phases');
    }
  }

  private async suspendForHandoffInternal(): Promise<SessionHandoffResult> {
    if (!this.state.initialized) {
      throw new SessionHandoffError('SESSION_HANDOFF_UNAVAILABLE', 'Session is not initialized');
    }
    const runtime = this.state.getRuntime();
    runtime.assertNoPendingCleanup();
    const journal = this.state.durableJournal;
    if (!journal) {
      throw new SessionHandoffError(
        'SESSION_HANDOFF_NOT_CONFIGURED',
        'Session handoff requires durableEventStore',
      );
    }

    const handoffState = await this.state.inputMutex.runExclusive(() => {
      if (this.state.executionState.phase === 'closed') {
        throw new SessionHandoffError('SESSION_HANDOFF_UNAVAILABLE', 'Session is already closed');
      }
      if (this.state.executionState.phase === 'stopping') {
        throw new SessionHandoffError(
          'SESSION_HANDOFF_UNAVAILABLE',
          'Session request cancellation has already started',
        );
      }

      const durableRecorder =
        this.state.executionState.phase === 'pending' ||
        this.state.executionState.phase === 'running' ||
        this.state.executionState.phase === 'suspending'
          ? this.state.executionState.durableRecorder
          : null;
      if (
        (this.state.executionState.phase === 'pending' ||
          this.state.executionState.phase === 'running' ||
          this.state.executionState.phase === 'suspending') &&
        !durableRecorder
      ) {
        throw new SessionHandoffError(
          'SESSION_HANDOFF_NOT_CONFIGURED',
          'Active Session handoff requires a durable Request recorder',
        );
      }
      durableRecorder?.assertHandoffReady();

      const blockers = runtime.sealBackgroundWorkForHandoff(this.state.executionLease?.fence);
      if (blockers.activeSubagentIds.length > 0 || blockers.activeShellIds.length > 0) {
        throw new SessionHandoffError(
          'SESSION_HANDOFF_ACTIVE_WORK',
          'Session handoff requires all background work to settle first',
          blockers,
        );
      }

      if (this.state.executionState.phase === 'suspending') {
        return {
          durableRecorder,
          executions: [...this.state.streamExecutions],
        };
      }
      if (this.state.executionState.phase === 'running') {
        const { requestId, controller, execution } = this.state.executionState;
        if (!durableRecorder) {
          throw new SessionHandoffError(
            'SESSION_HANDOFF_NOT_CONFIGURED',
            'Running Session handoff requires a durable Request recorder',
          );
        }
        durableRecorder.beginHandoff();
        controller.abortRequest({ kind: 'session_handoff' });
        execution.releaseBackpressure();
        this.state.executionState = {
          phase: 'suspending',
          requestId,
          controller,
          durableRecorder,
          execution,
        };
        const executions = [...this.state.streamExecutions];
        for (const activeExecution of executions) {
          activeExecution.releaseBackpressure();
        }
        return { durableRecorder, executions };
      }

      if (this.state.executionState.phase === 'pending') {
        durableRecorder?.beginHandoff();
        this.state.executionState.controller.abortRequest({ kind: 'session_handoff' });
        this.state.executionState.controller.dispose();
      }
      this.state.executionState = {
        phase: 'closed',
        disposition: 'detached',
      };
      const executions = [...this.state.streamExecutions];
      for (const activeExecution of executions) {
        activeExecution.releaseBackpressure();
      }
      return {
        durableRecorder,
        executions,
      };
    });

    const handoffErrors: unknown[] = [];
    const executionResults = await Promise.allSettled(
      handoffState.executions.map((execution) => execution.completion),
    );
    for (const result of executionResults) {
      if (result.status === 'rejected') {
        handoffErrors.push(result.reason);
      }
    }
    runtime.assertNoPendingCleanup();
    if (handoffState.durableRecorder) {
      try {
        await handoffState.durableRecorder.finalizeHandoff();
      } catch (error) {
        handoffErrors.push(error);
      }
    }

    await this.state.inputMutex.runExclusive(() => {
      if (this.state.executionState.phase === 'suspending') {
        this.state.executionState = {
          phase: 'closed',
          disposition: 'detached',
        };
      }
    });
    handoffErrors.push(...(await this.releaseLocalRuntime()));

    let recoveryPlan = null;
    let headSequence = null;
    try {
      const projection = await journal.refresh();
      if (projection.status !== 'open' || projection.headSequence === null) {
        throw new SessionHandoffError(
          'SESSION_HANDOFF_UNAVAILABLE',
          `Durable Session ${this.state.sessionId} is not open after handoff`,
        );
      }
      headSequence = projection.headSequence;
      recoveryPlan = journal.getRecoveryPlan();
    } catch (error) {
      handoffErrors.push(error);
    }
    if (!this.state.runtime && (handoffErrors.length === 0 || this.state.executionLeaseFailure)) {
      try {
        await this.releaseExecutionLease();
      } catch (error) {
        handoffErrors.push(error);
      }
    }

    if (handoffErrors.length === 1) {
      throw handoffErrors[0];
    }
    if (handoffErrors.length > 1) {
      throw new AggregateError(handoffErrors, 'Session handoff failed in multiple phases');
    }
    if (!recoveryPlan || headSequence === null) {
      throw new SessionHandoffError(
        'SESSION_HANDOFF_UNAVAILABLE',
        'Session handoff did not produce a durable recovery frontier',
      );
    }

    this.state.logger.debug(`[Session] Suspended session ${this.state.sessionId} for handoff`);
    return {
      sessionId: this.state.sessionId,
      headSequence,
      recoveryPlan,
    };
  }

  private async releaseLocalRuntime(): Promise<unknown[]> {
    const errors: unknown[] = [];
    this.state.cleanupHandle?.unregister();
    this.state.cleanupHandle = null;
    this.state.agent = null;
    this.state.initialized = false;
    const runtime = this.state.runtime;
    const executionFence = this.state.executionLease?.fence;
    if (runtime) {
      let runtimeClosed = false;
      if (!this.state.runtimeEndAttempted) {
        try {
          await runtime.getHookRuntime().runSessionEnd({ reason: 'other' });
          this.state.runtimeEndAttempted = true;
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await runtime.close(executionFence);
        runtimeClosed = true;
      } catch (error) {
        errors.push(error);
      }
      if (this.state.runtimeEndAttempted && runtimeClosed && this.state.runtime === runtime) {
        this.state.runtime = null;
      }
    }
    return errors;
  }

  private async initializeExecutionLease(): Promise<void> {
    const options = this.state.options.executionLease;
    if (!options || this.state.executionLease) {
      return;
    }
    if (!this.state.persistenceEnabled) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        'Session execution leases require persistent transcript storage',
        { sessionId: this.state.sessionId },
      );
    }
    const store = this.state.options.durableEventStore;
    if (!store) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_NOT_SUPPORTED',
        'Session execution leases require durableEventStore',
        { sessionId: this.state.sessionId },
      );
    }
    this.state.executionLease = await DurableExecutionLease.acquire(store, this.state.sessionId, {
      ...options,
      storeTimeoutMs: Math.min(
        options.storeTimeoutMs ?? this.state.durableStoreTimeoutMs,
        this.state.durableStoreTimeoutMs,
      ),
    });
  }

  private async releaseExecutionLease(): Promise<void> {
    const lease = this.state.executionLease;
    await lease?.release();
    if (this.state.executionLease === lease) {
      this.state.executionLeaseLossCleanup?.();
      this.state.executionLeaseLossCleanup = null;
      this.state.executionLease = null;
    }
  }

  private handleExecutionLeaseLoss(error: DurableExecutionLeaseError): void {
    if (this.state.executionLeaseFailure) {
      return;
    }
    this.state.executionLeaseFailure = error;
    const executionState = this.state.executionState;
    if (executionState.phase === 'pending') {
      executionState.controller.abortRequest({
        kind: 'execution_lease_lost',
        cause: error,
      });
    } else if (
      executionState.phase === 'running' ||
      executionState.phase === 'stopping' ||
      executionState.phase === 'suspending'
    ) {
      executionState.controller.abortRequest({
        kind: 'execution_lease_lost',
        cause: error,
      });
      executionState.execution.releaseBackpressure();
    }
    const executionFence = this.state.executionLease?.fence;
    if (executionFence) {
      this.state.runtime?.stopBackgroundWorkAfterLeaseLoss(executionFence);
    }
    if (!this.state.initialized || this.state.handoffPromise || this.state.closePromise) {
      return;
    }

    const cleanup = this.closeInternal('detached', {
      kind: 'execution_lease_lost',
      cause: error,
    });
    this.state.closePromise = cleanup;
    void cleanup.catch((cleanupError: unknown) => {
      this.state.logger.error(
        `[Session] Failed to clean up after execution lease loss for ${this.state.sessionId}`,
        cleanupError,
      );
      if (this.state.closePromise === cleanup) {
        this.state.closePromise = null;
      }
    });
  }
}
