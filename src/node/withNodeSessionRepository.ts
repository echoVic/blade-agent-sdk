import { PersistentStore } from '../context/storage/PersistentStore.js';
import { getContextCwd } from '../runtime/index.js';
import type { SessionOptions } from '../session/types.js';

export function withNodeSessionRepository(options: SessionOptions): SessionOptions {
  if (
    options.sessionRepository ||
    options.sessionEventStore ||
    options.persistSession === false ||
    !options.storagePath
  ) {
    return options;
  }

  const persistence = new PersistentStore(
    options.storagePath,
    100,
    getContextCwd(options.defaultContext),
  );
  return {
    ...options,
    sessionRepository: persistence,
    sessionEventStore: persistence,
  };
}
