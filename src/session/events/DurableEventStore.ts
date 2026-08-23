import { SdkError } from '../../errors/SdkError.js';
import type { EventSequence, SessionId } from '../../types/branded.js';
import type {
  DurableEventAppendOptions,
  DurableEventAppendResult,
  DurableEventDraft,
  DurableEventPage,
  DurableEventReadOptions,
} from './types.js';

export interface DurableEventStore {
  append(
    sessionId: SessionId,
    events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ): Promise<DurableEventAppendResult>;

  read(sessionId: SessionId, options?: DurableEventReadOptions): Promise<DurableEventPage>;

  getHeadSequence(sessionId: SessionId): Promise<EventSequence | null>;
}

export class DurableEventSequenceConflictError extends SdkError {
  readonly expectedSequence: EventSequence | null;
  readonly actualSequence: EventSequence | null;

  constructor(expectedSequence: EventSequence | null, actualSequence: EventSequence | null) {
    super(
      'DURABLE_EVENT_SEQUENCE_CONFLICT',
      `Expected durable event sequence ${String(expectedSequence)}, ` +
        `but current sequence is ${String(actualSequence)}`,
    );
    this.expectedSequence = expectedSequence;
    this.actualSequence = actualSequence;
  }
}

export type DurableEventStoreErrorCode =
  | 'DURABLE_EVENT_CORRUPT_LOG'
  | 'DURABLE_EVENT_INVALID_APPEND'
  | 'DURABLE_EVENT_INVALID_CURSOR'
  | 'DURABLE_EVENT_LOCK_FAILED'
  | 'DURABLE_EVENT_LOCK_TIMEOUT'
  | 'DURABLE_EVENT_READ_FAILED'
  | 'DURABLE_EVENT_WRITE_FAILED';

export class DurableEventStoreError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(code: DurableEventStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
  }
}
