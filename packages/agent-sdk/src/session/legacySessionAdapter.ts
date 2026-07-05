import { nanoid } from 'nanoid';
import type { SessionRuntimeFactory } from './factory.js';
import { createLegacyDelegateSession } from './legacySessionDelegate.js';
import type { ResumeOptions, SessionOptions } from './types.js';

type LegacySessionModule = typeof import('../../../../src/session/Session.js');
type LegacySessionOptions = Parameters<LegacySessionModule['createSession']>[0];
type LegacyResumeOptions = Parameters<LegacySessionModule['resumeSession']>[0];

let legacySessionModulePromise: Promise<LegacySessionModule> | null = null;

function loadLegacySessionModule(): Promise<LegacySessionModule> {
  legacySessionModulePromise ??= import('../../../../src/session/Session.js');
  return legacySessionModulePromise;
}

function toLegacySessionOptions(options: SessionOptions): LegacySessionOptions {
  const { mcpServers, ...rest } = options;
  return {
    ...rest,
    ...(mcpServers ? { mcpServers: mcpServers as LegacySessionOptions['mcpServers'] } : {}),
  };
}

function toLegacyResumeOptions(options: ResumeOptions): LegacyResumeOptions {
  const { sessionId, ...sessionOptions } = options;
  return {
    ...toLegacySessionOptions(sessionOptions),
    sessionId: sessionId as LegacyResumeOptions['sessionId'],
  };
}

export function createLegacySessionRuntimeFactory(): SessionRuntimeFactory {
  return {
    async create(options) {
      const { createSession } = await loadLegacySessionModule();
      const legacySession = await createSession(toLegacySessionOptions(options));
      return createLegacyDelegateSession({
        delegate: legacySession,
        options,
        createTurnId: nanoid,
      });
    },
    async resume(options) {
      const { resumeSession } = await loadLegacySessionModule();
      const legacySession = await resumeSession(toLegacyResumeOptions(options));
      const { sessionId: _sessionId, ...sessionOptions } = options;
      return createLegacyDelegateSession({
        delegate: legacySession,
        options: sessionOptions,
        createTurnId: nanoid,
      });
    },
  };
}
