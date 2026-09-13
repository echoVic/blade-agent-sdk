import type { MessageId, RequestId, TurnId } from '../types/identifiers.js';

/**
 * How far the message projection is known to be complete.
 *
 * The recovery cursor may only be handed to a client when everything before it is
 * actually in the snapshot's messages. Execution progress is not history progress:
 * a model turn can finish while one of its message writes failed, and the transcript
 * would then be missing content that the event log already streamed. This record is
 * committed with the messages themselves (it lives in the transcript projection), so
 * the cursor never has to be inferred from `result` events.
 *
 * State machine:
 * - `in_progress`: a request is writing messages. It does not restrict the cursor
 *   beyond what the completed-request boundary already does.
 * - `complete`: no known gap.
 * - `failed`: a message write failed, so the transcript has a gap. Nothing clears
 *   this except a successful repair that verified the transcript against the durable
 *   journal; a later successful request must not advance past the gap.
 */
export interface SessionHistoryProgress {
  readonly state: 'in_progress' | 'complete' | 'failed';
  readonly requestId?: RequestId;
  readonly turnId?: TurnId;
  /** The newest message the projection holds for this request. */
  readonly messageId?: MessageId;
  readonly updatedAt: number;
  /** Why the gap exists, for operators and the repair report. */
  readonly detail?: string;
  /** How many messages the repair had to rebuild, when it closed a gap. */
  readonly repairedMessages?: number;
}

/** Whether the transcript may contain a gap the client would otherwise skip. */
export function hasHistoryGap(
  progress: SessionHistoryProgress | undefined,
): boolean {
  return progress?.state === 'failed';
}

/**
 * Progress recorded by a later request must not clear an open gap. The store
 * applies this rule so a sequence of successful writes cannot hide the hole.
 */
export function mergeHistoryProgress(
  current: SessionHistoryProgress | undefined,
  next: SessionHistoryProgress,
): SessionHistoryProgress {
  const isRepair = next.repairedMessages !== undefined;
  if (current?.state === 'failed' && next.state !== 'failed' && !isRepair) {
    return { ...current, updatedAt: next.updatedAt };
  }
  return next;
}
