import type { MessageId, RequestId, TurnId } from '../types/identifiers.js';

export interface SessionHistoryProgress {
  readonly state: 'in_progress' | 'complete' | 'failed';
  readonly requestId?: RequestId;
  readonly turnId?: TurnId;
  readonly messageId?: MessageId;
  readonly coveredRequestId?: RequestId;
  readonly updatedAt: number;
  readonly detail?: string;
  readonly repairedMessages?: number;
}

export function hasHistoryGap(progress: SessionHistoryProgress | undefined): boolean {
  return progress?.state === 'failed';
}

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

export function coveredRequestOf(
  progress: SessionHistoryProgress | undefined,
): RequestId | undefined {
  return progress?.coveredRequestId;
}
