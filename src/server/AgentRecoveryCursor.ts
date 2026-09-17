import type { AgentServerEvent } from '../protocol/index.js';
import { hasHistoryGap, type SessionHistoryProgress } from '../session/historyProgress.js';
import type { RequestId, SessionId } from '../types/identifiers.js';
import type { AgentServerStore } from './AgentServerStore.js';

export interface RecoveryCursor {
  readonly cursor?: number;
  readonly incomplete: boolean;
}

export async function resolveRecoveryCursor(
  store: AgentServerStore,
  tenantId: string,
  sessionId: SessionId,
  progress: SessionHistoryProgress | undefined,
  snapshotHead: number | null,
): Promise<RecoveryCursor> {
  if (!store.getEventStreamRange) {
    try {
      await store.readEvents(tenantId, sessionId, { after: 0, limit: 1 });
      return { cursor: 0, incomplete: false };
    } catch {
      return { incomplete: true };
    }
  }
  const range = await store.getEventStreamRange(tenantId, sessionId);
  if (!range) return { cursor: 0, incomplete: hasHistoryGap(progress) };
  const head =
    snapshotHead === null ? range.headSequence : Math.min(snapshotHead, range.headSequence);
  const covered = progress?.coveredRequestId;
  const boundary = await scanBoundary(
    store,
    tenantId,
    sessionId,
    range.firstSequence,
    head,
    covered,
  );
  if (boundary !== null) return { cursor: boundary, incomplete: hasHistoryGap(progress) };
  return {
    cursor: range.firstSequence - 1,
    incomplete: hasHistoryGap(progress) && range.firstSequence > 1,
  };
}

async function scanBoundary(
  store: AgentServerStore,
  tenantId: string,
  sessionId: SessionId,
  first: number,
  head: number,
  requestId?: RequestId,
): Promise<number | null> {
  let end = head;
  while (end >= first) {
    const start = Math.max(first, end - 499);
    const page = await store.readEvents(tenantId, sessionId, { after: start - 1, limit: 500 });
    const match = [...page.events].reverse().find((event) => {
      if (event.sequence > end) return false;
      return requestId ? event.requestId === requestId : completesRequest(event);
    });
    if (match) return Number(match.sequence);
    end = start - 1;
  }
  return null;
}

function completesRequest(event: AgentServerEvent): boolean {
  return (
    event.type === 'session.stream' &&
    (event.data as { type?: unknown } | undefined)?.type === 'result'
  );
}
