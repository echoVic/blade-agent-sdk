import { nanoid } from 'nanoid';
import { CommandId } from '../types/identifiers.js';
import type { ActiveRequestController } from './ActiveRequestController.js';
import { serializeDurableRuntimeContext } from './DurableRequestRecovery.js';
import {
  DurableEventSubscription,
  DurableEventSubscriptionError,
  type DurableEventSubscriptionOptions,
} from './events/DurableEventSubscription.js';
import { DurableSessionJournal } from './events/DurableSessionJournal.js';
import { DurableSessionRecoveryCoordinator } from './events/DurableSessionRecoveryCoordinator.js';
import {
  DurableSessionRecoveryRequiredError,
  SessionDurableRecorder,
  SessionDurableRecorderError,
} from './events/SessionDurableRecorder.js';
import { DurableEventType, type DurableRequestInterruptReason } from './events/types.js';
import type { SessionExecutionState, SessionState } from './SessionState.js';
import { InputPriority } from './types.js';

export class SessionDurability {
  constructor(private readonly state: SessionState) {}

  async subscribe(
    options: DurableEventSubscriptionOptions = {},
  ): Promise<DurableEventSubscription> {
    const store = this.state.options.durableEventStore;
    if (!store) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_NOT_CONFIGURED',
        'Session durable event subscription requires durableEventStore',
      );
    }
    return DurableEventSubscription.open(store, this.state.sessionId, {
      ...options,
      storeTimeoutMs: Math.min(
        options.storeTimeoutMs ?? this.state.durableStoreTimeoutMs,
        this.state.durableStoreTimeoutMs,
      ),
    });
  }

  async initializeJournal(): Promise<void> {
    if (this.state.durableJournal) {
      return;
    }
    const eventStore = this.state.options.durableEventStore;
    if (!eventStore) {
      return;
    }

    const journal = await DurableSessionJournal.open(eventStore, this.state.sessionId, {
      ...(this.state.executionLease ? { executionLease: this.state.executionLease } : {}),
      ...(this.state.options.durableExecutionLeaseStore
        ? { executionLeaseStore: this.state.options.durableExecutionLeaseStore }
        : {}),
      storeTimeoutMs: this.state.durableStoreTimeoutMs,
    });
    const projection = journal.getProjection();
    if (projection.status === 'empty') {
      await journal.commit({
        commandId: CommandId(nanoid()),
        events: [
          {
            type: DurableEventType.SESSION_CREATED,
            data: {
              source: this.state.durableOrigin.source,
              ...(this.state.durableOrigin.parentSessionId
                ? { parentSessionId: this.state.durableOrigin.parentSessionId }
                : {}),
            },
          },
        ],
      });
      this.state.durableJournal = journal;
      return;
    }
    if (!this.state.isResumeSession) {
      throw new SessionDurableRecorderError(
        `Durable Session ${this.state.sessionId} already exists`,
      );
    }
    if (projection.status === 'closed') {
      throw new SessionDurableRecorderError(`Durable Session ${this.state.sessionId} is closed`);
    }
    const resumeDecision = new DurableSessionRecoveryCoordinator(journal).planResume();
    if (resumeDecision.action === 'recovery_required') {
      throw new DurableSessionRecoveryRequiredError(resumeDecision.recoveryPlan);
    }
    if (resumeDecision.action === 'resume_accepted_request') {
      this.state.durableAcceptedRequest = resumeDecision.request;
      this.state.options.model = resumeDecision.request.model;
    }
    this.state.durableJournal = journal;
  }

  async ensureRecorder(
    pendingState: Extract<SessionExecutionState, { phase: 'pending' }>,
  ): Promise<SessionDurableRecorder | null> {
    if (pendingState.durableRecorder || !this.state.durableJournal) {
      return pendingState.durableRecorder;
    }
    const recorder = new SessionDurableRecorder(
      this.state.durableJournal,
      pendingState.requestId,
      this.state.options.model,
    );
    await recorder.recordAccepted(
      pendingState.input.inputId,
      pendingState.input.content,
      pendingState.input.priority === InputPriority.LATER ? 'later' : 'next',
      this.executionSnapshot(pendingState),
    );
    return recorder;
  }

  async closeSession(): Promise<void> {
    if (this.state.durableClosePromise) {
      return this.state.durableClosePromise;
    }
    const journal = this.state.durableJournal;
    if (!journal) {
      return;
    }
    const projection = journal.getProjection();
    if (projection.status !== 'open' || projection.activeRequest) {
      return;
    }
    const closePromise = journal
      .commit({
        commandId: CommandId(nanoid()),
        events: [
          {
            type: DurableEventType.SESSION_CLOSED,
            data: { reason: 'shutdown' },
          },
        ],
      })
      .then(() => undefined);
    this.state.durableClosePromise = closePromise;
    try {
      await closePromise;
    } catch (error) {
      if (this.state.durableClosePromise === closePromise) {
        this.state.durableClosePromise = null;
      }
      throw error;
    }
  }

  assertReadyForNewRequest(): void {
    const recoveryPlan = this.state.durableJournal?.getRecoveryPlan();
    if (recoveryPlan && recoveryPlan.action !== 'none') {
      throw new DurableSessionRecoveryRequiredError(recoveryPlan);
    }
  }

  interruptReason(controller: ActiveRequestController): DurableRequestInterruptReason {
    const reason = controller.requestSignal.reason;
    if (typeof reason === 'object' && reason !== null && 'kind' in reason) {
      if (reason.kind === 'session_close') {
        return 'session_close';
      }
      if (reason.kind === 'session_handoff' || reason.kind === 'execution_lease_lost') {
        return 'process_restart';
      }
    }
    return 'user_abort';
  }

  executionSnapshot(state: Extract<SessionExecutionState, { phase: 'pending' }>): {
    maxTurns: number;
    context: ReturnType<typeof serializeDurableRuntimeContext>;
  } {
    return {
      maxTurns: state.options?.maxTurns ?? this.state.maxTurns,
      context: serializeDurableRuntimeContext(state.snapshot.context),
    };
  }
}
