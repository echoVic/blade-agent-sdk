import type { SessionRuntimeFactory } from './factory.js';
import {
  PackageLocalSession,
  type PackageLocalSessionRuntimePort,
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
  createSessionRuntimePort?: (
    context: PackageLocalSessionRuntimeContext,
  ) => PackageLocalSessionRuntimePort;
  initialize?: (context: PackageLocalSessionRuntimeContext) => Promise<void> | void;
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
      runtime: options.createSessionRuntimePort?.(context),
      cleanup: options.cleanup ? () => options.cleanup?.(context) : undefined,
    });
  }

  return {
    async create(sessionOptions) {
      const context = {
        sessionId: options.createSessionId(),
        options: sessionOptions,
        isResume: false,
      };
      await options.initialize?.(context);
      return createSessionFor(context);
    },

    async resume(resumeOptions: ResumeOptions) {
      const { sessionId, ...sessionOptions } = resumeOptions;
      const context = {
        sessionId,
        options: sessionOptions,
        isResume: true,
      };
      await options.initialize?.(context);
      return createSessionFor(context);
    },
  };
}
