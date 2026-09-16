import { EventId, EventSequence, type SessionId } from '../../types/identifiers.js';
import { planDurableSessionRecovery } from './DurableRecoveryPlan.js';
import {
  applyDurableEvent,
  assertNewEventBoundary,
  DurableEventProjectionError,
  hasCrossedNonIdempotentBoundary,
} from './DurableSessionReducer.js';
import {
  createDurableSessionState,
  type DurableSessionProjection,
  type DurableSessionRecoveryPlan,
  type DurableSessionState,
  snapshotDurableSessionState,
} from './DurableSessionState.js';
import { parseDurableEventDraft, parseDurableEventEnvelope } from './schemas.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventDraft,
  type DurableEventEnvelope,
  type DurableEventType,
  DurableEventType as DurableEventTypeValue,
} from './types.js';

export type {
  DurableModelAttemptProjection,
  DurableModelAttemptStatus,
  DurablePermissionProjection,
  DurablePermissionStatus,
  DurableRequestProjection,
  DurableRequestRecoveryKind,
  DurableRequestStatus,
  DurableSessionProjection,
  DurableSessionProjectionStatus,
  DurableSessionRecoveryAction,
  DurableSessionRecoveryPlan,
  DurableToolAttemptProjection,
  DurableToolAttemptStatus,
  DurableTurnProjection,
  DurableTurnStatus,
} from './DurableSessionState.js';
export { DurableEventProjectionError, hasCrossedNonIdempotentBoundary, planDurableSessionRecovery };

export class DurableSessionProjector {
  private state: DurableSessionState = createDurableSessionState();
  private failure: DurableEventProjectionError | null = null;

  apply(events: readonly DurableEventEnvelope[]): this {
    this.assertHealthy();
    for (const candidate of events) {
      try {
        applyDurableEvent(this.state, parseDurableEventEnvelope(candidate));
      } catch (error) {
        this.failure =
          error instanceof DurableEventProjectionError
            ? error
            : new DurableEventProjectionError('Failed to project durable event', undefined, {
                cause: error,
              });
        throw this.failure;
      }
    }
    return this;
  }

  snapshot(): DurableSessionProjection {
    this.assertHealthy();
    return snapshotDurableSessionState(this.state);
  }

  recoveryPlan(): DurableSessionRecoveryPlan {
    return planDurableSessionRecovery(this.snapshot());
  }

  fork(): DurableSessionProjector {
    this.assertHealthy();
    const projector = new DurableSessionProjector();
    projector.state = structuredClone(this.state);
    return projector;
  }

  preview(sessionId: SessionId, drafts: readonly DurableEventDraft[]): DurableSessionProjection {
    const projector = this.fork();
    const recordedAt = new Date(0).toISOString();
    let nextSequence = Number(projector.state.headSequence ?? 0) + 1;
    for (const candidate of drafts) {
      let eventId = EventId(`__preview__:${nextSequence}`);
      for (let collision = 1; projector.state.seenEventIds.has(eventId); collision += 1) {
        eventId = EventId(`__preview__:${nextSequence}:${collision}`);
      }
      const draft = parseDurableEventDraft(candidate);
      const event = parseDurableEventEnvelope({
        ...draft,
        schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
        eventId,
        sequence: EventSequence(nextSequence),
        sessionId,
        recordedAt,
        occurredAt: draft.occurredAt ?? recordedAt,
      });
      assertNewEventBoundary(projector.state, event);
      applyDurableEvent(projector.state, event);
      nextSequence += 1;
    }
    return projector.snapshot();
  }

  private assertHealthy(): void {
    if (this.failure) throw this.failure;
  }
}

export function projectDurableSession(
  events: readonly DurableEventEnvelope[],
): DurableSessionProjection {
  return new DurableSessionProjector().apply(events).snapshot();
}

export function isDurableEventType(value: string): value is DurableEventType {
  return Object.values(DurableEventTypeValue).includes(value as DurableEventType);
}
