import type { SessionRuntimeFactory } from './factory.js';
import {
  PackageLocalSession,
  type PackageLocalSessionRuntimePort,
  type PackageLocalSessionStreamTurn,
} from './sessionInstance.js';
import type {
  ResumeOptions,
  SessionId,
  SessionMessage,
  SessionOptions,
} from './types.js';

export interface PackageLocalSessionRuntimeContext {
  sessionId: SessionId;
  options: SessionOptions;
  isResume: boolean;
}

export interface PackageLocalSessionInitialState {
  messages?: SessionMessage[];
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
  initialize?: (
    context: PackageLocalSessionRuntimeContext,
  ) =>
    | Promise<PackageLocalSessionInitialState | undefined>
    | PackageLocalSessionInitialState
    | undefined;
  cleanup?: (context: PackageLocalSessionRuntimeContext) => Promise<void> | void;
}

export function createPackageLocalSessionRuntimeFactory(
  options: PackageLocalSessionRuntimeFactoryOptions,
): SessionRuntimeFactory {
  function createSessionFor(
    context: PackageLocalSessionRuntimeContext,
    initialState?: PackageLocalSessionInitialState,
  ): PackageLocalSession {
    return new PackageLocalSession({
      sessionId: context.sessionId,
      options: context.options,
      initialMessages: initialState?.messages,
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
      const initialState = await options.initialize?.(context);
      return createSessionFor(context, initialState);
    },

    async resume(resumeOptions: ResumeOptions) {
      const { sessionId, ...sessionOptions } = resumeOptions;
      const context = {
        sessionId,
        options: sessionOptions,
        isResume: true,
      };
      const initialState = await options.initialize?.(context);
      return createSessionFor(context, initialState);
    },
  };
}
