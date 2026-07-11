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

  async function initializeSession(
    context: PackageLocalSessionRuntimeContext,
  ): Promise<PackageLocalSession> {
    try {
      const initialState = await options.initialize?.(context);
      return createSessionFor(context, initialState);
    } catch (initializationError) {
      try {
        await options.cleanup?.(context);
      } catch (cleanupError) {
        throw new AggregateError(
          [initializationError, cleanupError],
          'Session initialization and cleanup both failed',
        );
      }
      throw initializationError;
    }
  }

  return {
    async create(sessionOptions) {
      const context = {
        sessionId: options.createSessionId(),
        options: sessionOptions,
        isResume: false,
      };
      return initializeSession(context);
    },

    async resume(resumeOptions: ResumeOptions) {
      const { sessionId, ...sessionOptions } = resumeOptions;
      const context = {
        sessionId,
        options: sessionOptions,
        isResume: true,
      };
      return initializeSession(context);
    },
  };
}
