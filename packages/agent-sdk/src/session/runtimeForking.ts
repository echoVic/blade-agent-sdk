import type { SessionSnapshot } from './store.js';
import type { ForkSessionOptions, ISession, SessionId, SessionOptions } from './types.js';

export interface PackageLocalRuntimeForkSessionStorePort {
  forkState(
    sessionId: SessionId,
    options?: ForkSessionOptions,
  ): Promise<SessionSnapshot | null>;
  writeForkState(
    forkedSessionId: SessionId,
    snapshot: SessionSnapshot | null,
  ): Promise<SessionSnapshot | null>;
}

export interface PackageLocalRuntimeForkOptions {
  sessionId: SessionId;
  options: SessionOptions;
  forkOptions?: ForkSessionOptions;
  sessionStore: PackageLocalRuntimeForkSessionStorePort;
  createForkSessionId?: () => SessionId;
  createForkSession?: (
    sessionId: SessionId,
    options: SessionOptions,
  ) => Promise<ISession> | ISession;
}

export async function forkPackageLocalRuntimeSession(
  options: PackageLocalRuntimeForkOptions,
): Promise<ISession> {
  const { createForkSession, createForkSessionId, sessionId, sessionStore } = options;
  if (!createForkSessionId || !createForkSession) {
    throw new Error('Fork runtime is not configured for this session.');
  }

  const snapshot = await sessionStore.forkState(sessionId, options.forkOptions);
  if (!snapshot) {
    throw new Error(`Session "${sessionId}" was not found for fork.`);
  }

  const forkedSessionId = createForkSessionId();
  const writtenSnapshot = await sessionStore.writeForkState(forkedSessionId, snapshot);
  if (!writtenSnapshot) {
    throw new Error(`Session "${sessionId}" could not be materialized for fork.`);
  }

  return createForkSession(forkedSessionId, options.options);
}
