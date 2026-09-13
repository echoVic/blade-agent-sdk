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
 * `coveredRequestId` is the cross-log part of the record. The transcript and the
 * event log are separate stores that never share a sequence, so the only identity
 * both of them carry is the Request: the projection states which Request it has
 * fully materialised, and the event log supplies the sequence of that Request's last
 * event. Reading the boundary from the snapshot closes the race where a request
 * completes between the snapshot read and the cursor resolution.
 *
 * State machine:
 * - `in_progress`: a request is writing messages. It does not restrict the cursor
 *   beyond what the covered-request boundary already does.
 * - `complete`: no known gap.
 * - `failed`: a message write failed, so the transcript has a gap. Nothing clears
 *   this except a successful repair that verified the transcript against the durable
 *   journal; a later successful request must not advance past the gap.
 */
export interface SessionHistoryProgress {
  readonly state: 'in_progress' | 'complete' | 'failed';
  /**
   * The Request this record describes: the one writing messages, or - when the
   * state is `failed` - the one whose write failed. The repair path uses it to
   * rebuild the right history instead of whatever happens to be active now.
   */
  readonly requestId?: RequestId;
  readonly turnId?: TurnId;
  /** The newest message the projection holds for this request. */
  readonly messageId?: MessageId;
  /**
   * The newest Request whose message content the projection holds. Every Request
   * before it is covered too. Absent means the projection cannot prove any
   * boundary, so the reader must fall back to replaying the retained log.
   */
  readonly coveredRequestId?: RequestId;
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
 *
 * The covered-request boundary is monotonic for the same reason: coverage is a
 * statement about messages that are already durable, and a later record that
 * omits it must not make the projection forget what it holds.
 */
export function mergeHistoryProgress(
  current: SessionHistoryProgress | undefined,
  next: SessionHistoryProgress,
): SessionHistoryProgress {
  const isRepair = next.repairedMessages !== undefined;
  if (current?.state === 'failed' && next.state !== 'failed' && !isRepair) {
    return { ...current, updatedAt: next.updatedAt };
  }
  if (current?.coveredRequestId && !next.coveredRequestId) {
    return { ...next, coveredRequestId: current.coveredRequestId };
  }
  return next;
}

/**
 * The Request boundary the projection proves on its own, for readers that must
 * turn it into an event-log sequence.
 */
export function coveredRequestOf(
  progress: SessionHistoryProgress | undefined,
): RequestId | undefined {
  return progress?.coveredRequestId;
}
