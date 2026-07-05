import {
  createSession as createLegacySession,
  type ResumeOptions as LegacyResumeOptions,
  resumeSession as resumeLegacySession,
} from '../../../../src/session/Session.js';
import type { SessionOptions as LegacySessionOptions } from '../../../../src/session/types.js';
import { SessionId as toLegacySessionId } from '../../../../src/types/branded.js';
import type { SessionRuntimeFactory } from './factory.js';
import type { ResumeOptions, SessionOptions } from './types.js';

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
    sessionId: toLegacySessionId(sessionId),
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
