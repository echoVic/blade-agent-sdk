import { basename, join } from 'node:path';
import type { SessionId } from '../../types/identifiers.js';

export function normalizeSessionStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === 'sessions' ? storageRoot : join(storageRoot, 'sessions');
}

export function getSessionFilePathFromStorageRoot(
  storageRoot: string,
  sessionId: SessionId,
): string {
  if (!sessionId || /[/\\\0]/.test(sessionId)) {
    throw new TypeError('Session ID must be a non-empty path-segment-safe string');
  }
  return join(normalizeSessionStorageRoot(storageRoot), `${sessionId}.jsonl`);
}
