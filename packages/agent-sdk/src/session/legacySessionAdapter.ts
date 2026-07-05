import { nanoid } from 'nanoid';
import type { SessionRuntimeFactory } from './factory.js';
import { createLegacyDelegateSession } from './legacySessionDelegate.js';
import type { ISession, ResumeOptions, SessionOptions } from './types.js';

export interface LegacySessionModulePort {
  createSession(options: SessionOptions): Promise<ISession>;
  resumeSession(options: ResumeOptions): Promise<ISession>;
}

export interface LegacySessionRuntimeFactoryOptions {
  loadLegacySessionModule?: () => Promise<LegacySessionModulePort>;
  createTurnId?: () => string;
}

let legacySessionModulePromise: Promise<LegacySessionModulePort> | null = null;

function loadDefaultLegacySessionModule(): Promise<LegacySessionModulePort> {
  legacySessionModulePromise ??= import('../../../../src/session/Session.js').then(
    (module) => module as LegacySessionModulePort,
  );
  return legacySessionModulePromise;
}

function toLegacySessionOptions(options: SessionOptions): SessionOptions {
  return options;
}

function toLegacyResumeOptions(options: ResumeOptions): ResumeOptions {
  return options;
}

export function createLegacySessionRuntimeFactory(
  options: LegacySessionRuntimeFactoryOptions = {},
): SessionRuntimeFactory {
  const loadLegacySessionModule =
    options.loadLegacySessionModule ?? loadDefaultLegacySessionModule;
  const createTurnId = options.createTurnId ?? nanoid;

  return {
    async create(sessionOptions) {
      const { createSession } = await loadLegacySessionModule();
      const legacySession = await createSession(toLegacySessionOptions(sessionOptions));
      return createLegacyDelegateSession({
        delegate: legacySession,
        options: sessionOptions,
        createTurnId,
      });
    },
    async resume(resumeOptions) {
      const { resumeSession } = await loadLegacySessionModule();
      const legacySession = await resumeSession(toLegacyResumeOptions(resumeOptions));
      const { sessionId: _sessionId, ...sessionOptions } = resumeOptions;
      return createLegacyDelegateSession({
        delegate: legacySession,
        options: sessionOptions,
        createTurnId,
      });
    },
  };
}
