import type { SessionRuntimeFactory } from './factory.js';
import {
  PackageLocalSession,
  type PackageLocalSessionStreamTurn,
} from './sessionInstance.js';
import type {
  ResumeOptions,
  SessionId,
  SessionOptions,
} from './types.js';

export interface PackageLocalSessionRuntimeContext {
  sessionId: SessionId;
  options: SessionOptions;
  isResume: boolean;
}

export interface PackageLocalSessionRuntimeFactoryOptions {
  createSessionId: () => SessionId;
  createTurnId: () => string;
  createStreamTurn: (
    context: PackageLocalSessionRuntimeContext,
  ) => PackageLocalSessionStreamTurn;
  cleanup?: (context: PackageLocalSessionRuntimeContext) => Promise<void> | void;
}

export function createPackageLocalSessionRuntimeFactory(
  options: PackageLocalSessionRuntimeFactoryOptions,
): SessionRuntimeFactory {
  function createSessionFor(context: PackageLocalSessionRuntimeContext): PackageLocalSession {
    return new PackageLocalSession({
      sessionId: context.sessionId,
      options: context.options,
      createTurnId: options.createTurnId,
      streamTurn: options.createStreamTurn(context),
      cleanup: options.cleanup ? () => options.cleanup?.(context) : undefined,
    });
  }

  return {
    async create(sessionOptions) {
      return createSessionFor({
        sessionId: options.createSessionId(),
        options: sessionOptions,
        isResume: false,
      });
    },

    async resume(resumeOptions: ResumeOptions) {
      const { sessionId, ...sessionOptions } = resumeOptions;
      return createSessionFor({
        sessionId,
        options: sessionOptions,
        isResume: true,
      });
    },
  };
}
