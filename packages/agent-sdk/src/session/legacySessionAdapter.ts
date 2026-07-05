import {
  createSession as createLegacySession,
  resumeSession as resumeLegacySession,
} from '../../../../src/session/Session.js';
import type { SessionRuntimeFactory } from './factory.js';
import type { ResumeOptions, SessionOptions } from './types.js';

type LegacySessionOptions = Parameters<typeof createLegacySession>[0];
type LegacyResumeOptions = Parameters<typeof resumeLegacySession>[0];

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
      return createLegacySession(toLegacySessionOptions(options));
    },
    async resume(options) {
      return resumeLegacySession(toLegacyResumeOptions(options));
    },
  };
}
