import {
  PackageLocalSession,
  type PackageLocalSessionStreamTurn,
} from './sessionInstance.js';
import type { ISession, SessionOptions } from './types.js';

export interface LegacyDelegateSessionOptions {
  delegate: ISession;
  options: SessionOptions;
  createTurnId: () => string;
}

export function createLegacyDelegateSession(
  options: LegacyDelegateSessionOptions,
): PackageLocalSession {
  const streamTurn: PackageLocalSessionStreamTurn = async function* (
    turn,
    streamOptions,
  ) {
    await options.delegate.send(turn.message, turn.sendOptions ?? undefined);
    yield* options.delegate.stream(streamOptions);
  };

  return new PackageLocalSession({
    sessionId: options.delegate.sessionId,
    options: options.options,
    createTurnId: options.createTurnId,
    streamTurn,
    delegate: options.delegate,
  });
}
